import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { MockStripe, StripeError } from "../src/lib/stripe.client";
import { MockRegistrar } from "../src/lib/registrar";
import { MockGabiaClient, GabiaRegistrar } from "../src/lib/registrarRouter";
import { MockZones } from "../src/lib/zones";
import { processJob, consumeBatch, recoverStuckJobs, backoffSeconds, RetryableError, PermanentError, HANDLERS, type JobContext, type Handler } from "../src/lib/jobs";
import { dispatchOutbox } from "../src/lib/outbox";
import { runScheduled } from "../src/lib/scheduler";
import { connectDomain } from "../src/lib/zoneService";
import { createQuoteRouted, markPaid } from "../src/lib/domainOrders";
import { costSideRate } from "../src/lib/fx";
import { encryptSecret, decryptSecret, b64urlEncode } from "../src/lib/crypto";

const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
const crypt = { encrypt: (p: string, a: string) => encryptSecret(p, KEY, a), decrypt: (t: string, a: string) => decryptSecret(t, KEY, a) };
const NOW = Date.UTC(2026, 9, 20), FX = 1_400_000_000;
const contact = { email: "o@x.co", phone: "+82.1012345678", postal_info: { name: "홍", address: { street: "s", city: "c", state: "s", postal_code: "1", country_code: "KR" } } };

function world() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h')");
  const cf = new MockRegistrar(), gc = new MockGabiaClient(), gabia = new GabiaRegistrar(gc), stripe = new MockStripe(), zones = new MockZones();
  const base = { db, stripe, portFor: (p: string) => (p === "gabia" ? gabia : cf), nsPortFor: () => gabia, zones, crypto: crypt, provisioner: null } as const;
  const ctx = (nowMs = NOW, over: Partial<JobContext> = {}): JobContext => ({ ...base, nowMs, ...over });
  const addJob = (id: string, kind: string, payload = "{}", extra = "") => raw.exec(`INSERT INTO deployment_jobs(id,kind,idempotency_key,payload_json,state${extra ? "," + extra.split("=")[0] : ""}) VALUES('${id}','${kind}','k_${id}','${payload}','queued'${extra ? "," + extra.split("=")[1] : ""})`);
  return { db, raw, cf, gc, gabia, stripe, zones, ctx, addJob };
}
const job = (raw: any, id: string) => raw.prepare("select state, attempts, last_error e, next_run_at n from deployment_jobs where id=?").get(id) as any;

describe("작업 처리기", () => {
  it("성공하면 succeeded, 같은 작업의 중복 전달은 실행하지 않음(skipped)", async () => {
    const w = world(); let runs = 0; const h: Record<string, Handler> = { ok: async () => { runs++; } };
    w.addJob("j1", "ok");
    expect(await processJob(w.ctx(), "j1", h)).toBe("succeeded");
    expect(await processJob(w.ctx(), "j1", h)).toBe("skipped");
    expect(runs).toBe(1);
    expect(job(w.raw, "j1")).toMatchObject({ state: "succeeded", attempts: 1 });
  });
  it("동시 실행도 정확히 1회", async () => {
    const w = world(); let runs = 0; const h: Record<string, Handler> = { slow: async () => { runs++; await new Promise((r) => setTimeout(r, 5)); } };
    w.addJob("j1", "slow");
    const out = await Promise.all([processJob(w.ctx(), "j1", h), processJob(w.ctx(), "j1", h), processJob(w.ctx(), "j1", h)]);
    expect(runs).toBe(1); expect(out.filter((o) => o === "succeeded")).toHaveLength(1);
  });
  it("재시도 가능 오류: 백오프 일정 기록, 큐 전달 기록 삭제, 기한 전에는 실행 안 함, 기한 후 성공", async () => {
    const w = world(); let fail = true; const h: Record<string, Handler> = { flaky: async () => { if (fail) throw new RetryableError("일시 오류"); } };
    w.addJob("j1", "flaky");
    w.raw.exec("INSERT INTO queue_jobs(id,queue_name,deployment_job_id) VALUES('q_j1','q','j1')");
    expect(await processJob(w.ctx(), "j1", h, 0.5)).toBe("retrying");
    const j = job(w.raw, "j1");
    expect(j).toMatchObject({ state: "retrying", attempts: 1, e: "일시 오류" });
    expect(Date.parse(j.n)).toBe(NOW + 30_000);
    expect(w.raw.prepare("select count(*) c from queue_jobs").get()).toMatchObject({ c: 0 });
    expect(await processJob(w.ctx(NOW + 10_000), "j1", h)).toBe("skipped");
    fail = false;
    expect(await processJob(w.ctx(NOW + 31_000), "j1", h)).toBe("succeeded");
    expect(job(w.raw, "j1")).toMatchObject({ state: "succeeded", attempts: 2, e: null, n: null });
  });
  it("영구 오류·미지 작업·최대 시도 초과는 폐기(dead) + 운영자 알림", async () => {
    const w = world();
    const h: Record<string, Handler> = { perm: async () => { throw new PermanentError("복구 불가"); }, always: async () => { throw new Error("계속 실패"); } };
    w.addJob("a", "perm"); w.addJob("b", "mystery"); w.addJob("c", "always", "{}", "max_attempts=2");
    expect(await processJob(w.ctx(), "a", h)).toBe("dead");
    expect(await processJob(w.ctx(), "b", h)).toBe("dead");
    expect(await processJob(w.ctx(), "c", h)).toBe("retrying");
    expect(await processJob(w.ctx(NOW + 120_000), "c", h)).toBe("dead");
    expect(job(w.raw, "c")).toMatchObject({ state: "dead", attempts: 2 });
    expect(w.raw.prepare("select count(*) c from notifications where audience='operator' and severity='critical'").get()).toMatchObject({ c: 3 });
  });
  it("외부 API 오류 분류: 429/5xx 는 재시도, 4xx 는 폐기", async () => {
    const w = world();
    const mk = (e: Error): Record<string, Handler> => ({ x: async () => { throw e; } });
    w.addJob("a", "x"); w.addJob("b", "x");
    expect(await processJob(w.ctx(), "a", mk(new StripeError(503, undefined, "down")))).toBe("retrying");
    expect(await processJob(w.ctx(), "b", mk(new StripeError(402, "card_declined", "no")))).toBe("dead");
  });
  it("백오프는 지수 증가·최대 1시간·±20% 분산", () => {
    expect([1, 2, 3, 4].map((a) => backoffSeconds(a, 0.5))).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(20, 0.5)).toBe(3600);
    expect(backoffSeconds(1, 0)).toBe(24); expect(backoffSeconds(1, 1)).toBe(36);
  });
  it("멈춘 작업(running 고착)은 복구되어 다시 큐로", async () => {
    const w = world();
    w.raw.exec("INSERT INTO deployment_jobs(id,kind,idempotency_key,state,updated_at) VALUES('s1','x','ks1','running','2026-10-20T00:00:00.000Z')");
    w.raw.exec("INSERT INTO queue_jobs(id,queue_name,deployment_job_id) VALUES('q_s1','q','s1')");
    expect(await recoverStuckJobs(w.db, NOW + 10 * 60_000)).toBe(0);
    expect(await recoverStuckJobs(w.db, NOW + 20 * 60_000)).toBe(1);
    expect(job(w.raw, "s1")).toMatchObject({ state: "retrying", e: "stuck_recovered" });
    const q = { sent: [] as unknown[], send: async function (m: unknown) { this.sent.push(m); } };
    expect(await dispatchOutbox(w.db, q, NOW + 20 * 60_000)).toBe(1);
  });
  it("아웃박스는 재시도 기한이 지난 작업만 다시 전달", async () => {
    const w = world();
    w.raw.exec("INSERT INTO deployment_jobs(id,kind,idempotency_key,state,next_run_at) VALUES('r1','x','kr1','retrying','2026-10-20T01:00:00.000Z')");
    const q = { send: async () => {} };
    expect(await dispatchOutbox(w.db, q, NOW + 30 * 60_000)).toBe(0);
    expect(await dispatchOutbox(w.db, q, NOW + 61 * 60_000)).toBe(1);
  });
  it("배치 소비: 결과를 집계하고 모든 메시지를 ack(큐의 즉시 재전송이 백오프를 깨지 않게)", async () => {
    const w = world();
    w.addJob("a", "provision", "{}"); w.addJob("b", "provision", "{}");
    w.raw.exec("UPDATE deployment_jobs SET subscription_id=NULL");
    let acked = 0; const msgs = ["a", "b", "ghost"].map((id) => ({ body: { jobId: id }, ack: () => { acked++; } }));
    const t = await consumeBatch(w.ctx(), msgs);
    expect(acked).toBe(3);
    expect(t).toMatchObject({ dead: 2, skipped: 1 }); // provisioner 미연결 → 폐기(연결되지 않은 기능을 성공으로 처리하지 않음)
  });
});

describe("도메인 작업 종단 간", () => {
  async function paidOrder(w: ReturnType<typeof world>, hostname: string, kr = false) {
    if (kr) w.cf.cfg.unavailable = [hostname];
    const q = await createQuoteRouted(w.db, { cloudflare: w.cf, gabia: w.gabia }, crypt, { customerId: "u1", hostname, contact, nowMs: NOW, currency: "KRW", rate: { smoothedRateMicro: FX, costRateMicro: costSideRate(FX) } });
    await markPaid(w.db, q.orderId, `pi_${hostname}`, NOW);
    w.raw.exec(`INSERT INTO deployment_jobs(id,kind,idempotency_key,payload_json,state) VALUES('reg','register_domain','register:${q.orderId}','{"orderId":"${q.orderId}"}','queued')`);
    return q;
  }
  it(".com: 등록 → 영역 확보까지 작업 1건으로 완료", async () => {
    const w = world(); const q = await paidOrder(w, "shop.com");
    expect(await processJob(w.ctx(), "reg")).toBe("succeeded");
    expect(w.raw.prepare("select status s from domain_orders").get()).toMatchObject({ s: "registered" });
    expect(w.raw.prepare("select origin o, order_id oid from dns_zones").get()).toMatchObject({ o: "registered", oid: q.orderId });
  });
  it(".kr: 가비아 등록 → 영역 생성 → 가비아 NS 를 Cloudflare NS 로 위임", async () => {
    const w = world(); await paidOrder(w, "shop.kr", true);
    expect(await processJob(w.ctx(), "reg")).toBe("succeeded");
    expect(w.gc.nameservers.get("shop.kr")![0]).toContain("cloudflare.com");
    expect(w.raw.prepare("select ns_delegated_at t from domain_orders").get()).toMatchObject({ t: expect.any(String) });
  });
  it("위임 실패는 작업이 재시도되고, 재시도 때 등록을 다시 호출하지 않음", async () => {
    const w = world(); await paidOrder(w, "retry.kr", true); w.gc.cfg.failNs = true;
    expect(await processJob(w.ctx(), "reg")).toBe("retrying");
    w.gc.cfg.failNs = false;
    expect(await processJob(w.ctx(NOW + 61_000), "reg")).toBe("succeeded");
    expect(w.gc.calls.filter((c) => c.startsWith("register:"))).toHaveLength(1);
  });
  it("등록 진행 중이면 재시도로 폴링, 완료되면 마무리", async () => {
    const w = world(); await paidOrder(w, "slow.com"); w.cf.cfg.registerBehavior = "in_progress";
    expect(await processJob(w.ctx(), "reg")).toBe("retrying");
    w.cf.registered.set("slow.com", "2027-10-20T00:00:00Z");
    expect(await processJob(w.ctx(NOW + 61_000), "reg")).toBe("succeeded");
    expect(w.raw.prepare("select count(*) c from dns_zones").get()).toMatchObject({ c: 1 });
  });
  it("모호한 등록 결과(검토 필요)는 작업은 끝내되 운영자에게 알림, 자동 환불·재등록 없음", async () => {
    const w = world(); await paidOrder(w, "amb.com"); w.cf.cfg.registerBehavior = "throw";
    expect(await processJob(w.ctx(), "reg")).toBe("succeeded");
    expect(w.raw.prepare("select status s from domain_orders").get()).toMatchObject({ s: "needs_review" });
    expect(w.raw.prepare("select count(*) c from notifications where audience='operator'").get()).toMatchObject({ c: 1 });
    expect(w.raw.prepare("select count(*) c from deployment_jobs where kind='refund_domain_order'").get()).toMatchObject({ c: 0 });
  });
  it("환불 작업: 결제 직후 불가 판정 → refund_due → Stripe 환불(멱등 키) → refunded, 재실행해도 1회", async () => {
    const w = world(); const q = await paidOrder(w, "gone.com"); w.cf.cfg.unavailable = ["gone.com"];
    expect(await processJob(w.ctx(), "reg")).toBe("succeeded");
    expect(w.raw.prepare("select status s from domain_orders").get()).toMatchObject({ s: "refund_due" });
    const refundJob = w.raw.prepare("select id from deployment_jobs where kind='refund_domain_order'").get() as { id: string };
    expect(await processJob(w.ctx(), refundJob.id)).toBe("succeeded");
    expect(w.raw.prepare("select status s from domain_orders").get()).toMatchObject({ s: "refunded" });
    const refunds = w.stripe.calls.filter((c) => c.op === "refund");
    expect(refunds).toHaveLength(1); expect(refunds[0]!.idem).toBe(`refund:${q.orderId}`);
    w.raw.exec(`UPDATE deployment_jobs SET state='queued', attempts=0 WHERE id='${refundJob.id}'`);
    expect(await processJob(w.ctx(), refundJob.id)).toBe("succeeded"); // 이미 환불됨 → 추가 호출 없음
    expect(w.stripe.calls.filter((c) => c.op === "refund")).toHaveLength(1);
  });
  it("환불 작업은 등록 완료 주문을 환불하지 않음(폐기 + 알림)", async () => {
    const w = world(); const q = await paidOrder(w, "done.com");
    await processJob(w.ctx(), "reg");
    w.raw.exec(`INSERT INTO deployment_jobs(id,kind,idempotency_key,payload_json,state) VALUES('rf','refund_domain_order','refund:${q.orderId}','{"orderId":"${q.orderId}"}','queued')`);
    expect(await processJob(w.ctx(), "rf")).toBe("dead");
    expect(w.stripe.calls.some((c) => c.op === "refund")).toBe(false);
  });
});

describe("스케줄러", () => {
  it("견적 만료·방치 구독·멈춘 작업·아웃박스·영역 확인을 한 번에, 하나가 실패해도 나머지 진행", async () => {
    const w = world();
    const z = await connectDomain(w.db, w.zones, "u1", "wait.com", NOW - 10 * 60_000);
    w.zones.zones.get([...w.zones.zones.values()][0]!.id)!.status = "active";
    w.raw.exec("INSERT INTO deployment_jobs(id,kind,idempotency_key,state) VALUES('q1','provision','kq1','queued')");
    const sent: unknown[] = [];
    const r = await runScheduled(w.db, { queue: { send: async (m) => { sent.push(m); } }, zones: w.zones }, NOW);
    expect(r).toMatchObject({ dispatched: 1, zonesChecked: 1, errors: [] });
    expect(sent).toHaveLength(1);
    expect(w.raw.prepare("select status s from dns_zones where id=?").get(z.zoneId)).toMatchObject({ s: "active" });
    const broken = { ...w.zones, getZone: async () => { throw new Error("cf down"); }, recheckActivation: async () => {} } as unknown as MockZones;
    const z2 = await connectDomain(w.db, w.zones, "u1", "other.com", NOW - 400 * 60_000);
    const r2 = await runScheduled(w.db, { queue: null, zones: broken }, NOW);
    expect(z2.zoneId).toBeTruthy();
    expect(r2.errors.some((e) => e.includes("cf down"))).toBe(true);
    expect(r2.dispatched).toBe(0);
  });
  it("영역 확인은 간격을 두고 수행(방금 확인한 영역은 건너뜀)", async () => {
    const w = world();
    await connectDomain(w.db, w.zones, "u1", "gap.com", NOW - 60_000);
    w.raw.exec(`UPDATE dns_zones SET last_checked_at='${new Date(NOW - 60_000).toISOString()}', activation_checks=2`);
    expect((await runScheduled(w.db, { queue: null, zones: w.zones }, NOW)).zonesChecked).toBe(0);
    expect((await runScheduled(w.db, { queue: null, zones: w.zones }, NOW + 61 * 60_000)).zonesChecked).toBe(1);
  });
});
void HANDLERS;
