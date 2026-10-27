import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { MockPayPal } from "../src/lib/paypal.client";
import { MockRegistrar } from "../src/lib/registrar";
import { resolveInstance, quoteCpuAddon, purchaseCpuAddon, saveCpuPolicy, loadCpuPolicy, finalizeCpuAddons, SEED_CPU_POLICY } from "../src/lib/cpuAddons";
import { handlePayPalWebhook } from "../src/lib/webhooks";
import { processJob, type JobContext, type Provisioner } from "../src/lib/jobs";

const NOW = Date.UTC(2026, 9, 26);
const ctx0 = { appOrigin: "https://app.test", nowMs: NOW };
const VALID = { authAlgo: "a", certUrl: "https://api.paypal.com/c", transmissionId: "t", transmissionSig: MockPayPal.VALID_SIG, transmissionTime: "x" };
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];
const one = (raw: any, sql: string) => raw.prepare(sql).get() as any;
let n = 0;
const hook = (db: any, type: string, resource: any) => handlePayPalWebhook(db, new MockPayPal(), JSON.stringify({ id: `WH-c${++n}`, event_type: type, resource }), VALID, "W", NOW);
const sale = (id: string, sub: string, total = "6.99", custom?: string) => ({ id, state: "completed", billing_agreement_id: sub, custom, amount: { total, currency: "USD" } });

function world(instance = "basic") {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
  raw.exec(`INSERT INTO products(id,kind,name_ko,instance_type) VALUES('p-ccs','ccs','CCS','${instance}'),('p-csw','csw','CSW',NULL)`);
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr1','p-ccs',1,12990000),('pr2','p-csw',1,4990000)");
  raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,status) VALUES('s1','u1','p-ccs','pr1','active'),('s2','u1','p-csw','pr2','active')");
  raw.exec(`INSERT INTO containers(id,subscription_id,customer_id,instance_type,target_vcpu,actual_vcpu,state) VALUES('c1','s1','u1','${instance}',2,0.25,'running')`);
  const paypal = new MockPayPal();
  const resized: string[] = [];
  const prov: Provisioner = { provision: async () => {}, suspend: async () => {}, resume: async () => {}, resize: async (id, to) => { resized.push(`${id}:${to}`); } };
  const jctx = (over: Partial<JobContext> = {}): JobContext => ({ db, nowMs: NOW, paypal, portFor: () => new MockRegistrar(), nsPortFor: () => ({ setNameservers: async () => {} }), zones: {} as any, crypto: {} as any, provisioner: prov, ...over });
  return { db, raw, paypal, resized, jctx };
}

describe("추가 CPU: 사양 계산", () => {
  it("기본 사양 + 추가 vCPU → 공식 지원 인스턴스 중 가장 작은 것, 없으면 null", () => {
    expect(resolveInstance("basic", 1)).toBe("standard-3");      // 0.25 + 1 = 1.25 → 2 vCPU
    expect(resolveInstance("basic", 2)).toBe("standard-4");      // 2.25 → 4 vCPU
    expect(resolveInstance("standard-2", 1)).toBe("standard-3"); // 1 + 1 = 2
    expect(resolveInstance("basic", 4)).toBeNull();              // 4.25 vCPU 사양은 공식 지원 없음
    expect(resolveInstance("basic", 8)).toBeNull();
    expect(resolveInstance("basic", 0)).toBe("basic");
  });
  it("허용 인스턴스 목록을 좁히면 그 안에서만 선택", () => {
    expect(resolveInstance("basic", 1, ["standard-4"])).toBe("standard-4");
    expect(resolveInstance("basic", 1, ["lite", "basic"])).toBeNull();
  });
});

describe("추가 CPU: 견적·구매 검증", () => {
  it("견적: 가격·결과 사양(메모리·디스크 동반 변경 안내) 반환", async () => {
    const w = world();
    const r = await quoteCpuAddon(w.db, "u1", "s1", 1);
    expect(r).toMatchObject({ monthlyMicro: 6_990_000, fromInstance: "basic", toInstance: "standard-3", resulting: { vcpu: 2, memoryMiB: 8192, diskGB: 16 } });
    expect(r.note).toContain("메모리");
  });
  it("지원되지 않는 사양(+4/+8)·판매하지 않는 수량·타인/비컨테이너/비활성 서비스는 안전하게 거부", async () => {
    const w = world();
    await expect(quoteCpuAddon(w.db, "u1", "s1", 4)).rejects.toMatchObject({ code: "unsupported_spec" });
    await expect(quoteCpuAddon(w.db, "u1", "s1", 8)).rejects.toMatchObject({ code: "unsupported_spec" });
    await expect(quoteCpuAddon(w.db, "u1", "s1", 3)).rejects.toMatchObject({ code: "bad_tier" });
    await expect(quoteCpuAddon(w.db, "u1", "s1", 1.5)).rejects.toMatchObject({ code: "bad_tier" });
    await expect(quoteCpuAddon(w.db, "u2", "s1", 1)).rejects.toMatchObject({ code: "not_found" });
    await expect(quoteCpuAddon(w.db, "u1", "s2", 1)).rejects.toMatchObject({ code: "unsupported_product" });
    w.raw.exec("UPDATE subscriptions SET status='suspended' WHERE id='s1'");
    await expect(quoteCpuAddon(w.db, "u1", "s1", 1)).rejects.toMatchObject({ code: "bad_state" });
    w.raw.exec("UPDATE subscriptions SET status='active' WHERE id='s1'; DELETE FROM containers");
    await expect(quoteCpuAddon(w.db, "u1", "s1", 1)).rejects.toMatchObject({ code: "no_container" });
  });
  it("구매 시작: pending 행 + PayPal 별도 구독(custom_id=cpu:<id>), 플랜은 가격당 1개, 결제 대기 중복 구매 거부", async () => {
    const w = world();
    const r = await purchaseCpuAddon(w.db, w.paypal, "u1", "s1", 1, ctx0);
    expect(r.url).toContain("paypal.test");
    expect((w.paypal.calls.find((c) => c.op === "subscription")!.args as any).customId).toBe(`cpu:${r.id}`);
    expect(one(w.raw, "select purchase_status p, apply_status a, add_vcpu v, monthly_micro m from cpu_addons")).toEqual({ p: "pending", a: "not_started", v: 1, m: 6_990_000 });
    await expect(purchaseCpuAddon(w.db, w.paypal, "u1", "s1", 1, ctx0)).rejects.toMatchObject({ code: "pending_exists" });
    expect(w.paypal.calls.filter((c) => c.op === "plan")).toHaveLength(1);
  });
  it("합계 상한(기본 8)과 가격 정책 변경(관리자) — 일할 계산 true 는 거부", async () => {
    const w = world("lite");
    await expect(saveCpuPolicy(w.db, "u1", { prorate: true }, NOW)).rejects.toMatchObject({ code: "bad_policy" });
    await expect(saveCpuPolicy(w.db, "u1", { prices: { "1": 6_995_001 } }, NOW)).rejects.toMatchObject({ code: "bad_policy" });
    await expect(saveCpuPolicy(w.db, "u1", { allowedInstances: ["huge" as any] }, NOW)).rejects.toMatchObject({ code: "bad_policy" });
    await saveCpuPolicy(w.db, "u1", { prices: { "1": 7_490_000 }, maxTotalAddVcpu: 1 }, NOW);
    expect((await loadCpuPolicy(w.db)).prices["1"]).toBe(7_490_000);
    expect((await quoteCpuAddon(w.db, "u1", "s1", 1)).monthlyMicro).toBe(7_490_000);
    expect(SEED_CPU_POLICY.prices["1"]).toBe(6_990_000); // 시드 불변
    w.raw.exec("INSERT INTO cpu_addons(id,subscription_id,container_id,from_instance_type,to_instance_type,add_vcpu,monthly_micro,purchase_status) VALUES('x','s1','c1','lite','standard-2',1,1,'paid')");
    await expect(quoteCpuAddon(w.db, "u1", "s1", 1)).rejects.toMatchObject({ code: "limit_exceeded" });
  });
});

describe("추가 CPU: 결제 → 적용(구매/적용 상태 분리)", () => {
  async function bought(w: ReturnType<typeof world>) {
    const r = await purchaseCpuAddon(w.db, w.paypal, "u1", "s1", 1, ctx0);
    const sub = one(w.raw, "select paypal_subscription_id p from cpu_addons").p as string;
    return { id: r.id, sub };
  }
  it("결제 웹훅 → purchase=paid, apply=queued, 작업 1건. 재전송·갱신 결제는 작업 추가 없음", async () => {
    const w = world(); const { sub } = await bought(w);
    expect((await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S1", sub))).status).toBe(200);
    expect(one(w.raw, "select purchase_status p, apply_status a from cpu_addons")).toEqual({ p: "paid", a: "queued" });
    expect(q(w.raw, "select kind from deployment_jobs")).toEqual([{ kind: "cpu_resize" }]);
    expect(q(w.raw, "select subscription_id s from invoices")).toEqual([{ s: "s1" }]);
    await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S2", sub)); // 다음 달 갱신
    expect(q(w.raw, "select * from deployment_jobs")).toHaveLength(1);
    expect(q(w.raw, "select * from payments")).toHaveLength(2);
    expect(one(w.raw, "select status from subscriptions where id='s1'").status).toBe("active"); // 부모 구독은 그대로
  });
  it("약속한 가격과 다른 금액은 적용하지 않는다(500 → 재시도/수동 확인)", async () => {
    const w = world(); const { sub } = await bought(w);
    expect((await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S9", sub, "1.00"))).status).toBe(500);
    expect(one(w.raw, "select purchase_status p from cpu_addons").p).toBe("pending");
    expect(q(w.raw, "select * from deployment_jobs")).toHaveLength(0);
  });
  it("증설 작업 성공: 컨테이너 사양·적용 상태 갱신, 재실행해도 한 번만 resize", async () => {
    const w = world(); const { sub } = await bought(w);
    await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S1", sub));
    const jobId = one(w.raw, "select id from deployment_jobs").id;
    expect(await processJob(w.jctx(), jobId)).toBe("succeeded");
    expect(w.resized).toEqual(["c1:standard-3"]);
    expect(one(w.raw, "select instance_type i, actual_vcpu v from containers")).toEqual({ i: "standard-3", v: 2 });
    expect(one(w.raw, "select apply_status a, applied_at t from cpu_addons").a).toBe("applied");
  });
  it("증설 실패(컨테이너 매니저 미연결): 적용 상태 failed, 컨테이너는 그대로, 운영자 알림", async () => {
    const w = world(); const { sub } = await bought(w);
    await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S1", sub));
    const jobId = one(w.raw, "select id from deployment_jobs").id;
    expect(await processJob(w.jctx({ provisioner: null }), jobId)).toBe("dead");
    expect(one(w.raw, "select purchase_status p, apply_status a, last_error e from cpu_addons")).toMatchObject({ p: "paid", a: "failed" }); // 결제 성공 ≠ 적용 성공
    expect(one(w.raw, "select instance_type i from containers").i).toBe("basic");
    expect(q(w.raw, "select severity from notifications where audience='operator'")).toEqual([{ severity: "critical" }]);
  });
  it("취소: 결제 기간 유지 → 기간 종료 시 cancelled + 축소 작업 → 기본 사양 복귀", async () => {
    const w = world(); const { sub } = await bought(w);
    await hook(w.db, "PAYMENT.SALE.COMPLETED", sale("S1", sub));
    await processJob(w.jctx(), one(w.raw, "select id from deployment_jobs").id);
    await hook(w.db, "BILLING.SUBSCRIPTION.CANCELLED", { id: sub });
    expect(one(w.raw, "select purchase_status p, cancel_at_period_end c from cpu_addons")).toEqual({ p: "paid", c: 1 });
    expect(await finalizeCpuAddons(w.db, NOW)).toEqual({ expired: 0, cancelled: 0 }); // 아직 이용 기간 중
    expect(one(w.raw, "select instance_type i from containers").i).toBe("standard-3");
    const later = NOW + 40 * 86_400_000;
    expect(await finalizeCpuAddons(w.db, later)).toEqual({ expired: 0, cancelled: 1 });
    const jobs = q(w.raw, "select id from deployment_jobs where state='queued'");
    expect(jobs).toHaveLength(1);
    expect(await processJob(w.jctx({ nowMs: later }), jobs[0].id)).toBe("succeeded");
    expect(w.resized).toEqual(["c1:standard-3", "c1:basic"]);
    expect(one(w.raw, "select instance_type i, actual_vcpu v from containers")).toEqual({ i: "basic", v: 0.25 });
  });
  it("결제 대기 24시간 초과 구매는 정리된다", async () => {
    const w = world(); await bought(w);
    expect(await finalizeCpuAddons(w.db, NOW + 25 * 3_600_000)).toMatchObject({ expired: 1 });
  });
});
