import { type D1Like, type QueueLike } from "./lib/db";
import { registerUser, login, getSession, logout, verifyCsrf, originAllowed, sessionCookie, clearSessionCookie, parseCookie, SESSION_COOKIE } from "./lib/auth";
import { handlePayPalWebhook, paypalWebhookHeaders } from "./lib/webhooks";
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
import { ForbiddenError, rotateCsrf } from "./lib/auth";
import { routeApi, listPlans } from "./api";

export interface Env {
  DB: D1Like;
  JOBS?: QueueLike<{ jobId: string }>;
  APP_ORIGIN: string;
  CLOUDPRESS_MODE: "mock" | "live";
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_ENV?: "sandbox" | "live";
  SECRETS_ENCRYPTION_KEY?: string;
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

// 마이그레이션 적용 여부 점검(isolate 당 성공 시 1회). 스키마를 요청 중에 임의로 만들지 않는다.
let schemaOk = false;
const REQUIRED_TABLES = ["users", "user_sessions", "products", "prices", "subscriptions", "audit_logs"];
async function schemaReady(db: D1Like): Promise<string | null> {
  if (schemaOk) return null;
  for (const t of REQUIRED_TABLES) {
    try { await db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).first(); }
    catch { return t; }
  }
  schemaOk = true;
  return null;
}

async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const now = Date.now();
  try {
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        mode: env.CLOUDPRESS_MODE,
        paypalWebhookConfigured: Boolean(env.PAYPAL_WEBHOOK_ID),
        encryptionKeyConfigured: Boolean(env.SECRETS_ENCRYPTION_KEY),
        liveIntegrations: [],
        schemaMissingTable: await schemaReady(env.DB)
      });
    }

    {
      const missing = await schemaReady(env.DB);
      if (missing) return json({ error: "schema_not_ready", message: `데이터베이스 마이그레이션이 적용되지 않았습니다(없는 테이블: ${missing}). 운영자가 'wrangler d1 migrations apply'를 실행해야 합니다.` }, 503);
    }

    if (url.pathname === "/api/webhooks/paypal" && req.method === "POST") {
      const webhookId = env.PAYPAL_WEBHOOK_ID ?? (env.CLOUDPRESS_MODE === "live" ? undefined : "WH-MOCK");
      if (!webhookId) return json({ error: "webhook_not_configured" }, 503);
      const raw = await req.text();
      if (raw.length > 1_000_000) return json({ error: "too_large" }, 413);
      const rt = buildRuntime(env);
      const r = await handlePayPalWebhook(env.DB, rt.paypal, raw, paypalWebhookHeaders(req.headers), webhookId, now);
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
      
      try {
        const r = await login(env.DB, b.email, b.password, now);
        if (!r.ok) return json({ error: r.code === "suspended" ? "account_suspended" : "invalid_credentials" }, r.code === "suspended" ? 403 : 401);
        return json({ ok: true, csrfToken: r.csrfToken, user: { id: r.user.id, email: r.user.email, role: r.user.role } }, 200, { "Set-Cookie": sessionCookie(r.token) });
      } catch (loginErr: any) {
        console.error("[Login Error Detail]", loginErr?.message, loginErr?.stack);
        return json({ error: "internal_error", details: loginErr?.message }, 500);
      }
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

    // 페이지 로드 시 세션 확인 + CSRF 토큰 (재)발급. 비로그인도 200(authenticated:false)으로 응답해 콘솔 오류를 만들지 않는다.
    // 서버에는 토큰 해시만 있으므로 새 토큰으로 회전한다.
    if (url.pathname === "/api/auth/csrf" && req.method === "GET") {
      return session
        ? json({ authenticated: true, csrfToken: await rotateCsrf(env.DB, session.sessionId), user: session.user })
        : json({ authenticated: false });
    }

    if (url.pathname === "/api/plans" && req.method === "GET") {
      return json(await listPlans(env.DB));
    }

    if (!session) return json({ error: "unauthenticated" }, 401);

    // 인증된 모든 상태 변경 요청은 CSRF 토큰 필수.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !(await verifyCsrf(session, req.headers.get("X-CSRF-Token")))) {
      return json({ error: "bad_csrf", message: "보안 토큰이 만료되었습니다. 페이지를 새로고침하세요." }, 403);
    }

    const routed = await routeApi({
      req, env, url, now, session,
      json: (d, st, ex) => json(d, st, ex),
      body: (max = 8192) => readJson(req, max),
    });
    if (routed) return routed;

    return json({ error: "not_found" }, 404);
  } catch (e: any) {
    console.error("[API Fatal Error]", e?.message, e?.stack);
    // 후속 마이그레이션(0007~0009)이 적용되지 않은 DB 에서 해당 기능만 실패하는 경우를 명확히 알린다.
    if (/no such table/i.test(String(e?.message))) return json({ error: "schema_not_ready", message: "데이터베이스 마이그레이션이 최신이 아닙니다. 운영자가 'wrangler d1 migrations apply'를 실행해야 합니다." }, 503);
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

    const assetResponse = await env.ASSETS.fetch(req);

    // 서비스 상세(/services/<구독ID>)는 정적 플레이스홀더 페이지를 서빙하고 클라이언트가 ID 를 읽는다.
    // 실제 정적 페이지(/services/create 등)가 있으면 그것을 우선한다.
    if (assetResponse.status === 404 && /^\/services\/[^/]+\/?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/services/_/", url), req));
    }

    // 없는 파일은 404 그대로 반환한다(HTML 로 대체하면 module script MIME 오류가 난다).
    return assetResponse;
  },

  async queue(batch: { messages: { body: { jobId: string }; ack(): void }[] }, env: Env): Promise<void> {
    const rt = buildRuntime(env);
    await consumeBatch({
      db: env.DB,
      nowMs: Date.now(),
      paypal: rt.paypal,
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
