import { type D1Like, newId, nowIso } from "./lib/db";
import { type SessionInfo, audit, revokeAllSessions, hashPasswordForUser } from "./lib/auth";
import { verifyPassword } from "./lib/crypto";
import type { Env } from "./worker";
import { buildRuntime } from "./runtime";
import { createSubscriptionCheckout, createDomainCheckout, createPortal } from "./lib/checkout";
import { applyDomainCapture, applyAiTopup } from "./lib/webhooks";
import { applyAffiliate, affiliateSummary, setAffiliateStatus, adminAffiliateOverview, approvePayout, markPayoutPaid, releasePayout, clearReferralFlag, saveAffiliatePolicy, settleAffiliates } from "./lib/affiliateProgram";
import { seedWorkforce, runTick, companyOverview, createTask, decideApproval, completeHumanTask, setSetting, loadSettings } from "./lib/workforce";
import { issueKey, revokeKey, rotateKey, creditBalance, syncModels, adminSetModel, currentPrice, MIN_TOPUP_MICRO, MAX_TOPUP_MICRO, COST_MICRO_PER_NEURON, type Tier } from "./lib/cas";
import { quoteCpuAddon, purchaseCpuAddon, loadCpuPolicy, saveCpuPolicy } from "./lib/cpuAddons";
import { parseCurrency } from "./lib/currency";
import { recordFxSample } from "./lib/fxStore";
import { ServiceError, connectDomain } from "./lib/zoneService";
import { createQuote } from "./lib/domainOrders";

export interface ApiCtx {
  req: Request;
  env: Env;
  url: URL;
  now: number;
  session: SessionInfo;
  json(data: unknown, status?: number, extra?: Record<string, string>): Response;
  body(maxBytes?: number): Promise<Record<string, any> | null>;
}

type Handler = (c: ApiCtx, m: RegExpMatchArray) => Promise<Response>;
interface Route { method: string; re: RegExp; admin?: boolean; h: Handler }

const routes: Route[] = [];
const add = (method: string, path: string, h: Handler, admin = false) =>
  routes.push({ method, re: new RegExp("^" + path.replace(/:[a-z]+/gi, "([^/]+)") + "/?$"), admin, h });

const all = async <T = any>(db: D1Like, sql: string, ...b: unknown[]): Promise<T[]> => (await db.prepare(sql).bind(...b).all<T>()).results;
const one = async <T = any>(db: D1Like, sql: string, ...b: unknown[]): Promise<T | null> => db.prepare(sql).bind(...b).first<T>();
const parseJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** 라우터. 일치하는 라우트가 없으면 null(호출자가 404 처리). */
export async function routeApi(c: ApiCtx): Promise<Response | null> {
  const path = c.url.pathname;
  for (const r of routes) {
    if (r.method !== c.req.method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    if (r.admin && c.session.user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    return r.h(c, m);
  }
  return null;
}

/* ───────────── 상품 · 구독 ───────────── */

export async function listPlans(db: D1Like) {
  const rows = await all(db, `SELECT p.id, p.kind, p.name_ko, p.instance_type, p.target_vcpu, p.included_storage_gb, p.included_active_hours, pr.monthly_micro
    FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.retired_at IS NULL
    WHERE p.on_sale = 1 AND pr.version = (SELECT MAX(version) FROM prices WHERE product_id = p.id AND retired_at IS NULL)
    ORDER BY p.kind, pr.monthly_micro`);
  return rows.map((r: any) => ({ id: r.id, kind: r.kind, nameKo: r.name_ko, monthlyMicro: r.monthly_micro, instanceType: r.instance_type, targetVcpu: r.target_vcpu, includedStorageGb: r.included_storage_gb, includedActiveHours: r.included_active_hours }));
}

const subSelect = `SELECT s.id, s.product_id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.created_at, s.billing_interval, s.quantity,
    p.kind, p.name_ko, pr.monthly_micro
  FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_version_id`;
const subOut = (r: any) => ({
  id: r.id, productId: r.product_id, status: r.status, currentPeriodStart: r.current_period_start, currentPeriodEnd: r.current_period_end,
  cancelAtPeriodEnd: !!r.cancel_at_period_end, createdAt: r.created_at, billingInterval: r.billing_interval, quantity: r.quantity,
  product: { id: r.product_id, nameKo: r.name_ko, kind: r.kind, monthlyMicro: r.monthly_micro },
});

add("GET", "/api/subscriptions", async (c) => {
  // 결제 전(incomplete) 구독은 목록에서 숨긴다. 결제 완료는 PayPal 웹훅으로만 확정된다.
  const rows = await all(c.env.DB, `${subSelect} WHERE s.customer_id = ? AND s.status NOT IN ('incomplete') ORDER BY s.created_at DESC`, c.session.user.id);
  return c.json(rows.map(subOut));
});

add("POST", "/api/subscriptions", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.productId !== "string") return c.json({ error: "bad_request" }, 400);
  let cur;
  try { cur = parseCurrency(b.currency ?? "USD"); } catch { return c.json({ error: "bad_currency" }, 400); }
  const rt = buildRuntime(c.env);
  const r = await createSubscriptionCheckout(c.env.DB, rt.paypal, c.session.user.id, b.productId, cur, { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  return c.json({ ok: true, subscriptionId: r.subscriptionId, url: r.url }, 201);
});

add("GET", "/api/subscriptions/:id", async (c, m) => {
  const r = await one(c.env.DB, `${subSelect} WHERE s.id = ? AND s.customer_id = ?`, m[1], c.session.user.id);
  return r ? c.json(subOut(r)) : c.json({ error: "not_found" }, 404);
});

// 취소: PayPal 구독을 해지해 다음 결제를 막고, 이미 결제한 이용 기간은 끝까지 유지한다(canceling → 기간 종료 시 canceled).
// 즉시 환불은 하지 않는다.
add("POST", "/api/services/:id/cancel", async (c, m) => {
  const s = await one<{ id: string; status: string; pp: string | null }>(c.env.DB, "SELECT id, status, paypal_subscription_id AS pp FROM subscriptions WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!["active", "past_due", "suspended"].includes(s.status)) return c.json({ error: "bad_state", message: "취소할 수 없는 상태입니다." }, 409);
  if (s.pp) {
    try { await buildRuntime(c.env).paypal.cancelSubscription(s.pp, "고객 요청에 의한 취소"); }
    catch (e: any) { return c.json({ error: "paypal_error", message: "PayPal 구독 해지에 실패했습니다. 잠시 후 다시 시도하세요." }, e?.retryable ? 503 : 502); }
  }
  await c.env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, status = 'canceling', updated_at = ? WHERE id = ?").bind(nowIso(c.now), s.id).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "subscription.cancel", targetType: "subscription", targetId: s.id }, c.now);
  return c.json({ ok: true, cancelAtPeriodEnd: true });
});

// 정지/재개는 PayPal 구독의 청구도 함께 멈추거나 재개한다(정지 중 과금 방지).
for (const [action, from, to] of [["suspend", "active", "suspended"], ["resume", "suspended", "active"]] as const) {
  add("POST", `/api/services/:id/${action}`, async (c, m) => {
    const s = await one<{ id: string; pp: string | null }>(c.env.DB, "SELECT id, paypal_subscription_id AS pp FROM subscriptions WHERE id = ? AND customer_id = ? AND status = ?", m[1], c.session.user.id, from);
    if (!s) return c.json({ error: "bad_state", message: "현재 상태에서는 실행할 수 없습니다." }, 409);
    if (s.pp) {
      try { const pp = buildRuntime(c.env).paypal; await (action === "suspend" ? pp.suspendSubscription(s.pp, "고객 요청 정지") : pp.activateSubscription(s.pp, "고객 요청 재개")); }
      catch (e: any) { return c.json({ error: "paypal_error", message: "PayPal 처리에 실패했습니다. 잠시 후 다시 시도하세요." }, e?.retryable ? 503 : 502); }
    }
    await c.env.DB.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ? AND status = ?").bind(to, nowIso(c.now), s.id, from).run();
    await audit(c.env.DB, { actorId: c.session.user.id, action: `subscription.${action}`, targetType: "subscription", targetId: s.id }, c.now);
    return c.json({ ok: true });
  });
}

// PayPal 승인 후 구매자가 돌아오는 주소. 도메인(일회성) 주문은 여기서 서버가 캡처하고, 결제 확정은 금액·주문을 서버에서 다시 검증한다.
// (구독은 웹훅으로만 확정한다. 이 주소의 쿼리값만으로 결제 완료를 믿지 않는다.)
add("GET", "/api/paypal/return", async (c) => {
  const kind = c.url.searchParams.get("kind");
  const orderId = c.url.searchParams.get("order");
  const token = c.url.searchParams.get("token"); // PayPal 주문 ID
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: `${c.env.APP_ORIGIN}${to}` } });
  if (kind === "ai" && orderId && token) {
    const t = await one<{ id: string; paypal_order_id: string | null; status: string }>(c.env.DB, "SELECT id, paypal_order_id, status FROM ai_credit_topups WHERE id = ? AND customer_id = ?", orderId, c.session.user.id);
    if (!t || t.paypal_order_id !== token) return redirect("/ai?topup=invalid");
    if (t.status === "paid") return redirect("/ai?topup=done");
    try {
      const cap = await buildRuntime(c.env).paypal.captureOrder(token, `capture:${t.id}`);
      if (cap.status !== "COMPLETED") return redirect("/ai?topup=pending");
      await applyAiTopup(c.env.DB, t.id, cap.captureId, cap.currency, cap.amountMinor, c.now);
      return redirect("/ai?topup=success");
    } catch { return redirect("/ai?topup=error"); } // 실제로 캡처됐다면 PAYMENT.CAPTURE.COMPLETED 웹훅이 멱등하게 반영한다.
  }
  if (kind !== "domain" || !orderId || !token) return redirect("/dashboard");
  const o = await one<{ id: string; paypal_order_id: string | null; status: string }>(c.env.DB, "SELECT id, paypal_order_id, status FROM domain_orders WHERE id = ? AND customer_id = ?", orderId, c.session.user.id);
  if (!o || o.paypal_order_id !== token) return redirect("/domains?checkout=invalid");
  if (o.status !== "awaiting_payment") return redirect("/domains?checkout=done");
  try {
    const cap = await buildRuntime(c.env).paypal.captureOrder(token, `capture:${o.id}`);
    if (cap.status !== "COMPLETED") return redirect("/domains?checkout=pending");
    await applyDomainCapture(c.env.DB, o.id, cap.captureId, cap.currency, cap.amountMinor, c.now);
    return redirect("/domains?checkout=success");
  } catch {
    return redirect("/domains?checkout=error"); // 캡처가 실제로 됐다면 PAYMENT.CAPTURE.COMPLETED 웹훅이 같은 처리를 멱등하게 수행한다.
  }
});

/* ───────────── 추가 CPU ───────────── */

add("GET", "/api/services/:id/cpu-addons", async (c, m) => {
  const own = await one(c.env.DB, "SELECT id FROM subscriptions WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
  if (!own) return c.json({ error: "not_found" }, 404);
  const policy = await loadCpuPolicy(c.env.DB);
  const rows = await all(c.env.DB, "SELECT id, add_vcpu, monthly_micro, from_instance_type, to_instance_type, purchase_status, apply_status, last_error, current_period_end, cancel_at_period_end, created_at FROM cpu_addons WHERE subscription_id = ? AND purchase_status != 'cancelled' ORDER BY created_at DESC", m[1]);
  const container = await one(c.env.DB, "SELECT instance_type, target_vcpu, actual_vcpu FROM containers WHERE subscription_id = ? AND deleted_at IS NULL", m[1]);
  return c.json({
    tiers: Object.entries(policy.prices).map(([v, p]) => ({ addVcpu: Number(v), monthlyMicro: p })), maxTotalAddVcpu: policy.maxTotalAddVcpu,
    container: container ? { instanceType: container.instance_type, targetVcpu: container.target_vcpu, actualVcpu: container.actual_vcpu } : null,
    addons: rows.map((r: any) => ({ id: r.id, addVcpu: r.add_vcpu, monthlyMicro: r.monthly_micro, fromInstance: r.from_instance_type, toInstance: r.to_instance_type, purchaseStatus: r.purchase_status, applyStatus: r.apply_status, lastError: r.last_error, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: !!r.cancel_at_period_end })),
  });
});

add("POST", "/api/services/:id/cpu-addons/quote", async (c, m) => {
  const b = await c.body(512);
  const q = await quoteCpuAddon(c.env.DB, c.session.user.id, m[1]!, Number(b?.addVcpu));
  return c.json(q);
});

add("POST", "/api/services/:id/cpu-addons", async (c, m) => {
  const b = await c.body(512);
  const r = await purchaseCpuAddon(c.env.DB, buildRuntime(c.env).paypal, c.session.user.id, m[1]!, Number(b?.addVcpu), { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  return c.json({ ok: true, id: r.id, url: r.url, quote: r.quote }, 201);
});

// 취소: PayPal 해지(다음 결제 중단) + 결제한 기간은 유지, 다음 갱신일(기간 종료)부터 축소.
add("POST", "/api/cpu-addons/:id/cancel", async (c, m) => {
  const a = await one<{ id: string; pp: string | null; status: string }>(c.env.DB, `SELECT a.id, a.paypal_subscription_id AS pp, a.purchase_status AS status FROM cpu_addons a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.id = ? AND s.customer_id = ?`, m[1], c.session.user.id);
  if (!a) return c.json({ error: "not_found" }, 404);
  if (a.status !== "paid") return c.json({ error: "bad_state", message: "취소할 수 없는 상태입니다." }, 409);
  if (a.pp) {
    try { await buildRuntime(c.env).paypal.cancelSubscription(a.pp, "고객 요청 추가 CPU 취소"); }
    catch (e: any) { return c.json({ error: "paypal_error", message: "PayPal 해지에 실패했습니다. 잠시 후 다시 시도하세요." }, e?.retryable ? 503 : 502); }
  }
  await c.env.DB.prepare("UPDATE cpu_addons SET cancel_at_period_end = 1 WHERE id = ?").bind(a.id).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "cpu_addon.cancel", targetType: "cpu_addon", targetId: a.id }, c.now);
  return c.json({ ok: true, cancelAtPeriodEnd: true });
});

add("GET", "/api/admin/cpu-policy", async (c) => c.json(await loadCpuPolicy(c.env.DB)), true);
add("PUT", "/api/admin/cpu-policy", async (c) => {
  const b = await c.body(4096);
  if (!b) return c.json({ error: "bad_request" }, 400);
  return c.json(await saveCpuPolicy(c.env.DB, c.session.user.id, b, c.now));
}, true);

/* ───────────── CAS (AI) ───────────── */

const TIER_PRODUCT: Record<string, string> = { general: "cas-general", performance: "cas-performance", premium: "cas-premium" };

add("GET", "/api/cas/models", async (c) => {
  const rows = await all(c.env.DB, `SELECT m.id, m.model_id, m.name, m.task_type, m.tier, m.input_neurons_per_m i, m.output_neurons_per_m o, m.unit_neurons u, m.official_status,
      (SELECT sell_per_1k_micro FROM ai_model_prices WHERE model_id = m.id ORDER BY version DESC LIMIT 1) AS sell
    FROM ai_models m WHERE m.enabled = 1 AND m.official_status != 'removed' ORDER BY m.tier, m.name`);
  const prods: Record<string, number> = Object.fromEntries((await all(c.env.DB, "SELECT p.id, pr.monthly_micro AS m FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.retired_at IS NULL WHERE p.kind = 'cas'")).map((r: any) => [r.id, r.m]));
  const mine = new Set((await all(c.env.DB, "SELECT a.model_id AS m FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND s.status IN ('active','canceling','past_due')", c.session.user.id)).map((r: any) => r.m));
  return c.json({ models: rows.map((r: any) => ({ id: r.id, modelId: r.model_id, name: r.name, task: r.task_type, tier: r.tier, monthlyMicro: prods[TIER_PRODUCT[r.tier] ?? ""] ?? null, sellPer1kNeuronsMicro: r.sell, deprecating: r.official_status === "deprecating", subscribed: mine.has(r.id) })) });
});

add("POST", "/api/cas/subscribe", async (c) => {
  const b = await c.body(512);
  if (!b || typeof b.modelId !== "string") return c.json({ error: "bad_request" }, 400);
  const m = await one<{ id: string; tier: string; i: number | null; o: number | null; u: number | null }>(c.env.DB, "SELECT id, tier, input_neurons_per_m i, output_neurons_per_m o, unit_neurons u FROM ai_models WHERE id = ? AND enabled = 1 AND official_status != 'removed'", b.modelId);
  if (!m || !(m.i || m.o || m.u) || !(await currentPrice(c.env.DB, m.id))) return c.json({ error: "model_not_found", message: "판매 중인 모델이 아닙니다." }, 404);
  const dup = await one(c.env.DB, "SELECT a.subscription_id FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND a.model_id = ? AND s.status IN ('incomplete','active','canceling','past_due','suspended')", c.session.user.id, m.id);
  if (dup) return c.json({ error: "already_subscribed", message: "이미 이 모델을 구독 중이거나 결제 대기 중입니다." }, 409);
  const r = await createSubscriptionCheckout(c.env.DB, buildRuntime(c.env).paypal, c.session.user.id, TIER_PRODUCT[m.tier]!, "USD", { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  await c.env.DB.prepare("INSERT INTO cas_model_access(subscription_id,customer_id,model_id,created_at) VALUES(?,?,?,?)").bind(r.subscriptionId, c.session.user.id, m.id, nowIso(c.now)).run();
  return c.json({ ok: true, subscriptionId: r.subscriptionId, url: r.url }, 201);
});

add("GET", "/api/cas/keys", async (c) => c.json({ keys: (await all(c.env.DB, "SELECT id, name, prefix, status, rate_limit_per_min, monthly_cap_micro, created_at, last_used_at FROM ai_api_keys WHERE customer_id = ? AND status != 'revoked' ORDER BY created_at DESC", c.session.user.id)).map((k: any) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status, rateLimitPerMin: k.rate_limit_per_min, monthlyCapMicro: k.monthly_cap_micro, createdAt: k.created_at, lastUsedAt: k.last_used_at })) }));
add("POST", "/api/cas/keys", async (c) => {
  const b = await c.body(1024);
  const k = await issueKey(c.env.DB, c.session.user.id, String(b?.name ?? ""), c.now, { rateLimitPerMin: b?.rateLimitPerMin, monthlyCapMicro: b?.monthlyCapMicro });
  return c.json({ ...k, notice: "이 키는 지금만 볼 수 있습니다. 안전한 곳에 보관하세요." }, 201);
});
add("POST", "/api/cas/keys/:id/revoke", async (c, m) => { await revokeKey(c.env.DB, c.session.user.id, m[1]!, c.now); return c.json({ ok: true }); });
add("POST", "/api/cas/keys/:id/rotate", async (c, m) => c.json({ ...(await rotateKey(c.env.DB, c.session.user.id, m[1]!, c.now)), notice: "이전 키는 폐기되었습니다. 새 키는 지금만 볼 수 있습니다." }, 201));

add("GET", "/api/cas/usage", async (c) => {
  const ms = new Date(c.now); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0);
  const rows = await all(c.env.DB, `SELECT m.model_id, m.name, COUNT(*) AS requests, SUM(u.neurons) AS neurons, SUM(u.billed_micro) AS billed
    FROM ai_usage_records u JOIN ai_models m ON m.id = u.model_id JOIN cas_model_access a ON a.subscription_id = u.subscription_id
    WHERE a.customer_id = ? AND u.ts >= ? GROUP BY m.id ORDER BY billed DESC`, c.session.user.id, nowIso(ms.getTime()));
  return c.json({ balanceMicro: await creditBalance(c.env.DB, c.session.user.id), month: nowIso(ms.getTime()).slice(0, 7), models: rows, note: "Neurons 는 공식 단가로 환산한 추정치이며 Cloudflare 의 실제 집계와 소폭 다를 수 있습니다." });
});

// 크레딧 충전(PayPal 일회성 결제). 사용량 요금은 이 선불 크레딧에서 차감된다.
add("POST", "/api/cas/credits/topup", async (c) => {
  const b = await c.body(256);
  const usd = Number(b?.amountUsd);
  const micro = Math.round(usd * 1_000_000);
  if (!Number.isFinite(usd) || micro % 10_000 !== 0 || micro < MIN_TOPUP_MICRO || micro > MAX_TOPUP_MICRO) return c.json({ error: "bad_amount", message: `충전 금액은 $${MIN_TOPUP_MICRO / 1e6} ~ $${MAX_TOPUP_MICRO / 1e6} 사이(센트 단위)여야 합니다.` }, 400);
  const id = newId("top");
  const ord = await buildRuntime(c.env).paypal.createOrder({ customId: `ai:${id}`, currency: "USD", amountMinor: micro / 10_000, description: "CloudPress AI 크레딧 충전",
    returnUrl: `${c.env.APP_ORIGIN}/api/paypal/return?kind=ai&order=${encodeURIComponent(id)}`, cancelUrl: `${c.env.APP_ORIGIN}/ai?topup=cancel` }, `aitopup:${id}`);
  await c.env.DB.prepare("INSERT INTO ai_credit_topups(id,customer_id,amount_micro,paypal_order_id,created_at) VALUES(?,?,?,?,?)").bind(id, c.session.user.id, micro, ord.id, nowIso(c.now)).run();
  return c.json({ ok: true, url: ord.approveUrl }, 201);
});

// 운영자
add("GET", "/api/admin/cas/overview", async (c) => {
  const ms = new Date(c.now); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0);
  const models = await all(c.env.DB, `SELECT m.id, m.model_id, m.name, m.task_type, m.tier, m.enabled, m.official_status, m.pricing_source, m.input_neurons_per_m i, m.output_neurons_per_m o, m.unit_neurons u, m.last_synced_at,
      (SELECT sell_per_1k_micro FROM ai_model_prices WHERE model_id = m.id ORDER BY version DESC LIMIT 1) AS sell,
      (SELECT COUNT(*) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS requests,
      (SELECT COALESCE(SUM(neurons),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS neurons,
      (SELECT COALESCE(SUM(billed_micro),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS billed,
      (SELECT COALESCE(SUM(cost_micro),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS cost
    FROM ai_models m ORDER BY m.enabled DESC, m.name`, nowIso(ms.getTime()), nowIso(ms.getTime()), nowIso(ms.getTime()), nowIso(ms.getTime()));
  const kill = await one(c.env.DB, "SELECT value_json FROM admin_settings WHERE key = 'cas_kill_switch'");
  return c.json({ models, killSwitch: kill?.value_json === "true", costPerNeuronMicro: COST_MICRO_PER_NEURON });
}, true);

add("POST", "/api/admin/cas/sync", async (c) => {
  const env = c.env;
  if (env.CLOUDPRESS_MODE !== "live") {
    const mock = [{ name: "@cf/meta/llama-3.1-8b-instruct", task: { name: "Text Generation" }, properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.282, currency: "USD" }, { unit: "per M output tokens", price: 0.827, currency: "USD" }] }] }];
    return c.json({ mode: "mock", ...(await syncModels(env.DB, mock as any, c.now)) });
  }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return c.json({ error: "not_configured", message: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 가 필요합니다." }, 503);
  const models: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    if (!res.ok) return c.json({ error: "upstream_error", message: `Cloudflare 모델 목록 조회 실패(HTTP ${res.status})` }, 502);
    const j: any = await res.json();
    models.push(...(j.result ?? []));
    if (!j.result || j.result.length < 100) break;
  }
  return c.json({ mode: "live", ...(await syncModels(env.DB, models, c.now)) });
}, true);

add("PATCH", "/api/admin/cas/models/:id", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  await adminSetModel(c.env.DB, c.session.user.id, m[1]!, { enabled: b.enabled, tier: b.tier as Tier | undefined, inputNeuronsPerM: b.inputNeuronsPerM, outputNeuronsPerM: b.outputNeuronsPerM, unitNeurons: b.unitNeurons, sellPer1kMicro: b.sellPer1kMicro }, c.now);
  return c.json({ ok: true });
}, true);

add("POST", "/api/admin/cas/kill", async (c) => {
  const b = await c.body(128);
  const on = b?.on === true;
  await c.env.DB.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cas_kill_switch',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(on ? "true" : "false", c.session.user.id, nowIso(c.now)).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.cas_kill_switch", detail: { on } }, c.now);
  return c.json({ ok: true, killSwitch: on });
}, true);

/* ───────────── AI 직원(회사 운영) — 운영자 전용 ───────────── */

add("GET", "/api/admin/company/overview", async (c) => {
  const has = await one(c.env.DB, "SELECT 1 AS x FROM ai_departments LIMIT 1");
  if (!has) await seedWorkforce(c.env.DB, c.now); // 최초 1회 조직 구성(멱등)
  return c.json(await companyOverview(c.env.DB, c.now));
}, true);

add("POST", "/api/admin/company/tick", async (c) => {
  const rt = buildRuntime(c.env);
  await seedWorkforce(c.env.DB, c.now);
  const r = await runTick(c.env.DB, rt.llm, c.now, { force: true });
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.manual_tick", detail: r }, c.now);
  return c.json(r);
}, true);

add("POST", "/api/admin/company/settings", async (c) => {
  const b = await c.body(512);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const map: Record<string, string> = { enabled: "workforce_enabled", paused: "workforce_paused", maxTasksPerTick: "workforce_max_tasks_per_tick", tickMinutes: "workforce_tick_minutes", dailyRunCap: "workforce_daily_run_cap" };
  for (const [k, key] of Object.entries(map)) if (b[k] !== undefined) {
    const v = typeof b[k] === "boolean" ? String(b[k]) : Number.isFinite(Number(b[k])) ? String(Math.floor(Number(b[k]))) : null;
    if (v === null) return c.json({ error: "bad_value", message: `${k} 값이 올바르지 않습니다.` }, 400);
    await setSetting(c.env.DB, c.session.user.id, key, v, c.now);
  }
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.settings", detail: b }, c.now);
  return c.json(await loadSettings(c.env.DB));
}, true);

add("POST", "/api/admin/company/tasks", async (c) => {
  const b = await c.body(8192);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const id = await createTask(c.env.DB, c.session.user.id, { department: String(b.department ?? ""), title: String(b.title ?? ""), detail: b.detail, priority: Number(b.priority) || 5, confidential: b.confidential === true, human: b.human === true }, c.now);
  return c.json({ ok: true, id }, 201);
}, true);

add("POST", "/api/admin/company/tasks/:id/complete", async (c, m) => { await completeHumanTask(c.env.DB, c.session.user.id, m[1]!, c.now); return c.json({ ok: true }); }, true);

add("POST", "/api/admin/company/approvals/:id/decide", async (c, m) => {
  const b = await c.body(1024);
  if (!b || typeof b.approve !== "boolean") return c.json({ error: "bad_request" }, 400);
  await decideApproval(c.env.DB, c.session.user.id, m[1]!, b.approve, String(b.note ?? ""), c.now);
  return c.json({ ok: true });
}, true);

add("PATCH", "/api/admin/company/providers/:name", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const p = await one<{ external: number }>(c.env.DB, "SELECT external FROM ai_providers WHERE name = ?", m[1]);
  if (!p) return c.json({ error: "not_found" }, 404);
  // 외부 무료 AI 를 켜는 것은 (개인정보를 지운) 업무 텍스트가 외부 사업자로 전송됨을 운영자가 인지했다는 확인이 필요하다.
  if (b.enabled === true && p.external && b.acknowledgeExternal !== true) return c.json({ error: "ack_required", message: "외부 AI 는 업무 텍스트(개인정보 마스킹 후)가 해당 사업자로 전송되며 무료 한도·약관 확인이 필요합니다. 확인했다면 acknowledgeExternal 을 true 로 보내세요." }, 400);
  if (b.dailyLimit !== undefined && (!Number.isInteger(b.dailyLimit) || b.dailyLimit < 0 || b.dailyLimit > 100000)) return c.json({ error: "bad_value" }, 400);
  if (b.enabled !== undefined) await c.env.DB.prepare("UPDATE ai_providers SET enabled = ? WHERE name = ?").bind(b.enabled ? 1 : 0, m[1]).run();
  if (b.dailyLimit !== undefined) await c.env.DB.prepare("UPDATE ai_providers SET daily_limit = ? WHERE name = ?").bind(b.dailyLimit, m[1]).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.provider_update", targetType: "ai_provider", targetId: m[1], detail: { enabled: b.enabled, dailyLimit: b.dailyLimit } }, c.now);
  return c.json({ ok: true });
}, true);

add("POST", "/api/admin/company/goals", async (c) => {
  const b = await c.body(512);
  const target = Number(b?.target);
  if (!b || typeof b.title !== "string" || !b.title.trim() || !["active_subscriptions", "mrr_usd", "ai_margin_pct"].includes(b.metric) || !Number.isFinite(target) || target <= 0) return c.json({ error: "bad_request", message: "title, metric(active_subscriptions|mrr_usd|ai_margin_pct), target(>0)이 필요합니다." }, 400);
  await c.env.DB.prepare("INSERT INTO company_goals(id,title,metric,target,created_at) VALUES(?,?,?,?,?)").bind(newId("goal"), b.title.trim().slice(0, 120), b.metric, target, nowIso(c.now)).run();
  return c.json({ ok: true }, 201);
}, true);

add("POST", "/api/admin/company/agents/:id/pause", async (c, m) => {
  const b = await c.body(128);
  const r = await c.env.DB.prepare("UPDATE ai_agents SET status = ? WHERE id = ?").bind(b?.paused === true ? "paused" : "idle", m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);

<<<<<<< ours
=======
/* ───────────── 제휴(Affiliate) ───────────── */

add("GET", "/api/affiliate", async (c) => c.json(await affiliateSummary(c.env.DB, c.session.user.id, c.env.APP_ORIGIN)));
add("POST", "/api/affiliate/apply", async (c) => {
  const b = await c.body(512);
  const r = await applyAffiliate(c.env.DB, c.session.user.id, String(b?.payoutEmail ?? ""), c.now);
  return c.json({ ok: true, ...r }, 201);
});

add("GET", "/api/admin/affiliate/overview", async (c) => c.json(await adminAffiliateOverview(c.env.DB)), true);
add("POST", "/api/admin/affiliate/:id/status", async (c, m) => {
  const b = await c.body(256);
  if (!b || !["approved", "suspended", "rejected"].includes(b.status)) return c.json({ error: "bad_request" }, 400);
  await setAffiliateStatus(c.env.DB, c.session.user.id, m[1]!, b.status, c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/referrals/:id/clear-flag", async (c, m) => { await clearReferralFlag(c.env.DB, c.session.user.id, m[1]!, c.now); return c.json({ ok: true }); }, true);
add("POST", "/api/admin/affiliate/payouts/:id/approve", async (c, m) => { await approvePayout(c.env.DB, c.session.user.id, m[1]!, c.now); return c.json({ ok: true }); }, true);
add("POST", "/api/admin/affiliate/payouts/:id/paid", async (c, m) => { const b = await c.body(512); await markPayoutPaid(c.env.DB, c.session.user.id, m[1]!, String(b?.reference ?? ""), c.now); return c.json({ ok: true }); }, true);
add("POST", "/api/admin/affiliate/payouts/:id/fail", async (c, m) => { const b = await c.body(512); await releasePayout(c.env.DB, c.session.user.id, m[1]!, "failed", String(b?.reason ?? ""), c.now); return c.json({ ok: true }); }, true);
add("POST", "/api/admin/affiliate/payouts/:id/reject", async (c, m) => { const b = await c.body(512); await releasePayout(c.env.DB, c.session.user.id, m[1]!, "rejected", String(b?.reason ?? ""), c.now); return c.json({ ok: true }); }, true);
add("PUT", "/api/admin/affiliate/policy", async (c) => { const b = await c.body(1024); if (!b) return c.json({ error: "bad_request" }, 400); return c.json(await saveAffiliatePolicy(c.env.DB, c.session.user.id, b, c.now)); }, true);
add("POST", "/api/admin/affiliate/settle", async (c) => { const b = await c.body(128); return c.json(await settleAffiliates(c.env.DB, c.now, { forcePayout: b?.forcePayout === true })); }, true);

>>>>>>> theirs
add("POST", "/api/billing/portal", async (c) => {
  const rt = buildRuntime(c.env);
  return c.json(await createPortal(c.env.DB, rt.paypal, c.session.user.id, c.env.APP_ORIGIN, rt.paypalEnv));
});

/* ───────────── 청구 ───────────── */

const invOut = (r: any) => ({ id: r.id, subscriptionId: r.subscription_id, status: r.status, totalMicro: r.total_micro, subtotalMicro: r.subtotal_micro, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at });

add("GET", "/api/billing/invoices", async (c) => {
  const sub = c.url.searchParams.get("subscription");
  const rows = sub
    ? await all(c.env.DB, "SELECT * FROM invoices WHERE customer_id = ? AND subscription_id = ? ORDER BY created_at DESC LIMIT 100", c.session.user.id, sub)
    : await all(c.env.DB, "SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100", c.session.user.id);
  return c.json(rows.map(invOut));
});

// 다음 결제 예정: 활성 구독의 가격 버전 합계(초과 사용료는 인보이스 확정 시점에 계산되므로 포함하지 않는다).
add("GET", "/api/billing/upcoming", async (c) => {
  const rows = await all(c.env.DB, `SELECT s.current_period_start AS ps, s.current_period_end AS pe, pr.monthly_micro AS m, s.quantity AS q
    FROM subscriptions s JOIN prices pr ON pr.id = s.price_version_id
    WHERE s.customer_id = ? AND s.status = 'active' AND s.cancel_at_period_end = 0 AND s.current_period_end IS NOT NULL ORDER BY s.current_period_end`, c.session.user.id);
  if (!rows.length) return c.json(null);
  const total = rows.reduce((a: number, r: any) => a + r.m * (r.q || 1), 0);
  return c.json({ totalMicro: total, periodStart: rows[0].ps, periodEnd: rows[0].pe, note: "초과 사용료 제외 기본 요금 합계(USD)" });
});

/* ───────────── 사용자 ───────────── */

add("GET", "/api/user/profile", async (c) => {
  const u = await one(c.env.DB, "SELECT id,email,role,status,locale,created_at FROM users WHERE id = ?", c.session.user.id);
  return c.json({ user: { id: u.id, email: u.email, role: u.role, status: u.status, locale: u.locale, createdAt: u.created_at } });
});

add("POST", "/api/user/password", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.currentPassword !== "string" || typeof b.newPassword !== "string") return c.json({ error: "bad_request" }, 400);
  const row = await one<{ password_hash: string }>(c.env.DB, "SELECT password_hash FROM users WHERE id = ?", c.session.user.id);
  if (!row || !(await verifyPassword(b.currentPassword, row.password_hash))) return c.json({ error: "invalid_credentials", message: "현재 비밀번호가 올바르지 않습니다." }, 403);
  const hash = await hashPasswordForUser(b.newPassword);
  if (!hash.ok) return c.json({ error: "weak_password", message: hash.message }, 400);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(hash.hash, nowIso(c.now), c.session.user.id).run();
  // 다른 기기의 세션은 모두 폐기하고 현재 세션만 유지한다.
  await c.env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL").bind(nowIso(c.now), c.session.user.id, c.session.sessionId).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "user.password_change", targetType: "user", targetId: c.session.user.id }, c.now);
  return c.json({ ok: true });
});

// 계정 삭제: 활성 구독이 있으면 거부(청구 중단 없이 계정만 지우면 결제가 계속되기 때문).
add("DELETE", "/api/user/account", async (c) => {
  const open = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ? AND status IN ('active','past_due','suspended','canceling')", c.session.user.id);
  if (open && open.n > 0) return c.json({ error: "active_subscriptions", message: "활성 구독이 있어 삭제할 수 없습니다. 먼저 모든 서비스를 취소하세요." }, 409);
  await c.env.DB.prepare("UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?").bind(nowIso(c.now), c.session.user.id).run();
  await revokeAllSessions(c.env.DB, c.session.user.id, c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "user.delete", targetType: "user", targetId: c.session.user.id }, c.now);
  return c.json({ ok: true });
});

/* ───────────── 도메인 ───────────── */

add("GET", "/api/domains", async (c) => {
  const zones = await all(c.env.DB, "SELECT id, hostname, status, name_servers_json, created_at, activated_at FROM dns_zones WHERE customer_id = ? ORDER BY created_at DESC", c.session.user.id);
  const orders = await all(c.env.DB, "SELECT id, hostname, status, created_at FROM domain_orders WHERE customer_id = ? AND status NOT IN ('expired','cancelled') ORDER BY created_at DESC", c.session.user.id);
  const seen = new Set(zones.map((z: any) => z.hostname));
  return c.json([
    ...zones.map((z: any) => ({ id: z.id, hostname: z.hostname, ownershipStatus: z.status === "active" ? "verified" : "pending", sslStatus: z.status === "active" ? "active" : "pending", nameServers: parseJson<string[]>(z.name_servers_json, []), createdAt: z.created_at, kind: "zone" })),
    ...orders.filter((o: any) => !seen.has(o.hostname)).map((o: any) => ({ id: o.id, hostname: o.hostname, ownershipStatus: "pending", sslStatus: "pending", orderStatus: o.status, createdAt: o.created_at, kind: "order" })),
  ]);
});

// 보유 도메인 연결: Cloudflare 영역을 만들고 네임서버를 안내한다.
add("POST", "/api/domains", async (c) => {
  const b = await c.body(8192);
  if (!b || typeof b.hostname !== "string") return c.json({ error: "bad_request" }, 400);
  const rt = buildRuntime(c.env);
  const r = await connectDomain(c.env.DB, rt.zones, c.session.user.id, b.hostname, c.now);
  return c.json({ ok: true, ...r }, 201);
});

add("GET", "/api/domains/check", async (c) => {
  const q = (c.url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(q) || q.length > 253) return c.json({ error: "bad_hostname" }, 400);
  const taken = await one(c.env.DB, "SELECT 1 AS x FROM dns_zones WHERE hostname = ? AND status != 'deleted'", q);
  return c.json({ hostname: q, connectedInCloudPress: !!taken, note: "등록 가능 여부와 가격은 견적 요청 시 등록기관에서 확인합니다." });
});

add("POST", "/api/domains/quote", async (c) => {
  const b = await c.body(8192);
  if (!b || typeof b.hostname !== "string" || typeof b.contact !== "object") return c.json({ error: "bad_request" }, 400);
  const rt = buildRuntime(c.env);
  const r = await createQuote(c.env.DB, rt.registrar, rt.crypto, { customerId: c.session.user.id, hostname: b.hostname, contact: b.contact, nowMs: c.now });
  return c.json(r, 201);
});

add("POST", "/api/domains/orders/:id/checkout", async (c, m) => {
  const rt = buildRuntime(c.env);
  return c.json(await createDomainCheckout(c.env.DB, rt.paypal, c.session.user.id, m[1]!, { appOrigin: c.env.APP_ORIGIN, nowMs: c.now }));
});

/* ───────────── 컨테이너 · 데이터베이스 (고객 소유 자원) ───────────── */

add("GET", "/api/containers", async (c) => {
  const rows = await all(c.env.DB, `SELECT c.id, c.subscription_id, c.instance_type, c.target_vcpu, c.actual_vcpu, c.state, c.created_at,
      (SELECT ip FROM container_instances i WHERE i.container_id = c.id ORDER BY i.created_at DESC LIMIT 1) AS ip
    FROM containers c WHERE c.customer_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC`, c.session.user.id);
  return c.json(rows);
});

// 컨테이너 제어는 실제 Cloudflare Containers 연결이 필요하다. 연결 전에는 성공한 것처럼 응답하지 않는다.
for (const act of ["start", "stop", "restart", "delete"]) {
  add("POST", `/api/containers/:id/${act}`, async (c, m) => {
    const owned = await one(c.env.DB, "SELECT id FROM containers WHERE id = ? AND customer_id = ? AND deleted_at IS NULL", m[1], c.session.user.id);
    if (!owned) return c.json({ error: "not_found" }, 404);
    if (c.env.CLOUDPRESS_MODE === "live") return c.json({ error: "not_configured", message: "컨테이너 매니저가 아직 연결되지 않아 이 작업을 실행할 수 없습니다. 운영자에게 문의하세요." }, 503);
    const to = act === "start" || act === "restart" ? "running" : act === "stop" ? "stopped" : "deleted";
    await c.env.DB.prepare("UPDATE containers SET state = ?, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END WHERE id = ?").bind(to, to, nowIso(c.now), m[1]).run();
    await audit(c.env.DB, { actorId: c.session.user.id, action: `container.${act}`, targetType: "container", targetId: m[1] }, c.now);
    return c.json({ ok: true, state: to, mode: "mock" });
  });
}

add("GET", "/api/databases", async (c) => {
  const dbs = await all(c.env.DB, "SELECT id, subscription_id, engine, provider, state, storage_limit_gb, last_backup_at, created_at FROM databases WHERE customer_id = ? ORDER BY created_at DESC", c.session.user.id);
  const out = [];
  for (const d of dbs) {
    out.push({ ...d,
      replicas: await all(c.env.DB, "SELECT id, replica_type, status, replication_lag_ms FROM database_replicas WHERE database_id = ?", d.id),
      pitrSnapshots: await all(c.env.DB, "SELECT id, created_at, expires_at FROM database_pitr_snapshots WHERE database_id = ?", d.id) });
  }
  return c.json({ databases: out });
});

// DB는 DB 상품 구독(결제) 후 작업 큐가 생성한다. 직접 생성 요청은 결제 흐름으로 안내한다.
add("POST", "/api/databases", async (c) => c.json({ error: "purchase_required", message: "ClouDB 상품을 구독하면 결제 확인 후 자동으로 생성됩니다.", next: "/services/create" }, 402));

for (const [act, label] of [["backup", "백업"], ["replicas", "레플리카"]] as const) {
  add("POST", `/api/databases/:id/${act}`, async (c, m) => {
    const d = await one(c.env.DB, "SELECT id FROM databases WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
    if (!d) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "not_configured", message: `${label} 실행기(컨테이너·R2 연동)가 아직 연결되지 않았습니다.` }, 503);
  });
}

/* ───────────── 운영자 전용: 관리자 · 게이트웨이 · 메쉬 · 관측 · 플릿 ───────────── */

add("GET", "/api/admin/summary", async (c) => {
  const db = c.env.DB;
  const users = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE status != 'deleted'");
  const subs = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'");
  const rev = await one<{ s: number }>(db, "SELECT COALESCE(SUM(amount_micro),0) AS s FROM payments WHERE status = 'succeeded' AND paid_at >= ?", nowIso(c.now - 30 * 86400_000));
  const dead = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM deployment_jobs WHERE state = 'dead'");
  const waste = await all(db, "SELECT resource_id, kind, payload_json FROM resource_recommendations WHERE status = 'open' ORDER BY est_saving_micro DESC LIMIT 20").catch(() => []);
  const pend = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM affiliate_payouts WHERE status = 'pending'");
  return c.json({
    totalUsers: users?.n ?? 0, activeSubscriptions: subs?.n ?? 0, totalRevenueMicro: rev?.s ?? 0,
    systemHealth: (dead?.n ?? 0) > 0 ? "degraded" : "healthy",
    wasteResources: (waste as any[]).map((w) => { const p = parseJson<any>(w.payload_json, {}); return { resourceId: w.resource_id, kind: w.kind, detail: p.detail ?? "", action: p.action ?? "" }; }),
    pendingApprovals: pend?.n ?? 0,
  });
}, true);

add("GET", "/api/admin/users", async (c) => c.json({ users: await all(c.env.DB, "SELECT id, email, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 500") }), true);

add("PATCH", "/api/admin/users/:id", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  if (m[1] === c.session.user.id) return c.json({ error: "self_change", message: "자기 자신의 권한·상태는 변경할 수 없습니다." }, 400);
  const sets: string[] = []; const vals: unknown[] = [];
  if (b.status !== undefined) { if (!["active", "suspended"].includes(b.status)) return c.json({ error: "bad_status" }, 400); sets.push("status = ?"); vals.push(b.status); }
  if (b.role !== undefined) { if (!["customer", "admin", "affiliate_only"].includes(b.role)) return c.json({ error: "bad_role" }, 400); sets.push("role = ?"); vals.push(b.role); }
  if (!sets.length) return c.json({ error: "nothing_to_update" }, 400);
  const r = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND status != 'deleted'`).bind(...vals, nowIso(c.now), m[1]).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  if (b.status === "suspended") await revokeAllSessions(c.env.DB, m[1]!, c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.user_update", targetType: "user", targetId: m[1], detail: { status: b.status, role: b.role } }, c.now);
  return c.json({ ok: true });
}, true);

add("GET", "/api/admin/subscriptions", async (c) => c.json({ subscriptions: await all(c.env.DB, `SELECT s.id, u.email AS customer_email, p.kind AS product_kind, s.status, s.billing_interval, s.current_period_end
  FROM subscriptions s JOIN users u ON u.id = s.customer_id JOIN products p ON p.id = s.product_id ORDER BY s.created_at DESC LIMIT 500`) }), true);

add("GET", "/api/admin/billing", async (c) => {
  const db = c.env.DB;
  const rev = await one<{ s: number }>(db, "SELECT COALESCE(SUM(amount_micro),0) AS s FROM payments WHERE status = 'succeeded' AND paid_at >= ?", nowIso(c.now - 30 * 86400_000));
  const out = await one<{ s: number }>(db, "SELECT COALESCE(SUM(total_micro),0) AS s FROM invoices WHERE status = 'open'");
  const ref = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM refunds");
  const act = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'");
  const invoices = await all(db, `SELECT i.id, u.email AS customer_email, i.total_micro, i.status, i.created_at,
      (SELECT paid_at FROM payments WHERE invoice_id = i.id AND status = 'succeeded' ORDER BY paid_at DESC LIMIT 1) AS paid_at
    FROM invoices i JOIN users u ON u.id = i.customer_id ORDER BY i.created_at DESC LIMIT 200`);
  return c.json({ monthlyRevenue: rev?.s ?? 0, outstanding: out?.s ?? 0, refundsCount: ref?.n ?? 0, activeSubscriptions: act?.n ?? 0, invoices });
}, true);

add("GET", "/api/admin/system", async (c) => {
  const db = c.env.DB;
  let d1Healthy = true; try { await one(db, "SELECT 1 AS ok"); } catch { d1Healthy = false; }
  const q = await all(db, "SELECT state, COUNT(*) AS n FROM deployment_jobs GROUP BY state");
  const n = (s: string) => (q.find((r: any) => r.state === s)?.n ?? 0) as number;
  const cont = await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM containers WHERE state = 'running' AND deleted_at IS NULL");
  const errs = await all(db, "SELECT action, target_type, ts, detail_json FROM audit_logs WHERE action LIKE '%failed%' OR action LIKE '%error%' ORDER BY ts DESC LIMIT 20");
  return c.json({
    apiP99: null, // Workers 요청 지연 분포는 이 API 에서 측정하지 않는다(관측 대시보드 사용).
    queuePending: n("queued") + n("retrying"), d1Healthy, activeContainers: cont?.n ?? 0,
    recentErrors: errs.map((e: any) => ({ message: e.action, timestamp: e.ts, endpoint: e.target_type ?? "-" })),
    queues: [{ name: "cloudpress-jobs", status: n("dead") > 0 ? "degraded" : "healthy", pending: n("queued"), processing: n("running"), completed: n("succeeded"), failed: n("failed") + n("dead") }],
    workers: [],
  });
}, true);

add("POST", "/api/admin/fx", async (c) => {
  const b = await c.body(512);
  const won = Number(b?.wonPerUsd);
  if (!Number.isFinite(won) || won < 100 || won > 100000) return c.json({ error: "bad_rate", message: "100~100,000 사이 값이어야 합니다." }, 400);
  const res = await recordFxSample(c.env.DB, { rateMicro: Math.round(won * 1e6), fetchedAtMs: c.now, source: "admin" }, c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.fx_update", detail: { won, status: res.status } }, c.now);
  return c.json({ ok: true, status: res.status, reason: res.reason });
}, true);

// 게이트웨이
const routeOut = (r: any) => ({ ...r, methods: parseJson<string[]>(r.methods_json, []) });
add("GET", "/api/gateway/routes", async (c) => c.json({ routes: (await all(c.env.DB, "SELECT * FROM api_gateway_routes ORDER BY created_at DESC")).map(routeOut) }), true);
add("POST", "/api/gateway/routes", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.name !== "string" || typeof b.pathPattern !== "string" || (!b.targetService && !b.targetUrl)) return c.json({ error: "bad_request" }, 400);
  if (b.targetUrl && !/^https:\/\//.test(String(b.targetUrl))) return c.json({ error: "bad_target", message: "targetUrl 은 https 만 허용됩니다." }, 400);
  const id = newId("rt"); const t = nowIso(c.now);
  try {
    await c.env.DB.prepare(`INSERT INTO api_gateway_routes(id,name,path_pattern,methods_json,target_service,target_url,strip_path_prefix,timeout_ms,retries,retry_backoff_ms,circuit_breaker_threshold,circuit_breaker_timeout_sec,auth_required,roles_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, b.name, b.pathPattern, JSON.stringify(b.methods ?? ["GET"]), b.targetService ?? null, b.targetUrl ?? null, b.stripPathPrefix ? 1 : 0,
      Math.min(Number(b.timeoutMs) || 30000, 120000), Math.min(Number(b.retries) || 0, 5), Number(b.retryBackoffMs) || 100, Number(b.circuitBreakerThreshold) || 5, Number(b.circuitBreakerTimeoutSec) || 30, b.authRequired === false ? 0 : 1, JSON.stringify(b.roles ?? []), t, t).run();
  } catch (e: any) { return c.json({ error: "conflict", message: "이름 또는 경로가 이미 존재하거나 값이 올바르지 않습니다." }, 409); }
  await audit(c.env.DB, { actorId: c.session.user.id, action: "gateway.route_create", targetType: "route", targetId: id }, c.now);
  return c.json({ ok: true, id }, 201);
}, true);
add("DELETE", "/api/gateway/routes/:id", async (c, m) => {
  const r = await c.env.DB.prepare("DELETE FROM api_gateway_routes WHERE id = ?").bind(m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);

// 서비스 메쉬
add("GET", "/api/mesh/services", async (c) => {
  const ns = c.url.searchParams.get("namespace") ?? "default";
  const rows = await all(c.env.DB, "SELECT service_name, namespace, COUNT(*) AS n FROM service_endpoints WHERE namespace = ? AND deregistered_at IS NULL AND healthy = 1 GROUP BY service_name, namespace", ns);
  return c.json({ services: rows.map((r: any) => ({ serviceName: r.service_name, namespace: r.namespace, endpointCount: r.n })) });
}, true);
add("GET", "/api/mesh/policies", async (c) => c.json({ policies: (await all(c.env.DB, "SELECT * FROM traffic_policies ORDER BY priority, created_at")).map((p: any) => ({ id: p.id, sourceService: p.source_service, targetService: p.target_service, namespace: p.namespace, policy: p.policy, priority: p.priority, config: parseJson(p.config_json, {}) })) }), true);
add("POST", "/api/mesh/policies", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.sourceService !== "string" || typeof b.targetService !== "string" || typeof b.policy !== "string") return c.json({ error: "bad_request" }, 400);
  const id = newId("tp"); const t = nowIso(c.now);
  try {
    await c.env.DB.prepare("INSERT INTO traffic_policies(id,source_service,target_service,namespace,policy,config_json,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(id, b.sourceService, b.targetService, b.namespace ?? "default", b.policy, JSON.stringify(b.config ?? {}), Number(b.priority) || 100, t, t).run();
  } catch { return c.json({ error: "bad_policy", message: "정책 값이 올바르지 않습니다." }, 400); }
  return c.json({ ok: true, id }, 201);
}, true);
add("GET", "/api/mesh/certificates", async (c) => c.json({ certificates: await all(c.env.DB, "SELECT id, service_name, namespace, issued_at, expires_at FROM service_certificates WHERE revoked = 0 ORDER BY expires_at") }), true);

// 관측
add("GET", "/api/observability/alerts", async (c) => c.json({ alerts: (await all(c.env.DB, `SELECT e.id, e.alert_id, a.name AS alert_name, a.metric_name, a.severity, e.status, e.value
  FROM observability_alert_events e JOIN observability_alerts a ON a.id = e.alert_id ORDER BY e.started_at DESC LIMIT 200`)).map((r: any) => ({ id: r.id, alertId: r.alert_id, alertName: r.alert_name, metricName: r.metric_name, severity: r.severity, status: r.status, value: r.value })) }), true);
add("POST", "/api/observability/alerts", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.name !== "string" || typeof b.metricName !== "string" || typeof b.condition !== "object") return c.json({ error: "bad_request" }, 400);
  const id = newId("al"); const t = nowIso(c.now);
  try {
    await c.env.DB.prepare("INSERT INTO observability_alerts(id,name,description,metric_name,condition_json,severity,enabled,notification_channels_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(id, b.name, b.description ?? null, b.metricName, JSON.stringify(b.condition), b.severity ?? "warning", b.enabled === false ? 0 : 1, JSON.stringify(b.notificationChannels ?? []), t, t).run();
  } catch { return c.json({ error: "conflict", message: "이미 같은 이름의 알림이 있거나 값이 올바르지 않습니다." }, 409); }
  return c.json({ ok: true, id }, 201);
}, true);
add("POST", "/api/observability/alerts/:id/ack", async (c, m) => {
  const r = await c.env.DB.prepare("UPDATE observability_alert_events SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND status = 'firing'").bind(nowIso(c.now), c.session.user.id, m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);
add("GET", "/api/observability/slos", async (c) => c.json({ slos: (await all(c.env.DB, "SELECT * FROM observability_slos ORDER BY created_at DESC")).map((s: any) => ({ id: s.id, name: s.name, service: s.service, target: s.target, window: s.window, current: null, met: false, errorBudgetRemaining: 0 })) }), true);
add("POST", "/api/observability/metrics/query", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.name !== "string") return c.json({ error: "bad_request" }, 400);
  const from = new Date(Number(b.fromMs) || c.now - 3600_000).toISOString(); const to = new Date(Number(b.toMs) || c.now).toISOString();
  const agg = ["avg", "sum", "min", "max", "count"].includes(b.aggregation) ? (b.aggregation as string).toUpperCase() : "AVG";
  const r = await one(c.env.DB, `SELECT ${agg}(value) AS value, COUNT(*) AS points FROM observability_metrics WHERE metric_name = ? AND timestamp BETWEEN ? AND ?`, b.name, from, to);
  return c.json({ name: b.name, aggregation: agg.toLowerCase(), value: r?.value ?? null, points: r?.points ?? 0, from, to });
}, true);

// 플릿 배포: 기록·상태 관리만 한다. 실제 롤아웃은 컨테이너 매니저 연결 후 실행된다.
const depOut = (d: any) => ({ id: d.id, name: d.name, status: d.status, strategy: parseJson<any>(d.strategy_json, {}).type ?? "rolling", currentStep: d.current_step, totalSteps: d.total_steps, targetVersion: d.target_version, startedAt: d.started_at });
add("GET", "/api/fleet/deployments", async (c) => c.json({ deployments: (await all(c.env.DB, "SELECT * FROM fleet_deployments ORDER BY started_at DESC LIMIT 200")).map(depOut) }), true);
add("POST", "/api/fleet/deployments", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.name !== "string" || typeof b.targetVersion !== "string") return c.json({ error: "bad_request" }, 400);
  const type = b.strategy?.type ?? "rolling";
  if (!["rolling", "canary", "blue_green", "recreate"].includes(type)) return c.json({ error: "bad_strategy" }, 400);
  const id = newId("deploy");
  await c.env.DB.prepare("INSERT INTO fleet_deployments(id,name,subscription_id,strategy_json,status,current_step,total_steps,target_version,started_at) VALUES(?,?,NULL,?,'pending',0,?,?,?)")
    .bind(id, b.name, JSON.stringify({ ...b.strategy, type }), type === "recreate" ? 1 : 5, b.targetVersion, nowIso(c.now)).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "fleet.deployment_create", targetType: "deployment", targetId: id }, c.now);
  return c.json({ ok: true, id, note: "배포 기록이 생성되었습니다. 실제 롤아웃은 컨테이너 매니저 연결 후 실행됩니다." }, 201);
}, true);
for (const [act, from, to] of [["pause", "running", "paused"], ["resume", "paused", "running"], ["rollback", "", "rolled_back"]] as const) {
  add("POST", `/api/fleet/deployments/:id/${act}`, async (c, m) => {
    const r = act === "rollback"
      ? await c.env.DB.prepare("UPDATE fleet_deployments SET status = 'rolled_back' WHERE id = ? AND status != 'rolled_back'").bind(m[1]).run()
      : await c.env.DB.prepare("UPDATE fleet_deployments SET status = ? WHERE id = ? AND status = ?").bind(to, m[1], from).run();
    if (!r.meta.changes) return c.json({ error: "bad_state", message: "현재 상태에서는 실행할 수 없습니다." }, 409);
    await audit(c.env.DB, { actorId: c.session.user.id, action: `fleet.${act}`, targetType: "deployment", targetId: m[1] }, c.now);
    return c.json({ ok: true });
  }, true);
}

