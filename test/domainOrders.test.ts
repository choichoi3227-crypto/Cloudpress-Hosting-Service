import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { MockRegistrar } from "../src/lib/registrar";
import { encryptSecret, decryptSecret, b64urlEncode } from "../src/lib/crypto";
import { createQuote, markPaid, runRegistration, expireQuotes } from "../src/lib/domainOrders";

const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const crypt = { encrypt: (p: string, a: string) => encryptSecret(p, KEY, a), decrypt: (t: string, a: string) => decryptSecret(t, KEY, a) };
const NOW = Date.UTC(2026, 9, 25);
const contact = { email: "o@x.co", phone: "+82.1012345678", postal_info: { name: "홍", address: { street: "s", city: "c", state: "s", postal_code: "1", country_code: "KR" } } };

function world(cfg: ConstructorParameters<typeof MockRegistrar>[0] = {}) {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h')");
  return { db, raw, cf: new MockRegistrar(cfg) };
}

describe("도메인 견적(USD, Cloudflare Registrar)", () => {
  it("견적은 원가 + 마진을 정수 센트로 저장하고 결제 통화는 USD", async () => {
    const w = world({ costs: { com: ["10.44", "10.44"] } });
    const q = await createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "Shop.COM", contact, nowMs: NOW });
    expect(q).toMatchObject({ hostname: "shop.com", currency: "USD" });
    expect(Number.isInteger(q.chargeAmount)).toBe(true);
    expect(q.chargeAmount * 10_000).toBe(q.priceMicro);
    expect(q.chargeAmount).toBeGreaterThan(1044); // 원가보다 비싸다
    expect(w.raw.prepare("select registrar_provider p, charge_currency c, charge_amount a from domain_orders").get()).toMatchObject({ p: "cloudflare", c: "USD", a: q.chargeAmount });
  });
  it("등록 불가·잘못된 호스트·중복 주문은 거부", async () => {
    const w = world({ unavailable: ["taken.com"] });
    await expect(createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "taken.com", contact, nowMs: NOW })).rejects.toMatchObject({ code: "unavailable" });
    await expect(createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "sub.shop.com", contact, nowMs: NOW })).rejects.toMatchObject({ code: "invalid_hostname" });
    const q = await createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "mine.com", contact, nowMs: NOW });
    await markPaid(w.db, q.orderId, "CAP1", NOW);
    await expect(createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "mine.com", contact, nowMs: NOW })).rejects.toMatchObject({ code: "unavailable" });
  });
  it("결제 후 등록 직전 가격이 크게 오르면 등록하지 않고 환불 대상(refund_due)", async () => {
    const w = world({ costs: { com: ["10.44", "10.44"] } });
    const q = await createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "drift.com", contact, nowMs: NOW });
    await markPaid(w.db, q.orderId, "CAP2", NOW);
    w.cf.cfg.costs = { com: ["40.00", "40.00"] };
    expect(await runRegistration(w.db, w.cf, crypt, q.orderId, NOW)).toBe("refund_due");
    expect(w.cf.calls.some((c) => c.startsWith("register:"))).toBe(false);
  });
  it("같은 결제 참조를 두 번 처리해도 한 번만 paid, 등록은 한 번만", async () => {
    const w = world();
    const q = await createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "once.com", contact, nowMs: NOW });
    expect(await markPaid(w.db, q.orderId, "CAP3", NOW)).toBe("paid");
    expect(await markPaid(w.db, q.orderId, "CAP3", NOW)).toBe("duplicate");
    expect(await runRegistration(w.db, w.cf, crypt, q.orderId, NOW)).toBe("registered");
    expect(await runRegistration(w.db, w.cf, crypt, q.orderId, NOW)).toBe("registered");
    expect(w.cf.calls.filter((c) => c.startsWith("register:"))).toHaveLength(1);
  });
  it("만료된 견적은 정리된다", async () => {
    const w = world();
    await createQuote(w.db, w.cf, crypt, { customerId: "u1", hostname: "old.com", contact, nowMs: NOW });
    expect(await expireQuotes(w.db, NOW + 24 * 3_600_000)).toBe(1);
  });
});
