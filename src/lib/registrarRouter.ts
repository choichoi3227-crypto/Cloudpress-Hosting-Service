import type { DomainCheck, RegistrarPort, RegistrationOutcome, RegistrantContact, NameserverPort } from "./registrar";
import { usdMicroToWon, wonToUsdMicro } from "./fx";

export type ProviderId = "cloudflare" | "gabia";
export type PortMap = Partial<Record<ProviderId, RegistrarPort>>;

export interface RouterConfig { renewalWeight: number }
export const SEED_ROUTER_CONFIG: RouterConfig = { renewalWeight: 2 };

export interface ProviderQuote { provider: ProviderId; check: DomainCheck; regWon: number; renWon: number; regUsdMicro: number; renUsdMicro: number; score: number }
export interface RouteResult { best: ProviderQuote; all: ProviderQuote[]; failures: { provider: ProviderId; reason: string }[]; reasons: string[] }

/**
 * 등록기관 선택: 가용성 → 비용(등록가 + 가중×갱신가, 원화 환산) 최소.
 * - USD 원가(Cloudflare)는 환율 버퍼가 얹힌 환율로 원화 환산(환율 위험을 우리가 부담하므로 보수적으로)
 * - 갱신은 등록한 곳에서만 가능하므로 갱신가에 가중치를 둔다
 * - 한 곳이 오류여도 다른 곳으로 진행, 모두 실패하면 오류
 */
export async function routeDomain(ports: PortMap, hostname: string, rate: { smoothedRateMicro: number; costRateMicro: number }, cfg: RouterConfig = SEED_ROUTER_CONFIG): Promise<RouteResult> {
  const entries = Object.entries(ports) as [ProviderId, RegistrarPort][];
  const settled = await Promise.allSettled(entries.map(([, p]) => p.check([hostname])));
  const all: ProviderQuote[] = [];
  const failures: RouteResult["failures"] = [];
  const reasons: string[] = [];
  settled.forEach((r, i) => {
    const provider = entries[i]![0];
    if (r.status === "rejected") { failures.push({ provider, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }); return; }
    const c = r.value[0];
    if (!c || !c.registrable) { reasons.push(`${provider}: 등록 불가${c?.reason ? ` (${c.reason})` : ""}`); return; }
    let regWon: number, renWon: number, regUsd: number, renUsd: number;
    if (c.registrationCostWon !== undefined && c.renewalCostWon !== undefined) {
      regWon = c.registrationCostWon; renWon = c.renewalCostWon;
      regUsd = wonToUsdMicro(regWon, rate.smoothedRateMicro); renUsd = wonToUsdMicro(renWon, rate.smoothedRateMicro);
    } else if (c.registrationCostMicro !== undefined && c.renewalCostMicro !== undefined) {
      regUsd = c.registrationCostMicro; renUsd = c.renewalCostMicro;
      regWon = usdMicroToWon(regUsd, rate.costRateMicro); renWon = usdMicroToWon(renUsd, rate.costRateMicro);
    } else { reasons.push(`${provider}: 가격 정보 없음`); return; }
    all.push({ provider, check: c, regWon, renWon, regUsdMicro: regUsd, renUsdMicro: renUsd, score: regWon + cfg.renewalWeight * renWon });
  });
  if (all.length === 0) throw new Error(failures.length === entries.length ? "provider_unavailable: 모든 등록기관 조회 실패" : `unavailable: ${reasons.join("; ")}`);
  all.sort((a, b) => a.score - b.score || a.provider.localeCompare(b.provider));
  const best = all[0]!;
  reasons.push(`${best.provider} 선택: 등록 ${best.regWon}원 + 갱신 ${best.renWon}원×${cfg.renewalWeight}`);
  return { best, all, failures, reasons };
}

/* ── 가비아 도메인 API(파트너 계약 필요) ── */
export class ProviderNotConfigured extends Error { constructor(m = "가비아 도메인 API 파트너 계약 및 API 명세가 필요합니다") { super(m); } }

/**
 * 가비아 도메인 API 클라이언트 계약. 실제 엔드포인트·인증(OAuth 2.0 REST)은 파트너 승인 후 제공되는 명세로 구현한다.
 * 공개된 명세가 없어 경로·필드를 추측해 구현하지 않는다.
 */
export interface GabiaClient {
  check(domains: string[]): Promise<{ name: string; registrable: boolean; reason?: string; registrationWon?: number; renewalWon?: number }[]>;
  register(domainName: string, years: number, registrant: RegistrantContact): Promise<RegistrationOutcome>;
  status(domainName: string): Promise<RegistrationOutcome>;
  setNameservers(domainName: string, nameservers: string[]): Promise<void>;
  renew(domainName: string, years: number): Promise<void>;
}

export class GabiaRegistrar implements RegistrarPort, NameserverPort {
  constructor(private client: GabiaClient | null) {}
  private c(): GabiaClient { if (!this.client) throw new ProviderNotConfigured(); return this.client; }
  async search(q: string, limit: number) { return this.check([`${q}.kr`, `${q}.co.kr`, `${q}.com`, `${q}.net`].slice(0, limit)); }
  async check(domains: string[]): Promise<DomainCheck[]> {
    return (await this.c().check(domains)).map((d) => ({ name: d.name, registrable: d.registrable, reason: d.reason, registrationCostWon: d.registrationWon, renewalCostWon: d.renewalWon }));
  }
  async register(domainName: string, contact?: RegistrantContact) {
    if (!contact) throw new Error("가비아 등록에는 등록자 정보가 필요함");
    return this.c().register(domainName, 1, contact);
  }
  status(domainName: string) { return this.c().status(domainName); }
  setNameservers(domainName: string, nameservers: string[]) { return this.c().setNameservers(domainName, nameservers); }
}

/** 테스트·모의 모드용. 한국 확장자(.kr 계열)와 일반 확장자를 원화 공급가로 응답. */
export class MockGabiaClient implements GabiaClient {
  registered = new Map<string, string>();
  nameservers = new Map<string, string[]>();
  calls: string[] = [];
  constructor(public cfg: { prices?: Record<string, [number, number]>; failNs?: boolean; registerBehavior?: "succeed" | "throw" } = {}) {}
  private price(name: string): [number, number] {
    const tld = name.split(".").slice(name.endsWith(".co.kr") ? -2 : -1).join(".");
    return this.cfg.prices?.[tld] ?? (tld.endsWith("kr") ? [22_000, 22_000] : [15_500, 21_000]);
  }
  async check(domains: string[]) { this.calls.push(`check:${domains.join(",")}`); return domains.map((name) => { const [r, n] = this.price(name); return { name, registrable: !this.registered.has(name), registrationWon: r, renewalWon: n, reason: this.registered.has(name) ? "domain_unavailable" : undefined }; }); }
  async register(domainName: string): Promise<RegistrationOutcome> {
    this.calls.push(`register:${domainName}`);
    if (this.cfg.registerBehavior === "throw") throw new Error("gabia timeout");
    this.registered.set(domainName, "2027-10-19T00:00:00Z");
    return { outcome: "succeeded", expiresAt: "2027-10-19T00:00:00Z" };
  }
  async status(domainName: string): Promise<RegistrationOutcome> { const v = this.registered.get(domainName); return v ? { outcome: "succeeded", expiresAt: v } : { outcome: "failed", code: "not_found" }; }
  async setNameservers(domainName: string, ns: string[]) { this.calls.push(`ns:${domainName}`); if (this.cfg.failNs) throw new Error("ns update failed"); this.nameservers.set(domainName, ns); }
  async renew() {}
}
