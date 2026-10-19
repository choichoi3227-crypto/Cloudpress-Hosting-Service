import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { encryptSecret, decryptSecret, b64urlEncode } from "../src/lib/crypto";
import { MockRegistrar, type RegistrantContact } from "../src/lib/registrar";
import { MockZones } from "../src/lib/zones";
import { createQuote, markPaid, runRegistration, pollRegistration, markRefunded, expireQuotes, adoptRegisteredZone, type Crypto } from "../src/lib/domainOrders";
import { connectDomain, checkActivation, addRecord, deleteRecord, applySettings, replaceRules, getOwnedZone, nextActivationDelayMin, ServiceError } from "../src/lib/zoneService";
import { usd } from "../src/lib/money";

const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const crypt: Crypto = { encrypt: (p, aad) => encryptSecret(p, KEY, aad), decrypt: (t, aad) => decryptSecret(t, KEY, aad) };
const NOW = Date.UTC(2026, 9, 18);
const contact: RegistrantContact = { email: "owner@example.com", phone: "+82.1012345678", postal_info: { name: "홍길동", address: { street: "테헤란로 1", city: "서울", state: "서울", postal_code: "06000", country_code: "KR" } } };

function setup() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  return { db, raw, reg: new MockRegistrar(), zones: new MockZones() };
}
const st = (raw: any, id: string) => (raw.prepare("select status from domain_orders where id=?").get(id) as { status: string }).status;
const jobs = (raw: any) => raw.prepare("select kind, idempotency_key k from deployment_jobs").all() as { kind: string; k: string }[];

describe("도메인 구매 흐름", () => {
  it("견적 → 결제 → 등록 → 영역 확보(전체 정상 흐름), 등록자 정보는 암호문으로만 저장", async () => {
    const { db, raw, reg, zones } = setup();
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "MyShop.com", contact, nowMs: NOW });
    expect(q.hostname).toBe("myshop.com");
    expect(q.priceMicro).toBeGreaterThan(usd("10.44"));
    expect(q.nonRefundableNotice).toContain("환불");
    expect(await markPaid(db, q.orderId, "pi_1", NOW)).toBe("paid");
    expect(await runRegistration(db, reg, crypt, q.orderId, NOW)).toBe("registered");
    expect(reg.calls.filter((c) => c.startsWith("register:"))).toEqual(["register:myshop.com"]);
    const enc = (raw.prepare("select registrant_enc e from domain_orders").get() as { e: string }).e;
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("홍길동");
    const z = await adoptRegisteredZone(db, zones, q.orderId, NOW);
    expect(z.created).toBe(true);
    expect((await adoptRegisteredZone(db, zones, q.orderId, NOW)).created).toBe(false); // 멱등
    expect(raw.prepare("select origin from dns_zones").get()).toMatchObject({ origin: "registered" });
  });
  it("등록 불가·미지원 TLD·서브도메인·잘못된 연락처는 견적 단계에서 거부(비용 발생 없음)", async () => {
    const { db, reg } = setup();
    const reject = (hostname: string, c = contact) => createQuote(db, reg, crypt, { customerId: "u1", hostname, contact: c, nowMs: NOW }).catch((e) => e as ServiceError);
    reg.cfg.unavailable = ["taken.com"];
    expect((await reject("taken.com") as ServiceError).code).toBe("unavailable");
    expect((await reject("www.example.com") as ServiceError).code).toBe("invalid_hostname");
    expect((await reject("example.com", { ...contact, phone: "01012345678" }) as ServiceError).code).toBe("invalid_contact");
    expect((await reject("example.com", { ...contact, email: "bad" }) as ServiceError).code).toBe("invalid_contact");
    expect(reg.calls.filter((c) => c.startsWith("register"))).toEqual([]);
  });
  it("결제 중복 수신은 한 번만 반영, 다른 결제로 덮어쓰기 불가", async () => {
    const { db, reg } = setup();
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "a.com", contact, nowMs: NOW });
    expect(await markPaid(db, q.orderId, "pi_1", NOW)).toBe("paid");
    expect(await markPaid(db, q.orderId, "pi_1", NOW)).toBe("duplicate");
    await expect(markPaid(db, q.orderId, "pi_2", NOW)).rejects.toThrow(/이미 처리/);
  });
  it("등록 클레임은 원자적: 동시에 두 번 실행해도 register 는 정확히 1회(환불 불가 비용 보호)", async () => {
    const { db, reg } = setup();
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "race.com", contact, nowMs: NOW });
    await markPaid(db, q.orderId, "pi_1", NOW);
    await Promise.all([runRegistration(db, reg, crypt, q.orderId, NOW), runRegistration(db, reg, crypt, q.orderId, NOW), runRegistration(db, reg, crypt, q.orderId, NOW)]);
    expect(reg.calls.filter((c) => c === "register:race.com")).toHaveLength(1);
  });
  it("결제 직후 도메인이 사라졌거나 원가가 급등하면 등록하지 않고 환불 작업 생성", async () => {
    const a = setup();
    const q1 = await createQuote(a.db, a.reg, crypt, { customerId: "u1", hostname: "gone.com", contact, nowMs: NOW });
    await markPaid(a.db, q1.orderId, "pi_1", NOW);
    a.reg.cfg.unavailable = ["gone.com"];
    expect(await runRegistration(a.db, a.reg, crypt, q1.orderId, NOW)).toBe("refund_due");
    expect(a.reg.calls.some((c) => c.startsWith("register:"))).toBe(false);
    expect(jobs(a.raw)).toEqual([{ kind: "refund_domain_order", k: `refund:${q1.orderId}` }]);
    const b = setup();
    const q2 = await createQuote(b.db, b.reg, crypt, { customerId: "u1", hostname: "pricey.com", contact, nowMs: NOW });
    await markPaid(b.db, q2.orderId, "pi_1", NOW);
    b.reg.cfg.priceBump = "1.00";
    expect(await runRegistration(b.db, b.reg, crypt, q2.orderId, NOW)).toBe("refund_due");
    expect(b.raw.prepare("select failure_reason r from domain_orders").get()).toMatchObject({ r: "price_changed" });
    expect(await markRefunded(b.db, q2.orderId, NOW)).toBe(true);
    expect(await markRefunded(b.db, q2.orderId, NOW)).toBe(false);
  });
  it("모호한 오류(타임아웃)는 재시도·환불하지 않고 운영자 검토로", async () => {
    const { db, raw, reg } = setup();
    reg.cfg.registerBehavior = "throw";
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "amb.com", contact, nowMs: NOW });
    await markPaid(db, q.orderId, "pi_1", NOW);
    expect(await runRegistration(db, reg, crypt, q.orderId, NOW)).toBe("needs_review");
    expect(reg.calls.filter((c) => c.startsWith("register:"))).toHaveLength(1);
    expect(jobs(raw)).toEqual([]); // 자동 환불 없음
  });
  it("타임아웃이었지만 상태 조회로 성공이 확인되면 registered", async () => {
    const { db, reg } = setup();
    const orig = reg.register.bind(reg);
    reg.register = async (d: string) => { await orig(d); throw new Error("timeout after success"); }; // 서버에선 성공했지만 응답을 못 받음
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "ok.com", contact, nowMs: NOW });
    await markPaid(db, q.orderId, "pi_1", NOW);
    expect(await runRegistration(db, reg, crypt, q.orderId, NOW)).toBe("registered");
  });
  it("진행 중(in_progress)은 폴링으로 완료, action_required 는 검토, registrar failed 는 환불", async () => {
    const a = setup(); a.reg.cfg.registerBehavior = "in_progress";
    const q = await createQuote(a.db, a.reg, crypt, { customerId: "u1", hostname: "slow.com", contact, nowMs: NOW });
    await markPaid(a.db, q.orderId, "pi_1", NOW);
    expect(await runRegistration(a.db, a.reg, crypt, q.orderId, NOW)).toBe("registering");
    expect(await pollRegistration(a.db, a.reg, q.orderId, NOW)).toBe("registering");
    a.reg.registered.set("slow.com", "2027-10-18T00:00:00Z");
    expect(await pollRegistration(a.db, a.reg, q.orderId, NOW)).toBe("registered");
    const b = setup(); b.reg.cfg.registerBehavior = "action_required";
    const q2 = await createQuote(b.db, b.reg, crypt, { customerId: "u1", hostname: "verify.com", contact, nowMs: NOW });
    await markPaid(b.db, q2.orderId, "pi_1", NOW);
    expect(await runRegistration(b.db, b.reg, crypt, q2.orderId, NOW)).toBe("needs_review");
    const c = setup(); c.reg.cfg.registerBehavior = "fail";
    const q3 = await createQuote(c.db, c.reg, crypt, { customerId: "u1", hostname: "bad.com", contact, nowMs: NOW });
    await markPaid(c.db, q3.orderId, "pi_1", NOW);
    expect(await runRegistration(c.db, c.reg, crypt, q3.orderId, NOW)).toBe("refund_due");
    expect(jobs(c.raw)).toHaveLength(1);
  });
  it("같은 도메인을 두 고객이 동시에 결제하면 한 명만 등록 대상, 나머지는 환불", async () => {
    const { db, raw, reg } = setup();
    const q1 = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "dup.com", contact, nowMs: NOW });
    const q2 = await createQuote(db, reg, crypt, { customerId: "u2", hostname: "dup.com", contact, nowMs: NOW });
    expect(await markPaid(db, q1.orderId, "pi_1", NOW)).toBe("paid");
    expect(await markPaid(db, q2.orderId, "pi_2", NOW)).toBe("refund_due");
    expect(st(raw, q2.orderId)).toBe("refund_due");
    expect(jobs(raw).filter((j) => j.k === `refund:${q2.orderId}`)).toHaveLength(1);
    await expect(createQuote(db, reg, crypt, { customerId: "u2", hostname: "dup.com", contact, nowMs: NOW })).rejects.toThrow();
  });
  it("견적 만료 처리 후에도 결제가 도착하면 가격 변동 검사를 거쳐 처리", async () => {
    const { db, raw, reg } = setup();
    const q = await createQuote(db, reg, crypt, { customerId: "u1", hostname: "late.com", contact, nowMs: NOW });
    expect(await expireQuotes(db, NOW + 16 * 60_000)).toBe(1);
    expect(st(raw, q.orderId)).toBe("quote_expired");
    expect(await markPaid(db, q.orderId, "pi_1", NOW + 20 * 60_000)).toBe("paid");
    expect(await runRegistration(db, reg, crypt, q.orderId, NOW + 21 * 60_000)).toBe("registered");
  });
});

describe("영역 연결·DNS·설정", () => {
  it("연결: 네임서버 안내 반환, 감사 로그 기록, 중복·서브도메인 거부", async () => {
    const { db, raw, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "Example.com", NOW);
    expect(r.nameServers).toHaveLength(2);
    expect(r.instructions).toContain("네임서버");
    expect(raw.prepare("select status from dns_zones").get()).toMatchObject({ status: "pending_nameservers" });
    expect(raw.prepare("select action from audit_logs where action='domain.connect'").all()).toHaveLength(1);
    await expect(connectDomain(db, zones, "u2", "example.com", NOW)).rejects.toMatchObject({ code: "already_connected" });
    await expect(connectDomain(db, zones, "u1", "www.example.com", NOW)).rejects.toMatchObject({ code: "not_apex" });
    await expect(connectDomain(db, zones, "u1", "not a domain", NOW)).rejects.toMatchObject({ code: "invalid_hostname" });
  });
  it("보안: 운영 계정에 이미 있는 영역(운영자 본인 도메인 등)은 고객이 가져갈 수 없음", async () => {
    const { db, raw, zones } = setup();
    zones.preexisting("info100.kr");
    await expect(connectDomain(db, zones, "u1", "info100.kr", NOW)).rejects.toMatchObject({ code: "domain_in_platform_account" });
    expect(raw.prepare("select count(*) c from dns_zones").get()).toMatchObject({ c: 0 });
  });
  it("DB 저장 실패 시 방금 만든 영역을 정리(고아 영역 방지)", async () => {
    const { db, zones } = setup();
    await connectDomain(db, zones, "u1", "first.com", NOW);
    const orig = zones.createZone.bind(zones);
    zones.createZone = async (name: string) => { const z = await orig(name); return { ...z, id: [...zones.zones.values()][0]!.id }; }; // cf_zone_id 중복 → UNIQUE 위반
    const before = zones.zones.size;
    await expect(connectDomain(db, zones, "u1", "second.com", NOW)).rejects.toThrow();
    expect(zones.zones.size).toBeLessThan(before + 1);
  });
  it("활성화 확인: 대기 → 활성, 7일 초과 미활성은 영역 삭제(한도 낭비 방지), 확인 간격은 점점 늘어남", async () => {
    const { db, raw, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "wait.com", NOW);
    let z = await getOwnedZone(db, "u1", r.zoneId);
    expect(await checkActivation(db, zones, z, NOW + 60_000)).toBe("pending");
    expect(nextActivationDelayMin(0)).toBe(5);
    expect(nextActivationDelayMin(3)).toBeGreaterThan(nextActivationDelayMin(1));
    expect(nextActivationDelayMin(100)).toBe(1440);
    zones.zones.get(z.cf_zone_id)!.status = "active";
    expect(await checkActivation(db, zones, z, NOW + 120_000)).toBe("active");
    const r2 = await connectDomain(db, zones, "u1", "stale.com", NOW);
    const z2 = await getOwnedZone(db, "u1", r2.zoneId);
    expect(await checkActivation(db, zones, z2, NOW + 8 * 86_400_000)).toBe("expired");
    expect(raw.prepare("select status from dns_zones where hostname='stale.com'").get()).toMatchObject({ status: "deleted" });
    expect([...zones.zones.values()].some((x) => x.name === "stale.com")).toBe(false);
    z = await getOwnedZone(db, "u1", r.zoneId);
  });
  it("고객 간 격리: 다른 고객의 영역은 존재 여부도 알 수 없음", async () => {
    const { db, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "mine.com", NOW);
    await expect(getOwnedZone(db, "u2", r.zoneId)).rejects.toMatchObject({ code: "not_found" });
    await expect(addRecord(db, zones, "u2", r.zoneId, { type: "A", name: "@", content: "1.2.3.4" }, NOW)).rejects.toMatchObject({ code: "not_found" });
  });
  it("DNS 레코드 추가·삭제: 검증·충돌·미러 동기화·감사", async () => {
    const { db, raw, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "dns.com", NOW);
    const a = await addRecord(db, zones, "u1", r.zoneId, { type: "A", name: "www", content: "203.0.113.9", proxied: true }, NOW);
    expect(a.record.name).toBe("www.dns.com");
    expect(raw.prepare("select count(*) c from dns_records").get()).toMatchObject({ c: 1 });
    await expect(addRecord(db, zones, "u1", r.zoneId, { type: "CNAME", name: "www", content: "x.example.net" }, NOW)).rejects.toMatchObject({ code: "conflict" });
    await expect(addRecord(db, zones, "u1", r.zoneId, { type: "A", name: "api", content: "10.0.0.1", proxied: true }, NOW)).rejects.toMatchObject({ code: "invalid_record" });
    await expect(addRecord(db, zones, "u1", r.zoneId, { type: "A", name: "x", content: "1.2.3.4" }, NOW, 1)).rejects.toMatchObject({ code: "conflict" }); // 개수 상한
    await deleteRecord(db, zones, "u1", r.zoneId, a.cfRecordId, NOW);
    expect(raw.prepare("select count(*) c from dns_records").get()).toMatchObject({ c: 0 });
    await expect(deleteRecord(db, zones, "u1", r.zoneId, "nope", NOW)).rejects.toMatchObject({ code: "not_found" });
    expect((raw.prepare("select count(*) c from audit_logs where action like 'dns.%'").get() as { c: number }).c).toBe(2);
  });
  it("설정 적용: 비활성 영역 거부, 허용 값만·바뀐 것만 호출, 위험 값 거부, 부분 실패 보고", async () => {
    const { db, raw, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "set.com", NOW);
    await expect(applySettings(db, zones, "u1", r.zoneId, { http3: "on" }, NOW)).rejects.toMatchObject({ code: "zone_not_active" });
    const z = await getOwnedZone(db, "u1", r.zoneId);
    zones.zones.get(z.cf_zone_id)!.status = "active";
    await checkActivation(db, zones, z, NOW);
    const first = await applySettings(db, zones, "u1", r.zoneId, { http3: "on", ssl: "off", min_tls_version: "1.0", brotli: "on" }, NOW);
    expect(first.applied.sort()).toEqual(["brotli", "http3"]);
    expect(first.rejected.map((x) => x.key).sort()).toEqual(["min_tls_version", "ssl"]);
    const again = await applySettings(db, zones, "u1", r.zoneId, { http3: "on", brotli: "on" }, NOW);
    expect(again.applied).toEqual([]);
    expect(again.unchanged.sort()).toEqual(["brotli", "http3"]);
    const orig = zones.setSetting.bind(zones);
    zones.setSetting = async (z2: string, k: string, v: unknown) => { if (k === "early_hints") throw new Error("api down"); return orig(z2, k, v); };
    const mixed = await applySettings(db, zones, "u1", r.zoneId, { early_hints: "on", ipv6: "off" }, NOW);
    expect(mixed.applied).toEqual(["ipv6"]);
    expect(mixed.failed[0]).toMatchObject({ key: "early_hints" });
    expect(raw.prepare("select count(*) c from zone_settings where setting_key='early_hints'").get()).toMatchObject({ c: 0 }); // 실패한 항목은 기록하지 않음
    const dn = await applySettings(db, zones, "u1", r.zoneId, { dnssec: "active" }, NOW);
    expect(dn.applied).toEqual(["dnssec"]);
  });
  it("규칙 교체: 전부 검증 후 적용, 한도 초과 시 아무것도 적용하지 않음", async () => {
    const { db, raw, zones } = setup();
    const r = await connectDomain(db, zones, "u1", "rules.com", NOW);
    const z = await getOwnedZone(db, "u1", r.zoneId);
    zones.zones.get(z.cf_zone_id)!.status = "active"; await checkActivation(db, zones, z, NOW);
    const rule = { expression: '(ip.src eq 203.0.113.1)', action: "block" };
    expect((await replaceRules(db, zones, "u1", r.zoneId, "http_request_firewall_custom", [rule, rule], NOW)).count).toBe(2);
    expect(raw.prepare("select count(*) c from zone_rules").get()).toMatchObject({ c: 2 });
    await expect(replaceRules(db, zones, "u1", r.zoneId, "http_request_firewall_custom", Array(6).fill(rule), NOW)).rejects.toMatchObject({ code: "invalid_rule" });
    expect(raw.prepare("select count(*) c from zone_rules").get()).toMatchObject({ c: 2 }); // 기존 규칙 유지
    await expect(replaceRules(db, zones, "u1", r.zoneId, "http_request_firewall_custom", [{ ...rule, action: "skip" }], NOW)).rejects.toMatchObject({ code: "invalid_rule" });
  });
});

describe("마이그레이션 0004 제약", () => {
  it("결제 이후 주문은 도메인당 1개, 시작 단계 주문은 중복 허용", () => {
    const { raw } = setup();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u9','c@x.co','h')");
    const ins = (id: string, status: string) => () => raw.exec(`INSERT INTO domain_orders(id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at) VALUES('${id}','u1','Same.com','${status}',1,1,1,1,'x')`);
    expect(ins("o1", "awaiting_payment")).not.toThrow();
    expect(ins("o2", "awaiting_payment")).not.toThrow();
    expect(ins("o3", "registered")).not.toThrow();
    expect(ins("o4", "paid")).toThrow();
    expect(ins("o5", "refunded")).not.toThrow();
  });
  it("DNS 레코드 제약(프록시 유형·TTL), 영역 삭제 시 레코드 연쇄 삭제", () => {
    const { raw } = setup();
    raw.exec("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin) VALUES('z','u1','a.com','cf1','connected')");
    const rec = (id: string, type: string, ttl: number, proxied: number) => () => raw.exec(`INSERT INTO dns_records(id,zone_id,cf_record_id,type,name,content,ttl,proxied) VALUES('${id}','z','c${id}','${type}','a.com','x',${ttl},${proxied})`);
    expect(rec("1", "A", 1, 1)).not.toThrow();
    expect(rec("2", "TXT", 1, 1)).toThrow();
    expect(rec("3", "A", 30, 0)).toThrow();
    expect(rec("4", "A", 100000, 0)).toThrow();
    raw.exec("DELETE FROM dns_zones WHERE id='z'");
    expect(raw.prepare("select count(*) c from dns_records").get()).toMatchObject({ c: 0 });
  });
});
