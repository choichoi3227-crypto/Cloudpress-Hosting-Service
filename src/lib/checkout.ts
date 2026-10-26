import { type D1Like, newId, nowIso } from "./db";
import type { PayPalPort } from "./paypal.client";
import type { Cur } from "./currency";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

/**
 * PayPal 은 KRW 를 지원하지 않는다(공식 지원 통화 목록에 없음). 따라서 결제는 USD 만 허용한다.
 * 한국에 등록된 PayPal 계정은 한국 밖 구매자의 결제만 받을 수 있다는 점도 운영자가 알아야 한다(docs/PAYPAL.md).
 */
export function assertPayPalCurrency(currency: Cur): void {
  if (currency !== "USD") throw new ServiceError("currency_unsupported", "PayPal 결제는 USD 만 지원합니다.");
}

/** 가격 버전 × USD → PayPal 월 구독 플랜. 한 번 만들면 재사용한다(가격 버전이 바뀌면 새 플랜 = 기존 구독 가격 유지). */
export async function ensurePayPalPlan(db: D1Like, paypal: PayPalPort, priceId: string, currency: Cur, nowMs: number): Promise<{ paypalPlanId: string; amountMinor: number }> {
  assertPayPalCurrency(currency);
  const existing = await db.prepare("SELECT amount_minor AS a, paypal_plan_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first<{ a: number; s: string | null }>();
  if (existing?.s) return { paypalPlanId: existing.s, amountMinor: existing.a };
  const p = await db.prepare("SELECT p.monthly_micro AS m, p.product_id AS pid, pr.name_ko AS name FROM prices p JOIN products pr ON pr.id = p.product_id WHERE p.id = ?").bind(priceId).first<{ m: number; pid: string; name: string }>();
  if (!p) throw new ServiceError("not_found", "가격 없음");
  if (p.m % 10_000 !== 0) throw new ServiceError("bad_price", "USD 가격은 센트 단위여야 함");
  const amountMinor = p.m / 10_000;
  const created = await paypal.createMonthlyPlan({ name: `CloudPress ${p.name}`, currency, amountMinor, customId: priceId }, `${priceId}:${currency}`);
  await db.prepare("INSERT INTO price_amounts(price_id,currency,amount_minor,paypal_plan_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(price_id,currency) DO UPDATE SET paypal_plan_id = COALESCE(price_amounts.paypal_plan_id, excluded.paypal_plan_id)")
    .bind(priceId, currency, amountMinor, created.planId, nowIso(nowMs)).run();
  const row = (await db.prepare("SELECT amount_minor AS a, paypal_plan_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first<{ a: number; s: string }>())!;
  return { paypalPlanId: row.s, amountMinor: row.a };
}

export interface CheckoutCtx { appOrigin: string; nowMs: number; fxRateMicro?: number | null }

/** 구독 결제 시작: 결제 전(incomplete) 구독을 만들고 PayPal 승인 URL 을 돌려준다. 활성화는 웹훅(PAYMENT.SALE.COMPLETED)으로만 한다. */
export async function createSubscriptionCheckout(db: D1Like, paypal: PayPalPort, userId: string, productId: string, currency: Cur, ctx: CheckoutCtx) {
  assertPayPalCurrency(currency);
  const prod = await db.prepare("SELECT id, on_sale FROM products WHERE id = ?").bind(productId).first<{ id: string; on_sale: number }>();
  if (!prod || prod.on_sale !== 1) throw new ServiceError("not_for_sale", "판매 중인 상품이 아님");
  const price = await db.prepare("SELECT id FROM prices WHERE product_id = ? AND retired_at IS NULL ORDER BY version DESC LIMIT 1").bind(productId).first<{ id: string }>();
  if (!price) throw new ServiceError("not_for_sale", "판매 가능한 가격이 없음");
  const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  if (!user) throw new ServiceError("not_found", "사용자 없음");
  const { paypalPlanId } = await ensurePayPalPlan(db, paypal, price.id, currency, ctx.nowMs);
  const subId = newId("sub");
  // custom_id 로 우리 구독 ID 를 PayPal 에 심어 두면 웹훅에서 정확히 연결된다(최대 127자).
  const s = await paypal.createSubscription({ planId: paypalPlanId, customId: subId, email: user.email,
    returnUrl: `${ctx.appOrigin}/dashboard?checkout=success`, cancelUrl: `${ctx.appOrigin}/services/create?checkout=cancel` }, `sub:${subId}`);
  await db.prepare("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,paypal_plan_id,paypal_subscription_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'incomplete',?,?)")
    .bind(subId, userId, productId, price.id, paypalPlanId, s.id, nowIso(ctx.nowMs), nowIso(ctx.nowMs)).run();
  await audit(db, { actorId: userId, action: "checkout.subscription", targetType: "subscription", targetId: subId, detail: { productId, currency, provider: "paypal" } }, ctx.nowMs);
  return { subscriptionId: subId, url: s.approveUrl };
}

/** 도메인 구매 결제: 견적이 유효할 때만 PayPal 주문(일회성)을 만든다. 결제 확정은 캡처 + 웹훅으로만 한다. */
export async function createDomainCheckout(db: D1Like, paypal: PayPalPort, userId: string, orderId: string, ctx: CheckoutCtx) {
  const o = await db.prepare("SELECT id,hostname,status,charge_currency AS cur,charge_amount AS amt,quote_expires_at AS exp FROM domain_orders WHERE id = ? AND customer_id = ?").bind(orderId, userId).first<{ id: string; hostname: string; status: string; cur: Cur; amt: number | null; exp: string }>();
  if (!o) throw new ServiceError("not_found", "주문이 없거나 권한 없음");
  if (o.status !== "awaiting_payment") throw new ServiceError("bad_state", "결제할 수 없는 주문 상태");
  if (Date.parse(o.exp) <= ctx.nowMs) throw new ServiceError("quote_expired", "견적이 만료됨. 다시 견적을 받으세요.");
  if (!o.amt) throw new ServiceError("bad_price", "주문 금액이 없음");
  assertPayPalCurrency(o.cur);
  const ord = await paypal.createOrder({ customId: o.id, currency: o.cur, amountMinor: o.amt, description: `도메인 등록 1년: ${o.hostname}`,
    returnUrl: `${ctx.appOrigin}/api/paypal/return?kind=domain&order=${encodeURIComponent(o.id)}`, cancelUrl: `${ctx.appOrigin}/domains?checkout=cancel` }, `domain:${o.id}`);
  await db.prepare("UPDATE domain_orders SET paypal_order_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").bind(ord.id, nowIso(ctx.nowMs), o.id).run();
  await audit(db, { actorId: userId, action: "checkout.domain", targetType: "domain_order", targetId: o.id }, ctx.nowMs);
  return { url: ord.approveUrl };
}

/** PayPal 에는 Stripe 같은 고객 포털이 없다. 구매자가 PayPal 계정의 자동 결제 관리 페이지에서 직접 관리한다. */
export async function createPortal(_db: D1Like, _paypal: PayPalPort, _userId: string, _appOrigin: string, env: "sandbox" | "live" = "live") {
  return { url: env === "sandbox" ? "https://www.sandbox.paypal.com/myaccount/autopay/" : "https://www.paypal.com/myaccount/autopay/" };
}

/** 승인 없이 방치된 결제 전 구독 정리(24시간). 결제 연결이 끝난 구독은 건드리지 않는다. */
export async function expireIncompleteSubscriptions(db: D1Like, nowMs: number, ttlHours = 24): Promise<number> {
  const r = await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE status='incomplete' AND created_at < ?").bind(nowIso(nowMs), nowIso(nowMs - ttlHours * 3_600_000)).run();
  return r.meta.changes;
}

/**
 * 취소 예약(canceling) 구독의 이용 기간이 끝나면 canceled 로 확정하고 서비스 중지 작업을 만든다.
 * PayPal 은 취소 즉시 CANCELLED 웹훅을 보내므로(기간 종료 시점 아님), 이용 종료는 우리 쪽에서 기간 만료로 처리한다.
 */
export async function finalizeCanceledSubscriptions(db: D1Like, nowMs: number): Promise<number> {
  const { results } = await db.prepare("SELECT id FROM subscriptions WHERE status = 'canceling' AND current_period_end IS NOT NULL AND current_period_end <= ?").bind(nowIso(nowMs)).all<{ id: string }>();
  for (const s of results) {
    await db.batch([
      db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=? AND status='canceling'").bind(nowIso(nowMs), s.id),
      db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "suspend", s.id, `suspend:${s.id}:period_end`, nowIso(nowMs), nowIso(nowMs)),
    ]);
  }
  return results.length;
}
