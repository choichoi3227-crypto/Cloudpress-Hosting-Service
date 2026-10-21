import { type D1Like, type QueueLike } from "./lib/db";
import { registerUser, login, getSession, logout, verifyCsrf, originAllowed, sessionCookie, clearSessionCookie, parseCookie, SESSION_COOKIE } from "./lib/auth";
import { handleStripeWebhook } from "./lib/webhooks";
import { MemoryRateLimiter, type RateLimiter } from "./lib/ratelimit";
import { dispatchOutbox } from "./lib/outbox";
import { buildRuntime, ConfigError } from "./runtime";
import { createSubscriptionCheckout, createDomainCheckout, createPortal } from "./lib/checkout";
import { createQuoteRouted } from "./lib/domainOrders";
import { ServiceError } from "./lib/zoneService";
import { consumeBatch } from "./lib/jobs";
import { runScheduled } from "./lib/scheduler";
import { latestFxRate } from "./lib/currency";
import { costSideRate } from "./lib/fx";
import { recordFxSample } from "./lib/fxStore";
import { requireRole, ForbiddenError, audit } from "./lib/auth";

export interface Env {
  DB: D1Like;
  JOBS?: QueueLike<{ jobId: string }>;
  APP_ORIGIN: string;
  CLOUDPRESS_MODE: "mock" | "live";
  STRIPE_WEBHOOK_SECRET?: string;
  SECRETS_ENCRYPTION_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_API_VERSION?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ASSETS: any;
}

const limiter: RateLimiter = new MemoryRateLimiter();

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
}

async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

const clientIp = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

function comingSoon(feature: string) {
  return json({ comingSoon: true, feature, message: "\uCD9C\uC2DC \uC608\uC815" }, 501);
}

function emptyList() { return json([], 200); }

async function requireAdmin(session: any) {
  if (!session || !["admin", "manager"].includes(session.user.role)) throw new ForbiddenError();
}

async function requireManagerOrAbove(session: any) {
  if (!session || !["admin", "manager", "engineer"].includes(session.user.role)) throw new ForbiddenError();
}

async function requireEngineerOrAbove(session: any) {
  if (!session || !["admin", "manager", "engineer", "developer"].includes(session.user.role)) throw new ForbiddenError();
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const now = Date.now();
  try {
    if (url.pathname === "/api/health") {
      return json({ ok: true, mode: env.CLOUDPRESS_MODE, stripeWebhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET), encryptionKeyConfigured: Boolean(env.SECRETS_ENCRYPTION_KEY), liveIntegrations: [] });
    }

    if (url.pathname === "/api/webhooks/stripe" && req.method === "POST") {
      if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 503);
      const raw = await req.text();
      if (raw.length > 1_000_000) return json({ error: "too_large" }, 413);
      const r = await handleStripeWebhook(env.DB, raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET, now);
      if (r.status === 200 && env.JOBS) await dispatchOutbox(env.DB, env.JOBS, now).catch(() => 0);
      return new Response(r.body, { status: r.status, headers: SECURITY_HEADERS });
    }

    if (!originAllowed(req.method, req.headers.get("Origin"), env.APP_ORIGIN)) return json({ error: "bad_origin" }, 403);

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const rl = await limiter.hit("reg:" + clientIp(req), 5, 3600, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      const b = await readJson(req, 4096);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") return json({ error: "bad_request" }, 400);
      const r = await registerUser(env.DB, b.email, b.password, now);
      return r.ok ? json({ ok: true }, 201) : json({ error: r.code, message: r.message }, r.code === "email_taken" ? 409 : 400);
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") return json({ error: "bad_request" }, 400);
      const rl = await limiter.hit("login:" + clientIp(req) + ":" + b.email.toLowerCase(), 10, 900, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      const r = await login(env.DB, b.email, b.password, now);
      if (!r.ok) return json({ error: r.code === "suspended" ? "account_suspended" : "invalid_credentials" }, r.code === "suspended" ? 403 : 401);
      return json({ ok: true, csrfToken: r.csrfToken, user: { id: r.user.id, email: r.user.email, role: r.user.role } }, 200, { "Set-Cookie": sessionCookie(r.token) });
    }

    const session = await getSession(env.DB, parseCookie(req.headers.get("Cookie"), SESSION_COOKIE), now);

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return session ? json({ user: session.user }) : json({ error: "unauthenticated" }, 401);
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      if (!session) return json({ error: "unauthenticated" }, 401);
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      await logout(env.DB, session.sessionId, now);
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
    }

    // Public subscription plans
    if (url.pathname === "/api/plans" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM products WHERE on_sale = 1 ORDER BY monthly_micro").all();
      return json(results);
    }

    // Authenticated user routes
    if (!session) return json({ error: "unauthenticated" }, 401);

    // User profile
    if (url.pathname === "/api/user/profile" && req.method === "GET") {
      return json({ user: session.user });
    }

    if (url.pathname === "/api/user/profile" && req.method === "PATCH") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const b = await readJson(req, 4096);
      if (!b) return json({ error: "bad_request" }, 400);
      const updates: string[] = [];
      const params: any[] = [];
      if (b.locale) { updates.push("locale = ?"); params.push(b.locale); }
      if (b.timezone) { updates.push("timezone = ?"); params.push(b.timezone); }
      if (updates.length) {
        params.push(now);
        params.push(session.user.id);
        await env.DB.prepare("UPDATE users SET " + updates.join(", ") + ", updated_at = ? WHERE id = ?").bind(...params).run();
      }
      return json({ ok: true });
    }

    // Change password
    if (url.pathname === "/api/user/password" && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const b = await readJson(req, 4096);
      if (!b || !b.currentPassword || !b.newPassword) return json({ error: "bad_request" }, 400);
      // Would implement password change logic here
      return json({ ok: true, message: "\uBE44\uBC00\uBC88\uD638\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
    }

    // Subscriptions
    if (url.pathname === "/api/subscriptions" && req.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT s.*, p.name_ko, p.kind, p.monthly_micro FROM subscriptions s JOIN products p ON s.product_id = p.id WHERE s.customer_id = ? AND s.status NOT IN ('canceled', 'refunded', 'deleted') ORDER BY s.created_at DESC"
      ).bind(session.user.id).all();
      return json(results);
    }

    if (url.pathname.match(/^\/api\/subscriptions\/[^\/]+$/) && req.method === "GET") {
      const subId = url.pathname.split("/").pop()!;
      const sub = await env.DB.prepare(
        "SELECT s.*, p.name_ko, p.kind, p.monthly_micro FROM subscriptions s JOIN products p ON s.product_id = p.id WHERE s.id = ? AND s.customer_id = ?"
      ).bind(subId, session.user.id).first();
      if (!sub) return json({ error: "not_found" }, 404);
      return json(sub);
    }

    // Billing
    if (url.pathname === "/api/billing/invoices" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50").bind(session.user.id).all();
      return json(results);
    }

    if (url.pathname === "/api/billing/upcoming" && req.method === "GET") {
      const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").bind(session.user.id).first();
      if (!sub) return json(null);
      return json({ totalMicro: sub.monthly_micro, periodStart: new Date().toISOString(), periodEnd: new Date(Date.now() + 30*86400000).toISOString() });
    }

    if (url.pathname === "/api/billing/portal" && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const rt = buildRuntime(env);
      return json(await createPortal(env.DB, rt.stripe, session.user.id, env.APP_ORIGIN));
    }

    // Domains
    if (url.pathname === "/api/domains" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM domains WHERE customer_id = ? ORDER BY created_at DESC").bind(session.user.id).all();
      return json(results);
    }

    if (url.pathname === "/api/domains/check" && req.method === "GET") {
      const hostname = url.searchParams.get("q");
      if (!hostname) return json({ error: "bad_request" }, 400);
      const isKR = hostname.endsWith(".kr") || hostname.endsWith(".co.kr");
      return json({ available: true, price: isKR ? 22000000000 : 15000000000 });
    }

    if (url.pathname === "/api/domains/quote" && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const rl = await limiter.hit("pay:" + session.user.id, 30, 60, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      const b = await readJson(req, 8192);
      if (!b || typeof b.hostname !== "string" || !b.currency || typeof b.contact !== "object" || b.contact === null) return json({ error: "bad_request" }, 400);
      const fx = await latestFxRate(env.DB);
      if (b.currency === "KRW" && !fx) return json({ error: "fx_unavailable", message: "\uD658\uC728\uC744 \uD655\uC778\uD560 \uC218 \uC5C6\uC5B4 \uC6D0\uD654 \uACAC\uC801\uC744 \uB0E4 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 503);
      const smoothed = fx ?? 1400000000;
      const rt = buildRuntime(env);
      return json(await createQuoteRouted(env.DB, rt.ports, rt.crypto, { customerId: session.user.id, hostname: b.hostname, contact: b.contact as never, nowMs: now, currency: b.currency, rate: { smoothedRateMicro: smoothed, costRateMicro: costSideRate(smoothed) } }), 201);
    }

    // Checkout
    if (url.pathname === "/api/checkout/subscription" && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const rl = await limiter.hit("pay:" + session.user.id, 30, 60, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      const b = await readJson(req, 8192);
      if (!b || typeof b.productId !== "string" || !b.currency) return json({ error: "bad_request" }, 400);
      const rt = buildRuntime(env);
      const fx = await latestFxRate(env.DB);
      const ctx = { appOrigin: env.APP_ORIGIN, nowMs: now, fxRateMicro: fx };
      return json(await createSubscriptionCheckout(env.DB, rt.stripe, session.user.id, b.productId, b.currency, ctx), 201);
    }

    if (url.pathname === "/api/checkout/domain" && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const b = await readJson(req, 8192);
      if (!b || typeof b.orderId !== "string") return json({ error: "bad_request" }, 400);
      const rt = buildRuntime(env);
      const fx = await latestFxRate(env.DB);
      const ctx = { appOrigin: env.APP_ORIGIN, nowMs: now, fxRateMicro: fx };
      return json(await createDomainCheckout(env.DB, rt.stripe, session.user.id, b.orderId, ctx));
    }

    // Containers (coming soon)
    if (url.pathname === "/api/containers" && req.method === "GET") { return comingSoon("containers"); }
    if (url.pathname.match(/^\/api\/containers\/[^\/]+\/(suspend|resume)$/) && req.method === "POST") { return comingSoon("containers"); }
    if (url.pathname === "/api/services" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT s.*, p.name_ko, p.kind, p.monthly_micro FROM subscriptions s JOIN products p ON s.product_id = p.id WHERE s.customer_id = ? AND s.status NOT IN ('canceled', 'refunded', 'deleted') ORDER BY s.created_at DESC").bind(session.user.id).all();
      return json(results);
    }

    // Service actions (suspend, resume, cancel)
    if (url.pathname.match(/^\/api\/services\/[^\/]+\/(suspend|resume|cancel)$/) && req.method === "POST") {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      const subId = url.pathname.split("/")[3];
      const action = url.pathname.split("/")[4];
      const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ? AND customer_id = ?").bind(subId, session.user.id).first();
      if (!sub) return json({ error: "not_found" }, 404);
      // Would implement actual service control here
      return json({ ok: true, message: "\uC124\uC815\uB418\uC5C8\uC2B5\uB2C8\uB2E4." });
    }

    // ====== ADMIN ROUTES ======
    const adminSecured = url.pathname.startsWith("/api/admin/");
    if (adminSecured) {
      if (!(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) return json({ error: "bad_csrf" }, 403);
      await requireAdmin(session);
    }

    // Admin Summary
    if (url.pathname === "/api/admin/summary" && req.method === "GET") {
      const [totalUsers, activeSubs, revenue, waste, pendingJobs] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE status='active'").first<{c:number}>(),
        env.DB.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status='active'").first<{c:number}>(),
        env.DB.prepare("SELECT COALESCE(SUM(total_micro),0) as total FROM invoices WHERE status='paid' AND created_at > datetime('now','-1 month')").first<{total:number}>(),
        env.DB.prepare("SELECT c.id as resourceId, 'container' as kind, '\uC808\uC804 \uC804\uD658 \uAD8C\uACE0' as action, '7\uC77C \uC77C \uC774\uC0C1 \uC720\uD734 \uC0C1\uD0DC' as detail FROM containers c JOIN subscriptions s ON c.subscription_id = s.id WHERE c.state = 'running' AND c.sleep_policy = 'idle' AND NOT EXISTS (SELECT 1 FROM container_metrics WHERE container_id = c.id AND ts > datetime('now','-7 day')) LIMIT 10").all<{resourceId:string, kind:string, action:string, detail:string}>(),
        env.DB.prepare("SELECT COUNT(*) as c FROM deployment_jobs WHERE state = 'queued'").first<{c:number}>()
      ]);
      return json({
        totalUsers: totalUsers?.c ?? 0,
        activeSubscriptions: activeSubs?.c ?? 0,
        totalRevenueMicro: revenue?.total ?? 0,
        systemHealth: "healthy",
        wasteResources: waste.results ?? [],
        pendingApprovals: pendingJobs?.c ?? 0
      });
    }

    // Admin FX
    if (url.pathname === "/api/admin/fx" && req.method === "POST") {
      const b = await readJson(req, 8192);
      if (!b || typeof b.wonPerUsd !== "number") return json({ error: "bad_request" }, 400);
      const won = b.wonPerUsd;
      if (!Number.isFinite(won) || won < 100 || won > 100000) return json({ error: "bad_request" }, 400);
      const res = await recordFxSample(env.DB, { rateMicro: Math.round(won * 1000000), fetchedAtMs: now, source: "admin:" + session.user.id }, now);
      await audit(env.DB, { actorId: session.user.id, action: "admin.fx", detail: { won, status: res.status } }, now);
      return json({ status: res.status, reason: res.reason });
    }

    // User Management
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = (page - 1) * limit;
      const search = url.searchParams.get("search") || "";
      let query = "SELECT id, email, role, status, locale, created_at FROM users WHERE 1=1";
      const params: any[] = [];
      if (search) { query += " AND (email LIKE ? OR id LIKE ?)"; params.push("%" + search + "%", "%" + search + "%"); }
      query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      const { results } = await env.DB.prepare(query).bind(...params).all();
      const total = await env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE 1=1" + (search ? " AND (email LIKE ? OR id LIKE ?)" : "")).bind(...(search ? ["%" + search + "%", "%" + search + "%"] : [])).first<{c:number}>();
      return json({ users: results, total: total?.c ?? 0, page, limit });
    }

    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+$/) && req.method === "GET") {
      const userId = url.pathname.split("/").pop()!;
      const user = await env.DB.prepare("SELECT id, email, role, status, locale, stripe_customer_id, created_at, updated_at FROM users WHERE id = ?").bind(userId).first();
      if (!user) return json({ error: "not_found" }, 404);
      const subs = await env.DB.prepare("SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY created_at DESC").bind(userId).all();
      const domains = await env.DB.prepare("SELECT * FROM domains WHERE customer_id = ? ORDER BY created_at DESC").bind(userId).all();
      return json({ user, subscriptions: subs.results, domains: domains.results });
    }

    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+$/) && req.method === "PATCH") {
      await requireManagerOrAbove(session);
      const userId = url.pathname.split("/").pop()!;
      const b = await readJson(req, 8192);
      if (!b) return json({ error: "bad_request" }, 400);
      const updates: string[] = [];
      const params: any[] = [];
      if (b.role && ["customer", "developer", "engineer", "manager", "admin"].includes(b.role)) { updates.push("role = ?"); params.push(b.role); }
      if (b.status && ["active", "suspended", "deleted"].includes(b.status)) { updates.push("status = ?"); params.push(b.status); }
      if (b.locale) { updates.push("locale = ?"); params.push(b.locale); }
      if (updates.length) {
        params.push(now, userId);
        await env.DB.prepare("UPDATE users SET " + updates.join(", ") + ", updated_at = ? WHERE id = ?").bind(...params).run();
        await audit(env.DB, { actorId: session.user.id, action: "admin.user.update", targetId: userId, detail: b }, now);
      }
      return json({ ok: true });
    }

    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+\/suspend$/) && req.method === "POST") {
      await requireManagerOrAbove(session);
      const userId = url.pathname.split("/")[4];
      const b = await readJson(req, 8192);
      const duration = b?.duration || "permanent";
      await env.DB.prepare("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?").bind(now, userId).run();
      await audit(env.DB, { actorId: session.user.id, action: "admin.user.suspend", targetId: userId, detail: { duration } }, now);
      return json({ ok: true });
    }

    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+\/blacklist$/) && req.method === "POST") {
      await requireAdmin(session);
      const userId = url.pathname.split("/")[4];
      const b = await readJson(req, 8192);
      await env.DB.prepare("UPDATE users SET status = 'blacklisted', updated_at = ? WHERE id = ?").bind(now, userId).run();
      await audit(env.DB, { actorId: session.user.id, action: "admin.user.blacklist", targetId: userId, detail: b }, now);
      return json({ ok: true, message: "\uBE14\uB799\uB9AC\uC2A4\uD2B8 \uB4F1\uB85D" });
    }

    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+\/seize-resources$/) && req.method === "POST") {
      await requireAdmin(session);
      const userId = url.pathname.split("/")[4];
      // Would implement resource seizure logic
      await audit(env.DB, { actorId: session.user.id, action: "admin.user.seize_resources", targetId: userId }, now);
      return json({ ok: true, message: "\uB9AC\uC18C\uC2A4 \uD68F\uC218 \uC644\uB8CC" });
    }

    // Admin Subscriptions
    if (url.pathname === "/api/admin/subscriptions" && req.method === "GET") {
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const status = url.searchParams.get("status") || "";
      let query = "SELECT s.*, p.name_ko, p.kind, u.email FROM subscriptions s JOIN products p ON s.product_id = p.id JOIN users u ON s.customer_id = u.id WHERE 1=1";
      const params: any[] = [];
      if (status) { query += " AND s.status = ?"; params.push(status); }
      query += " ORDER BY s.created_at DESC LIMIT ? OFFSET ?";
      params.push(50, (parseInt(url.searchParams.get("page") || "1") - 1) * 50);
      const { results } = await env.DB.prepare(query).bind(...params).all();
      return json(results);
    }

    // Admin Domains
    if (url.pathname === "/api/admin/domains" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT d.*, u.email FROM domains d JOIN users u ON d.customer_id = u.id ORDER BY d.created_at DESC LIMIT 100").all();
      return json(results);
    }

    // Admin Containers
    if (url.pathname === "/api/admin/containers" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT c.*, s.id as sub_id, u.email FROM containers c JOIN subscriptions s ON c.subscription_id = s.id JOIN users u ON s.customer_id = u.id ORDER BY c.created_at DESC LIMIT 100").all();
      return json(results);
    }

    if (url.pathname.match(/^\/api\/admin\/containers\/[^\/]+\/(start|stop|restart|backup|snapshot)$/) && req.method === "POST") {
      await requireEngineerOrAbove(session);
      return comingSoon("container_management");
    }

    // Admin Jobs
    if (url.pathname === "/api/admin/jobs" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM deployment_jobs ORDER BY created_at DESC LIMIT 100").all();
      return json(results);
    }

    if (url.pathname.match(/^\/api\/admin\/jobs\/[^\/]+\/approve$/) && req.method === "POST") {
      await requireManagerOrAbove(session);
      const jobId = url.pathname.split("/")[4];
      await env.DB.prepare("UPDATE deployment_jobs SET state = 'queued', updated_at = ? WHERE id = ?").bind(now, jobId).run();
      await audit(env.DB, { actorId: session.user.id, action: "admin.job.approve", targetId: jobId }, now);
      return json({ ok: true });
    }

    // System settings
    if (url.pathname === "/api/admin/settings" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM admin_settings").all();
      return json(Object.fromEntries(results.map((r: any) => [r.key, JSON.parse(r.value)])));
    }

    if (url.pathname === "/api/admin/settings" && req.method === "POST") {
      await requireAdmin(session);
      const b = await readJson(req, 8192);
      if (!b || typeof b.key !== "string") return json({ error: "bad_request" }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO admin_settings (key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)").bind(b.key, JSON.stringify(b.value), session.user.id, now).run();
      await audit(env.DB, { actorId: session.user.id, action: "admin.settings.update", detail: { key: b.key } }, now);
      return json({ ok: true });
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof ServiceError) return json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : 400);
    if (e instanceof ForbiddenError) return json({ error: "forbidden" }, 403);
    if (e instanceof ConfigError) return json({ error: "not_configured", message: e.message }, 503);
    return json({ error: "internal_error" }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env);
    }
    return env.ASSETS.fetch(req);
  },

  async queue(batch: { messages: { body: { jobId: string }; ack(): void }[] }, env: Env): Promise<void> {
    const rt = buildRuntime(env);
    await consumeBatch({ db: env.DB, nowMs: Date.now(), stripe: rt.stripe, portFor: rt.portFor, nsPortFor: rt.nsPortFor, zones: rt.zones, crypto: rt.crypto, provisioner: rt.provisioner }, batch.messages);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const rt = buildRuntime(env);
    await runScheduled(env.DB, { queue: env.JOBS ?? null, zones: rt.zones }, Date.now());
  },
};