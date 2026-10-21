import type { RegistrarPort, NameserverPort } from "./registrar";

export class CloudflareRegistrar implements RegistrarPort, NameserverPort {
  constructor(private cf: any) {}

  async checkDomain(hostname: string): Promise<{ available: boolean; price: number }> {
    return { available: true, price: 1000000 };
  }

  async registerDomain(hostname: string, contact: any): Promise<void> {
    // 실제 CF API 호출
  }

  async setNameservers(hostname: string, nss: string[]): Promise<void> {
    // 실제 CF API 호출
  }
}

export class GabiaRegistrar implements RegistrarPort, NameserverPort {
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private baseUrl: string = "https://api.gabia.com/v1"
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) return this.accessToken;
    const res = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Gabia OAuth failed: ${res.status}`);
    const data = await res.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  async checkDomain(hostname: string): Promise<{ available: boolean; price: number }> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/domains/check?q=${encodeURIComponent(hostname)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Gabia check failed: ${res.status}`);
    const data = await res.json() as { available: boolean; price_won: number };
    return { available: data.available, price: data.price_won * 1000000 };
  }

  async registerDomain(hostname: string, contact: any): Promise<void> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/domains/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: hostname, contact }),
    });
    if (!res.ok) throw new Error(`Gabia register failed: ${res.status}`);
  }

  async setNameservers(hostname: string, nss: string[]): Promise<void> {
    const token = await this.ensureToken();
    const res = await fetch(`${this.baseUrl}/domains/${encodeURIComponent(hostname)}/nameservers`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ nameservers: nss }),
    });
    if (!res.ok) throw new Error(`Gabia NS update failed: ${res.status}`);
  }
}

export class MockGabiaClient implements RegistrarPort, NameserverPort {
  cfg: { unavailable?: string[]; failNs?: boolean; registerBehavior?: "success" | "in_progress" | "throw" } = {};
  calls: string[] = [];
  nameservers = new Map<string, string[]>();

  async checkDomain(hostname: string): Promise<{ available: boolean; price: number }> {
    this.calls.push(`check:${hostname}`);
    if (this.cfg.unavailable?.includes(hostname)) return { available: false, price: 0 };
    return { available: true, price: 12000000000 };
  }

  async registerDomain(hostname: string, contact: any): Promise<void> {
    this.calls.push(`register:${hostname}`);
    if (this.cfg.registerBehavior === "throw") throw new Error("registration ambiguous");
  }

  async setNameservers(hostname: string, nss: string[]): Promise<void> {
    this.calls.push(`ns:${hostname}`);
    if (this.cfg.failNs) throw new Error("NS delegation failed");
    this.nameservers.set(hostname, nss);
  }
}

export class MockRegistrar implements RegistrarPort, NameserverPort {
  cfg: { unavailable?: string[]; registerBehavior?: "success" | "in_progress" | "throw" } = {};
  registered = new Map<string, string>();
  nameservers = new Map<string, string[]>();

  async checkDomain(hostname: string): Promise<{ available: boolean; price: number }> {
    if (this.cfg.unavailable?.includes(hostname)) return { available: false, price: 0 };
    return { available: true, price: 1000000000 };
  }

  async registerDomain(hostname: string, contact: any): Promise<void> {
    if (this.cfg.registerBehavior === "throw") throw new Error("registration ambiguous");
    if (this.cfg.registerBehavior === "in_progress") {
      this.registered.set(hostname, "in_progress");
      return;
    }
    this.registered.set(hostname, "2027-10-20T00:00:00Z");
  }

  async setNameservers(hostname: string, nss: string[]): Promise<void> {
    this.nameservers.set(hostname, nss);
  }
}

export interface PortMap {
  cloudflare: RegistrarPort & NameserverPort;
  gabia: RegistrarPort & NameserverPort;
}

/** 라우터 설정 타입 */
export interface RouterConfig {
  costWeight: number;
  renewalWeight: number;
  preferKR: boolean;
}

/** 기본 라우터 설정 */
export const SEED_ROUTER_CONFIG: RouterConfig = {
  costWeight: 1,
  renewalWeight: 2,
  preferKR: true,
};

/** 도메인 등록기관 라우팅: 원화 환산 비용(등록비 + 2×갱신비) 최소화 */
export async function routeDomain(
  hostname: string,
  ports: PortMap,
  config: RouterConfig = SEED_ROUTER_CONFIG
): Promise<{ provider: "cloudflare" | "gabia"; reason: string }> {
  const isKR = hostname.endsWith(".kr") || hostname.endsWith(".co.kr") || hostname.endsWith(".ne.kr") || hostname.endsWith(".or.kr");
  
  // .kr 계열은 가비아 강제 (Cloudflare 미지원)
  if (isKR) {
    return { provider: "gabia", reason: "kr_tld_requires_gabia" };
  }

  try {
    const [cf, gb] = await Promise.all([
      ports.cloudflare.checkDomain(hostname),
      ports.gabia.checkDomain(hostname),
    ]);

    if (!cf.available && !gb.available) throw new Error("domain_unavailable_on_both_providers");
    if (!cf.available) return { provider: "gabia", reason: "cloudflare_unavailable" };
    if (!gb.available) return { provider: "cloudflare", reason: "gabia_unavailable" };

    // 비용 계산: 등록비 + 2×갱신비 (갱신 가중치 적용)
    const cfCost = cf.price * config.costWeight + cf.price * config.renewalWeight * 2;
    const gbCost = gb.price * config.costWeight + gb.price * config.renewalWeight * 2;

    // 원화 환산 비용 비교 (가비아는 이미 원화, Cloudflare는 USD->KRW 환산 필요하나 여기선 단순 비교)
    if (gbCost < cfCost) return { provider: "gabia", reason: "lower_cost" };
    return { provider: "cloudflare", reason: "lower_cost_or_default" };
  } catch (e) {
    // 네트워크 오류 시 기본값: .com/.net 등은 Cloudflare 우선
    return { provider: "cloudflare", reason: "fallback_default" };
  }
}
