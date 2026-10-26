import { type D1Like, type QueueLike } from "./db";
import { expireQuotes } from "./domainOrders";
import { expireIncompleteSubscriptions, finalizeCanceledSubscriptions } from "./checkout";
import { recoverStuckJobs } from "./jobs";
import { dispatchOutbox } from "./outbox";
import { checkActivation, nextActivationDelayMin, type ZoneRow } from "./zoneService";
import type { ZonesPort } from "./zones";

export interface ScheduledReport { quotesExpired: number; incompleteExpired: number; stuckRecovered: number; dispatched: number; zonesChecked: number; errors: string[] }

/**
 * 주기 작업(크론). 각 작업은 독립적으로 실행해 하나가 실패해도 나머지는 계속한다.
 * 호출 낭비를 줄이기 위해 영역 활성화 확인은 점점 간격을 늘린다.
 */
export async function runScheduled(db: D1Like, deps: { queue: QueueLike<{ jobId: string }> | null; zones: ZonesPort }, nowMs: number): Promise<ScheduledReport> {
  const r: ScheduledReport = { quotesExpired: 0, incompleteExpired: 0, stuckRecovered: 0, dispatched: 0, zonesChecked: 0, errors: [] };
  const step = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { r.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)); } };
  await step("expireQuotes", async () => { r.quotesExpired = await expireQuotes(db, nowMs); });
  await step("expireIncomplete", async () => { r.incompleteExpired = await expireIncompleteSubscriptions(db, nowMs); });
  await step("finalizeCanceled", async () => { await finalizeCanceledSubscriptions(db, nowMs); });
  await step("recoverStuck", async () => { r.stuckRecovered = await recoverStuckJobs(db, nowMs); });
  await step("dispatchOutbox", async () => { if (deps.queue) r.dispatched = await dispatchOutbox(db, deps.queue, nowMs); });
  await step("zones", async () => {
    const { results } = await db.prepare("SELECT id,customer_id,hostname,cf_zone_id,status,origin,name_servers_json,created_at,activation_checks,last_checked_at FROM dns_zones WHERE status='pending_nameservers' ORDER BY COALESCE(last_checked_at, created_at) LIMIT 50").all<ZoneRow & { last_checked_at: string | null }>();
    for (const z of results) {
      const last = z.last_checked_at ? Date.parse(z.last_checked_at) : 0;
      if (nowMs - last < nextActivationDelayMin(z.activation_checks) * 60_000) continue;
      try { await checkActivation(db, deps.zones, z, nowMs); r.zonesChecked++; } catch (e) { r.errors.push(`zone ${z.id}: ${e instanceof Error ? e.message : "오류"}`.slice(0, 200)); }
    }
  });
  return r;
}
