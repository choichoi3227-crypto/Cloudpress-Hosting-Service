import { OFFICIAL_INSTANCE_TYPES, type InstanceType } from "./catalog";
import type { Micro } from "./money";

/* ───────────── 1. 적정 크기 산정(right-sizing) ───────────── */

export interface WindowStats {
  samples: number;
  days: number;
  cpuP95Vcpu: number;
  memP99MiB: number;
  diskUsedGB: number;
  oomKills: number;
  /** CPU 스로틀링 비율(0~1). */
  cpuThrottleRatio: number;
  restarts: number;
}

export interface RightSizeOptions {
  allowedTypes: InstanceType[];
  /** 인스턴스 타입별 월 판매 요금(micro-USD). */
  priceOf: (t: InstanceType) => Micro;
  headroomMem?: number;
  headroomCpu?: number;
  headroomDisk?: number;
  minSamples?: number;
  minDays?: number;
  cooldownDays?: number;
  daysSinceLastChange?: number;
}

export interface RightSizeResult {
  action: "keep" | "upsize" | "downsize" | "upsize_blocked";
  target: InstanceType;
  reasons: string[];
  /** 양수 = 고객 월 절감액, 음수 = 증가액. */
  deltaMicroPerMonth: Micro;
}

/**
 * 성능을 해치지 않는 적정 크기 권고.
 * - 상향: OOM·스로틀링·메모리 85% 초과 시 즉시(쿨다운 무시)
 * - 하향: 충분한 표본, OOM/스로틀/재시작 0, 메모리 p99 < 50%, 헤드룸을 만족하는 더 저렴한 타입이 있을 때만
 */
export function rightSize(stats: WindowStats, current: InstanceType, o: RightSizeOptions): RightSizeResult {
  const hm = o.headroomMem ?? 0.25, hc = o.headroomCpu ?? 0.3, hd = o.headroomDisk ?? 0.3;
  const cur = OFFICIAL_INSTANCE_TYPES[current];
  const needMem = Math.ceil(stats.memP99MiB * (1 + hm));
  const needCpu = stats.cpuP95Vcpu * (1 + hc);
  const needDisk = stats.diskUsedGB * (1 + hd);
  const fits = (t: InstanceType) => { const s = OFFICIAL_INSTANCE_TYPES[t]; return s.memoryMiB >= needMem && s.vcpu >= needCpu && s.diskGB >= needDisk; };
  const keep = (reason: string): RightSizeResult => ({ action: "keep", target: current, reasons: [reason], deltaMicroPerMonth: 0 });

  const pressure = stats.oomKills > 0 || stats.cpuThrottleRatio > 0.05 || stats.memP99MiB > 0.85 * cur.memoryMiB || stats.diskUsedGB > 0.85 * cur.diskGB;
  if (pressure) {
    const bigger = o.allowedTypes.filter((t) => fits(t) && OFFICIAL_INSTANCE_TYPES[t].memoryMiB >= cur.memoryMiB && t !== current).sort((a, b) => o.priceOf(a) - o.priceOf(b));
    const pick = bigger[0];
    if (!pick) return { action: "upsize_blocked", target: current, reasons: ["자원 압박이 있으나 허용된 상위 타입이 없음 — 운영자 확인 필요"], deltaMicroPerMonth: 0 };
    return { action: "upsize", target: pick, reasons: [`자원 압박(OOM ${stats.oomKills}회, 스로틀 ${(stats.cpuThrottleRatio * 100).toFixed(1)}%, 메모리 p99 ${stats.memP99MiB}MiB)`], deltaMicroPerMonth: o.priceOf(current) - o.priceOf(pick) };
  }
  if (stats.samples < (o.minSamples ?? 500) || stats.days < (o.minDays ?? 7)) return keep("표본 부족: 하향 판단 보류");
  if ((o.daysSinceLastChange ?? Infinity) < (o.cooldownDays ?? 7)) return keep("최근 변경 쿨다운 중(진동 방지)");
  if (stats.restarts > 0) return keep("재시작 이력이 있어 하향 보류");
  if (stats.memP99MiB >= 0.5 * cur.memoryMiB) return keep("메모리 사용률이 충분히 낮지 않음");
  const cheaper = o.allowedTypes.filter((t) => fits(t) && o.priceOf(t) < o.priceOf(current)).sort((a, b) => o.priceOf(a) - o.priceOf(b));
  const pick = cheaper[0];
  if (!pick) return keep("헤드룸을 만족하는 더 저렴한 타입 없음");
  return { action: "downsize", target: pick, reasons: [`p99 메모리 ${stats.memP99MiB}MiB, p95 CPU ${stats.cpuP95Vcpu}vCPU — 헤드룸 포함 ${pick} 로 충분`], deltaMicroPerMonth: o.priceOf(current) - o.priceOf(pick) };
}

/* ───────────── 2. 절전 시간(sleepAfter) 최적화 ───────────── */

export interface SleepParams {
  /** 깨어 있는 동안 초당 원가(micro-USD). */
  warmCostPerSecMicro: number;
  /** 콜드 스타트 1회의 환산 비용(지연·재개 연산 포함, micro-USD). */
  coldStartPenaltyMicro: number;
  /** 허용 콜드 스타트 비율(0~1). 성능 보호 한도. */
  coldStartBudget: number;
  /** 상태 저장(DB 등)이면 절전 금지. */
  stateful: boolean;
  ladderSec?: number[];
  minSamples?: number;
}
export interface SleepResult { sleepAfterSec: number | "never"; expectedCostPerGapMicro: number; coldStartFraction: number; reason: string }
const DEFAULT_LADDER = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** 유휴 간격 표본으로 기대 비용을 최소화하되 콜드 스타트 비율이 예산을 넘지 않는 T 선택. */
export function tuneSleepAfter(idleGapsSec: number[], p: SleepParams): SleepResult {
  if (p.stateful) return { sleepAfterSec: "never", expectedCostPerGapMicro: 0, coldStartFraction: 0, reason: "상태 저장 서비스는 절전 금지(데이터 보호)" };
  if (idleGapsSec.length < (p.minSamples ?? 30)) return { sleepAfterSec: 600, expectedCostPerGapMicro: 0, coldStartFraction: 0, reason: "표본 부족: 보수적 기본값 600초" };
  const n = idleGapsSec.length;
  const evalT = (T: number) => {
    let cost = 0, cold = 0;
    for (const g of idleGapsSec) { if (g <= T) cost += g * p.warmCostPerSecMicro; else { cost += T * p.warmCostPerSecMicro + p.coldStartPenaltyMicro; cold++; } }
    return { cost: cost / n, cold: cold / n };
  };
  let best: SleepResult | null = null;
  for (const T of p.ladderSec ?? DEFAULT_LADDER) {
    const e = evalT(T);
    if (e.cold <= p.coldStartBudget && (!best || e.cost < best.expectedCostPerGapMicro - 1e-9)) best = { sleepAfterSec: T, expectedCostPerGapMicro: e.cost, coldStartFraction: e.cold, reason: "기대 비용 최소(콜드 스타트 예산 충족)" };
  }
  const never = idleGapsSec.reduce((a, g) => a + g * p.warmCostPerSecMicro, 0) / n;
  if (!best || never < best.expectedCostPerGapMicro - 1e-9) return { sleepAfterSec: "never", expectedCostPerGapMicro: never, coldStartFraction: 0, reason: best ? "상시 가동이 더 저렴" : "콜드 스타트 예산을 만족하는 절전 시간 없음 → 상시 가동" };
  return best;
}

/* ───────────── 3. 낭비 탐지(orphan / idle) ───────────── */

export interface ResourceFacts {
  type: "container" | "database" | "bucket";
  id: string;
  subscriptionStatus: "active" | "past_due" | "suspended" | "canceling" | "canceled" | "refunded" | "incomplete";
  canceledAtMs?: number;
  lastRequestAtMs?: number;
  requests30d: number;
  sleepPolicy?: "idle" | "never";
  stateful?: boolean;
  storedBytes?: number;
  createdAtMs: number;
}
export interface WasteFinding { resourceId: string; kind: "orphan_suspend" | "orphan_delete_review" | "idle_always_on" | "never_used"; action: string; detail: string }
const DAY = 86_400_000;

/**
 * 낭비 탐지. 자동 삭제는 하지 않는다: 삭제는 'review' 로만 올리고 2단계 확인을 거친다.
 * 결제 중이고 사용 중인 자원, 분쟁·미납 중인 자원은 건드리지 않는다.
 */
export function detectWaste(rs: ResourceFacts[], nowMs: number, o = { orphanGraceDays: 30, idleDays: 14, neverUsedDays: 30 }): WasteFinding[] {
  const out: WasteFinding[] = [];
  for (const r of rs) {
    if (r.subscriptionStatus === "canceled" || r.subscriptionStatus === "refunded") {
      const age = nowMs - (r.canceledAtMs ?? nowMs);
      if (age < o.orphanGraceDays * DAY) out.push({ resourceId: r.id, kind: "orphan_suspend", action: "suspend_keep_data", detail: "취소된 구독: 중지하되 데이터는 유예 기간 동안 보존" });
      else out.push({ resourceId: r.id, kind: "orphan_delete_review", action: "request_two_step_deletion", detail: `유예 ${o.orphanGraceDays}일 경과: 삭제 검토 요청(자동 삭제 안 함)` });
      continue;
    }
    if (r.subscriptionStatus !== "active" && r.subscriptionStatus !== "canceling") continue;
    const lastUse = r.lastRequestAtMs ?? r.createdAtMs;
    const idleFor = nowMs - lastUse;
    if (r.type === "bucket" && r.requests30d === 0 && (r.storedBytes ?? 0) === 0 && nowMs - r.createdAtMs > o.neverUsedDays * DAY)
      out.push({ resourceId: r.id, kind: "never_used", action: "notify_customer", detail: "생성 후 사용 이력 없는 빈 버킷" });
    else if (r.type === "container" && r.sleepPolicy === "never" && !r.stateful && r.requests30d === 0 && idleFor > o.idleDays * DAY)
      out.push({ resourceId: r.id, kind: "idle_always_on", action: "suggest_idle_sleep", detail: `${o.idleDays}일 이상 요청 없음: 유휴 절전 전환 권고(고객 승인 필요)` });
  }
  return out;
}

/* ───────────── 4. 백업 보존/정리 ───────────── */

export interface BackupFacts { id: string; kind: "full" | "incremental" | "binlog" | "snapshot" | "logical"; createdAtMs: number; verified: boolean; sizeBytes: number }

/**
 * 보존 기간 밖 백업만 정리하되, 복구 체인(보존 시작 시점 이전 최신 전체 백업 + 이후 증분/binlog)은 반드시 유지.
 * 검증된 전체 백업이 하나도 남지 않게 되는 삭제는 절대 하지 않는다.
 */
export function planBackupPrune(bs: BackupFacts[], nowMs: number, retentionDays: number, legalHold = false) {
  if (legalHold) return { keep: bs.map((b) => b.id), prune: [] as string[], freedBytes: 0 };
  const cutoff = nowMs - retentionDays * DAY;
  const fulls = bs.filter((b) => b.kind === "full" && b.verified).sort((a, b) => b.createdAtMs - a.createdAtMs);
  const anchor = fulls.find((b) => b.createdAtMs <= cutoff);
  const newestFull = fulls[0];
  const newestSnapshot = bs.filter((b) => b.kind === "snapshot").sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
  const keepIds = new Set<string>();
  for (const b of bs) {
    if (!anchor) { keepIds.add(b.id); continue; } // 앵커가 없으면 아무것도 지우지 않는다
    if (b.createdAtMs >= anchor.createdAtMs) keepIds.add(b.id);
  }
  if (newestFull) keepIds.add(newestFull.id);
  if (newestSnapshot) keepIds.add(newestSnapshot.id);
  const prune = bs.filter((b) => !keepIds.has(b.id));
  return { keep: [...keepIds], prune: prune.map((b) => b.id), freedBytes: prune.reduce((a, b) => a + b.sizeBytes, 0) };
}

/* ───────────── 5. 배치 점수(명령서 수식) ───────────── */

export interface PlacementCandidate {
  id: string;
  healthy: boolean;
  supportsType: boolean;
  freeMemMiB: number;
  freeVcpu: number;
  cpuLoad: number; // 0~1
  queueDepth: number;
  errorRate: number; // 0~1
  restarts7d: number;
  estCostPerHourMicro: number;
  latencyMs: number;
}
export interface PlacementWeights { fit: number; capacity: number; latency: number; overload: number; cost: number; failure: number }
export const DEFAULT_PLACEMENT_WEIGHTS: PlacementWeights = { fit: 30, capacity: 20, latency: 15, overload: 25, cost: 10, failure: 20 };

/** 하드 제약을 먼저 거른 뒤 score = fit + capacity + latency − overload − cost − failure. 후보가 없으면 null(가짜 배치 금지). */
export function choosePlacement(cands: PlacementCandidate[], need: { memMiB: number; vcpu: number }, w: PlacementWeights = DEFAULT_PLACEMENT_WEIGHTS, maxLoad = 0.9) {
  const eligible = cands.filter((c) => c.healthy && c.supportsType && c.freeMemMiB >= need.memMiB && c.freeVcpu >= need.vcpu && c.cpuLoad < maxLoad);
  if (eligible.length === 0) return null;
  const maxCost = Math.max(...eligible.map((c) => c.estCostPerHourMicro), 1);
  const maxLat = Math.max(...eligible.map((c) => c.latencyMs), 1);
  const scored = eligible.map((c) => {
    const fit = w.fit * Math.min(1, need.memMiB / Math.max(1, c.freeMemMiB)); // 딱 맞을수록 높음(조각화 방지)
    const capacity = w.capacity * (1 - c.cpuLoad);
    const latency = w.latency * (1 - c.latencyMs / maxLat);
    const overload = w.overload * Math.min(1, c.queueDepth / 100) * 1;
    const cost = w.cost * (c.estCostPerHourMicro / maxCost);
    const failure = w.failure * Math.min(1, c.errorRate * 10 + c.restarts7d / 10);
    return { id: c.id, score: fit + capacity + latency - overload - cost - failure };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored[0]!;
}

/* ───────────── 6. 지출 상한 보호 ───────────── */

/** 경과 비율로 월말 예상 지출을 추정해 ok/warn/block 판정. */
export function budgetState(capMicro: Micro, spentMicro: Micro, elapsedFraction: number, warnRatio = 0.8): "ok" | "warn" | "block" {
  if (spentMicro >= capMicro) return "block";
  const projected = elapsedFraction > 0 ? spentMicro / elapsedFraction : spentMicro;
  return projected >= capMicro * warnRatio || spentMicro >= capMicro * warnRatio ? "warn" : "ok";
}
