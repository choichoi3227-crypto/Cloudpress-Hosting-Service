import { type D1Like, newId, nowIso } from "./db";
import { verifyStripeSignature, type StripeEvent } from "./stripe";
import { assertTransition, SUBSCRIPTION_TRANSITIONS, type SubscriptionState } from "./states";

const CENT_TO_MICRO = 10_000;
type Sub = { id: string; customer_id: string; status: SubscriptionState; stripe_subscription_id: string | null };

export interface WebhookResponse { status: number; body: string }

/**
 * Stripe 웹훅 진입점.
 * - 서명 검증 실패 → 400 (처리하지 않음)
 * - 같은 이벤트 ID 가 이미 처리됨 → 200 (중복 무시)
 * - 처리 중 오류 → 500 (Stripe 가 재시도, 순서가 뒤바뀐 이벤트도 재시도로 해소)
 */
export async function handleStripeWebhook(db: D1Like, rawBody: string, sigHeader: string | null, secret: string, nowMs: number): Promise<WebhookResponse> {
  const v = await verifyStripeSignature(rawBody, sigHeader, secret, nowMs);
  if (!v.ok) return { status: 400, body: `invalid signature: ${v.reason}` };
  const event = v.event;

  const ins = await db.prepare("INSERT OR IGNORE INTO webhook_events(id,type,payload_json,received_at) VALUES(?,?,?,?)").bind(event.id, event.type, rawBody, nowIso(nowMs)).run();
  if (ins.meta.changes === 0) {
    const prev = await db.prepare("SELECT status FROM webhook_events WHERE id = ?").bind(event.id).first<{ status: string }>();
    if (prev?.status === "processed" || prev?.status === "ignored") return { status: 200, body: "duplicate" };
  }

  try {
    const handled = await dispatch(db, event, nowMs);
    await db.prepare("UPDATE webhook_events SET status = ?, processed_at = ?, last_error = NULL WHERE id = ?").bind(handled ? "processed" : "ignored", nowIso(nowMs), event.id).run();
    return { status: 200, body: handled ? "ok" : "ignored" };
  } catch (e) {
    await db.prepare("UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").bind(String(e instanceof Error ? e.message : e).slice(0, 500), event.id).run();
    return { status: 500, body: "processing failed" };
  }
}

async function dispatch(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  switch (ev.type) {
    case "checkout.session.completed": return onCheckoutCompleted(db, ev, nowMs);
    case "invoice.paid": return onInvoicePaid(db, ev, nowMs);
    case "invoice.payment_failed": return onPaymentFailed(db, ev, nowMs);
    case "customer.subscription.updated": return onSubscriptionUpdated(db, ev, nowMs);
    case "customer.subscription.deleted": return onSubscriptionDeleted(db, ev, nowMs);
    case "charge.refunded": return onChargeRefunded(db, ev, nowMs);
    case "charge.dispute.created": return onDisputeCreated(db, ev, nowMs);
    default: return false;
  }
}

const findSubByStripe = (db: D1Like, id: string | null | undefined) =>
  id ? db.prepare("SELECT id,customer_id,status,stripe_subscription_id FROM subscriptions WHERE stripe_subscription_id = ?").bind(id).first<Sub>() : Promise.resolve(null);

function jobStmt(db: D1Like, kind: string, subId: string, idemKey: string, nowMs: number) {
  return db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(newId("job"), kind, subId, idemKey, nowIso(nowMs), nowIso(nowMs));
}

/** 결제 확정은 하지 않는다. 우리 구독 행과 Stripe 구독 ID 만 연결한다(활성화는 invoice.paid 에서). */
async function onCheckoutCompleted(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const s = ev.data.object;
  const ourId: string | undefined = s.metadata?.cloudpress_subscription_id;
  if (s.mode !== "subscription" || !ourId || !s.subscription) return false;
  const r = await db.prepare("UPDATE subscriptions SET stripe_subscription_id = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), updated_at = ? WHERE id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)")
    .bind(s.subscription, s.customer ?? null, nowIso(nowMs), ourId, s.subscription).run();
  if (r.meta.changes === 0) throw new Error(`cannot link checkout to subscription ${ourId}`);
  return true;
}

async function onInvoicePaid(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const inv = ev.data.object;
  const sub = await findSubByStripe(db, inv.subscription);
  if (!sub) throw new Error(`subscription not linked yet: ${inv.subscription}`); // 순서 역전 → 재시도
  const amountMicro = Number(inv.amount_paid ?? 0) * CENT_TO_MICRO;
  const period = inv.lines?.data?.[0]?.period;
  const invoiceId = `inv_${inv.id}`;
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO invoices(id,subscription_id,customer_id,stripe_invoice_id,status,subtotal_micro,total_micro,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(invoiceId, sub.id, sub.customer_id, inv.id, "paid", amountMicro, amountMicro, period ? nowIso(period.start * 1000) : null, period ? nowIso(period.end * 1000) : null, nowIso(nowMs)),
    db.prepare("INSERT OR IGNORE INTO payments(id,invoice_id,customer_id,stripe_payment_intent_id,stripe_charge_id,amount_micro,status,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(`pay_${inv.id}`, invoiceId, sub.customer_id, inv.payment_intent ?? null, inv.charge ?? null, amountMicro, "succeeded", nowIso(nowMs), nowIso(nowMs)),
  ];
  if (sub.status !== "active" && sub.status !== "canceling") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "active");
    stmts.push(db.prepare("UPDATE subscriptions SET status='active', current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?")
      .bind(period ? nowIso(period.start * 1000) : null, period ? nowIso(period.end * 1000) : null, invoiceId, nowIso(nowMs), sub.id));
    // 최초 활성화만 프로비저닝. 같은 구독의 중복 생성은 UNIQUE 멱등 키가 막는다.
    stmts.push(jobStmt(db, sub.status === "incomplete" ? "provision" : "resume", sub.id, sub.status === "incomplete" ? `provision:${sub.id}` : `resume:${sub.id}:${inv.id}`, nowMs));
  } else {
    stmts.push(db.prepare("UPDATE subscriptions SET current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?")
      .bind(period ? nowIso(period.start * 1000) : null, period ? nowIso(period.end * 1000) : null, invoiceId, nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  return true;
}

async function onPaymentFailed(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const sub = await findSubByStripe(db, ev.data.object.subscription);
  if (!sub) throw new Error("subscription not linked yet");
  const stmts = [db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)")
    .bind(newId("ntf"), sub.customer_id, "warning", "결제 실패", "결제에 실패했습니다. 결제 수단을 확인해 주세요.", nowIso(nowMs))];
  if (sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "past_due");
    stmts.push(db.prepare("UPDATE subscriptions SET status='past_due', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  return true;
}

const STRIPE_STATUS_MAP: Record<string, SubscriptionState | undefined> = { active: "active", past_due: "past_due", unpaid: "suspended", canceled: "canceled" };

async function onSubscriptionUpdated(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const o = ev.data.object;
  const sub = await findSubByStripe(db, o.id);
  if (!sub) throw new Error("subscription not linked yet");
  let next: SubscriptionState = sub.status;
  const mapped = STRIPE_STATUS_MAP[o.status];
  if (mapped && mapped !== sub.status && sub.status !== "incomplete") { // 활성화는 invoice.paid 가 담당
    try { assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, mapped); next = mapped; } catch { /* 허용되지 않는 전이는 무시 */ }
  }
  if (o.cancel_at_period_end && next === "active") next = "canceling";
  if (!o.cancel_at_period_end && next === "canceling") next = "active";
  await db.prepare("UPDATE subscriptions SET status=?, cancel_at_period_end=?, current_period_start=COALESCE(?,current_period_start), current_period_end=COALESCE(?,current_period_end), updated_at=? WHERE id=?")
    .bind(next, o.cancel_at_period_end ? 1 : 0, o.current_period_start ? nowIso(o.current_period_start * 1000) : null, o.current_period_end ? nowIso(o.current_period_end * 1000) : null, nowIso(nowMs), sub.id).run();
  return true;
}

async function onSubscriptionDeleted(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const sub = await findSubByStripe(db, ev.data.object.id);
  if (!sub) throw new Error("subscription not linked yet");
  if (sub.status === "canceled" || sub.status === "refunded") return true;
  assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "canceled");
  // 자원 삭제는 즉시 하지 않는다: 'suspend' 작업만 만들고, 데이터는 유예 기간 후 별도 2단계 확인으로 삭제한다.
  await db.batch([
    db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id),
    jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:canceled`, nowMs),
  ]);
  return true;
}

type Pay = { id: string; customer_id: string; amount_micro: number; invoice_id: string | null };
const findPayment = (db: D1Like, charge: string | null | undefined, pi: string | null | undefined) =>
  db.prepare("SELECT id,customer_id,amount_micro,invoice_id FROM payments WHERE (stripe_charge_id IS NOT NULL AND stripe_charge_id = ?) OR (stripe_payment_intent_id IS NOT NULL AND stripe_payment_intent_id = ?)")
    .bind(charge ?? null, pi ?? null).first<Pay>();

async function subOfPayment(db: D1Like, p: Pay) {
  return p.invoice_id ? db.prepare("SELECT s.id,s.customer_id,s.status,s.stripe_subscription_id FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id WHERE i.id = ?").bind(p.invoice_id).first<Sub>() : null;
}

async function onChargeRefunded(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const c = ev.data.object;
  const pay = await findPayment(db, c.id, c.payment_intent);
  if (!pay) throw new Error(`payment not found for charge ${c.id}`);
  const totalRefundedMicro = Number(c.amount_refunded ?? 0) * CENT_TO_MICRO;
  const full = totalRefundedMicro >= pay.amount_micro;
  const stmts = [];
  const list: Array<{ id: string; amount: number; reason?: string }> = c.refunds?.data ?? [];
  if (list.length > 0) {
    for (const r of list) stmts.push(db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,stripe_refund_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,?,'refund',?)")
      .bind(`ref_${r.id}`, pay.id, r.id, r.amount * CENT_TO_MICRO, r.reason ?? null, nowIso(nowMs)));
  } else if (totalRefundedMicro > 0) {
    // 최신 API 는 refunds 목록을 기본 포함하지 않는다. 누적액 기준 합성 행을 남기고 대조 작업(reconcile)이 실제 환불 ID 로 보정한다.
    stmts.push(db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,amount_micro,kind,created_at) VALUES(?,?,?,'refund',?)").bind(`ref_total_${c.id}_${c.amount_refunded}`, pay.id, totalRefundedMicro, nowIso(nowMs)));
  }
  stmts.push(db.prepare("UPDATE payments SET status=? WHERE id=?").bind(full ? "refunded" : "partially_refunded", pay.id));
  const sub = await subOfPayment(db, pay);
  if (full && sub && sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "refunded");
    stmts.push(db.prepare("UPDATE subscriptions SET status='refunded', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:refunded`, nowMs));
  }
  await db.batch(stmts);
  return true;
}

async function onDisputeCreated(db: D1Like, ev: StripeEvent, nowMs: number): Promise<boolean> {
  const d = ev.data.object;
  const pay = await findPayment(db, d.charge, d.payment_intent);
  if (!pay) throw new Error(`payment not found for dispute ${d.id}`);
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,'chargeback',?)").bind(`cb_${d.id}`, pay.id, Number(d.amount ?? 0) * CENT_TO_MICRO, d.reason ?? null, nowIso(nowMs)),
    db.prepare("UPDATE payments SET status='disputed' WHERE id=?").bind(pay.id),
    db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", "결제 분쟁 발생", `dispute ${d.id}`, nowIso(nowMs)),
  ];
  const sub = await subOfPayment(db, pay);
  if (sub && (sub.status === "active" || sub.status === "past_due")) {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "suspended");
    stmts.push(db.prepare("UPDATE subscriptions SET status='suspended', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:dispute:${d.id}`, nowMs));
  }
  await db.batch(stmts);
  return true;
}
