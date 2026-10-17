import { type D1Like, type QueueLike, nowIso } from "./db";

/**
 * 트랜잭셔널 아웃박스: 웹훅 처리는 DB 에만 쓰고(deployment_jobs.state='queued'),
 * 이 함수가 아직 큐에 보내지 않은 작업을 전달한다. 전달은 최소 1회(at-least-once)이므로
 * 소비자는 idempotency_key 로 멱등하게 처리해야 한다.
 */
export async function dispatchOutbox(db: D1Like, queue: QueueLike<{ jobId: string }>, nowMs: number, limit = 50): Promise<number> {
  const { results } = await db.prepare(
    `SELECT j.id FROM deployment_jobs j
      WHERE j.state = 'queued' AND NOT EXISTS (SELECT 1 FROM queue_jobs q WHERE q.deployment_job_id = j.id)
      ORDER BY j.created_at LIMIT ?`,
  ).bind(limit).all<{ id: string }>();
  let sent = 0;
  for (const { id } of results) {
    try {
      await queue.send({ jobId: id });
    } catch {
      continue; // 다음 실행에서 재시도
    }
    await db.prepare("INSERT OR IGNORE INTO queue_jobs(id,queue_name,deployment_job_id,state,enqueued_at) VALUES(?,?,?,?,?)").bind(`q_${id}`, "cloudpress-jobs", id, "enqueued", nowIso(nowMs)).run();
    sent++;
  }
  return sent;
}
