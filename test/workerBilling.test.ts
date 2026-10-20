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
    expect((await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "USD" }), e)).status).toBe(401);
    const s = await session(e);
    expect((await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "USD" }, { ...s, csrf: "wrong" }), e)).status).toBe(403);
  });
  it("구독 체크아웃 생성(USD), 잘못된 통화·상품은 거부", async () => {
    const { env: e, raw } = env(); const s = await session(e);
    const ok = await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "USD" }, s), e);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).url).toContain("checkout.stripe.test");
    expect(raw.prepare("select status s from subscriptions").get()).toMatchObject({ s: "incomplete" });
    expect((await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "EUR" }, s), e)).status).toBe(400);
    expect((await worker.fetch(post("/api/checkout/subscription", { productId: "ghost", currency: "USD" }, s), e)).status).toBe(400);
  });
  it("원화 결제는 환율이 없으면 503, 관리자가 환율을 넣으면 진행", async () => {
    const { env: e, raw } = env();
    const user = await session(e, "u@example.com");
    expect((await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "KRW" }, user), e)).status).toBe(400); // fx_unavailable(ServiceError)
    expect((await worker.fetch(post("/api/domains/quote", { hostname: "shop.com", currency: "KRW", contact }, user), e)).status).toBe(503);
    expect((await worker.fetch(post("/api/admin/fx", { wonPerUsd: 1400 }, user), e)).status).toBe(403); // 일반 사용자는 환율 입력 불가
    const admin = await session(e, "admin@example.com", "admin");
    const fx = await worker.fetch(post("/api/admin/fx", { wonPerUsd: 1400 }, admin), e);
    expect(((await fx.json()) as any).status).toBe("accepted");
    expect((await worker.fetch(post("/api/admin/fx", { wonPerUsd: -5 }, admin), e)).status).toBe(400);
    const q = await worker.fetch(post("/api/domains/quote", { hostname: "shop.com", currency: "KRW", contact }, user), e);
    expect(q.status).toBe(201);
    const qb = (await q.json()) as any;
    expect(qb).toMatchObject({ currency: "KRW", hostname: "shop.com" });
    expect(qb.chargeAmount % 100).toBe(0);
    const co = await worker.fetch(post("/api/checkout/domain", { orderId: qb.orderId }, user), e);
    expect(co.status).toBe(200);
    expect(raw.prepare("select count(*) c from audit_logs where action='admin.fx'").get()).toMatchObject({ c: 1 });
  });
  it("다른 사용자의 주문으로는 결제 불가", async () => {
    const { env: e } = env();
    const a = await session(e, "a@example.com"); const admin = await session(e, "admin@example.com", "admin");
    await worker.fetch(post("/api/admin/fx", { wonPerUsd: 1400 }, admin), e);
    const q = (await (await worker.fetch(post("/api/domains/quote", { hostname: "mine.com", currency: "USD", contact }, a), e)).json()) as any;
    const b = await session(e, "b@example.com");
    expect((await worker.fetch(post("/api/checkout/domain", { orderId: q.orderId }, b), e)).status).toBe(404);
  });
  it("live 모드에서 비밀 값이 없으면 연결된 것처럼 동작하지 않고 503", async () => {
    const { env: e } = env({ CLOUDPRESS_MODE: "live" });
    const s = await session(e);
    const r = await worker.fetch(post("/api/checkout/subscription", { productId: "ccs-basic", currency: "USD" }, s), e);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).message).toContain("STRIPE_SECRET_KEY");
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
