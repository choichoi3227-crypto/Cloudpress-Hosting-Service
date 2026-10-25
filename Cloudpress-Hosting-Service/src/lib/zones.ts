import type { CfClient } from "./cfApi";
import type { DnsRecord } from "./dnsRecords";
import type { RulePhase, RuleInput } from "./zoneSettings";

export interface ZoneInfo { id: string; name: string; status: string; nameServers: string[] }

export interface ZonesPort {
  findZone(name: string): Promise<ZoneInfo | null>;
  createZone(name: string): Promise<ZoneInfo>;
  getZone(id: string): Promise<ZoneInfo>;
  recheckActivation(id: string): Promise<void>;
  deleteZone(id: string): Promise<void>;
  createRecord(zoneId: string, r: DnsRecord): Promise<string>;
  updateRecord(zoneId: string, recordId: string, r: DnsRecord): Promise<void>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;
  setSetting(zoneId: string, key: string, value: unknown): Promise<void>;
  putRules(zoneId: string, phase: RulePhase, rules: RuleInput[]): Promise<void>;
  setDnssec(zoneId: string, status: "active" | "disabled"): Promise<{ ds?: string } | void>;
  attachWorkerRoute(zoneId: string, pattern: string, script: string): Promise<void>;
}

const toInfo = (z: any): ZoneInfo => ({ id: z.id, name: z.name, status: z.status, nameServers: z.name_servers ?? [] });
const recBody = (r: DnsRecord) => ({ type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, ...(r.priority !== undefined ? { priority: r.priority } : {}) });

/**
 * Cloudflare 구현. 영역 생성(POST /zones, type=full)은 공식 문서로 확인됨.
 * 나머지 엔드포인트(activation_check, settings, rulesets phases, dnssec, workers/routes)는
 * 실계정 통합 테스트로 확인해야 하며, 여기서는 요청 구성만 모의 fetch 로 검증한다.
 */
export class CloudflareZones implements ZonesPort {
  constructor(private c: CfClient) {}
  async findZone(name: string) {
    const r = await this.c.request<any[]>("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${this.c.accountId}`);
    return r.result.length > 0 ? toInfo(r.result[0]) : null;
  }
  async createZone(name: string) {
    const r = await this.c.request<any>("POST", "/zones", { account: { id: this.c.accountId }, name, type: "full" });
    return toInfo(r.result);
  }
  async getZone(id: string) { return toInfo((await this.c.request<any>("GET", `/zones/${id}`)).result); }
  async recheckActivation(id: string) { await this.c.request("PUT", `/zones/${id}/activation_check`); }
  async deleteZone(id: string) { await this.c.request("DELETE", `/zones/${id}`); }
  async createRecord(zoneId: string, r: DnsRecord) { return (await this.c.request<{ id: string }>("POST", `/zones/${zoneId}/dns_records`, recBody(r))).result.id; }
  async updateRecord(zoneId: string, id: string, r: DnsRecord) { await this.c.request("PATCH", `/zones/${zoneId}/dns_records/${id}`, recBody(r)); }
  async deleteRecord(zoneId: string, id: string) { await this.c.request("DELETE", `/zones/${zoneId}/dns_records/${id}`); }
  async setSetting(zoneId: string, key: string, value: unknown) { await this.c.request("PATCH", `/zones/${zoneId}/settings/${key}`, { value }); }
  async putRules(zoneId: string, phase: RulePhase, rules: RuleInput[]) { await this.c.request("PUT", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { rules }); }
  async setDnssec(zoneId: string, status: "active" | "disabled") {
    const r = await this.c.request<{ ds?: string }>("PATCH", `/zones/${zoneId}/dnssec`, { status });
    return { ds: r.result?.ds };
  }
  async attachWorkerRoute(zoneId: string, pattern: string, script: string) { await this.c.request("POST", `/zones/${zoneId}/workers/routes`, { pattern, script }); }
}

/** 모의 모드·테스트용 메모리 구현. */
export class MockZones implements ZonesPort {
  zones = new Map<string, ZoneInfo>();
  records = new Map<string, Map<string, DnsRecord>>();
  settings = new Map<string, Record<string, unknown>>();
  rules = new Map<string, RuleInput[]>();
  routes: string[] = [];
  n = 0;
  /** 운영 계정에 이미 있는 영역(예: 운영자 본인 도메인)을 흉내 낼 때 사용. */
  preexisting(name: string) { const z = { id: `z${++this.n}`, name, status: "active", nameServers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] }; this.zones.set(z.id, z); return z; }
  async findZone(name: string) { return [...this.zones.values()].find((z) => z.name === name) ?? null; }
  async createZone(name: string) {
    if (await this.findZone(name)) throw new Error("zone exists");
    const z = { id: `z${++this.n}`, name, status: "pending", nameServers: [`ns${this.n}a.mock.ns.cloudflare.com`, `ns${this.n}b.mock.ns.cloudflare.com`] };
    this.zones.set(z.id, z); return z;
  }
  async getZone(id: string) { const z = this.zones.get(id); if (!z) throw new Error("not found"); return z; }
  async recheckActivation() {}
  async deleteZone(id: string) { this.zones.delete(id); }
  async createRecord(zoneId: string, r: DnsRecord) { const id = `r${++this.n}`; (this.records.get(zoneId) ?? this.records.set(zoneId, new Map()).get(zoneId)!).set(id, r); return id; }
  async updateRecord(zoneId: string, id: string, r: DnsRecord) { this.records.get(zoneId)!.set(id, r); }
  async deleteRecord(zoneId: string, id: string) { this.records.get(zoneId)?.delete(id); }
  async setSetting(zoneId: string, key: string, value: unknown) { this.settings.set(zoneId, { ...(this.settings.get(zoneId) ?? {}), [key]: value }); }
  async putRules(zoneId: string, phase: RulePhase, rules: RuleInput[]) { this.rules.set(`${zoneId}:${phase}`, rules); }
  async setDnssec() { return { ds: "mock-ds" }; }
  async attachWorkerRoute(_z: string, pattern: string) { this.routes.push(pattern); }
}
