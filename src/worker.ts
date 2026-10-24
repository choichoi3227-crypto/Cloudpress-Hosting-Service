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
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra }
  });
}

async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clientIp = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

function comingSoon(feature: string) {
  return json({ comingSoon: true, feature, message: "출시 예정" }, 501);
}

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
      return json({
        ok: true,
        mode: env.CLOUDPRESS_MODE,
        stripeWebhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET),
        encryptionKeyConfigured: Boolean(env.SECRETS_ENCRYPTION_KEY),
        liveIntegrations: []
      });
    }

    if (url.pathname === "/api/webhooks/stripe" && req.method === "POST") {
      if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 503);
      const raw = await req.text();
      if (raw.length > 1_000_000) return json({ error: "too_large" }, 413);
      const r = await handleStripeWebhook(env.DB, raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET, now);
      if (r.status === 200 && env.JOBS) await dispatchOutbox(env.DB, env.JOBS, now).catch(() => 0);
      return new Response(r.body, { status: r.status, headers: SECURITY_HEADERS });
    }

    if (!originAllowed(req.method, req.headers.get("Origin"), env.APP_ORIGIN)) {
      return json({ error: "bad_origin" }, 403);
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const rl = await limiter.hit("reg:" + clientIp(req), 5, 3600, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });

      const b = await readJson(req, 4096);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") {
        return json({ error: "bad_request" }, 400);
      }

      try {
        // D1 테이블 자동 생성 안전장치 추가 (테이블 부재로 인한 500 에러 방지)
        if (typeof env.DB.prepare === "function") {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              email TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              role TEXT DEFAULT 'customer',
              status TEXT DEFAULT 'active',
              locale TEXT DEFAULT 'ko',
              timezone TEXT DEFAULT 'Asia/Seoul',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `).run().catch(() => {});
        }

        const r = await registerUser(env.DB, b.email, b.password, now);
        return r.ok 
          ? json({ ok: true }, 201) 
          : json({ error: r.code, message: r.message }, r.code === "email_taken" ? 409 : 400);
      } catch (regErr: any) {
        console.error("[Register Error Detail]", regErr?.message, regErr?.stack);
        return json({ error: "internal_error", details: regErr?.message }, 500);
      }
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

    if (url.pathname === "/api/plans" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM products WHERE on_sale = 1 ORDER BY monthly_micro").all();
      return json(results);
    }

    if (!session) return json({ error: "unauthenticated" }, 401);

    if (url.pathname === "/api/user/profile" && req.method === "GET") {
      return json({ user: session.user });
    }

    return json({ error: "not_found" }, 404);
  } catch (e: any) {
    console.error("[API Fatal Error]", e?.message, e?.stack);
    if (e instanceof ServiceError) return json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : 400);
    if (e instanceof ForbiddenError) return json({ error: "forbidden" }, 403);
    if (e instanceof ConfigError) return json({ error: "not_configured", message: e.message }, 503);
    return json({ error: "internal_error", details: e?.message }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env);
    }

    if (/^\/services\/[^/]+\/?$/.test(url.pathname) && !url.pathname.startsWith("/services/_")) {
      return env.ASSETS.fetch(new Request(new URL("/services/_/", url), req));
    }

    const assetResponse = await env.ASSETS.fetch(req);
    if (assetResponse.status === 404 && !url.pathname.includes(".")) {
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), req));
    }

    return assetResponse;
  },

  async queue(batch: { messages: { body: { jobId: string }; ack(): void }[] }, env: Env): Promise<void> {
    const rt = buildRuntime(env);
    await consumeBatch({
      db: env.DB,
      nowMs: Date.now(),
      stripe: rt.stripe,
      portFor: rt.portFor,
      nsPortFor: rt.nsPortFor,
      zones: rt.zones,
      crypto: rt.crypto,
      provisioner: rt.provisioner
    }, batch.messages);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const rt = buildRuntime(env);
    await runScheduled(env.DB, { queue: env.JOBS ?? null, zones: rt.zones }, Date.now());
  },
};
