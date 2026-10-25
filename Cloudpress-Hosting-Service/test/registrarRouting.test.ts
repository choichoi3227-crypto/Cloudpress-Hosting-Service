import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { makeDb } from "./helpers/d1";
import { encryptSecret, decryptSecret, b64urlEncode } from "../src/lib/crypto";
import { MockRegistrar, type RegistrantContact } from "../src/lib/registrar";
import { MockZones } from "../src/lib/zones";
import { routeDomain, GabiaRegistrar, MockGabiaClient, ProviderNotConfigured, type PortMap } from "../src/lib/registrarRouter";
import { createQuoteRouted, markPaid, runRegistration, adoptRegisteredZone, delegateNameservers, type Crypto } from "../src/lib/domainOrders";
import { connectDomain } from "../src/lib/zoneService";
import { costSideRate } from "../src/lib/fx";

const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const crypt: Crypto = { encrypt: (p, a) => encryptSecret(p, KEY, a), decrypt: (t, a) => decryptSecret(t, KEY, a) };
const NOW = Date.UTC(2026, 9, 19);
const contact: RegistrantContact = { email: "owner@example.com", phone: "+82.1012345678", postal_info: { name: "홍길동", address: { street: "테헤란로 1", city: "서울", state: "서울", postal_code: "06000", country_code: "KR" } } };
const rate = { smoothedRateMicro: 1_400_000_000, costRateMicro: costSideRate(1_400_000_000) };

function world(over: { cf?: MockRegistrar; gabia?: MockGabiaClient } = {}) {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  const cf = over.cf ?? new MockRegistrar({ costs: { com: ["10.44", "10.44"] } });
  const gc = over.gabia ?? new MockGabiaClient();
  const gabia = new GabiaRegistrar(gc);
  const ports: PortMap = { cloudflare: cf, gabia };
  const portFor = (p: string) => (p === "gabia" ? gabia : cf);
  return { db, raw, cf, gc, gabia, ports, portFor, zones: new MockZones() };
}

describe("등록기관 라우팅", () => {
  it(".kr 계열은 Cloudflare 가 지원하지 않아 가비아로(원화 공급가)", async () => {
    const w = world(); w.cf.cfg.unavailable = ["shop.kr", "shop.co.kr"];
    for (const h of ["shop.kr", "shop.co.kr"]) { const r = await routeDomain(w.ports, h, rate); expect(r.best.provider).toBe("gabia"); expect(r.all).toHaveLength(1); }
  });
  it(".com 은 환산 원가(등록+가중 갱신)가 낮은 쪽, 환율이 바뀌면 선택이 바뀔 수 있음", async () => {
    const w = world();
    // Cloudflare 10.44 USD ≈ 14.8천원(버퍼 포함) vs 가비아 15,500/21,000 → 갱신 가중 포함 시 Cloudflare 유리
    expect((await routeDomain(w.ports, "a.com", rate)).best.provider).toBe("cloudflare");
    const weak = { smoothedRateMicro: 1_900_000_000, costRateMicro: costSideRate(1_900_000_000) }; // 원화 급락
    expect((await routeDomain(w.ports, "a.com", weak)).best.provider).toBe("gabia");
  });
  it("한 곳이 장애여도 다른 곳으로 진행, 모두 실패하면 오류, 미설정 가비아는 명확한 오류", async () => {
    const w = world();
    const down = { check: async () => { throw new Error("cloudflare 503"); } } as never;
    const r = await routeDomain({ cloudflare: down, gabia: w.gabia }, "a.com", rate);
    expect(r.best.provider).toBe("gabia"); expect(r.failures[0]!.provider).toBe("cloudflare");
    await expect(routeDomain({ cloudflare: down }, "a.com", rate)).rejects.toThrow(/provider_unavailable/);
    await expect(new GabiaRegistrar(null).check(["a.kr"])).rejects.toBeInstanceOf(ProviderNotConfigured);
  });
});

describe("원화 견적·가비아 등록·네임서버 위임", () => {
  it("KRW 견적: 환율·통화·등록기관이 주문에 고정되고 100원 단위", async () => {
    const w = world();
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "mine.com", contact, nowMs: NOW, currency: "KRW", rate });
    expect(q.currency).toBe("KRW"); expect(q.chargeAmount % 100).toBe(0); expect(q.chargeAmount).toBeGreaterThan(14_000);
    const row = w.raw.prepare("select registrar_provider p, charge_currency c, fx_rate_micro f, charge_amount a from domain_orders").get() as Record<string, number | string>;
    expect(row).toMatchObject({ p: "cloudflare", c: "KRW", f: 1_400_000_000, a: q.chargeAmount });
  });
  it("USD 견적은 센트 단위 금액", async () => {
    const w = world();
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "usd.com", contact, nowMs: NOW, currency: "USD", rate });
    expect(q.currency).toBe("USD"); expect(q.chargeAmount).toBeGreaterThan(1044); expect(Number.isInteger(q.chargeAmount)).toBe(true);
  });
  it("시장 상한가로 마진을 못 맞추는 원가는 견적 거부(판매 중지)", async () => {
    const w = world(); w.cf.cfg.costs = { com: ["150.00", "150.00"] }; w.gc.cfg.prices = { com: [250_000, 250_000] };
    await expect(createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "huge.com", contact, nowMs: NOW, currency: "KRW", rate })).rejects.toMatchObject({ code: "unsellable" });
  });
  it(".kr 구매 전체 흐름: 가비아 등록 → Cloudflare 영역 생성 → 가비아 NS 를 Cloudflare NS 로 위임", async () => {
    const w = world(); w.cf.cfg.unavailable = ["myshop.co.kr"];
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "myshop.co.kr", contact, nowMs: NOW, currency: "KRW", rate });
    expect(q.provider).toBe("gabia");
    await markPaid(w.db, q.orderId, "pi_1", NOW);
    expect(await runRegistration(w.db, w.portFor, crypt, q.orderId, NOW)).toBe("registered");
    expect(w.gc.calls.filter((c) => c.startsWith("register:"))).toEqual(["register:myshop.co.kr"]);
    expect(w.cf.calls.some((c) => c.startsWith("register:"))).toBe(false);
    const z = await adoptRegisteredZone(w.db, w.zones, q.orderId, NOW);
    expect(z.created).toBe(true);
    const d = await delegateNameservers(w.db, w.gabia, q.orderId, NOW);
    expect(w.gc.nameservers.get("myshop.co.kr")).toEqual(d.nameServers);
    expect(d.nameServers[0]).toContain("cloudflare.com");
    expect(w.raw.prepare("select ns_delegated_at t from domain_orders").get()).toMatchObject({ t: expect.any(String) });
  });
  it("위임 실패는 시간 표시 없이 오류를 알리고 재시도 가능(멱등)", async () => {
    const w = world(); w.cf.cfg.unavailable = ["retry.kr"]; w.gc.cfg.failNs = true;
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "retry.kr", contact, nowMs: NOW, currency: "KRW", rate });
    await markPaid(w.db, q.orderId, "pi_1", NOW); await runRegistration(w.db, w.portFor, crypt, q.orderId, NOW); await adoptRegisteredZone(w.db, w.zones, q.orderId, NOW);
    await expect(delegateNameservers(w.db, w.gabia, q.orderId, NOW)).rejects.toThrow();
    expect(w.raw.prepare("select ns_delegated_at t from domain_orders").get()).toMatchObject({ t: null });
    w.gc.cfg.failNs = false;
    expect((await delegateNameservers(w.db, w.gabia, q.orderId, NOW)).delegated).toBe(true);
  });
  it("가비아 등록 응답이 모호(타임아웃)하면 상태 조회 후 불분명하면 검토 — 재등록 호출 없음", async () => {
    const w = world(); w.cf.cfg.unavailable = ["amb.kr"]; w.gc.cfg.registerBehavior = "throw";
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "amb.kr", contact, nowMs: NOW, currency: "KRW", rate });
    await markPaid(w.db, q.orderId, "pi_1", NOW);
    expect(await runRegistration(w.db, w.portFor, crypt, q.orderId, NOW)).toBe("needs_review");
    expect(w.gc.calls.filter((c) => c.startsWith("register:"))).toHaveLength(1);
  });
  it("원화 원가가 크게 오르면(환율이 아닌 공급가 변동) 등록하지 않고 환불", async () => {
    const w = world(); w.cf.cfg.unavailable = ["up.kr"];
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "up.kr", contact, nowMs: NOW, currency: "KRW", rate });
    await markPaid(w.db, q.orderId, "pi_1", NOW);
    w.gc.cfg.prices = { kr: [30_000, 30_000] };
    expect(await runRegistration(w.db, w.portFor, crypt, q.orderId, NOW)).toBe("refund_due");
    expect(w.gc.calls.some((c) => c.startsWith("register:"))).toBe(false);
  });
  it("보안: 구매 전에 다른 고객이 선점 연결해 둔 영역은 제거하고 실제 구매자에게 영역 부여", async () => {
    const w = world();
    const squat = await connectDomain(w.db, w.zones, "u2", "victim.com", NOW); // u2 가 아직 등록되지 않은 도메인을 먼저 '연결'
    const q = await createQuoteRouted(w.db, w.ports, crypt, { customerId: "u1", hostname: "victim.com", contact, nowMs: NOW, currency: "USD", rate });
    await markPaid(w.db, q.orderId, "pi_1", NOW); await runRegistration(w.db, w.portFor, crypt, q.orderId, NOW);
    const z = await adoptRegisteredZone(w.db, w.zones, q.orderId, NOW);
    expect(z.created).toBe(true);
    expect(w.raw.prepare("select customer_id c, status s from dns_zones where id=?").get(squat.zoneId)).toMatchObject({ s: "deleted" });
    expect(w.raw.prepare("select customer_id c from dns_zones where hostname='victim.com' and status<>'deleted'").get()).toMatchObject({ c: "u1" });
    expect(w.raw.prepare("select count(*) c from audit_logs where action='domain.squatter_zone_removed'").get()).toMatchObject({ c: 1 });
  });
  it("삭제된 영역이 있어도 같은 도메인을 다시 연결할 수 있음(만료 후 재연결)", async () => {
    const w = world();
    const a = await connectDomain(w.db, w.zones, "u1", "again.com", NOW);
    w.raw.exec(`UPDATE dns_zones SET status='deleted' WHERE id='${a.zoneId}'`);
    w.zones.zones.clear();
    const b = await connectDomain(w.db, w.zones, "u1", "again.com", NOW + 1000);
    expect(b.zoneId).not.toBe(a.zoneId);
    await expect(connectDomain(w.db, w.zones, "u2", "again.com", NOW + 2000)).rejects.toMatchObject({ code: "already_connected" });
  });
  it("마이그레이션 0005 제약: 등록기관·통화 CHECK, 환율 이력", () => {
    const { raw } = world();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u9','z@x.co','h')");
    const ins = (prov: string, cur: string) => () => raw.exec(`INSERT INTO domain_orders(id,customer_id,hostname,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrar_provider,charge_currency) VALUES('${prov}${cur}','u9','${prov}${cur}.com',1,1,1,1,'x','${prov}','${cur}')`);
    expect(ins("gabia", "KRW")).not.toThrow(); expect(ins("namecheap", "USD")).toThrow(); expect(ins("cloudflare", "EUR")).toThrow();
    expect(() => raw.exec("INSERT INTO fx_rates(pair,rate_micro,source,fetched_at,status) VALUES('USD/KRW',0,'x','t','accepted')")).toThrow();
    expect(() => raw.exec("INSERT INTO fx_rates(pair,rate_micro,source,fetched_at,status) VALUES('USD/JPY',1,'x','t','accepted')")).toThrow();
    expect(() => raw.exec("INSERT INTO fx_rates(pair,rate_micro,source,fetched_at,status) VALUES('USD/KRW',1400000000,'bok','t','accepted')")).not.toThrow();
  });
});
