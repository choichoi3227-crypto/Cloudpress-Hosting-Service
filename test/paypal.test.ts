import { describe, it, expect } from "vitest";
import { makeDb, seedSubscription } from "./helpers/d1";
import { PayPalHttp, PayPalError, MockPayPal, centsToValue, valueToCents } from "../src/lib/paypal.client";
import { ensurePayPalPlan, createSubscriptionCheckout, createDomainCheckout, createPortal, expireIncompleteSubscriptions, finalizeCanceledSubscriptions } from "../src/lib/checkout";
import { handlePayPalWebhook, applyDomainCapture } from "../src/lib/webhooks";

const NOW = Date.UTC(2026, 9, 25);
const VALID = { authAlgo: "SHA256withRSA", certUrl: "https://api.paypal.com/c", transmissionId: "t", transmissionSig: MockPayPal.VALID_SIG, transmissionTime: "x" };
const ctx = { appOrigin: "https://app.test", nowMs: NOW };
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];
const one = (raw: any, sql: string) => raw.prepare(sql).get() as any;

function world() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('ccs-basic','ccs','CCS Basic')");
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('price_v1','ccs-basic',1,12990000)");
  return { db, raw, paypal: new MockPayPal() };
}
let n = 0;
const ev = (event_type: string, resource: Record<string, unknown>, id = `WH-${++n}`) => JSON.stringify({ id, event_type, resource });
const send = (db: any, body: string, sig = MockPayPal.VALID_SIG, pp = new MockPayPal()) => handlePayPalWebhook(db, pp, body, { ...VALID, transmissionSig: sig }, "WH-ID", NOW);
const sale = (id = "SALE1", sub = "I-1", total = "12.99") => ev("PAYMENT.SALE.COMPLETED", { id, state: "completed", billing_agreement_id: sub, amount: { total, currency: "USD" } });

describe("PayPal 클라이언트", () => {
  it("금액 변환은 정수 센트로만(부동소수점 없음)", () => {
    expect(centsToValue(1299)).toBe("12.99"); expect(centsToValue(5)).toBe("0.05"); expect(centsToValue(700)).toBe("7.00");
    expect(valueToCents("12.99")).toBe(1299); expect(valueToCents("7")).toBe(700); expect(valueToCents("0.5")).toBe(50);
    expect(() => valueToCents("abc")).toThrow(); expect(() => centsToValue(1.5)).toThrow();
  });
  it("PayPalHttp: 토큰 발급·요청 형식·멱등 키·오류 분류", async () => {
    const calls: any[] = [];
    const responses: { status: number; body: any }[] = [
      { status: 200, body: { access_token: "AT", expires_in: 3600 } },
      { status: 201, body: { id: "PROD1" } }, { status: 201, body: { id: "P-PLAN1" } },
      { status: 402, body: { name: "UNPROCESSABLE_ENTITY", message: "no" } },
      { status: 503, body: { message: "down" } },
    ];
    const f = async (url: string, init: any) => { calls.push({ url, ...init }); const r = responses.shift()!; return { status: r.status, json: async () => r.body }; };
    const pp = new PayPalHttp({ clientId: "cid", clientSecret: "sec", env: "sandbox", fetch: f, now: () => NOW });
    const plan = await pp.createMonthlyPlan({ name: "CCS Basic", currency: "USD", amountMinor: 1299, customId: "price_v1" }, "price_v1:USD");
    expect(plan).toEqual({ planId: "P-PLAN1" });
    expect(calls[0].url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa("cid:sec")}`);
    expect(calls[1].url).toBe("https://api-m.sandbox.paypal.com/v1/catalogs/products");
    expect(calls[1].headers).toMatchObject({ Authorization: "Bearer AT", "PayPal-Request-Id": "product:price_v1:USD" });
    const planBody = JSON.parse(calls[2].body);
    expect(planBody.billing_cycles[0]).toMatchObject({ frequency: { interval_unit: "MONTH", interval_count: 1 }, total_cycles: 0, pricing_scheme: { fixed_price: { value: "12.99", currency_code: "USD" } } });
    const e1 = (await pp.cancelSubscription("I-1", "x").catch((e) => e)) as PayPalError;
    expect(e1).toMatchObject({ status: 402 }); expect(e1.retryable).toBe(false);
    expect(((await pp.cancelSubscription("I-1", "x").catch((e) => e)) as PayPalError).retryable).toBe(true);
    expect(() => new PayPalHttp({ clientId: "", clientSecret: "" , env: "live" })).toThrow();
  });
  it("KRW 는 거부한다(PayPal 은 KRW 미지원)", async () => {
    await expect(new MockPayPal().createMonthlyPlan({ name: "x", currency: "KRW", amountMinor: 100, customId: "c" }, "i")).rejects.toMatchObject({ status: 400 });
  });
  it("verifyWebhook: 인증서 URL 이 paypal.com 이 아니면 API 호출 없이 거부", async () => {
    let called = false;
    const pp = new PayPalHttp({ clientId: "a", clientSecret: "b", env: "sandbox", fetch: async () => { called = true; return { status: 200, json: async () => ({ access_token: "t", expires_in: 1, verification_status: "SUCCESS" }) }; } });
    expect(await pp.verifyWebhook({ headers: { ...VALID, certUrl: "https://evil.example/cert" }, webhookId: "W", rawBody: "{}" })).toBe(false);
    expect(called).toBe(false);
  });
});

describe("체크아웃", () => {
  it("구독: incomplete 생성, custom_id=우리 구독 ID, 플랜은 가격 버전당 1개만 만든다", async () => {
    const { db, raw, paypal } = world();
    const a = await createSubscriptionCheckout(db, paypal, "u1", "ccs-basic", "USD", ctx);
    const b = await createSubscriptionCheckout(db, paypal, "u1", "ccs-basic", "USD", ctx);
    expect(a.url).toContain("paypal.test");
    expect(paypal.calls.filter((c) => c.op === "plan")).toHaveLength(1);
    const sub = paypal.calls.filter((c) => c.op === "subscription")[0]!.args as any;
    expect(sub.customId).toBe(a.subscriptionId);
    expect(sub.email).toBe("a@x.co");
    expect(q(raw, "select status from subscriptions")).toEqual([{ status: "incomplete" }, { status: "incomplete" }]);
    expect(a.subscriptionId).not.toBe(b.subscriptionId);
  });
  it("KRW·판매중지·없는 상품은 거부", async () => {
    const { db, raw, paypal } = world();
    await expect(createSubscriptionCheckout(db, paypal, "u1", "ccs-basic", "KRW", ctx)).rejects.toMatchObject({ code: "currency_unsupported" });
    raw.exec("UPDATE products SET on_sale = 0");
    await expect(createSubscriptionCheckout(db, paypal, "u1", "ccs-basic", "USD", ctx)).rejects.toMatchObject({ code: "not_for_sale" });
    await expect(createSubscriptionCheckout(db, paypal, "u1", "ghost", "USD", ctx)).rejects.toMatchObject({ code: "not_for_sale" });
  });
  it("가격 버전이 바뀌어도 기존 구독의 플랜(가격)은 그대로", async () => {
    const { db, raw, paypal } = world();
    const first = await createSubscriptionCheckout(db, paypal, "u1", "ccs-basic", "USD", ctx);
    raw.exec("UPDATE prices SET retired_at='2026-10-01T00:00:00Z' WHERE id='price_v1'");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('p2','ccs-basic',2,15990000)");
    const second = await createSubscriptionCheckout(db, paypal, "u2", "ccs-basic", "USD", ctx);
    const rows = q(raw, "select id, price_version_id, paypal_plan_id from subscriptions order by created_at");
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[first.subscriptionId].price_version_id).toBe("price_v1");
    expect(byId[second.subscriptionId].price_version_id).toBe("p2");
    expect(byId[first.subscriptionId].paypal_plan_id).not.toBe(byId[second.subscriptionId].paypal_plan_id);
  });
  it("플랜 금액은 센트 단위여야 한다", async () => {
    const { db, raw, paypal } = world();
    raw.exec("UPDATE prices SET monthly_micro = 12995001 WHERE id='price_v1'");
    await expect(ensurePayPalPlan(db, paypal, "price_v1", "USD", NOW)).rejects.toMatchObject({ code: "bad_price" });
  });
  it("고객 포털 대신 PayPal 자동결제 관리 URL", async () => {
    const { db, paypal } = world();
    expect((await createPortal(db, paypal, "u1", "https://app.test", "sandbox")).url).toContain("sandbox.paypal.com");
    expect((await createPortal(db, paypal, "u1", "https://app.test", "live")).url).toBe("https://www.paypal.com/myaccount/autopay/");
  });
  it("승인 안 된 incomplete 는 24시간 뒤 정리, 활성 구독은 유지", async () => {
    const { db, raw } = world();
    seedSubscription(raw, { subId: "s_old" }); seedSubscription(raw, { subId: "s_act", paypalSub: "I-9" });
    raw.exec(`UPDATE subscriptions SET created_at='${new Date(NOW - 25 * 3_600_000).toISOString()}'`);
    raw.exec("UPDATE subscriptions SET status='active' WHERE id='s_act'");
    expect(await expireIncompleteSubscriptions(db, NOW)).toBe(1);
    expect(one(raw, "select status from subscriptions where id='s_act'").status).toBe("active");
  });
  it("취소 예약 구독은 이용 기간이 끝나면 canceled + suspend 작업 1건", async () => {
    const { db, raw } = world(); seedSubscription(raw);
    raw.exec(`UPDATE subscriptions SET status='canceling', current_period_end='${new Date(NOW - 1000).toISOString()}'`);
    expect(await finalizeCanceledSubscriptions(db, NOW)).toBe(1);
    expect(await finalizeCanceledSubscriptions(db, NOW)).toBe(0);
    expect(one(raw, "select status from subscriptions").status).toBe("canceled");
    expect(q(raw, "select kind from deployment_jobs")).toEqual([{ kind: "suspend" }]);
  });
  it("도메인 주문: 견적 만료·상태·금액 검증 후 PayPal 주문 생성", async () => {
    const { db, raw, paypal } = world();
    const ins = (id: string, status: string, exp: string) => raw.prepare("INSERT INTO domain_orders(id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,charge_currency,charge_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, "u1", `${id}.com`, status, 1, 1, 15_000_000, 15_000_000, exp, "USD", 1500);
    const future = new Date(NOW + 600_000).toISOString();
    ins("o1", "awaiting_payment", future); ins("o2", "awaiting_payment", new Date(NOW - 1000).toISOString()); ins("o3", "paid", future);
    expect((await createDomainCheckout(db, paypal, "u1", "o1", ctx)).url).toContain("paypal.test");
    expect((paypal.calls.find((c) => c.op === "order")!.args as any)).toMatchObject({ amountMinor: 1500, currency: "USD", customId: "o1" });
    expect(one(raw, "select paypal_order_id from domain_orders where id='o1'").paypal_order_id).toMatch(/^ORD-MOCK/);
    await expect(createDomainCheckout(db, paypal, "u1", "o2", ctx)).rejects.toMatchObject({ code: "quote_expired" });
    await expect(createDomainCheckout(db, paypal, "u1", "o3", ctx)).rejects.toMatchObject({ code: "bad_state" });
    await expect(createDomainCheckout(db, paypal, "u2", "o1", ctx)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("PayPal 웹훅", () => {
  it("서명 불일치는 400, 아무것도 저장하지 않는다", async () => {
    const { db, raw } = world();
    expect((await send(db, sale(), "bad")).status).toBe(400);
    expect(q(raw, "select * from webhook_events")).toHaveLength(0);
  });
  it("정상 흐름: ACTIVATED 연결 → SALE.COMPLETED → 활성화 + 프로비저닝 작업 1건 + 결제/인보이스 기록", async () => {
    const { db, raw } = world(); seedSubscription(raw);
    expect((await send(db, ev("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-1", custom_id: "sub_1" }))).status).toBe(200);
    expect(one(raw, "select status from subscriptions").status).toBe("incomplete"); // 승인만으로 서비스를 열지 않는다
    expect((await send(db, sale())).status).toBe(200);
    expect(one(raw, "select status, current_period_end from subscriptions")).toMatchObject({ status: "active" });
    expect(q(raw, "select kind from deployment_jobs")).toEqual([{ kind: "provision" }]);
    expect(one(raw, "select amount_micro, provider, amount_minor from payments")).toMatchObject({ amount_micro: 12_990_000, provider: "paypal", amount_minor: 1299 });
    expect(q(raw, "select paypal_sale_id from invoices")).toEqual([{ paypal_sale_id: "SALE1" }]);
  });
  it("같은 이벤트 재전송은 duplicate, 같은 결제 다른 이벤트도 중복 기록 없음", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    const body = sale();
    expect((await send(db, body)).body).toBe("ok");
    expect((await send(db, body)).body).toBe("duplicate");
    await send(db, sale("SALE1")); // 새 이벤트 ID 지만 같은 sale
    expect(q(raw, "select * from payments")).toHaveLength(1);
    expect(q(raw, "select * from deployment_jobs")).toHaveLength(1);
  });
  it("PayPal 구독 ID 연결 전에 결제가 먼저 오면 custom 값으로 찾고, 못 찾으면 500(재시도 유도)", async () => {
    const { db, raw } = world(); seedSubscription(raw);
    const r = await send(db, ev("PAYMENT.SALE.COMPLETED", { id: "S9", state: "completed", billing_agreement_id: "I-unknown", custom: "sub_1", amount: { total: "12.99", currency: "USD" } }));
    expect(r.status).toBe(200);
    expect(one(raw, "select status from subscriptions").status).toBe("active");
    const r2 = await send(db, ev("PAYMENT.SALE.COMPLETED", { id: "S10", state: "completed", billing_agreement_id: "I-ghost", amount: { total: "1.00", currency: "USD" } }));
    expect(r2.status).toBe(500);
    expect(one(raw, "select status from webhook_events where type='PAYMENT.SALE.COMPLETED' order by received_at desc, rowid desc limit 1").status).toBe("failed");
  });
  it("USD 가 아니거나 미완료 결제는 반영하지 않는다", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    expect((await send(db, ev("PAYMENT.SALE.COMPLETED", { id: "S1", state: "pending", billing_agreement_id: "I-1", amount: { total: "12.99", currency: "USD" } }))).body).toBe("ignored");
    expect((await send(db, ev("PAYMENT.SALE.COMPLETED", { id: "S2", state: "completed", billing_agreement_id: "I-1", amount: { total: "12.99", currency: "EUR" } }))).status).toBe(500);
    expect(q(raw, "select * from payments")).toHaveLength(0);
  });
  it("결제 실패 → past_due + 알림, 다음 결제 성공 → active + resume 작업", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    await send(db, sale("S1"));
    await send(db, ev("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: "I-1" }));
    expect(one(raw, "select status from subscriptions").status).toBe("past_due");
    expect(q(raw, "select * from notifications")).toHaveLength(1);
    await send(db, sale("S2"));
    expect(one(raw, "select status from subscriptions").status).toBe("active");
    expect(q(raw, "select kind from deployment_jobs order by rowid")).toEqual([{ kind: "provision" }, { kind: "resume" }]);
  });
  it("PayPal 에서 취소: 이용 기간이 남았으면 canceling(기간 종료까지 유지), 없으면 canceled + suspend", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    await send(db, sale("S1"));
    expect((await send(db, ev("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-1" }))).status).toBe(200);
    expect(one(raw, "select status, cancel_at_period_end c from subscriptions")).toMatchObject({ status: "canceling", c: 1 });
    expect(q(raw, "select kind from deployment_jobs")).toEqual([{ kind: "provision" }]); // 아직 중지하지 않는다
    const w2 = world(); seedSubscription(w2.raw, { paypalSub: "I-1" });
    w2.raw.exec("UPDATE subscriptions SET status='active', current_period_end='2020-01-01T00:00:00Z'");
    await send(w2.db, ev("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-1" }));
    expect(one(w2.raw, "select status from subscriptions").status).toBe("canceled");
    expect(q(w2.raw, "select kind from deployment_jobs")).toEqual([{ kind: "suspend" }]);
  });
  it("PayPal 이 구독을 정지하면 suspended + suspend 작업", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    await send(db, sale("S1"));
    await send(db, ev("BILLING.SUBSCRIPTION.SUSPENDED", { id: "I-1" }));
    expect(one(raw, "select status from subscriptions").status).toBe("suspended");
  });
  it("부분 환불은 payments=partially_refunded, 전액 환불은 refunded + 구독 refunded + suspend", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    await send(db, sale("S1"));
    await send(db, ev("PAYMENT.SALE.REFUNDED", { id: "R1", sale_id: "S1", amount: { total: "5.00", currency: "USD" } }));
    expect(one(raw, "select status from payments").status).toBe("partially_refunded");
    expect(one(raw, "select status from subscriptions").status).toBe("active");
    await send(db, ev("PAYMENT.SALE.REFUNDED", { id: "R2", sale_id: "S1", amount: { total: "7.99", currency: "USD" } }));
    expect(one(raw, "select status from payments").status).toBe("refunded");
    expect(one(raw, "select status from subscriptions").status).toBe("refunded");
    expect(q(raw, "select kind from deployment_jobs order by rowid")).toEqual([{ kind: "provision" }, { kind: "suspend" }]);
    await send(db, ev("PAYMENT.SALE.REFUNDED", { id: "R2", sale_id: "S1", amount: { total: "7.99", currency: "USD" } }, "WH-again"));
    expect(q(raw, "select * from refunds")).toHaveLength(2); // 같은 환불 ID 는 한 번만
  });
  it("분쟁/역전 → 결제 disputed + 구독 suspended + 운영자 알림", async () => {
    const { db, raw } = world(); seedSubscription(raw, { paypalSub: "I-1" });
    await send(db, sale("S1"));
    await send(db, ev("CUSTOMER.DISPUTE.CREATED", { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", disputed_transactions: [{ seller_transaction_id: "S1" }] }));
    expect(one(raw, "select status from payments").status).toBe("disputed");
    expect(one(raw, "select status from subscriptions").status).toBe("suspended");
    expect(q(raw, "select kind from refunds")).toEqual([{ kind: "chargeback" }]);
    expect(q(raw, "select severity from notifications where audience='operator'")).toEqual([{ severity: "critical" }]);
  });
  it("알 수 없는 이벤트는 ignored 로 200", async () => {
    const { db } = world();
    const r = await send(db, ev("CATALOG.PRODUCT.CREATED", {}));
    expect(r).toEqual({ status: 200, body: "ignored" });
  });
  it("PayPal 서명 검증 API 장애는 500(재시도)이고 이벤트를 처리하지 않는다", async () => {
    const { db, raw } = world();
    const pp = new MockPayPal(); pp.failNext = new PayPalError(503, undefined, "down");
    expect((await send(db, sale(), MockPayPal.VALID_SIG, pp)).status).toBe(500);
    expect(q(raw, "select * from webhook_events")).toHaveLength(0);
  });
});

describe("도메인 일회성 결제", () => {
  function orderWorld() {
    const w = world();
    w.raw.prepare("INSERT INTO domain_orders(id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,charge_currency,charge_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("o1", "u1", "a.com", "awaiting_payment", 1, 1, 15_000_000, 15_000_000, new Date(NOW + 600_000).toISOString(), "USD", 1500);
    return w;
  }
  const cap = (id = "CAP1", value = "15.00", custom = "o1") => ev("PAYMENT.CAPTURE.COMPLETED", { id, status: "COMPLETED", custom_id: custom, amount: { value, currency_code: "USD" } });
  it("캡처 완료 → 주문 paid + 결제 기록 + 등록 작업 1건, 재전송·리턴 처리와 겹쳐도 1건", async () => {
    const { db, raw } = orderWorld();
    expect((await send(db, cap())).status).toBe(200);
    expect(one(raw, "select status, stripe_payment_intent_id ref from domain_orders").status).toBe("paid");
    expect(q(raw, "select kind from deployment_jobs")).toEqual([{ kind: "register_domain" }]);
    await applyDomainCapture(db, "o1", "CAP1", "USD", 1500, NOW); // 리턴 URL 경로와 중복
    expect(q(raw, "select * from payments")).toHaveLength(1);
    expect(q(raw, "select * from deployment_jobs")).toHaveLength(1);
  });
  it("금액이 주문과 다르면 거부(500, 주문은 paid 가 되지 않음)", async () => {
    const { db, raw } = orderWorld();
    expect((await send(db, cap("CAP2", "1.00"))).status).toBe(500);
    expect(one(raw, "select status from domain_orders").status).toBe("awaiting_payment");
  });
  it("도메인 주문이 아닌 캡처는 무시", async () => {
    const { db } = orderWorld();
    expect((await send(db, cap("CAP3", "15.00", "nope"))).body).toBe("ignored");
  });
});
