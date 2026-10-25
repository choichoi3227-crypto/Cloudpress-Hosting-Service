import { type D1Like, newId, nowIso } from "./db";
import { assertTransition, JOB_TRANSITIONS, type JobState } from "./states";
import type { StripePort } from "./stripe.client";
import { StripeError } from "./stripe.client";
import { CfApiError } from "./cfApi";
import type { RegistrarPort, NameserverPort } from "./registrar";
import type { ZonesPort } from "./zones";
import { runRegistration, pollRegistration, adoptRegisteredZone, delegateNameservers, markRefunded, type Crypto } from "./domainOrders";

export class RetryableError extends Error {}
export class PermanentError extends Error {}

/** 컨테이너·DB 프로비저닝 포트. 컨테이너 매니저 구현 전까지 운영(live)에서는 연결되지 않으며, 그때 작업은 폐기 후 운영자 알림으로 드러난다. */
export interface Provisioner { provision(subId: string): Promise<void>; suspend(subId: string): Promise<void>; resume(subId: string): Promise<void> }

export interface JobContext {
  db: D1Like;
  nowMs: number;
  stripe: StripePort;
  portFor(provider: string): RegistrarPort;
  nsPortFor(provider: string): NameserverPort;
  zones: ZonesPort;
  crypto: Crypto;
  provisioner: Provisioner | null;
}
export interface JobRow { id: string; kind: string; subscription_id: string | null; payload_json: string; attempts: number; max_attempts: number }
export type Handler = (job: JobRow, ctx: JobContext) => Promise<void>;

/** 지수 백오프(30초 시작, 최대 1시간). jitter 는 0~1 값으로 ±20% 분산(테스트에서는 고정값 주입). */
export function backoffSeconds(attempt: number, jitter = 0.5): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * jitter));
}

function classify(e: unknown): "retry" | "permanent" {
  if (e instanceof PermanentError) return "permanent";
  if (e instanceof RetryableError) return "retry";
  if (e instanceof CfApiError || e instanceof StripeError) return e.retryable ? "retry" : "permanent";
  return "retry"; // 알 수 없는 오류는 최대 시도 횟수까지만 재시도
}

const notifyOperator = (db: D1Like, title: string, body: string, nowMs: number) =>
  db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", title, body.slice(0, 500), nowIso(nowMs));

export const HANDLERS: Record<string, Handler> = {
  async register_domain(job, ctx) {
    const { orderId } = JSON.parse(job.payload_json) as { orderId: string };
    let status = await runRegistration(ctx.db, ctx.portFor, ctx.crypto, orderId, ctx.nowMs);
    if (status === "registering") {
      status = await pollRegistration(ctx.db, ctx.portFor, orderId, ctx.nowMs);
      if (status === "registering") throw new RetryableError("등록 진행 중");
    }
    if (status === "registered") {
      await adoptRegisteredZone(ctx.db, ctx.zones, orderId, ctx.nowMs);
      const o = await ctx.db.prepare("SELECT registrar_provider AS p FROM domain_orders WHERE id = ?").bind(orderId).first<{ p: string }>();
      await delegateNameservers(ctx.db, ctx.nsPortFor(o!.p), orderId, ctx.nowMs);
    } else if (status === "needs_review") {
      await notifyOperator(ctx.db, "도메인 등록 검토 필요", `주문 ${orderId}: 자동 처리할 수 없는 상태입니다(등록은 환불 불가이므로 수동 확인).`, ctx.nowMs).run();
    }
    // refund_due 는 환불 작업이 이미 만들어져 있다.
  },

  async refund_domain_order(job, ctx) {
    const { orderId } = JSON.parse(job.payload_json) as { orderId: string };
    const o = await ctx.db.prepare("SELECT status, stripe_payment_intent_id AS pi FROM domain_orders WHERE id = ?").bind(orderId).first<{ status: string; pi: string | null }>();
    if (!o) throw new PermanentError("주문 없음");
    if (o.status === "refunded") return;
    if (o.status !== "refund_due") throw new PermanentError(`환불 대상이 아닌 상태: ${o.status}`); // 등록 완료 주문은 환불하지 않는다
    if (!o.pi) throw new PermanentError("결제 정보 없음");
    await ctx.stripe.createRefund({ paymentIntent: o.pi, metadata: { domain_order_id: orderId } }, `refund:${orderId}`);
    await markRefunded(ctx.db, orderId, ctx.nowMs);
  },

  async provision(job, ctx) { await need(ctx).provision(job.subscription_id!); },
  async suspend(job, ctx) { await need(ctx).suspend(job.subscription_id!); },
  async resume(job, ctx) { await need(ctx).resume(job.subscription_id!); },
};
function need(ctx: JobContext): Provisioner {
  if (!ctx.provisioner) throw new PermanentError("provisioner_not_connected: 컨테이너 매니저가 연결되지 않음");
  return ctx.provisioner;
}

export type JobOutcome = "succeeded" | "retrying" | "dead" | "skipped";

/**
 * 작업 1건 처리(멱등·재시도·폐기).
 * - 원자적 클레임: 같은 메시지가 중복 전달돼도 한 번만 실행
 * - 실패 시 백오프로 재시도 일정(next_run_at)을 기록하고, 아웃박스가 시간이 되면 다시 큐에 넣는다
 * - 영구 오류이거나 최대 시도 횟수를 넘기면 폐기(dead)하고 운영자에게 알린다
 */
export async function processJob(ctx: JobContext, jobId: string, handlers: Record<string, Handler> = HANDLERS, jitter = 0.5): Promise<JobOutcome> {
  const { db, nowMs } = ctx;
  const claim = await db.prepare("UPDATE deployment_jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=? AND state IN ('queued','retrying') AND (next_run_at IS NULL OR next_run_at <= ?)").bind(nowIso(nowMs), jobId, nowIso(nowMs)).run();
  if (claim.meta.changes === 0) return "skipped";
  const job = (await db.prepare("SELECT id,kind,subscription_id,payload_json,attempts,max_attempts FROM deployment_jobs WHERE id = ?").bind(jobId).first<JobRow>())!;
  const h = handlers[job.kind];
  const finish = async (state: JobState, err: string | null, nextRun: string | null, extra: ReturnType<typeof notifyOperator>[] = []) => {
    assertTransition(JOB_TRANSITIONS, "running", state);
    await db.batch([
      db.prepare("UPDATE deployment_jobs SET state=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?").bind(state, err, nextRun, nowIso(nowMs), jobId),
      ...(state === "retrying" ? [db.prepare("DELETE FROM queue_jobs WHERE deployment_job_id = ?").bind(jobId)] : []),
      ...extra,
    ]);
  };
  if (!h) { await finish("dead", `unknown_job_kind:${job.kind}`, null, [notifyOperator(db, "알 수 없는 작업 종류", job.kind, nowMs)]); return "dead"; }
  try {
    await h(job, ctx);
    await finish("succeeded", null, null);
    return "succeeded";
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    if (classify(e) === "retry" && job.attempts < job.max_attempts) {
      await finish("retrying", msg, nowIso(nowMs + backoffSeconds(job.attempts, jitter) * 1000));
      return "retrying";
    }
    await finish("dead", msg, null, [notifyOperator(db, `작업 폐기: ${job.kind}`, `${job.id} (${job.attempts}회 시도): ${msg}`, nowMs)]);
    return "dead";
  }
}

/** 실행 중에 워커가 죽어 'running' 으로 남은 작업을 되살린다. */
export async function recoverStuckJobs(db: D1Like, nowMs: number, timeoutMin = 15): Promise<number> {
  const cutoff = nowIso(nowMs - timeoutMin * 60_000);
  const { results } = await db.prepare("SELECT id FROM deployment_jobs WHERE state='running' AND updated_at < ?").bind(cutoff).all<{ id: string }>();
  for (const { id } of results) {
    await db.batch([
      db.prepare("UPDATE deployment_jobs SET state='retrying', next_run_at=?, last_error='stuck_recovered', updated_at=? WHERE id=? AND state='running'").bind(nowIso(nowMs), nowIso(nowMs), id),
      db.prepare("DELETE FROM queue_jobs WHERE deployment_job_id = ?").bind(id),
    ]);
  }
  return results.length;
}

/** 큐 메시지 일괄 소비: 재시도는 우리 상태기계가 맡으므로 항상 ack 한다(큐의 즉시 재전송이 백오프를 무력화하지 않게). */
export async function consumeBatch(ctx: JobContext, messages: { body: { jobId: string }; ack(): void }[]): Promise<Record<JobOutcome, number>> {
  const tally: Record<JobOutcome, number> = { succeeded: 0, retrying: 0, dead: 0, skipped: 0 };
  for (const m of messages) {
    try { tally[await processJob(ctx, m.body.jobId)]++; } catch { /* DB 오류: ack 하지 않아 큐가 재전달 */ continue; }
    m.ack();
  }
  return tally;
}
