import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { usd } from "../src/lib/money";
import { encodeForm, StripeHttp, StripeError, MockStripe } from "../src/lib/stripe.client";
import { ensureStripeCustomer, ensureStripePrice, createSubscriptionCheckout, createDomainCheckout, createPortal, expireIncompleteSubscriptions } from "../src/lib/checkout";
import { handleStripeWebhook } from "../src/lib/webhooks";
import { signStripePayload } from "../src/lib/stripe";
import { recordFxSample, loadFxState } from "../src/lib/fxStore";
import { MockRegistrar } from "../src/lib/registrar";
import { MockGabiaClient, GabiaRegistrar } from "../src/lib/registrarRouter";
import { createQuoteRouted } from "../src/lib/domainOrders";
import { costSideRate } from "../src/lib/fx";
import { encryptSecret, decryptSecret, b64urlEncode } from "../src/lib/crypto";

const NOW = Date.UTC(2026, 9, 19), SECRET = "whsec_t";
const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const crypt = { encrypt: (p: string, a: string) => encryptSecret(p, KEY, a), decrypt: (t: string, a: string) => decryptSecret(t, KEY, a) };
const FX = 1_400_000_000;
const ctx = { appOrigin: "https://app.test", nowMs: NOW, fxRateMicro: FX as number | null };

function world() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('ccs-basic','ccs','CCS Basic')");
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('p1','ccs-basic',1,12990000)");
  return { db, raw, stripe: new MockStripe() };
}
let n = 0;
const ev = (type: string, object: Record<string, unknown>) => JSON.stringify({ id: `evt_${++n}`, type, created: 1, data: { object } });
const send = async (db: any, body: string) => handleStripeWebhook(db, body, await signStripePayload(body, SECRET, NOW), SECRET, NOW);
const row = (raw: any, sql: string) => raw.prepare(sql).get() as any;

describe("Stripe 요청 형태", () => {
  it("form 인코딩: 중첩 객체·배열·특수문자", () => {
    expect(encodeForm({ a: 1, b: { c: "x y" }, d: [{ e: 1 }, { e: 2 }], f: ["p", "q"], g: undefined, h: null }).join("&"))
      .toBe("a=1&b%5Bc%5D=x%20y&d%5B0%5D%5Be%5D=1&d%5B1%5D%5Be%5D=2&f%5B0%5D=p&f%5B1%5D=q");
  });
  it("StripeHttp: 인증·멱등 키·본문·오류 변환", async () => {
    const calls: any[] = [];
    const responses = [{ status: 200, body: { id: "cs_1", url: "https://c" } }, { status: 402, body: { error: { code: "card_declined", message: "declined" } } }, { status: 503, body: { error: { message: "down" } } }];
    const f = async (url: string, init: any) => { calls.push({ url, ...init }); const r = responses.shift()!; return { status: r.status, json: async () => r.body }; };
    const s = new StripeHttp({ secretKey: "sk_test_x", apiVersion: "2099-01-01", fetch: f });
    const out = await s.createCheckoutSession({ mode: "payment", customer: "cus_1", clientReferenceId: "o1", metadata: { domain_order_id: "o1" }, successUrl: "https://s", cancelUrl: "https://c", inline: { currency: "KRW", amountMinor: 15400, name: "도메인" }, expiresAtSec: 1900000000 }, "idem1");
    expect(out).toEqual({ id: "cs_1", url: "https://c" });
    expect(calls[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer sk_test_x", "Idempotency-Key": "idem1", "Stripe-Version": "2099-01-01", "Content-Type": "application/x-www-form-urlencoded" });
    const body = decodeURIComponent(calls[0].body);
    for (const part of ["mode=payment", "line_items[0][price_data][currency]=krw", "line_items[0][price_data][unit_amount]=15400", "payment_intent_data[metadata][domain_order_id]=o1", "metadata[domain_order_id]=o1", "expires_at=1900000000"]) expect(body).toContain(part);
    const e1 = (await s.createRefund({ paymentIntent: "pi_1" }, "r1").catch((e) => e)) as StripeError;
    expect(e1).toMatchObject({ status: 402, code: "card_declined" }); expect(e1.retryable).toBe(false);
    expect(((await s.createRefund({ paymentIntent: "pi_1" }, "r2").catch((e) => e)) as StripeError).retryable).toBe(true);
    expect(() => new StripeHttp({ secretKey: "pk_live_x" })).toThrow();
    const net = new StripeHttp({ secretKey: "sk_test_x", fetch: async () => { throw new Error("socket"); } });
    expect(((await net.createCustomer({ email: "a@b.c", metadata: {} }, "i").catch((e) => e)) as StripeError).retryable).toBe(true);
  });
});

describe("체크아웃", () => {
  it("고객은 사용자당 1명(멱등), 이미 있으면 재사용", async () => {
    const { db, stripe } = world();
    const [a, b] = await Promise.all([ensureStripeCustomer(db, stripe, "u1"), ensureStripeCustomer(db, stripe, "u1")]);
    expect(a).toBe(b);
    expect(await ensureStripeCustomer(db, stripe, "u1")).toBe(a);
  });
  it("구독 체크아웃(USD): 구독 행 incomplete 생성·가격 버전 고정·메타데이터", async () => {
    const { db, raw, stripe } = world();
    const r = await createSubscriptionCheckout(db, stripe, "u1", "ccs-basic", "USD", ctx);
    expect(r.url).toContain("checkout.stripe.test");
    expect(row(raw, "select status s, price_version_id p, stripe_price_id sp from subscriptions")).toMatchObject({ s: "incomplete", p: "p1" });
    const call = stripe.calls.find((c) => c.op === "checkout")!;
    expect((call.args as any).metadata.cloudpress_subscription_id).toBe(r.subscriptionId);
    expect((stripe.calls.find((c) => c.op === "price")!.args as any).amountMinor).toBe(1299);
  });
  it("KRW 가격은 최초 환율로 100원 올림 확정 후 잠금: 환율이 변해도 기존 가격 유지", async () => {
    const { db, stripe } = world();
    const a = await ensureStripePrice(db, stripe, "p1", "KRW", FX, NOW);
    expect(a.amountMinor).toBe(18200); // 12.99 × 1400 = 18,186 → 100원 올림
    const b = await ensureStripePrice(db, stripe, "p1", "KRW", 1_900_000_000, NOW);
    expect(b).toEqual(a);
    expect(stripe.calls.filter((c) => c.op === "price")).toHaveLength(1);
    await expect(ensureStripePrice(db, stripe, "nope", "USD", null, NOW)).rejects.toMatchObject({ code: "not_found" });
    const w2 = world();
    await expect(ensureStripePrice(w2.db, w2.stripe, "p1", "KRW", null, NOW)).rejects.toMatchObject({ code: "fx_unavailable" });
  });
  it("새 가격 버전을 내면 새 구독만 새 가격, 기존 구독은 이전 가격 버전 유지", async () => {
    const { db, raw, stripe } = world();
    const first = await createSubscriptionCheckout(db, stripe, "u1", "ccs-basic", "USD", ctx);
    raw.exec("UPDATE prices SET retired_at='2026-10-19T00:00:00Z' WHERE id='p1'");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('p2','ccs-basic',2,14990000)");
    const second = await createSubscriptionCheckout(db, stripe, "u2", "ccs-basic", "USD", ctx);
    const v = (id: string) => row(raw, `select price_version_id p from subscriptions where id='${id}'`).p;
    expect(v(first.subscriptionId)).toBe("p1"); expect(v(second.subscriptionId)).toBe("p2");
  });
  it("판매 중지·없는 상품 거부", async () => {
    const { db, raw, stripe } = world();
    raw.exec("UPDATE products SET on_sale=0");
    await expect(createSubscriptionCheckout(db, stripe, "u1", "ccs-basic", "USD", ctx)).rejects.toMatchObject({ code: "not_for_sale" });
    await expect(createSubscriptionCheckout(db, stripe, "u1", "ghost", "USD", ctx)).rejects.toMatchObject({ code: "not_for_sale" });
  });
  it("방치된 incomplete 구독은 24시간 후 정리, 결제 연결된 것은 유지", async () => {
    const { db, raw, stripe } = world();
    await createSubscriptionCheckout(db, stripe, "u1", "ccs-basic", "USD", ctx);
    raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,stripe_subscription_id,created_at) VALUES('linked','u1','ccs-basic','p1','sub_x','2026-10-01T00:00:00Z')");
    expect(await expireIncompleteSubscriptions(db, NOW + 25 * 3_600_000)).toBe(1);
    expect(row(raw, "select status s from subscriptions where id='linked'").s).toBe("incomplete");
  });
  it("포털: 결제 이력 없으면 거부", async () => {
    const { db, stripe } = world();
    await expect(createPortal(db, stripe, "u1", "https://app.test")).rejects.toMatchObject({ code: "no_customer" });
    await ensureStripeCustomer(db, stripe, "u1");
    expect((await createPortal(db, stripe, "u1", "https://app.test")).url).toContain("billing.stripe.test");
  });
});

describe("도메인 결제 → 등록 작업", () => {
  const contact = { email: "o@x.co", phone: "+82.1012345678", postal_info: { name: "홍", address: { street: "s", city: "c", state: "s", postal_code: "1", country_code: "KR" } } };
  async function quoted(cur: "KRW" | "USD" = "KRW") {
    const w = world();
    const ports = { cloudflare: new MockRegistrar(), gabia: new GabiaRegistrar(new MockGabiaClient()) };
    const q = await createQuoteRouted(w.db, ports, crypt, { customerId: "u1", hostname: "shop.com", contact, nowMs: NOW, currency: cur, rate: { smoothedRateMicro: FX, costRateMicro: costSideRate(FX) } });
    return { ...w, q };
  }
  const paidEvent = (q: any, over: Record<string, unknown> = {}) => ev("checkout.session.completed", { mode: "payment", payment_status: "paid", payment_intent: "pi_dom1", currency: q.currency.toLowerCase(), amount_total: q.chargeAmount, metadata: { domain_order_id: q.orderId }, ...over });

  it("체크아웃: 본인 주문·유효 견적만, 금액·통화는 견적 고정값", async () => {
    const { db, stripe, q } = await quoted();
    await createDomainCheckout(db, stripe, "u1", q.orderId, ctx);
    const c = stripe.calls.find((x) => x.op === "checkout")!.args as any;
    expect(c.inline).toMatchObject({ currency: "KRW", amountMinor: q.chargeAmount });
    expect(c.metadata).toEqual({ domain_order_id: q.orderId });
    await expect(createDomainCheckout(db, stripe, "u2", q.orderId, ctx)).rejects.toMatchObject({ code: "not_found" }); // 다른 고객
    await expect(createDomainCheckout(db, stripe, "u1", q.orderId, { ...ctx, nowMs: NOW + 16 * 60_000 })).rejects.toMatchObject({ code: "quote_expired" });
  });
  it("결제 완료 웹훅 → 주문 paid + 결제 기록(KRW) + 등록 작업 1개, 재전송·중복 이벤트에도 1개", async () => {
    const { db, raw, q } = await quoted();
    const body = paidEvent(q);
    expect((await send(db, body)).status).toBe(200);
    expect((await send(db, body)).body).toBe("duplicate");
    expect((await send(db, paidEvent(q))).status).toBe(200); // 다른 이벤트 ID 로 같은 결제가 다시 와도
    expect(row(raw, "select status s, stripe_payment_intent_id p from domain_orders")).toMatchObject({ s: "paid", p: "pi_dom1" });
    expect(row(raw, "select currency c, amount_minor a, fx_rate_micro f from payments")).toMatchObject({ c: "KRW", a: q.chargeAmount, f: FX });
    expect(raw.prepare("select kind, idempotency_key k from deployment_jobs").all()).toEqual([{ kind: "register_domain", k: `register:${q.orderId}` }]);
  });
  it("금액·통화가 견적과 다르거나 미결제 상태면 등록 작업을 만들지 않음", async () => {
    const { db, raw, q } = await quoted();
    expect((await send(db, paidEvent(q, { amount_total: 100 }))).status).toBe(500);
    expect((await send(db, paidEvent(q, { currency: "usd" }))).status).toBe(500);
    expect((await send(db, paidEvent(q, { payment_status: "unpaid" }))).body).toBe("ignored");
    expect(raw.prepare("select count(*) c from deployment_jobs").get()).toMatchObject({ c: 0 });
    expect(row(raw, "select status s from domain_orders").s).toBe("awaiting_payment");
  });
  it("지연 결제 수단 성공 이벤트도 동일하게 처리", async () => {
    const { db, raw, q } = await quoted();
    expect((await send(db, ev("checkout.session.async_payment_succeeded", { mode: "payment", payment_status: "paid", payment_intent: "pi_a", currency: "krw", amount_total: q.chargeAmount, metadata: { domain_order_id: q.orderId } }))).status).toBe(200);
    expect(row(raw, "select status s from domain_orders").s).toBe("paid");
  });
});

describe("KRW 인보이스 금액 정확도", () => {
  async function setup() {
    const w = world();
    w.raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,stripe_subscription_id) VALUES('s1','u1','ccs-basic','p1','sub_k')");
    return w;
  }
  const inv = (cur: string, amt: number, id = "in_k1") => ev("invoice.paid", { id, subscription: "sub_k", currency: cur, amount_paid: amt, payment_intent: `pi_${id}`, charge: `ch_${id}`, lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] } });
  it("KRW 인보이스는 원을 환율로 환산해 USD 기준 금액을 기록(센트로 오해하지 않음)", async () => {
    const { db, raw } = await setup();
    await recordFxSample(db, { rateMicro: FX, fetchedAtMs: NOW, source: "t" }, NOW);
    expect((await send(db, inv("krw", 18200))).status).toBe(200);
    expect(row(raw, "select currency c, amount_minor a, fx_rate_micro f, amount_micro m from payments")).toMatchObject({ c: "KRW", a: 18200, f: FX, m: Math.floor((18200 * 1e12) / FX) });
    expect(row(raw, "select currency c, total_minor t from invoices")).toMatchObject({ c: "KRW", t: 18200 });
  });
  it("환율이 없으면 금액을 추정하지 않고 실패(재시도)", async () => {
    const { db, raw } = await setup();
    expect((await send(db, inv("krw", 18200))).status).toBe(500);
    expect(raw.prepare("select count(*) c from payments").get()).toMatchObject({ c: 0 });
  });
  it("지원하지 않는 통화는 실패로 드러남", async () => {
    const { db } = await setup();
    expect((await send(db, inv("eur", 1000))).status).toBe(500);
  });
  it("KRW 전액·부분 환불 판정은 결제 통화 기준, 환산은 결제 시 환율 고정", async () => {
    const { db, raw } = await setup();
    await recordFxSample(db, { rateMicro: FX, fetchedAtMs: NOW, source: "t" }, NOW);
    await send(db, ev("checkout.session.completed", { mode: "subscription", subscription: "sub_k", customer: "cus_1", metadata: { cloudpress_subscription_id: "s1" } }));
    await send(db, inv("krw", 18200));
    await send(db, ev("charge.refunded", { id: "ch_in_k1", payment_intent: "pi_in_k1", amount_refunded: 5000, refunds: { data: [{ id: "re_1", amount: 5000 }] } }));
    expect(row(raw, "select status s from payments").s).toBe("partially_refunded");
    expect(row(raw, "select amount_micro m from refunds").m).toBe(Math.floor((5000 * 1e12) / FX));
    await recordFxSample(db, { rateMicro: 1_450_000_000, fetchedAtMs: NOW + 1000, source: "t2" }, NOW + 1000); // 이후 환율 변동
    await send(db, ev("charge.refunded", { id: "ch_in_k1", payment_intent: "pi_in_k1", amount_refunded: 18200, refunds: { data: [{ id: "re_1", amount: 5000 }, { id: "re_2", amount: 13200 }] } }));
    expect(row(raw, "select status s from payments").s).toBe("refunded");
    expect(row(raw, "select amount_micro m from refunds where stripe_refund_id='re_2'").m).toBe(Math.floor((13200 * 1e12) / FX));
  });
  it("환율 저장소: 수용·급변 보류가 기록되고 상태가 복원됨", async () => {
    const { db, raw } = world();
    await recordFxSample(db, { rateMicro: FX, fetchedAtMs: NOW, source: "a" }, NOW);
    const q = await recordFxSample(db, { rateMicro: 1_700_000_000, fetchedAtMs: NOW + 1, source: "b" }, NOW + 1);
    expect(q.status).toBe("quarantined");
    const st = await loadFxState(db);
    expect(st.accepted).toHaveLength(1); expect(st.pending?.rateMicro).toBe(1_700_000_000);
    expect(raw.prepare("select status from fx_rates order by id").all()).toEqual([{ status: "accepted" }, { status: "quarantined" }]);
  });
});
