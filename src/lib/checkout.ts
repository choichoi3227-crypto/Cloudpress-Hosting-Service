import { type D1Like, newId, nowIso } from "./db";
import type { StripePort } from "./stripe.client";
import type { Cur } from "./currency";
import { usdMicroToWon } from "./fx";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

const ceilTo = (v: number, unit: number) => Math.ceil(v / unit) * unit;
export const KRW_LIST_ROUNDING = 100;

/** Stripe 고객은 사용자당 1명. 멱등 키로 동시 요청에서도 중복 생성을 막는다. */
export async function ensureStripeCustomer(db: D1Like, stripe: StripePort, userId: string): Promise<string> {
  const u = await db.prepare("SELECT email, stripe_customer_id AS c FROM users WHERE id = ?").bind(userId).first<{ email: string; c: string | null }>();
  if (!u) throw new ServiceError("not_found", "사용자 없음");
  if (u.c) return u.c;
  const c = await stripe.createCustomer({ email: u.email, metadata: { cloudpress_user_id: userId } }, `customer:${userId}`);
  await db.prepare("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?").bind(c.id, userId).run();
  return (await db.prepare("SELECT stripe_customer_id AS c FROM users WHERE id = ?").bind(userId).first<{ c: string }>())!.c;
}

/**
 * 가격 버전 × 통화의 Stripe Price 를 보장한다. 한 번 만든 금액은 바꾸지 않는다(가격 버전 보존).
 * KRW 는 최초 생성 시점의 환율로 목록가(100원 올림)를 확정해 잠근다. 환율이 바뀌어도 기존 구독 가격은 유지되고, 새 가격은 새 가격 버전으로 낸다.
 */
export async function ensureStripePrice(db: D1Like, stripe: StripePort, priceId: string, currency: Cur, fxRateMicro: number | null, nowMs: number): Promise<{ stripePriceId: string; amountMinor: number }> {
  const existing = await db.prepare("SELECT amount_minor AS a, stripe_price_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first<{ a: number; s: string | null }>();
  if (existing?.s) return { stripePriceId: existing.s, amountMinor: existing.a };
  const p = await db.prepare("SELECT p.monthly_micro AS m, p.product_id AS pid, pr.name_ko AS name FROM prices p JOIN products pr ON pr.id = p.product_id WHERE p.id = ?").bind(priceId).first<{ m: number; pid: string; name: string }>();
  if (!p) throw new ServiceError("not_found", "가격 없음");
  let amountMinor: number;
  if (currency === "USD") {
    if (p.m % 10_000 !== 0) throw new ServiceError("bad_price", "USD 가격은 센트 단위여야 함");
    amountMinor = p.m / 10_000;
  } else {
    const locked = existing?.a;
    if (!locked && !fxRateMicro) throw new ServiceError("fx_unavailable", "환율을 확인할 수 없어 원화 가격을 만들 수 없음");
    amountMinor = locked ?? ceilTo(usdMicroToWon(p.m, fxRateMicro!), KRW_LIST_ROUNDING);
  }
  const created = await stripe.createMonthlyPrice({ name: p.name, currency, amountMinor, metadata: { cloudpress_price_id: priceId } }, `price:${priceId}:${currency}`);
  await db.prepare("INSERT INTO price_amounts(price_id,currency,amount_minor,fx_rate_micro,stripe_price_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(price_id,currency) DO UPDATE SET stripe_price_id = COALESCE(price_amounts.stripe_price_id, excluded.stripe_price_id)")
    .bind(priceId, currency, amountMinor, currency === "KRW" ? fxRateMicro : null, created.priceId, nowIso(nowMs)).run();
  const row = (await db.prepare("SELECT amount_minor AS a, stripe_price_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first<{ a: number; s: string }>())!;
  return { stripePriceId: row.s, amountMinor: row.a };
}

export interface CheckoutCtx { appOrigin: string; nowMs: number; fxRateMicro: number | null }

/** 서비스별 독립 구독: 구독 행(incomplete)을 만들고 Stripe Checkout 으로 보낸다. 활성화는 웹훅(invoice.paid)에서만. */
export async function createSubscriptionCheckout(db: D1Like, stripe: StripePort, userId: string, productId: string, currency: Cur, ctx: CheckoutCtx) {
  const prod = await db.prepare("SELECT id, on_sale FROM products WHERE id = ?").bind(productId).first<{ id: string; on_sale: number }>();
  if (!prod || prod.on_sale !== 1) throw new ServiceError("not_for_sale", "판매 중인 상품이 아님");
  const price = await db.prepare("SELECT id FROM prices WHERE product_id = ? AND retired_at IS NULL ORDER BY version DESC LIMIT 1").bind(productId).first<{ id: string }>();
  if (!price) throw new ServiceError("not_for_sale", "판매 가격이 없음");
  const customer = await ensureStripeCustomer(db, stripe, userId);
  const { stripePriceId } = await ensureStripePrice(db, stripe, price.id, currency, ctx.fxRateMicro, ctx.nowMs);
  const subId = newId("sub");
  await db.prepare("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,stripe_customer_id,stripe_price_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'incomplete',?,?)")
    .bind(subId, userId, productId, price.id, customer, stripePriceId, nowIso(ctx.nowMs), nowIso(ctx.nowMs)).run();
  const s = await stripe.createCheckoutSession({ mode: "subscription", customer, priceId: stripePriceId, clientReferenceId: subId, metadata: { cloudpress_subscription_id: subId }, successUrl: `${ctx.appOrigin}/dashboard?checkout=success`, cancelUrl: `${ctx.appOrigin}/dashboard?checkout=cancel` }, `checkout:sub:${subId}`);
  await audit(db, { actorId: userId, action: "checkout.subscription", targetType: "subscription", targetId: subId, detail: { productId, currency } }, ctx.nowMs);
  return { subscriptionId: subId, url: s.url };
}

/** 도메인 결제: 견적이 유효하고 본인 주문일 때만. 금액·통화는 견적에 고정된 값을 그대로 사용한다(클라이언트 입력을 신뢰하지 않음). */
export async function createDomainCheckout(db: D1Like, stripe: StripePort, userId: string, orderId: string, ctx: CheckoutCtx) {
  const o = await db.prepare("SELECT id,hostname,status,charge_currency AS cur,charge_amount AS amt,quote_expires_at AS exp FROM domain_orders WHERE id = ? AND customer_id = ?").bind(orderId, userId).first<{ id: string; hostname: string; status: string; cur: Cur; amt: number | null; exp: string }>();
  if (!o) throw new ServiceError("not_found", "주문을 찾을 수 없음");
  if (o.status !== "awaiting_payment") throw new ServiceError("bad_state", "결제할 수 없는 주문 상태");
  if (Date.parse(o.exp) <= ctx.nowMs) throw new ServiceError("quote_expired", "견적이 만료됨. 다시 견적을 받으세요.");
  if (!o.amt) throw new ServiceError("bad_price", "견적 금액이 없음");
  const customer = await ensureStripeCustomer(db, stripe, userId);
  const sec = Math.floor(ctx.nowMs / 1000) + 31 * 60; // Checkout 만료는 최소 30분. 견적이 먼저 만료돼도 결제 도착 시 원가 변동 검사를 거친다.
  const s = await stripe.createCheckoutSession({ mode: "payment", customer, inline: { currency: o.cur, amountMinor: o.amt, name: `도메인 등록 1년: ${o.hostname}` }, clientReferenceId: o.id, metadata: { domain_order_id: o.id }, expiresAtSec: sec, successUrl: `${ctx.appOrigin}/domains?order=${o.id}`, cancelUrl: `${ctx.appOrigin}/domains?cancel=${o.id}` }, `checkout:domain:${o.id}`);
  await audit(db, { actorId: userId, action: "checkout.domain", targetType: "domain_order", targetId: o.id }, ctx.nowMs);
  return { url: s.url };
}

export async function createPortal(db: D1Like, stripe: StripePort, userId: string, appOrigin: string) {
  const u = await db.prepare("SELECT stripe_customer_id AS c FROM users WHERE id = ?").bind(userId).first<{ c: string | null }>();
  if (!u?.c) throw new ServiceError("no_customer", "결제 이력이 없어 포털을 열 수 없음");
  return stripe.createPortalSession({ customer: u.c, returnUrl: `${appOrigin}/dashboard` });
}

/** 결제가 끝나지 않은 채 방치된 구독 행 정리(24시간). */
export async function expireIncompleteSubscriptions(db: D1Like, nowMs: number, ttlHours = 24): Promise<number> {
  const r = await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE status='incomplete' AND created_at < ? AND stripe_subscription_id IS NULL").bind(nowIso(nowMs), nowIso(nowMs - ttlHours * 3_600_000)).run();
  return r.meta.changes;
}
