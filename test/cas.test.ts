import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { MockPayPal } from "../src/lib/paypal.client";
import { estimateNeurons, sellMicro, costMicro, neuronsFromProperties, syncModels, adminSetModel, issueKey, revokeKey, rotateKey, creditTopup, creditBalance, runGateway, MockAiRunner, detectAnomaly, type Runner } from "../src/lib/cas";
import { handlePayPalWebhook } from "../src/lib/webhooks";

const NOW = Date.UTC(2026, 9, 27, 12);
const VALID = { authAlgo: "a", certUrl: "https://api.paypal.com/c", transmissionId: "t", transmissionSig: MockPayPal.VALID_SIG, transmissionTime: "x" };
const one = (raw: any, sql: string) => raw.prepare(sql).get() as any;
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];
let n = 0;
const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const cfModel = { name: MODEL, task: { name: "Text Generation" }, properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.282, currency: "USD" }, { unit: "per M output tokens", price: 0.827, currency: "USD" }] }] };

async function world() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('cas-general','cas','CAS 일반')");
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pc','cas-general',1,990000)");
  await syncModels(db, [cfModel], NOW);
  const pk = one(raw, "select id from ai_models").id as string;
  await adminSetModel(db, "admin", pk, { enabled: true, tier: "general" }, NOW);
  raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,status) VALUES('s1','u1','cas-general','pc','active')");
  raw.exec(`INSERT INTO cas_model_access(subscription_id,customer_id,model_id,created_at) VALUES('s1','u1','${pk}','x')`);
  const key = await issueKey(db, "u1", "prod", NOW);
  await creditTopup(db, "u1", 10_000_000, "topup:t1", NOW);
  return { db, raw, pk, key: key.key, keyId: key.id, runner: new MockAiRunner() };
}
const call = (w: any, body: any = { model: MODEL, input: { prompt: "hello world" } }, over: any = {}) => runGateway(w.db, over.runner ?? w.runner, "key" in over ? over.key : w.key, body, { nowMs: over.now ?? NOW, requestId: over.rid ?? `r${++n}` });

describe("CAS: Neurons 환산(정수)", () => {
  it("공식 가격(USD/M토큰) → Neurons, 토큰 → Neurons 올림, 판매가 올림", () => {
    expect(neuronsFromProperties(cfModel.properties)).toEqual({ inputM: 25636, outputM: 75182, unit: null });
    const m = { input_neurons_per_m: 25636, output_neurons_per_m: 75182, unit_neurons: null };
    expect(estimateNeurons(m, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(25636);
    expect(estimateNeurons(m, { inputTokens: 1, outputTokens: 1 })).toBe(2); // 올림
    expect(sellMicro(1000, 20_000)).toBe(20_000);   // 1,000 Neurons = $0.02
    expect(sellMicro(1, 20_000)).toBe(20);
    expect(costMicro(1000)).toBe(11_000);           // 원가 $0.011 / 1,000 Neurons
  });
  it("알 수 없는 가격 형식은 null(→ 판매 불가)", () => {
    expect(neuronsFromProperties([{ property_id: "price", value: "n/a" }])).toEqual({ inputM: null, outputM: null, unit: null });
    expect(neuronsFromProperties(undefined)).toEqual({ inputM: null, outputM: null, unit: null });
  });
});

describe("CAS: 모델 동기화·관리", () => {
  it("새 모델은 비활성, 사라진 모델은 removed(삭제 안 함), 관리자 단가는 덮어쓰지 않음", async () => {
    const { db, raw } = makeDb();
    expect(await syncModels(db, [cfModel, { name: "not-a-model" } as any], NOW)).toMatchObject({ seen: 1, added: 1 });
    expect(one(raw, "select enabled e, pricing_source p from ai_models")).toEqual({ e: 0, p: "cloudflare_api" });
    const pk = one(raw, "select id from ai_models").id;
    await adminSetModel(db, "admin", pk, { inputNeuronsPerM: 99 }, NOW);
    await syncModels(db, [cfModel], NOW);
    expect(one(raw, "select input_neurons_per_m i, pricing_source p from ai_models")).toEqual({ i: 99, p: "admin" });
    expect(await syncModels(db, [], NOW)).toMatchObject({ removed: 1 });
    expect(one(raw, "select official_status s, enabled e from ai_models")).toEqual({ s: "removed", e: 0 });
  });
  it("단가 없는 모델은 활성화 불가, 가격은 새 버전 행으로(기존 유지), 숫자 검증", async () => {
    const { db, raw } = makeDb();
    await syncModels(db, [{ name: "@cf/x/img", task: { name: "Text-to-Image" } }], NOW);
    const pk = one(raw, "select id from ai_models").id;
    await expect(adminSetModel(db, "a", pk, { enabled: true }, NOW)).rejects.toMatchObject({ code: "no_pricing" });
    await adminSetModel(db, "a", pk, { unitNeurons: 5000, enabled: true, tier: "premium" }, NOW);
    await adminSetModel(db, "a", pk, { sellPer1kMicro: 45_000 }, NOW);
    expect(q(raw, "select version v, sell_per_1k_micro s from ai_model_prices order by version")).toEqual([{ v: 1, s: 40_000 }, { v: 2, s: 45_000 }]);
    await expect(adminSetModel(db, "a", pk, { unitNeurons: -1 }, NOW)).rejects.toMatchObject({ code: "bad_value" });
    await expect(adminSetModel(db, "a", "ghost", {}, NOW)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("CAS: API 키", () => {
  it("발급(원문 1회, 해시만 저장)·폐기·재발급(이전 키 즉시 무효)·개수 제한", async () => {
    const w = await world();
    expect(w.key).toMatch(/^cpai_/);
    expect(one(w.raw, "select key_hash h from ai_api_keys").h).not.toContain(w.key);
    const r = await rotateKey(w.db, "u1", w.keyId, NOW);
    expect(await call(w)).toMatchObject({ ok: false, status: 401 });            // 이전 키
    expect(await call(w, undefined, { key: r.key })).toMatchObject({ ok: true }); // 새 키
    await revokeKey(w.db, "u1", r.id, NOW);
    expect(await call(w, undefined, { key: r.key })).toMatchObject({ ok: false, status: 401 });
    await expect(revokeKey(w.db, "u2", r.id, NOW)).rejects.toMatchObject({ code: "not_found" }); // 타인 키
    for (let i = 0; i < 10; i++) await issueKey(w.db, "u1", `k${i}`, NOW);
    await expect(issueKey(w.db, "u1", "x", NOW)).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("CAS: 게이트웨이", () => {
  it("성공: 실제 사용량 기록 + 크레딧 차감 + 같은 요청 ID 는 한 번만 차감", async () => {
    const w = await world();
    const r = await call(w, undefined, { rid: "same" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.neurons).toBeGreaterThan(0);
    expect(await creditBalance(w.db, "u1")).toBe(10_000_000 - r.billedMicro);
    expect(one(w.raw, "select count(*) c, sum(billed_micro) b from ai_usage_records")).toEqual({ c: 1, b: r.billedMicro });
    expect(one(w.raw, "select cost_micro c, billed_micro b from ai_usage_records").c).toBeLessThan(one(w.raw, "select billed_micro b from ai_usage_records").b); // 판매가 > 원가
  });
  it("거부: 키 없음/잘못된 형식/모델·구독 없음/비활성 계정", async () => {
    const w = await world();
    expect(await call(w, undefined, { key: null })).toMatchObject({ status: 401 });
    expect(await call(w, { model: MODEL })).toMatchObject({ status: 400 });
    expect(await call(w, { model: "@cf/none", input: {} })).toMatchObject({ status: 404 });
    w.raw.exec("UPDATE subscriptions SET status='suspended'");
    expect(await call(w)).toMatchObject({ status: 403, error: "no_subscription" });
    w.raw.exec("UPDATE subscriptions SET status='active'; UPDATE users SET status='suspended' WHERE id='u1'");
    expect(await call(w)).toMatchObject({ status: 403, error: "account_inactive" });
    expect(w.runner.calls).toHaveLength(0); // 거부된 요청은 AI 를 실행하지 않는다
  });
  it("다른 고객의 구독으로는 사용 불가(고객 격리)", async () => {
    const w = await world();
    const k2 = await issueKey(w.db, "u2", "other", NOW); await creditTopup(w.db, "u2", 5_000_000, "topup:t2", NOW);
    expect(await call(w, undefined, { key: k2.key })).toMatchObject({ status: 403, error: "no_subscription" });
  });
  it("크레딧 부족은 실행 전에 402(AI 미실행), 충전하면 사용 가능", async () => {
    const w = await world();
    w.raw.exec("DELETE FROM ai_credit_ledger");
    expect(await call(w)).toMatchObject({ status: 402 });
    expect(w.runner.calls).toHaveLength(0);
    await creditTopup(w.db, "u1", 5_000_000, "topup:x", NOW);
    expect(await call(w)).toMatchObject({ ok: true });
  });
  it("분당 요청 제한(429)과 키별 월 비용 상한(429)", async () => {
    const w = await world();
    w.raw.exec("UPDATE ai_api_keys SET rate_limit_per_min = 2");
    await call(w); await call(w);
    expect(await call(w)).toMatchObject({ status: 429, error: "rate_limited" });
    expect(await call(w, undefined, { now: NOW + 61_000 })).toMatchObject({ ok: true }); // 1분 뒤 해제
    w.raw.exec("UPDATE ai_api_keys SET rate_limit_per_min = 1000, monthly_cap_micro = 1");
    expect(await call(w, undefined, { now: NOW + 200_000 })).toMatchObject({ status: 429, error: "monthly_cap" });
  });
  it("운영자 긴급 차단 스위치", async () => {
    const w = await world();
    w.raw.exec("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cas_kill_switch','true','a','x')");
    expect(await call(w)).toMatchObject({ status: 503, error: "service_paused" });
  });
  it("AI 실행 실패는 과금하지 않는다(502)", async () => {
    const w = await world();
    const bad: Runner = { run: async () => { throw new Error("boom"); } };
    expect(await call(w, undefined, { runner: bad })).toMatchObject({ status: 502 });
    expect(await creditBalance(w.db, "u1")).toBe(10_000_000);
    expect(q(w.raw, "select * from ai_usage_records")).toHaveLength(0);
  });
  it("이상 사용(10분 임계 초과) 감지 시 키 자동 차단 + 운영자 알림", async () => {
    const w = await world();
    w.raw.exec("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cas_anomaly_micro_10m','1','a','x')");
    expect(await call(w)).toMatchObject({ ok: true });
    expect(one(w.raw, "select status s from ai_api_keys").s).toBe("blocked");
    expect(q(w.raw, "select severity from notifications where audience='operator'")).toEqual([{ severity: "critical" }]);
    expect(await call(w)).toMatchObject({ status: 401 });
    expect(await detectAnomaly(w.db, w.keyId, "u1", NOW)).toBe(false); // 이미 차단됨
  });
});

describe("CAS: 크레딧 충전(PayPal 웹훅)", () => {
  const hook = (db: any, resource: any) => handlePayPalWebhook(db, new MockPayPal(), JSON.stringify({ id: `WH-ai${++n}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource }), VALID, "W", NOW);
  it("충전 캡처 → 크레딧 반영(멱등), 금액 불일치는 거부", async () => {
    const w = await world();
    w.raw.exec("INSERT INTO ai_credit_topups(id,customer_id,amount_micro,paypal_order_id,created_at) VALUES('top1','u1',20000000,'ORD1','x')");
    expect((await hook(w.db, { id: "CAP1", status: "COMPLETED", custom_id: "ai:top1", amount: { value: "5.00", currency_code: "USD" } })).status).toBe(500); // 금액 불일치
    expect(await creditBalance(w.db, "u1")).toBe(10_000_000);
    expect((await hook(w.db, { id: "CAP1", status: "COMPLETED", custom_id: "ai:top1", amount: { value: "20.00", currency_code: "USD" } })).status).toBe(200);
    expect(await creditBalance(w.db, "u1")).toBe(30_000_000);
    await hook(w.db, { id: "CAP1", status: "COMPLETED", custom_id: "ai:top1", amount: { value: "20.00", currency_code: "USD" } });
    expect(await creditBalance(w.db, "u1")).toBe(30_000_000); // 재전송은 한 번만
    expect(one(w.raw, "select status s from ai_credit_topups").s).toBe("paid");
  });
});
