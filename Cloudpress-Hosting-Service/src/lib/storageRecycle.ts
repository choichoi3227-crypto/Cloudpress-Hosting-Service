import { BYTES_PER_GB } from "./storageOptimizer";
import type { Product } from "./catalog";
import type { Micro } from "./money";

/**
 * 용량 재활용(대여) 로직.
 * - 약정(entitlement)은 고객에게 보이는 "논리" 용량이다. 압축·중복 제거로 물리 사용량이 줄어도 고객은 약정 전체를 쓸 수 있다.
 * - R2 는 용량이 탄력적이라 물리적 부족은 없다. 대여는 약정 회계(= 초과 과금 회피)와 비용 풀링을 위한 장치다.
 * - 대여자는 손해 보지 않는다: 대여자의 과금 기준 약정은 줄지 않고(billableOverage 참고), 필요하면 언제든 회수한다.
 */

export const entitlementBytes = (p: Product) => (p.includedStorageGB ?? 0) * BYTES_PER_GB;

export interface BucketLedger {
  id: string;
  customerId: string;
  entitlementBytes: number;
  /** 일별 논리 사용량 최대치(오래된 것 → 최신). */
  dailyPeakBytes: number[];
  usedBytes: number;
  lentBytes: number;
  borrowedBytes: number;
  createdAtMs: number;
  lastRecallAtMs?: number;
}

export interface RecycleParams {
  lookbackDays: number;
  minHistoryDays: number;
  growthWindowDays: number;
  safetyFraction: number;
  /** 유휴 헤드룸 중 대여 가능한 비율(요청 사양: 50%). */
  lendFraction: number;
  maxLentFractionOfEntitlement: number;
  chunkBytes: number;
  recallCooldownDays: number;
  graceHours: number;
  /** 'customer' = 같은 고객의 다른 서비스끼리만. 'platform' = 고객 간(운영자 승인·약관 필요, 기본 꺼짐). */
  scope: "customer" | "platform";
}
export const DEFAULT_RECYCLE: RecycleParams = {
  lookbackDays: 30, minHistoryDays: 30, growthWindowDays: 30, safetyFraction: 0.1, lendFraction: 0.5,
  maxLentFractionOfEntitlement: 0.5, chunkBytes: 256 * 1024 * 1024, recallCooldownDays: 7, graceHours: 72, scope: "customer",
};
const DAY = 86_400_000;
const floorChunk = (n: number, c: number) => Math.floor(Math.max(0, n) / c) * c;

/** 앞으로 성장 예측(바이트/일, 음수는 0). 최근 7일 평균과 그 이전 구간 평균의 차이로 선형 추정. */
export function growthPerDay(peaks: number[]): number {
  if (peaks.length < 14) return 0;
  const recent = peaks.slice(-7);
  const prior = peaks.slice(0, -7);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const days = (prior.length + 7) / 2; // 두 평균 사이의 대략적 간격(일)
  return Math.max(0, (avg(recent) - avg(prior)) / days);
}

/** 추가로 빌려줄 수 있는 바이트. 이력 부족·최근 회수 직후·성장 중이면 0 에 가깝다. */
export function additionalLendable(b: BucketLedger, nowMs: number, p: RecycleParams = DEFAULT_RECYCLE): number {
  if (b.borrowedBytes > 0) return 0; // 대여자와 차용자를 겸하지 않는다(순환 방지)
  const history = b.dailyPeakBytes.slice(-p.lookbackDays);
  if (history.length < p.minHistoryDays) return 0;
  if (b.lastRecallAtMs !== undefined && nowMs - b.lastRecallAtMs < p.recallCooldownDays * DAY) return 0;
  const peak = Math.max(...history, b.usedBytes);
  const buffer = Math.max(p.safetyFraction * b.entitlementBytes, growthPerDay(history) * p.growthWindowDays * 2);
  const idle = b.entitlementBytes - peak - buffer;
  if (idle <= 0) return 0;
  const allowedTotal = Math.min(p.lendFraction * idle, p.maxLentFractionOfEntitlement * b.entitlementBytes);
  return floorChunk(allowedTotal - b.lentBytes, p.chunkBytes);
}

/** 차용자가 필요로 하는 추가 약정: 현재 사용량 +10% 와 14일 성장분이 (약정+차용)을 넘는 만큼. */
export function neededBytes(b: BucketLedger, p: RecycleParams = DEFAULT_RECYCLE): number {
  if (b.lentBytes > 0) return 0;
  const projected = b.usedBytes * 1.1 + growthPerDay(b.dailyPeakBytes.slice(-p.lookbackDays)) * 14;
  const shortage = projected - (b.entitlementBytes + b.borrowedBytes);
  const pressured = b.usedBytes > 0.9 * (b.entitlementBytes + b.borrowedBytes) || shortage > 0;
  if (!pressured || shortage <= 0) return 0;
  const cap = b.entitlementBytes - b.borrowedBytes; // 차용 총량은 자기 약정 이하
  return Math.min(Math.ceil(shortage / p.chunkBytes) * p.chunkBytes, Math.max(0, floorChunk(cap, p.chunkBytes)));
}

export interface LoanProposal { lenderId: string; borrowerId: string; bytes: number }

/** 탐욕 매칭: 부족량이 큰 차용자부터, 같은 고객의 대여자 → 대여 가능량이 큰 순. 청크 단위로만 이동. */
export function matchLoans(buckets: BucketLedger[], nowMs: number, p: RecycleParams = DEFAULT_RECYCLE): LoanProposal[] {
  const pool = new Map(buckets.map((b) => [b.id, additionalLendable(b, nowMs, p)]));
  const borrowers = buckets.map((b) => ({ b, need: neededBytes(b, p) })).filter((x) => x.need > 0).sort((a, b) => b.need - a.need || a.b.id.localeCompare(b.b.id));
  const out: LoanProposal[] = [];
  for (const { b, need } of borrowers) {
    let left = need;
    const lenders = buckets
      .filter((l) => l.id !== b.id && (pool.get(l.id) ?? 0) >= p.chunkBytes && (p.scope === "platform" || l.customerId === b.customerId))
      .sort((x, y) => Number(y.customerId === b.customerId) - Number(x.customerId === b.customerId) || (pool.get(y.id)! - pool.get(x.id)!) || x.id.localeCompare(y.id));
    for (const l of lenders) {
      if (left <= 0) break;
      const give = floorChunk(Math.min(left, pool.get(l.id)!), p.chunkBytes);
      if (give <= 0) continue;
      out.push({ lenderId: l.id, borrowerId: b.id, bytes: give });
      pool.set(l.id, pool.get(l.id)! - give);
      left -= give;
    }
  }
  return out;
}

export interface ActiveLoan { id: string; bytes: number; createdAtMs: number }

/** 대여자의 사용량이 늘어 완충 여유가 줄면, 최근 대여 순(LIFO)으로 필요한 만큼만 회수. */
export function planRecall(b: BucketLedger, loans: ActiveLoan[], p: RecycleParams = DEFAULT_RECYCLE) {
  const buffer = Math.max(p.safetyFraction * b.entitlementBytes, growthPerDay(b.dailyPeakBytes.slice(-p.lookbackDays)) * p.growthWindowDays);
  const room = b.entitlementBytes - b.lentBytes - b.usedBytes;
  let deficit = buffer - room;
  if (deficit <= 0) return { recall: [] as string[], bytes: 0, graceHours: p.graceHours };
  const recall: string[] = [];
  let bytes = 0;
  for (const l of [...loans].sort((a, c) => c.createdAtMs - a.createdAtMs || a.id.localeCompare(c.id))) {
    if (deficit <= 0) break;
    recall.push(l.id); bytes += l.bytes; deficit -= l.bytes;
  }
  return { recall, bytes, graceHours: p.graceHours };
}

/** 과금 기준 초과량. 대여자는 약정이 줄지 않으므로 자기 약정만 기준(손해 없음), 차용자는 약정+차용분 기준. */
export function billableOverageBytes(b: Pick<BucketLedger, "usedBytes" | "entitlementBytes" | "borrowedBytes">): number {
  return Math.max(0, b.usedBytes - (b.entitlementBytes + b.borrowedBytes));
}

/** 게이트웨이 쓰기 허용 판단: 약정+차용+(고객이 허용한 유료 초과분 한도). */
export function writeAllowed(b: Pick<BucketLedger, "usedBytes" | "entitlementBytes" | "borrowedBytes">, incomingBytes: number, paidOverageCapBytes: number): boolean {
  return b.usedBytes + incomingBytes <= b.entitlementBytes + b.borrowedBytes + paidOverageCapBytes;
}

/** 고객 간(platform) 대여로 차용자가 덜 내게 되는 금액 = 운영자의 매출 감소분. 화면에 표시해 승인 판단에 쓴다. */
export function revenueImpactMicro(borrowedBytes: number, borrowerOverageBeforeBytes: number, overagePerGB: Micro): Micro {
  const credited = Math.min(borrowedBytes, borrowerOverageBeforeBytes);
  return Math.round((credited / BYTES_PER_GB) * overagePerGB);
}

/** 적용된 제안을 원장에 반영(순수 함수). 합계 보존: Σ lent = Σ borrowed. */
export function applyProposals(buckets: BucketLedger[], proposals: LoanProposal[]): BucketLedger[] {
  const m = new Map(buckets.map((b) => [b.id, { ...b }]));
  for (const pr of proposals) { m.get(pr.lenderId)!.lentBytes += pr.bytes; m.get(pr.borrowerId)!.borrowedBytes += pr.bytes; }
  return [...m.values()];
}
