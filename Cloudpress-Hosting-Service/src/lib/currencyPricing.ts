import { usdMicroToWon } from "./fx";

export interface KrwPriceConfig {
  /** 판매가 올림 단위(원). */
  roundingWon: number;
  /** 목표 마진율(원가 대비, bp). */
  targetMarkupBp: number;
  /** 하한 마진율(bp): 이 아래로는 절대 판매하지 않는다. */
  floorMarginBp: number;
  /** 시장 상한가(원): 경쟁 가격·고객 수용 한계. */
  ceilingWon: number;
  feeRateBp: number;
  feeFixedWon: number;
  /** 목록가 변경 임계(bp). 작은 환율 잡음에는 가격을 바꾸지 않는다. */
  hysteresisBp: number;
  minIntervalMs: number;
  /** 한 번에 바꿀 수 있는 최대 폭(bp). 하한 아래로 내려간 경우의 긴급 인상은 예외. */
  maxStepBp: number;
}
export const SEED_KRW_PRICE_CONFIG: KrwPriceConfig = { roundingWon: 100, targetMarkupBp: 2500, floorMarginBp: 1000, ceilingWon: 100_000, feeRateBp: 340, feeFixedWon: 0, hysteresisBp: 300, minIntervalMs: 24 * 3_600_000, maxStepBp: 1000 };

const ceilTo = (v: number, unit: number) => Math.ceil(v / unit) * unit;
/** 결제 수수료를 반영한 판매가: (원가×(1+마진)+고정수수료) ÷ (1−수수료율). */
const withFees = (costWon: number, marginBp: number, c: KrwPriceConfig) => ceilTo(((costWon * (10_000 + marginBp)) / 10_000 + c.feeFixedWon) / (1 - c.feeRateBp / 10_000), c.roundingWon);

export interface KrwBand { costWon: number; floorWon: number; targetWon: number; ceilingWon: number; sellable: boolean }
export function krwBand(costUsdMicro: number, costSideRateMicro: number, c: KrwPriceConfig = SEED_KRW_PRICE_CONFIG): KrwBand {
  return bandFromCostWon(usdMicroToWon(costUsdMicro, costSideRateMicro), c);
}

/** 원가가 이미 원화인 경우(가비아 공급가). */
export function bandFromCostWon(costWon: number, c: KrwPriceConfig = SEED_KRW_PRICE_CONFIG): KrwBand {
  const floorWon = withFees(costWon, c.floorMarginBp, c);
  const raw = withFees(costWon, c.targetMarkupBp, c);
  const targetWon = Math.min(Math.max(raw, floorWon), Math.max(c.ceilingWon, floorWon));
  // 하한이 상한을 넘으면 팔수록 손해이거나 시장가에 못 맞춘다 → 판매 중지(경고)
  return { costWon, floorWon, targetWon: Math.min(targetWon, c.ceilingWon), ceilingWon: c.ceilingWon, sellable: floorWon <= c.ceilingWon };
}

/** 순마진(원). 결제 수수료 차감 후. */
export const netMarginWon = (priceWon: number, costWon: number, c: KrwPriceConfig = SEED_KRW_PRICE_CONFIG) => priceWon - Math.round((priceWon * c.feeRateBp) / 10_000) - c.feeFixedWon - costWon;

export interface PricePoint { priceWon: number; changedAtMs: number }
export type RepriceAction = "initial" | "keep" | "raise" | "lower" | "emergency_raise" | "halt_sales";
export interface RepriceResult { action: RepriceAction; priceWon: number; reason: string }

/**
 * 목록가 재산정(히스테리시스).
 * - 인상은 빠르게(하한 미달이면 즉시), 인하는 느리게(임계·최소 간격·최대 폭·환율 신선도 조건)
 * - 환율이 오래됐으면 인하하지 않고 인상만 허용
 * - 하한이 상한을 넘으면 판매 중지
 */
export function repriceDecision(prev: PricePoint | null, costUsdMicro: number, costSideRateMicro: number, nowMs: number, rateStale: boolean, c: KrwPriceConfig = SEED_KRW_PRICE_CONFIG): RepriceResult {
  const b = krwBand(costUsdMicro, costSideRateMicro, c);
  if (!b.sellable) return { action: "halt_sales", priceWon: prev?.priceWon ?? b.floorWon, reason: `하한(${b.floorWon}원)이 상한(${b.ceilingWon}원)을 초과: 판매 중지` };
  if (!prev) return { action: "initial", priceWon: b.targetWon, reason: "최초 가격" };
  if (prev.priceWon < b.floorWon) return { action: "emergency_raise", priceWon: Math.min(b.targetWon, b.ceilingWon), reason: "현재가가 하한 미달(환율·원가 상승): 즉시 인상" };
  const diffBp = ((b.targetWon - prev.priceWon) * 10_000) / prev.priceWon;
  const step = (bp: number) => ceilTo(prev.priceWon * (1 + bp / 10_000), c.roundingWon);
  if (diffBp >= c.hysteresisBp) { const next = Math.min(b.targetWon, step(c.maxStepBp), b.ceilingWon); return next > prev.priceWon ? { action: "raise", priceWon: next, reason: `목표가 ${diffBp.toFixed(0)}bp 상회` } : { action: "keep", priceWon: prev.priceWon, reason: "상한 도달" }; }
  if (diffBp <= -c.hysteresisBp) {
    if (rateStale) return { action: "keep", priceWon: prev.priceWon, reason: "환율이 오래되어 인하 보류" };
    if (nowMs - prev.changedAtMs < c.minIntervalMs) return { action: "keep", priceWon: prev.priceWon, reason: "최소 변경 간격 미충족" };
    const lowest = Math.max(b.targetWon, b.floorWon, Math.floor((prev.priceWon * (10_000 - c.maxStepBp)) / 10_000 / c.roundingWon) * c.roundingWon);
    return { action: "lower", priceWon: lowest, reason: `목표가 ${(-diffBp).toFixed(0)}bp 하회` };
  }
  return { action: "keep", priceWon: prev.priceWon, reason: "임계 이내 변동" };
}

/**
 * 수요 탄력성 기반 이론 최적가(Lerner): p* = c·e/(e−1) (e>1). 탄력성은 실측 전 가정값이므로 결과는 [하한, 상한]으로 제한한다.
 * 탄력성 추정에는 동일 시점의 고객별 차등 가격이 아니라 시간대·지역·상품 단위 실험이 필요하다(개인별 차등가격은 위험).
 */
export function optimalPriceWon(costWon: number, elasticity: number, floorWon: number, ceilingWon: number, roundingWon = 100): number {
  const raw = elasticity > 1 ? (costWon * elasticity) / (elasticity - 1) : ceilingWon;
  return Math.min(ceilingWon, Math.max(floorWon, ceilTo(raw, roundingWon)));
}

/** 구독 갱신가 변경: 사전 고지 기간·최대 인상 폭을 지킨다. 인하는 즉시(고객에게 유리). */
export function subscriptionRepriceAllowed(current: number, proposed: number, o: { noticeDaysGiven: number; minNoticeDays: number; maxIncreaseBp: number }): { allowed: boolean; price: number; reason: string } {
  if (proposed <= current) return { allowed: true, price: proposed, reason: "인하는 즉시 적용" };
  if (o.noticeDaysGiven < o.minNoticeDays) return { allowed: false, price: current, reason: `인상은 ${o.minNoticeDays}일 전 사전 고지가 필요` };
  const cap = Math.floor((current * (10_000 + o.maxIncreaseBp)) / 10_000);
  return { allowed: true, price: Math.min(proposed, cap), reason: proposed > cap ? "1회 최대 인상 폭 적용" : "사전 고지 완료" };
}
