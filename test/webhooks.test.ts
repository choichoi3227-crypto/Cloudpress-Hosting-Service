import { describe, it, expect } from "vitest";
import { makeDb, seedSubscription } from "./helpers/d1";
import { handleStripeWebhook } from "../src/lib/webhooks";
import { signStripePayload } from "../src/lib/stripe";
import { dispatchOutbox } from "../src/lib/outbox";

const SECRET = "whsec_t";
const NOW = Date.UTC(2026, 9, 17);
let n = 0;
const ev = (type: string, object: Record<string, unknown>, id = `evt_${++n}`) => JSON.stringify({ id, type, created: 1, data: { object } });
async function send(db: ReturnType<typeof makeDb>["db"], body: string) {
  return handleStripeWebhook(db, body, await signStripePayload(body, SECRET, NOW), SECRET, NOW);
}
const checkout = (ourSub = "sub_1", stripeSub = "sub_stripe_1") => ev("checkout.session.completed", { mode: "subscription", subscription: stripeSub, customer: "cus_1", payment_status: "paid", metadata: { cloudpress_subscription_id: ourSub } });
const paid = (id = "in_1", stripeSub = "sub_stripe_1") => ev("invoice.paid", { id, subscription: stripeSub, amount_paid: 1299, payment_intent: `pi_${id}`, charge: `ch_${id}`, lines: { data: [{ period: { start: 1_700_000_000, end: 1_702_592_000 } }] } });
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];

describe("Stripe 웹훅 처리", () => {
  it("서명 불일치는 400이며 DB에 기록하지 않음", async () => {
    const { db, raw } = makeDb();
    const r = await handleStripeWebhook(db, "{}", "t=1,v1=bad", SECRET, NOW);
    expect(r.status).toBe(400);
    expect(q(raw, "select * from webhook_events")).toHaveLength(0);
  });
  it("결제 성공 흐름: 연결 → invoice.paid → 활성 + 프로비저닝 작업 1개", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    expect((await send(db, checkout())).status).toBe(200);
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "incomplete" }); // 리디렉션/체크아웃 완료만으로는 활성화하지 않음
    expect((await send(db, paid())).status).toBe(200);
    expect(raw.prepare("select status, current_period_end from subscriptions").get()).toMatchObject({ status: "active" });
    expect(q(raw, "select kind from deployment_jobs")).toEqual([{ kind: "provision" }]);
    expect(raw.prepare("select amount_micro from payments").get()).toMatchObject({ amount_micro: 12_990_000 });
  });
  it("같은 이벤트 재전송은 중복 처리되지 않음", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout());
    const body = paid();
    expect((await send(db, body)).body).toBe("ok");
    expect((await send(db, body)).body).toBe("duplicate");
    expect(q(raw, "select * from payments")).toHaveLength(1);
    expect(q(raw, "select * from deployment_jobs")).toHaveLength(1);
  });
  it("다른 이벤트 ID라도 같은 인보이스면 자원을 중복 생성하지 않음", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout());
    await send(db, paid("in_1"));
    await send(db, paid("in_2")); // 갱신 인보이스
    expect(q(raw, "select * from deployment_jobs")).toHaveLength(1);
    expect(q(raw, "select * from payments")).toHaveLength(2);
  });
  it("순서가 뒤바뀐 invoice.paid(연결 전)는 500 후 재시도로 해소", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    const body = paid();
    expect((await send(db, body)).status).toBe(500);
    expect(raw.prepare("select status, attempts from webhook_events").get()).toMatchObject({ status: "failed", attempts: 1 });
    await send(db, checkout());
    expect((await send(db, body)).status).toBe(200);
    expect(raw.prepare("select status from webhook_events where type='invoice.paid'").get()).toMatchObject({ status: "processed" });
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "active" });
  });
  it("다른 구독에 이미 연결된 Stripe 구독 ID 로의 재연결은 거부", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw, { stripeSub: "sub_other" });
    expect((await send(db, checkout("sub_1", "sub_stripe_1"))).status).toBe(500);
  });
  it("결제 실패 → past_due, 다음 결제 성공 → active + resume 작업", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid("in_1"));
    await send(db, ev("invoice.payment_failed", { subscription: "sub_stripe_1" }));
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "past_due" });
    await send(db, paid("in_2"));
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "active" });
    expect(q(raw, "select kind from deployment_jobs order by kind")).toEqual([{ kind: "provision" }, { kind: "resume" }]);
  });
  it("구독 삭제 → canceled + suspend 작업(자원 즉시 삭제 안 함)", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    await send(db, ev("customer.subscription.deleted", { id: "sub_stripe_1" }));
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "canceled" });
    expect(q(raw, "select kind from deployment_jobs order by kind").map((r) => r.kind)).toEqual(["provision", "suspend"]);
  });
  it("기간 말 취소 예약 ↔ 해제", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    await send(db, ev("customer.subscription.updated", { id: "sub_stripe_1", status: "active", cancel_at_period_end: true }));
    expect(raw.prepare("select status, cancel_at_period_end from subscriptions").get()).toMatchObject({ status: "canceling", cancel_at_period_end: 1 });
    await send(db, ev("customer.subscription.updated", { id: "sub_stripe_1", status: "active", cancel_at_period_end: false }));
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "active" });
  });
  it("부분 환불은 구독 유지, 전액 환불은 refunded + suspend", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    await send(db, ev("charge.refunded", { id: "ch_in_1", payment_intent: "pi_in_1", amount_refunded: 500, refunds: { data: [{ id: "re_1", amount: 500 }] } }));
    expect(raw.prepare("select status from payments").get()).toMatchObject({ status: "partially_refunded" });
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "active" });
    await send(db, ev("charge.refunded", { id: "ch_in_1", payment_intent: "pi_in_1", amount_refunded: 1299, refunds: { data: [{ id: "re_1", amount: 500 }, { id: "re_2", amount: 799 }] } }));
    expect(raw.prepare("select status from payments").get()).toMatchObject({ status: "refunded" });
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "refunded" });
    expect(q(raw, "select * from refunds")).toHaveLength(2); // re_1 중복 삽입 없음
  });
  it("분쟁(차지백) → 결제 disputed, 구독 suspended, 운영자 알림", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    await send(db, ev("charge.dispute.created", { id: "dp_1", charge: "ch_in_1", amount: 1299, reason: "fraudulent" }));
    expect(raw.prepare("select status from payments").get()).toMatchObject({ status: "disputed" });
    expect(raw.prepare("select status from subscriptions").get()).toMatchObject({ status: "suspended" });
    expect(raw.prepare("select kind from refunds").get()).toMatchObject({ kind: "chargeback" });
    expect(q(raw, "select * from notifications where audience='operator'")).toHaveLength(1);
  });
  it("알 수 없는 이벤트는 ignored 로 기록하고 200", async () => {
    const { db, raw } = makeDb();
    expect((await send(db, ev("customer.created", {}))).body).toBe("ignored");
    expect(raw.prepare("select status from webhook_events").get()).toMatchObject({ status: "ignored" });
  });
});

describe("아웃박스", () => {
  it("대기 작업을 큐로 1회만 전달", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    const sent: unknown[] = [];
    const queue = { send: async (m: unknown) => { sent.push(m); } };
    expect(await dispatchOutbox(db, queue, NOW)).toBe(1);
    expect(await dispatchOutbox(db, queue, NOW)).toBe(0);
    expect(sent).toHaveLength(1);
  });
  it("큐 전송 실패 시 다음 실행에서 재시도", async () => {
    const { db, raw } = makeDb(); seedSubscription(raw);
    await send(db, checkout()); await send(db, paid());
    expect(await dispatchOutbox(db, { send: async () => { throw new Error("down"); } }, NOW)).toBe(0);
    expect(await dispatchOutbox(db, { send: async () => {} }, NOW)).toBe(1);
  });
});
