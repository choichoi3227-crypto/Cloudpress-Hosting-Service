export type DnsType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV" | "CAA" | "NS";
export interface DnsRecordInput { type: DnsType; name: string; content: string; ttl?: number; proxied?: boolean; priority?: number }
export interface DnsRecord extends Required<Omit<DnsRecordInput, "priority">> { priority?: number; id?: string }
export type DnsResult = { ok: true; record: DnsRecord } | { ok: false; error: string };

const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const TYPES: DnsType[] = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"];

export function isIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) && m.slice(1).every((x) => x === String(Number(x))) ? p : null;
}
export function isIPv6(s: string): boolean {
  if (!/^[0-9a-f:]+$/i.test(s) || s.includes(":::")) return false;
  const dbl = s.split("::");
  if (dbl.length > 2) return false;
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const all = [...groups(dbl[0]!), ...(dbl[1] !== undefined ? groups(dbl[1]) : [])];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return dbl.length === 2 ? all.length <= 7 : all.length === 8;
}
/** 공용 인터넷에서 라우팅되지 않는 IPv4(프록시 대상으로 금지). */
export function isReservedIPv4(p: number[]): boolean {
  const [a, b] = p as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
const isHostname = (h: string) => h.length <= 253 && h.split(".").every((l) => HOST_LABEL.test(l)) && h.includes(".");

/** 영역 이름 기준 FQDN 정규화. '@' 와 빈 이름은 apex. */
export function toFqdn(name: string, zone: string): string | null {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  const full = n === "" || n === "@" ? zone : n === zone || n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
  const labels = full.split(".");
  const ok = labels.every((l, i) => (i === 0 && l === "*") || HOST_LABEL.test(l));
  return ok && full.length <= 253 ? full : null;
}

/** DNS 레코드 검증. 영역 안의 이름만 허용하고, 프록시 대상의 사설 IP 와 형식 오류를 거부한다. */
export function validateRecord(zone: string, r: DnsRecordInput): DnsResult {
  if (!TYPES.includes(r.type)) return { ok: false, error: `지원하지 않는 레코드 유형: ${r.type}` };
  const name = toFqdn(r.name, zone);
  if (!name) return { ok: false, error: "잘못된 레코드 이름" };
  const proxied = r.proxied ?? false;
  if (proxied && !["A", "AAAA", "CNAME"].includes(r.type)) return { ok: false, error: "프록시는 A/AAAA/CNAME 에서만 가능" };
  const ttl = proxied ? 1 : r.ttl ?? 1;
  if (!(ttl === 1 || (Number.isInteger(ttl) && ttl >= 60 && ttl <= 86400))) return { ok: false, error: "TTL 은 1(자동) 또는 60~86400" };
  if (proxied && r.ttl !== undefined && r.ttl !== 1) return { ok: false, error: "프록시 레코드의 TTL 은 자동(1)만 가능" };
  const c = r.content.trim();
  const base = { type: r.type, name, ttl, proxied };
  switch (r.type) {
    case "A": {
      const ip = isIPv4(c);
      if (!ip) return { ok: false, error: "올바른 IPv4 주소가 아님" };
      if (proxied && isReservedIPv4(ip)) return { ok: false, error: "프록시 레코드는 공용 IP 만 가능(사설·예약 대역 금지)" };
      return { ok: true, record: { ...base, content: c } };
    }
    case "AAAA":
      if (!isIPv6(c)) return { ok: false, error: "올바른 IPv6 주소가 아님" };
      if (proxied && /^(::1?|fe[89ab]|f[cd])/i.test(c)) return { ok: false, error: "프록시 레코드는 공용 IP 만 가능" };
      return { ok: true, record: { ...base, content: c.toLowerCase() } };
    case "CNAME": case "NS": {
      const h = c.toLowerCase().replace(/\.$/, "");
      if (!isHostname(h)) return { ok: false, error: "올바른 호스트 이름이 아님" };
      if (r.type === "NS" && name === zone) return { ok: false, error: "apex NS 는 변경할 수 없음" };
      return { ok: true, record: { ...base, content: h } };
    }
    case "MX": {
      const h = c.toLowerCase().replace(/\.$/, "");
      if (!isHostname(h)) return { ok: false, error: "MX 대상이 올바른 호스트 이름이 아님" };
      if (!Number.isInteger(r.priority) || r.priority! < 0 || r.priority! > 65535) return { ok: false, error: "MX 우선순위는 0~65535" };
      return { ok: true, record: { ...base, content: h, priority: r.priority } };
    }
    case "TXT":
      if (c.length === 0 || c.length > 2048) return { ok: false, error: "TXT 길이는 1~2048" };
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c)) return { ok: false, error: "제어 문자 불가" };
      return { ok: true, record: { ...base, content: c } };
    case "SRV": {
      const m = /^(\d{1,5}) (\d{1,5}) ([a-z0-9_.-]+)\.?$/i.exec(c);
      if (!m || Number(m[1]) > 65535 || Number(m[2]) > 65535 || !isHostname(m[3]!.toLowerCase())) return { ok: false, error: "SRV 내용은 '가중치 포트 대상' 형식" };
      if (!/^_[a-z0-9-]+\._(tcp|udp|tls)\./.test(name)) return { ok: false, error: "SRV 이름은 _서비스._프로토콜.이름 형식" };
      if (!Number.isInteger(r.priority) || r.priority! < 0 || r.priority! > 65535) return { ok: false, error: "SRV 우선순위는 0~65535" };
      return { ok: true, record: { ...base, content: c, priority: r.priority } };
    }
    case "CAA":
      if (!/^\d{1,3} (issue|issuewild|iodef) ("[^"\n]*"|[^\s"]+)$/.test(c)) return { ok: false, error: "CAA 내용은 '플래그 태그 \"값\"' 형식" };
      return { ok: true, record: { ...base, content: c } };
  }
}

/** 충돌 검사: 같은 이름에 CNAME 과 다른 유형 공존 금지, 동일 레코드 중복 금지, 영역당 개수 상한. */
export function checkConflicts(existing: DnsRecord[], next: DnsRecord, maxRecords: number): string | null {
  if (existing.length >= maxRecords) return `영역당 레코드는 최대 ${maxRecords}개`;
  const same = existing.filter((e) => e.name === next.name && e.id !== next.id);
  if (same.some((e) => e.type === next.type && e.content === next.content && e.priority === next.priority)) return "동일한 레코드가 이미 있음";
  if (next.type === "CNAME" && same.length > 0) return "CNAME 은 같은 이름의 다른 레코드와 공존할 수 없음";
  if (next.type !== "CNAME" && same.some((e) => e.type === "CNAME")) return "같은 이름에 CNAME 이 이미 있음";
  return null;
}
