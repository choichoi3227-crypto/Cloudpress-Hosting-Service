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
