import { CfClient, CfApiError } from "./cfApi";
import { usd, type Micro } from "./money";

export interface DomainCheck { name: string; registrable: boolean; reason?: string; tier?: string; registrationCostMicro?: Micro; renewalCostMicro?: Micro; /** 원화로 공급가를 주는 등록기관(가비아)용 */ registrationCostWon?: number; renewalCostWon?: number }

/** 등록기관의 네임서버 변경(타사 네임서버 위임). */
export interface NameserverPort { setNameservers(domainName: string, nameservers: string[]): Promise<void> }
export interface RegistrantContact { email: string; phone: string; postal_info: { name: string; organization?: string; address: { street: string; city: string; state: string; postal_code: string; country_code: string } } }

export type RegistrationOutcome =
  | { outcome: "succeeded"; expiresAt: string }
  | { outcome: "in_progress" }
  | { outcome: "action_required" | "blocked" | "failed"; code?: string; message?: string };

export interface RegistrarPort {
  search(q: string, limit: number): Promise<DomainCheck[]>;
  check(domains: string[]): Promise<DomainCheck[]>;
  register(domainName: string, contact?: RegistrantContact): Promise<RegistrationOutcome>;
  status(domainName: string): Promise<RegistrationOutcome>;
}

function mapDomain(d: any): DomainCheck {
  return {
    name: d.name, registrable: d.registrable === true, reason: d.reason, tier: d.tier,
    registrationCostMicro: d.pricing?.registration_cost ? usd(String(d.pricing.registration_cost)) : undefined,
    renewalCostMicro: d.pricing?.renewal_cost ? usd(String(d.pricing.renewal_cost)) : undefined,
  };
}

function mapState(r: any): RegistrationOutcome {
  switch (r?.state) {
    case "succeeded": return { outcome: "succeeded", expiresAt: r.context?.registration?.expires_at ?? "" };
    case "in_progress": return { outcome: "in_progress" };
    case "action_required": case "blocked": case "failed": return { outcome: r.state, code: r.error?.code, message: r.error?.message };
    default: return { outcome: "failed", code: "unknown_state", message: String(r?.state) };
  }
}

/** Cloudflare Registrar API(베타) 어댑터. 경로·본문은 2026-09 공식 문서 기준. */
export class CloudflareRegistrar implements RegistrarPort {
  constructor(private c: CfClient) {}
  private base = () => `/accounts/${this.c.accountId}/registrar`;

  async search(q: string, limit: number) {
    const r = await this.c.request<{ domains: any[] }>("GET", `${this.base()}/domain-search?q=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 20)}`);
    return r.result.domains.map(mapDomain);
  }
  async check(domains: string[]) {
    if (domains.length < 1 || domains.length > 20) throw new Error("check 는 1~20개 도메인만 허용");
    const r = await this.c.request<{ domains: any[] }>("POST", `${this.base()}/domain-check`, { domains });
    return r.result.domains.map(mapDomain);
  }
  /** 항상 비동기 응답(Prefer: respond-async)으로 요청해 Worker 가 오래 대기하지 않게 하고, 201/202 모두 정상으로 취급. 같은 요청을 즉시 재시도하지 않는다. */
  async register(domainName: string, contact?: RegistrantContact) {
    const body: Record<string, unknown> = { domain_name: domainName };
    if (contact) body.contacts = { registrant: contact };
    const r = await this.c.request<any>("POST", `${this.base()}/registrations`, body, { Prefer: "respond-async" });
    return mapState(r.result);
  }
  async status(domainName: string) {
    const r = await this.c.request<any>("GET", `${this.base()}/registrations/${encodeURIComponent(domainName)}/registration-status`);
    return mapState(r.result);
  }
}

/** 모의 모드·테스트용. 실제 비용이 발생하지 않는다. */
export class MockRegistrar implements RegistrarPort {
  registered = new Map<string, string>();
  calls: string[] = [];
  constructor(public cfg: { costs?: Record<string, [string, string]>; unavailable?: string[]; registerBehavior?: "succeed" | "in_progress" | "fail" | "throw" | "action_required"; priceBump?: string } = {}) {}
  private price(name: string): [string, string] { return this.cfg.costs?.[name.split(".").slice(-1)[0]!] ?? ["10.44", "10.44"]; }
  async search(q: string, limit: number) { return this.check([`${q}.com`, `${q}.dev`].slice(0, limit)); }
  async check(domains: string[]) {
    this.calls.push(`check:${domains.join(",")}`);
    return domains.map((name) => {
      if (this.registered.has(name) || this.cfg.unavailable?.includes(name)) return { name, registrable: false, reason: "domain_unavailable" };
      const [reg, ren] = this.price(name);
      const bump = this.cfg.priceBump ? usd(this.cfg.priceBump) : 0;
      return { name, registrable: true, tier: "standard", registrationCostMicro: usd(reg) + bump, renewalCostMicro: usd(ren) };
    });
  }
  async register(domainName: string): Promise<RegistrationOutcome> {
    this.calls.push(`register:${domainName}`);
    const b = this.cfg.registerBehavior ?? "succeed";
    if (b === "throw") throw new CfApiError(504, [], "timeout");
    if (b === "fail") return { outcome: "failed", code: "registry_rejected", message: "rejected" };
    if (b === "action_required") return { outcome: "action_required", code: "contact_verification" };
    if (b === "in_progress") { this.registered.set(domainName, "pending"); return { outcome: "in_progress" }; }
    this.registered.set(domainName, "2027-10-18T00:00:00Z");
    return { outcome: "succeeded", expiresAt: "2027-10-18T00:00:00Z" };
  }
  async status(domainName: string): Promise<RegistrationOutcome> {
    this.calls.push(`status:${domainName}`);
    const v = this.registered.get(domainName);
    if (!v) return { outcome: "failed", code: "not_found" };
    return v === "pending" ? { outcome: "in_progress" } : { outcome: "succeeded", expiresAt: v };
  }
}
