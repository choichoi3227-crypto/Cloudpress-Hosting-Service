import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/worker";
import { makeDb } from "./helpers/d1";
import { MockPayPal } from "../src/lib/paypal.client";

const ORIGIN = "https://app.test";
const mkEnv = (over: Partial<Env> = {}): Env => ({ DB: makeDb().db, APP_ORIGIN: ORIGIN, CLOUDPRESS_MODE: "mock", ...over });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

describe("Worker 라우터", () => {
  it("health 는 모의 모드와 미연결 상태를 정직하게 보고", async () => {
    const r = await worker.fetch(new Request("https://api.test/api/health"), mkEnv());
    const j = await r.json() as any;
    expect(j).toMatchObject({ mode: "mock", paypalWebhookConfigured: false, liveIntegrations: [] });
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
  it("웹훅: 서명 불일치 400, 정상 200, 라이브에서 웹훅 ID 미설정은 503(Origin 검사 대상 아님)", async () => {
    const body = JSON.stringify({ id: "WH-evt_w1", event_type: "CUSTOMER.CREATED", resource: {} });
    const mk = (sig: string) => new Request("https://api.test/api/webhooks/paypal", { method: "POST", headers: { "paypal-transmission-sig": sig, "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-transmission-id": "t1", "paypal-transmission-time": "2026-10-25T00:00:00Z" }, body });
    expect((await worker.fetch(mk("bad"), mkEnv())).status).toBe(400);
    expect((await worker.fetch(mk(MockPayPal.VALID_SIG), mkEnv())).status).toBe(200);
    expect((await worker.fetch(mk(MockPayPal.VALID_SIG), mkEnv({ CLOUDPRESS_MODE: "live" }))).status).toBe(503);
  });
  it("알 수 없는 경로 404, 잘못된 JSON 400", async () => {
    const env = mkEnv();
    expect((await worker.fetch(new Request("https://api.test/nope"), env)).status).toBe(404);
    const bad = new Request("https://api.test/api/auth/login", { method: "POST", headers: { Origin: ORIGIN }, body: "{not json" });
    expect((await worker.fetch(bad, env)).status).toBe(400);
  });
});
