import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/worker";
import { makeDb } from "./helpers/d1";
import { signStripePayload } from "../src/lib/stripe";

const ORIGIN = "https://app.test";
const mkEnv = (over: Partial<Env> = {}): Env => ({ DB: makeDb().db, APP_ORIGIN: ORIGIN, CLOUDPRESS_MODE: "mock", ...over });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

describe("Worker 라우터", () => {
  it("health 는 모의 모드와 미연결 상태를 정직하게 보고", async () => {
    const r = await worker.fetch(new Request("https://api.test/api/health"), mkEnv());
    const j = await r.json() as any;
    expect(j).toMatchObject({ mode: "mock", stripeWebhookConfigured: false, liveIntegrations: [] });
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
  it("가입 → 로그인 → me → CSRF 없는 로그아웃 거부 → 로그아웃", async () => {
    const env = mkEnv();
    expect((await worker.fetch(post("/api/auth/register", { email: "a@example.com", password: "a-long-enough-password" }), env)).status).toBe(201);
    const l = await worker.fetch(post("/api/auth/login", { email: "a@example.com", password: "a-long-enough-password" }), env);
    expect(l.status).toBe(200);
    const cookie = l.headers.get("Set-Cookie")!.split(";")[0]!;
    const { csrfToken } = await l.json() as any;
    const me = await worker.fetch(new Request("https://api.test/api/auth/me", { headers: { Cookie: cookie } }), env);
    expect(me.status).toBe(200);
    expect((await worker.fetch(post("/api/auth/logout", {}, { Cookie: cookie }), env)).status).toBe(403);
    expect((await worker.fetch(post("/api/auth/logout", {}, { Cookie: cookie, "X-CSRF-Token": csrfToken }), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://api.test/api/auth/me", { headers: { Cookie: cookie } }), env)).status).toBe(401);
  });
  it("다른 Origin 의 상태 변경 요청 거부", async () => {
    const r = await worker.fetch(post("/api/auth/register", { email: "a@example.com", password: "a-long-enough-password" }, { Origin: "https://evil.test" }), mkEnv());
    expect(r.status).toBe(403);
  });
  it("로그인 실패는 동일 응답, 10회 초과 시 429", async () => {
    const env = mkEnv();
    const h = { "CF-Connecting-IP": "9.9.9.9" };
    const first = await worker.fetch(post("/api/auth/login", { email: "x@example.com", password: "wrongwrongwrong" }, h), env);
    expect(first.status).toBe(401);
    let last = first;
    for (let i = 0; i < 10; i++) last = await worker.fetch(post("/api/auth/login", { email: "x@example.com", password: "wrongwrongwrong" }, h), env);
    expect(last.status).toBe(429);
  });
  it("웹훅: 시크릿 미설정 503, 서명 불일치 400, 정상 200(Origin 검사 대상 아님)", async () => {
    const body = JSON.stringify({ id: "evt_w1", type: "customer.created", created: 1, data: { object: {} } });
    const mk = (sig: string) => new Request("https://api.test/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": sig }, body });
    expect((await worker.fetch(mk("x"), mkEnv())).status).toBe(503);
    const env = mkEnv({ STRIPE_WEBHOOK_SECRET: "whsec_t" });
    expect((await worker.fetch(mk("t=1,v1=bad"), env)).status).toBe(400);
    expect((await worker.fetch(mk(await signStripePayload(body, "whsec_t", Date.now())), env)).status).toBe(200);
  });
  it("알 수 없는 경로 404, 잘못된 JSON 400", async () => {
    const env = mkEnv();
    expect((await worker.fetch(new Request("https://api.test/nope"), env)).status).toBe(404);
    const bad = new Request("https://api.test/api/auth/login", { method: "POST", headers: { Origin: ORIGIN }, body: "{not json" });
    expect((await worker.fetch(bad, env)).status).toBe(400);
  });
});
