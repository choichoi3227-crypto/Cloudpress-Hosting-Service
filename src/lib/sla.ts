/** SLA 엔진: 가동률 계산, 허용 장애 예산, 크레딧, 이중화 이론 가용성. 모두 순수 함수. */

export function downtimeBudgetSeconds(targetPercent: number, periodSeconds: number): number {
  return Math.floor(periodSeconds * (1 - targetPercent / 100));
}

/** 가동률(%). 점검 등 제외 시간(excludedSeconds)은 분모·분자에서 제외. */
export function availabilityPercent(periodSeconds: number, downSeconds: number, excludedSeconds = 0): number {
  const measured = periodSeconds - excludedSeconds;
  if (measured <= 0) return 100;
  const down = Math.min(Math.max(0, downSeconds), measured);
  return ((measured - down) / measured) * 100;
}

/** 직렬 의존(모두 살아야 함): 곱. */
export function seriesAvailability(parts: number[]): number {
  return parts.reduce((a, p) => a * (p / 100), 1) * 100;
}

/** 병렬 이중화(하나만 살면 됨): 1 - Π(1-p). 장애 전환 성공률 failoverSuccess(0~1)를 반영. */
export function parallelAvailability(parts: number[], failoverSuccess = 1): number {
  const allDown = parts.reduce((a, p) => a * (1 - p / 100), 1);
  const ideal = 1 - allDown;
  const single = Math.max(...parts) / 100;
  return (single + (ideal - single) * failoverSuccess) * 100;
}

export interface CreditTier { belowPercent: number; creditPercent: number }
export const DEFAULT_CREDIT_TIERS: CreditTier[] = [
  { belowPercent: 95, creditPercent: 100 },
  { belowPercent: 99, creditPercent: 50 },
  { belowPercent: 99.9, creditPercent: 25 },
  { belowPercent: 99.99, creditPercent: 10 },
];

/** 월 요금 대비 SLA 크레딧(micro-USD). 목표 이상이면 0. 월 요금을 넘지 않는다. */
export function slaCreditMicro(measuredPercent: number, targetPercent: number, monthlyFeeMicro: number, tiers = DEFAULT_CREDIT_TIERS): number {
  if (measuredPercent >= targetPercent) return 0;
  const sorted = [...tiers].sort((a, b) => a.belowPercent - b.belowPercent);
  const hit = sorted.find((t) => measuredPercent < t.belowPercent);
  const pct = Math.min(100, hit?.creditPercent ?? 0);
  return Math.floor((monthlyFeeMicro * pct) / 100);
}

/** 번 레이트: 허용 예산 대비 소진 속도. 1.0 = 예산을 딱 맞게 소진. 2 이상이면 경보. */
export function burnRate(downSeconds: number, elapsedSeconds: number, targetPercent: number): number {
  if (elapsedSeconds <= 0) return 0;
  const budgetFraction = 1 - targetPercent / 100;
  return downSeconds / elapsedSeconds / budgetFraction;
}

export interface ProbeSample { ts: number; ok: boolean }

/** 프로브 샘플로 장애 구간(초)을 계산. 연속된 실패 샘플 2회 이상일 때만 장애로 인정(오탐 방지). */
export function downSecondsFromProbes(samples: ProbeSample[], intervalSeconds: number, minConsecutiveFails = 2): number {
  let run = 0;
  let down = 0;
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) {
    if (s.ok) { run = 0; continue; }
    run++;
    if (run === minConsecutiveFails) down += intervalSeconds * minConsecutiveFails;
    else if (run > minConsecutiveFails) down += intervalSeconds;
  }
  return down;
}
