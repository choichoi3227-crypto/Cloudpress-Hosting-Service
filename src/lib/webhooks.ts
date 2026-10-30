import { type D1Like, newId, nowIso } from "./db";
import { assertTransition, SUBSCRIPTION_TRANSITIONS, type SubscriptionState } from "./states";
import { valueToCents, type PayPalPort, type WebhookHeaders } from "./paypal.client";
import { markPaid } from "./domainOrders";
import { enqueueResize } from "./cpuAddons";
import { creditTopup } from "./cas";

type Sub = { id: string; customer_id: string; status: SubscriptionState; paypal_subscription_id: string | null; current_period_end: string | null };

export interface WebhookResponse { status: number; body: string }

export interface PayPalEvent { id: string; event_type: string; create_time?: string; resource: Record<string, any> }

export function paypalWebhookHeaders(h: Headers): WebhookHeaders {
  return {
    authAlgo: h.get("paypal-auth-algo"), certUrl: h.get("paypal-cert-url"), transmissionId: h.get("paypal-transmission-id"),
    transmissionSig: h.get("paypal-transmission-sig"), transmissionTime: h.get("paypal-transmission-time"),
  };
}

const MICRO_PER_CENT = 10_000;
const addMonthUtc = (ms: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };

/**
 * PayPal 웹훅 처리.
 * - 서명 검증은 PayPal verify-webhook-signature API 로 한다(실패/불일치 → 400, 처리하지 않음)
 * - 같은 이벤트 ID 를 이미 처리했으면 200(멱등)
 * - 처리 중 오류 → 500(PayPal 이 재시도한다. 웹훅이 연결보다 먼저 도착하는 경우도 재시도로 해결)
 */
export async function handlePayPalWebhook(db: D1Like, paypal: PayPalPort, rawBody: string, headers: WebhookHeaders, webhookId: string, nowMs: number): Promise<WebhookResponse> {
  let event: PayPalEvent;
  try { event = JSON.parse(rawBody) as PayPalEvent; } catch { return { status: 400, body: "bad_json" }; }
  if (typeof event?.id !== "string" || typeof event?.event_type !== "string" || typeof event.resource !== "object" || event.resource === null) return { status: 400, body: "bad_event" };

  let ok = false;
  try { ok = await paypal.verifyWebhook({ headers, webhookId, rawBody }); }
  catch (e) { return { status: 500, body: "verification_unavailable" }; } // PayPal API 장애 → 재시도 유도
  if (!ok) return { status: 400, body: "invalid signature" };

  const ins = await db.prepare("INSERT OR IGNORE INTO webhook_events(id,type,payload_json,received_at,provider) VALUES(?,?,?,?,'paypal')").bind(event.id, event.event_type, rawBody, nowIso(nowMs)).run();
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

async function dispatch(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  switch (ev.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED": return onSubscriptionActivated(db, ev, nowMs);
    case "PAYMENT.SALE.COMPLETED": return onSaleCompleted(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED": return onPaymentFailed(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.SUSPENDED": return onSubscriptionSuspended(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.CANCELLED": case "BILLING.SUBSCRIPTION.EXPIRED": return onSubscriptionEnded(db, ev, nowMs);
    case "PAYMENT.SALE.REFUNDED": case "PAYMENT.CAPTURE.REFUNDED": return onRefunded(db, ev, nowMs);
    case "PAYMENT.SALE.REVERSED": case "PAYMENT.CAPTURE.REVERSED": return onReversed(db, ev, nowMs);
    case "CUSTOMER.DISPUTE.CREATED": return onDisputeCreated(db, ev, nowMs);
    case "PAYMENT.CAPTURE.COMPLETED": return onCaptureCompleted(db, ev, nowMs);
    default: return false;
  }
}

const SUB_COLS = "id,customer_id,status,paypal_subscription_id,current_period_end";
const findSubByPayPal = (db: D1Like, id: string | null | undefined) =>
  id ? db.prepare(`SELECT ${SUB_COLS} FROM subscriptions WHERE paypal_subscription_id = ?`).bind(id).first<Sub>() : Promise.resolve(null);
const findSubById = (db: D1Like, id: string | null | undefined) =>
  id ? db.prepare(`SELECT ${SUB_COLS} FROM subscriptions WHERE id = ?`).bind(id).first<Sub>() : Promise.resolve(null);

function jobStmt(db: D1Like, kind: string, subId: string, idemKey: string, nowMs: number) {
  return db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(newId("job"), kind, subId, idemKey, nowIso(nowMs), nowIso(nowMs));
}

/** 구독 ID 로 우리 구독을 찾는다. PayPal 구독 ID 가 아직 연결 전이면 custom_id(우리 구독 ID)로 찾는다. */
async function resolveSub(db: D1Like, paypalSubId: string | null | undefined, customId: string | null | undefined): Promise<Sub | null> {
  return (await findSubByPayPal(db, paypalSubId)) ?? (await findSubById(db, customId));
}

/** 구독 승인(ACTIVATED): 우리 구독과 PayPal 구독을 연결한다. 서비스 활성화는 결제 확정(SALE.COMPLETED)에서만 한다. */
async function onSubscriptionActivated(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const r = ev.resource;
  const ourId: string | undefined = r.custom_id;
  if (!ourId || typeof r.id !== "string") return false;
  if (ourId.startsWith("cpu:")) return (await findAddon(db, r.id, ourId)) !== null; // 추가 CPU 는 구매 시점에 PayPal 구독 ID 를 이미 저장한다
  const res = await db.prepare("UPDATE subscriptions SET paypal_subscription_id = ?, updated_at = ? WHERE id = ? AND (paypal_subscription_id IS NULL OR paypal_subscription_id = ?)").bind(r.id, nowIso(nowMs), ourId, r.id).run();
  if (res.meta.changes === 0) throw new Error(`cannot link paypal subscription to ${ourId}`);
  return true;
}

type Addon = { id: string; subscription_id: string; container_id: string; purchase_status: string; monthly_micro: number };
/** PayPal 구독 ID 또는 custom 값("cpu:<id>")으로 추가 CPU 구매를 찾는다. */
async function findAddon(db: D1Like, paypalSubId: string | null | undefined, custom: string | null | undefined): Promise<Addon | null> {
  const cols = "id,subscription_id,container_id,purchase_status,monthly_micro";
  if (paypalSubId) { const a = await db.prepare(`SELECT ${cols} FROM cpu_addons WHERE paypal_subscription_id = ?`).bind(paypalSubId).first<Addon>(); if (a) return a; }
  if (typeof custom === "string" && custom.startsWith("cpu:")) return db.prepare(`SELECT ${cols} FROM cpu_addons WHERE id = ?`).bind(custom.slice(4)).first<Addon>();
  return null;
}

/** 추가 CPU 결제 확정: 구매 상태만 paid 로 바꾸고 적용(증설)은 작업 큐로 넘긴다. 갱신 결제는 기간만 연장한다. */
async function onAddonSale(db: D1Like, addon: Addon, sale: Record<string, any>, nowMs: number): Promise<boolean> {
  const cents = valueToCents(sale.amount?.total);
  const micro = cents * MICRO_PER_CENT;
  const parent = await db.prepare("SELECT customer_id FROM subscriptions WHERE id = ?").bind(addon.subscription_id).first<{ customer_id: string }>();
  if (!parent) throw new Error(`parent subscription missing for addon ${addon.id}`);
  const invoiceId = `inv_${sale.id}`;
  const periodEnd = addMonthUtc(nowMs);
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO invoices(id,subscription_id,customer_id,paypal_sale_id,status,subtotal_micro,total_micro,currency,total_minor,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,'USD',?,?,?,?)")
      .bind(invoiceId, addon.subscription_id, parent.customer_id, sale.id, "paid", micro, micro, cents, nowIso(nowMs), nowIso(periodEnd), nowIso(nowMs)),
    db.prepare("INSERT OR IGNORE INTO payments(id,invoice_id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,?,'paypal',?,?,?,?,'USD',?)")
      .bind(`pay_${sale.id}`, invoiceId, parent.customer_id, sale.id, micro, "succeeded", nowIso(nowMs), nowIso(nowMs), cents),
    db.prepare("UPDATE cpu_addons SET current_period_end=? WHERE id=?").bind(nowIso(periodEnd), addon.id),
  ];
  if (addon.purchase_status === "pending") {
    // 청구 금액이 구매 시 약속한 가격과 다르면 적용하지 않는다(가격 변조·플랜 불일치 방지).
    if (micro !== addon.monthly_micro) throw new Error(`addon price mismatch: ${micro} != ${addon.monthly_micro}`);
    stmts.push(db.prepare("UPDATE cpu_addons SET purchase_status='paid', apply_status='queued' WHERE id=? AND purchase_status='pending'").bind(addon.id));
    stmts.push(enqueueResize(db, addon.subscription_id, addon.container_id, `buy:${addon.id}`, nowMs));
  }
  await db.batch(stmts);
  return true;
}

async function onSaleCompleted(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const sale = ev.resource;
  if (String(sale.state).toLowerCase() !== "completed") return false;
  const addon = await findAddon(db, sale.billing_agreement_id, sale.custom ?? sale.custom_id);
  if (addon) return onAddonSale(db, addon, sale, nowMs);
  const sub = await resolveSub(db, sale.billing_agreement_id, sale.custom ?? sale.custom_id);
  if (!sub) throw new Error(`subscription not linked yet: ${sale.billing_agreement_id}`); // 연결 전 도착 → 재시도
  if (String(sale.amount?.currency).toUpperCase() !== "USD") throw new Error(`unsupported currency: ${sale.amount?.currency}`);
  const cents = valueToCents(sale.amount?.total);
  const micro = cents * MICRO_PER_CENT;
  const periodStart = nowMs;
  const periodEnd = addMonthUtc(nowMs);
  const invoiceId = `inv_${sale.id}`;
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO invoices(id,subscription_id,customer_id,paypal_sale_id,status,subtotal_micro,total_micro,currency,total_minor,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,'USD',?,?,?,?)")
      .bind(invoiceId, sub.id, sub.customer_id, sale.id, "paid", micro, micro, cents, nowIso(periodStart), nowIso(periodEnd), nowIso(nowMs)),
    db.prepare("INSERT OR IGNORE INTO payments(id,invoice_id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,?,'paypal',?,?,?,?,'USD',?)")
      .bind(`pay_${sale.id}`, invoiceId, sub.customer_id, sale.id, micro, "succeeded", nowIso(nowMs), nowIso(nowMs), cents),
  ];
  if (sub.status !== "active" && sub.status !== "canceling") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "active");
    stmts.push(db.prepare("UPDATE subscriptions SET status='active', current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?").bind(nowIso(periodStart), nowIso(periodEnd), invoiceId, nowIso(nowMs), sub.id));
    // 첫 결제는 프로비저닝, 정지/연체 복구는 재개 작업. 같은 결제가 다시 와도 UNIQUE 키로 중복 생성되지 않는다.
    stmts.push(jobStmt(db, sub.status === "incomplete" ? "provision" : "resume", sub.id, sub.status === "incomplete" ? `provision:${sub.id}` : `resume:${sub.id}:${sale.id}`, nowMs));
  } else {
    stmts.push(db.prepare("UPDATE subscriptions SET current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?").bind(nowIso(periodStart), nowIso(periodEnd), invoiceId, nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  return true;
}

async function onPaymentFailed(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const addon = await findAddon(db, ev.resource.id, ev.resource.custom_id);
  if (addon) {
    const owner = await db.prepare("SELECT customer_id FROM subscriptions WHERE id = ?").bind(addon.subscription_id).first<{ customer_id: string }>();
    if (owner) await db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), owner.customer_id, "warning", "추가 CPU 결제 실패", "추가 CPU 결제에 실패했습니다. PayPal 결제 수단을 확인해 주세요.", nowIso(nowMs)).run();
    return true;
  }
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  const stmts = [db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)")
    .bind(newId("ntf"), sub.customer_id, "warning", "결제 실패", "결제에 실패했습니다. PayPal 결제 수단을 확인해 주세요.", nowIso(nowMs))];
  if (sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "past_due");
    stmts.push(db.prepare("UPDATE subscriptions SET status='past_due', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  return true;
}

async function onSubscriptionSuspended(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  if (await findAddon(db, ev.resource.id, ev.resource.custom_id)) return true; // 추가 CPU 는 정지만으로 사양을 줄이지 않는다(해지/기간 종료 시 축소)
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  if (sub.status !== "active" && sub.status !== "past_due") return true;
  assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "suspended");
  await db.batch([db.prepare("UPDATE subscriptions SET status='suspended', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id), jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:paypal_suspended:${ev.id}`, nowMs)]);
  return true;
}

/**
 * 구독 종료(취소/만료). PayPal 은 취소 즉시 이 이벤트를 보낸다.
 * 이미 이용 기간이 남아 있으면 기간 종료까지 'canceling' 으로 두고(스케줄러가 확정), 남은 기간이 없으면 바로 canceled.
 */
async function onSubscriptionEnded(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const addon = await findAddon(db, ev.resource.id, ev.resource.custom_id);
  if (addon) {
    if (addon.purchase_status === "pending") await db.prepare("UPDATE cpu_addons SET purchase_status='cancelled' WHERE id=?").bind(addon.id).run();
    else if (addon.purchase_status === "paid") await db.prepare("UPDATE cpu_addons SET cancel_at_period_end=1 WHERE id=?").bind(addon.id).run(); // 이미 결제한 기간은 유지, 기간 종료 시 축소
    return true;
  }
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  if (sub.status === "canceled" || sub.status === "refunded" || sub.status === "canceling") return true;
  const hasTimeLeft = sub.current_period_end !== null && Date.parse(sub.current_period_end) > nowMs;
  if (sub.status === "incomplete") {
    await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id).run();
    return true;
  }
  if (hasTimeLeft && sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "canceling");
    await db.prepare("UPDATE subscriptions SET status='canceling', cancel_at_period_end=1, updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id).run();
    return true;
  }
  assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "canceled");
  await db.batch([db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id), jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:canceled`, nowMs)]);
  return true;
}

/* ───────── 도메인(일회성) 결제 ───────── */

/** 캡처 완료를 도메인 주문에 반영한다. 금액·통화가 주문과 다르면 거부한다(웹훅과 리턴 URL 양쪽에서 쓰며 멱등). */
export async function applyDomainCapture(db: D1Like, orderId: string, captureId: string, currency: string, amountMinor: number, nowMs: number): Promise<void> {
  const o = await db.prepare("SELECT id,customer_id,charge_currency,charge_amount,price_micro FROM domain_orders WHERE id = ?").bind(orderId).first<{ id: string; customer_id: string; charge_currency: string; charge_amount: number | null; price_micro: number }>();
  if (!o) throw new Error(`domain order not found: ${orderId}`);
  if (currency.toUpperCase() !== "USD" || o.charge_currency !== "USD" || (o.charge_amount !== null && amountMinor !== o.charge_amount)) throw new Error(`domain payment mismatch for ${orderId}: ${currency} ${amountMinor} != ${o.charge_currency} ${o.charge_amount}`);
  const result = await markPaid(db, orderId, captureId, nowMs);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO payments(id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,'paypal',?,?,?,?,'USD',?)")
      .bind(`pay_${captureId}`, o.customer_id, captureId, o.price_micro, "succeeded", nowIso(nowMs), nowIso(nowMs), amountMinor),
    ...(result === "paid" ? [db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "register_domain", `register:${orderId}`, JSON.stringify({ orderId }), nowIso(nowMs), nowIso(nowMs))] : []),
  ]);
}

/** AI 크레딧 충전 캡처 반영(웹훅·리턴 URL 공용, 멱등). 금액·통화가 충전 요청과 다르면 거부한다. */
export async function applyAiTopup(db: D1Like, topupId: string, captureId: string, currency: string, amountMinor: number, nowMs: number): Promise<void> {
  const t = await db.prepare("SELECT id, customer_id, amount_micro, status FROM ai_credit_topups WHERE id = ?").bind(topupId).first<{ id: string; customer_id: string; amount_micro: number; status: string }>();
  if (!t) throw new Error(`ai topup not found: ${topupId}`);
  if (currency.toUpperCase() !== "USD" || amountMinor * MICRO_PER_CENT !== t.amount_micro) throw new Error(`ai topup mismatch for ${topupId}`);
  await db.batch([
    db.prepare("UPDATE ai_credit_topups SET status='paid' WHERE id=? AND status='pending'").bind(t.id),
    db.prepare("INSERT OR IGNORE INTO payments(id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,'paypal',?,?,?,?,'USD',?)").bind(`pay_${captureId}`, t.customer_id, captureId, t.amount_micro, "succeeded", nowIso(nowMs), nowIso(nowMs), amountMinor),
  ]);
  await creditTopup(db, t.customer_id, t.amount_micro, `topup:${captureId}`, nowMs);
}

async function onCaptureCompleted(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const c = ev.resource;
  if (String(c.status).toUpperCase() !== "COMPLETED") return false;
  const orderId: string | undefined = c.custom_id;
  if (!orderId) return false;
  if (orderId.startsWith("ai:")) { await applyAiTopup(db, orderId.slice(3), c.id, c.amount?.currency_code ?? "", valueToCents(c.amount?.value), nowMs); return true; }
  const exists = await db.prepare("SELECT 1 AS x FROM domain_orders WHERE id = ?").bind(orderId).first();
  if (!exists) return false; // 구독 결제 등 도메인 주문이 아닌 캡처
  await applyDomainCapture(db, orderId, c.id, c.amount?.currency_code ?? "", valueToCents(c.amount?.value), nowMs);
  return true;
}

/* ───────── 환불 · 분쟁 ───────── */

type Pay = { id: string; customer_id: string; amount_micro: number; invoice_id: string | null };
const findPaymentByRef = (db: D1Like, ref: string | null | undefined) =>
  ref ? db.prepare("SELECT id,customer_id,amount_micro,invoice_id FROM payments WHERE paypal_capture_id = ?").bind(ref).first<Pay>() : Promise.resolve(null);

async function subOfPayment(db: D1Like, p: Pay): Promise<Sub | null> {
  return p.invoice_id ? db.prepare(`SELECT s.id,s.customer_id,s.status,s.paypal_subscription_id,s.current_period_end FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id WHERE i.id = ?`).bind(p.invoice_id).first<Sub>() : null;
}

/** 환불 이벤트에서 원 결제(sale/capture) ID 를 찾는다. */
function refundedParentId(ev: PayPalEvent): string | undefined {
  const r = ev.resource;
  if (typeof r.sale_id === "string") return r.sale_id; // PAYMENT.SALE.REFUNDED
  const up = (r.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up")?.href; // PAYMENT.CAPTURE.REFUNDED
  return up ? up.split("/").pop() : undefined;
}

async function onRefunded(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const r = ev.resource;
  const parent = refundedParentId(ev);
  const pay = await findPaymentByRef(db, parent);
  if (!pay) throw new Error(`payment not found for refund ${r.id} (parent ${parent})`);
  const cents = valueToCents(r.amount?.total ?? r.amount?.value);
  const micro = cents * MICRO_PER_CENT;
  await db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,paypal_refund_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,?,'refund',?)").bind(`ref_${r.id}`, pay.id, r.id, micro, r.note_to_payer ?? r.reason_code ?? null, nowIso(nowMs)).run();
  const sum = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) AS s FROM refunds WHERE payment_id = ? AND kind = 'refund'").bind(pay.id).first<{ s: number }>();
  const full = (sum?.s ?? 0) >= pay.amount_micro;
  const stmts = [db.prepare("UPDATE payments SET status=? WHERE id=?").bind(full ? "refunded" : "partially_refunded", pay.id)];
  const sub = await subOfPayment(db, pay);
  if (full && sub && sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "refunded");
    stmts.push(db.prepare("UPDATE subscriptions SET status='refunded', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:refunded`, nowMs));
  }
  await db.batch(stmts);
  return true;
}

async function markChargeback(db: D1Like, pay: Pay, refKey: string, reason: string | null, nowMs: number): Promise<void> {
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,'chargeback',?)").bind(`cb_${refKey}`, pay.id, pay.amount_micro, reason, nowIso(nowMs)),
    db.prepare("UPDATE payments SET status='disputed' WHERE id=?").bind(pay.id),
    db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", "결제 분쟁/취소 발생", `PayPal ${refKey}`, nowIso(nowMs)),
  ];
  const sub = await subOfPayment(db, pay);
  if (sub && (sub.status === "active" || sub.status === "past_due")) {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "suspended");
    stmts.push(db.prepare("UPDATE subscriptions SET status='suspended', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:dispute:${refKey}`, nowMs));
  }
  await db.batch(stmts);
}

async function onReversed(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const pay = await findPaymentByRef(db, ev.resource.id);
  if (!pay) throw new Error(`payment not found for reversal ${ev.resource.id}`);
  await markChargeback(db, pay, String(ev.resource.id), "reversed", nowMs);
  return true;
}

async function onDisputeCreated(db: D1Like, ev: PayPalEvent, nowMs: number): Promise<boolean> {
  const d = ev.resource;
  const tx: string | undefined = d.disputed_transactions?.[0]?.seller_transaction_id;
  const pay = await findPaymentByRef(db, tx);
  if (!pay) throw new Error(`payment not found for dispute ${d.dispute_id ?? d.id}`);
  await markChargeback(db, pay, String(d.dispute_id ?? d.id), d.reason ?? null, nowMs);
  return true;
}
