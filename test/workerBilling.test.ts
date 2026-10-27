import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/worker";
import { makeDb } from "./helpers/d1";

const ORIGIN = "https://app.test";
async function session(env: Env, email = "a@example.com", role?: string) {
  await worker.fetch(new Request("https://api.test/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `1.1.1.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify({ email, password: "a-long-enough-password" }) }), env);
  if (role) (env.DB as any).prepare("UPDATE users SET role=? WHERE email=?").bind(role, email).run();
  const l = await worker.fetch(new Request("https://api.test/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `2.2.2.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify({ email, password: "a-long-enough-password" }) }), env);
  const { csrfToken } = (await l.json()) as { csrfToken: string };
  return { cookie: l.headers.get("Set-Cookie")!.split(";")[0]!, csrf: csrfToken };
}
const post = (path: string, body: unknown, s?: { cookie: string; csrf: string }, extra: Record<string, string> = {}) =>
  new Request(`https://api.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(s ? { Cookie: s.cookie, "X-CSRF-Token": s.csrf } : {}), ...extra }, body: JSON.stringify(body) });
const contact = { email: "o@x.co", phone: "+82.1012345678", postal_info: { name: "홍", address: { street: "s", city: "c", state: "s", postal_code: "1", country_code: "KR" } } };

function env(over: Partial<Env> = {}) {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('ccs-basic','ccs','CCS Basic')");
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('p1','ccs-basic',1,12990000)");
  return { env: { DB: db, APP_ORIGIN: ORIGIN, CLOUDPRESS_MODE: "mock", ...over } as Env, raw };
}

describe("결제·도메인 API 라우트(모의 모드)", () => {
  it("로그인·CSRF 없이는 거부", async () => {
    const { env: e } = env();
    expect((await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "USD" }), e)).status).toBe(401);
    const s = await session(e);
    expect((await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "USD" }, { ...s, csrf: "wrong" }), e)).status).toBe(403);
  });
  it("구독 결제 시작(USD): PayPal 승인 URL, incomplete 구독 생성. 미지원 통화·없는 상품은 400", async () => {
    const { env: e, raw } = env(); const s = await session(e);
    const ok = await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "USD" }, s), e);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).url).toContain("paypal.test");
    expect(raw.prepare("select status s from subscriptions").get()).toMatchObject({ s: "incomplete" });
    expect((await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "KRW" }, s), e)).status).toBe(400); // PayPal 은 KRW 미지원
    expect((await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "EUR" }, s), e)).status).toBe(400);
    expect((await worker.fetch(post("/api/subscriptions", { productId: "ghost", currency: "USD" }, s), e)).status).toBe(400);
  });
  it("환율 설정은 관리자만, 도메인 견적(USD)→PayPal 결제 URL, 남의 주문은 404", async () => {
    const { env: e, raw } = env();
    const user = await session(e, "u@example.com");
    expect((await worker.fetch(post("/api/admin/fx", { wonPerUsd: 1400 }, user), e)).status).toBe(403); // 일반 사용자는 환율 변경 불가
    const admin = await session(e, "admin@example.com", "admin");
    const fx = await worker.fetch(post("/api/admin/fx", { wonPerUsd: 1400 }, admin), e);
    expect(((await fx.json()) as any).status).toBe("accepted");
    expect((await worker.fetch(post("/api/admin/fx", { wonPerUsd: -5 }, admin), e)).status).toBe(400);
    expect(raw.prepare("select count(*) c from audit_logs where action='admin.fx_update'").get()).toMatchObject({ c: 1 });
    const q = await worker.fetch(post("/api/domains/quote", { hostname: "shop.com", contact }, user), e);
    expect(q.status).toBe(201);
    const qb = (await q.json()) as any;
    expect(qb).toMatchObject({ currency: "USD", hostname: "shop.com" });
    expect(Number.isInteger(qb.chargeAmount)).toBe(true);
    const co = await worker.fetch(post(`/api/domains/orders/${qb.orderId}/checkout`, {}, user), e);
    expect(co.status).toBe(200);
    expect(((await co.json()) as any).url).toContain("paypal.test");
    const other = await session(e, "b@example.com");
    expect((await worker.fetch(post(`/api/domains/orders/${qb.orderId}/checkout`, {}, other), e)).status).toBe(404);
  });
  it("live 모드에서 PayPal·Cloudflare 설정이 없으면 결제를 시작하지 않고 503", async () => {
    const { env: e } = env({ CLOUDPRESS_MODE: "live" });
    const s = await session(e);
    const r = await worker.fetch(post("/api/subscriptions", { productId: "ccs-basic", currency: "USD" }, s), e);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).message).toContain("PAYPAL_CLIENT_ID");
  });
  it("큐/크론 핸들러가 존재하고 모의 모드에서 오류 없이 실행", async () => {
    const { env: e, raw } = env();
    raw.exec("INSERT INTO deployment_jobs(id,kind,idempotency_key,state) VALUES('j','provision','kj','queued')");
    const acked: string[] = [];
    await (worker as any).queue({ messages: [{ body: { jobId: "j" }, ack: () => acked.push("j") }] }, e);
    expect(acked).toEqual(["j"]);
    expect(raw.prepare("select state s from deployment_jobs").get()).toMatchObject({ s: "succeeded" }); // mock 프로비저너
    await expect((worker as any).scheduled({}, e)).resolves.toBeUndefined();
  });
});
