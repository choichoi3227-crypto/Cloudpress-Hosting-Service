import { type D1Like, type QueueLike } from "./lib/db";
import { registerUser, login, getSession, logout, verifyCsrf, originAllowed, sessionCookie, clearSessionCookie, parseCookie, SESSION_COOKIE } from "./lib/auth";
import { handleStripeWebhook } from "./lib/webhooks";
import { MemoryRateLimiter, type RateLimiter } from "./lib/ratelimit";
import { dispatchOutbox } from "./lib/outbox";

export interface Env {
  DB: D1Like;
  JOBS?: QueueLike<{ jobId: string }>;
  APP_ORIGIN: string;
  CLOUDPRESS_MODE: "mock" | "live";
  STRIPE_WEBHOOK_SECRET?: string;
  SECRETS_ENCRYPTION_KEY?: string;
}

// 운영에서는 Durable Object 기반 제한기로 교체해야 한다(isolate 간 공유 안 됨).
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
  } catch {
    return null;
  }
}

const clientIp = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    try {
      if (url.pathname === "/api/health") {
        // 연결되지 않은 기능을 작동하는 것처럼 보이지 않도록 구성 상태를 정직하게 노출한다.
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
        const rl = await limiter.hit(`reg:${clientIp(req)}`, 5, 3600, now);
        if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
        const b = await readJson(req, 4096);
        if (!b || typeof b.email !== "string" || typeof b.password !== "string") return json({ error: "bad_request" }, 400);
        const r = await registerUser(env.DB, b.email, b.password, now);
        return r.ok ? json({ ok: true }, 201) : json({ error: r.code, message: r.message }, r.code === "email_taken" ? 409 : 400);
      }

      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const b = await readJson(req, 4096);
        if (!b || typeof b.email !== "string" || typeof b.password !== "string") return json({ error: "bad_request" }, 400);
        const rl = await limiter.hit(`login:${clientIp(req)}:${b.email.toLowerCase()}`, 10, 900, now);
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

      return json({ error: "not_found" }, 404);
    } catch {
      // 내부 오류 상세는 노출하지 않는다.
      return json({ error: "internal_error" }, 500);
    }
  },
};
