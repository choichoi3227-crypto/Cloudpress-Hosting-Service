import type { Micro } from "./money";

export interface AffiliatePolicy {
  /** 0~10000 (bp). 1500 = 15%. */
  rateBp: number;
  minMaintainedMonths: number;
  minPayoutMicro: Micro;
  maxCommissionMonths: number;
  payoutDayOfMonth: number;
}

export interface QualifyingPayment {
  paymentId: string;
  subscriptionId: string;
  paidMicro: Micro;
  refundedMicro: Micro;
  chargebackMicro: Micro;
  /** 미납(결제 실패)이면 true. */
  unpaid: boolean;
  paidAtMs: number;
}

export interface SubscriptionFacts {
  firstQualifyingPaymentAtMs: number;
  /** 정상 유지 개월 수(미납/정지 제외). */
  maintainedMonths: number;
  referralValid: boolean;
  /** 추천자 = 구매자 등 부정 추천 여부. */
  selfReferral: boolean;
}

const MONTH_MS = 30.4375 * 24 * 3600 * 1000;

/** 결제 1건의 수수료. 환불·차지백·미납 제외 후 bp 곱. */
export function commissionFor(p: QualifyingPayment, f: SubscriptionFacts, policy: AffiliatePolicy): Micro {
  if (!f.referralValid || f.selfReferral || p.unpaid) return 0;
  if (f.maintainedMonths < policy.minMaintainedMonths) return 0;
  if (p.paidAtMs - f.firstQualifyingPaymentAtMs >= policy.maxCommissionMonths * MONTH_MS) return 0;
  const net = Math.max(0, p.paidMicro - p.refundedMicro - p.chargebackMicro);
  return Math.floor((net * policy.rateBp) / 10_000);
}

/** 지급일(UTC) 판정. */
export function isPayoutDay(date: Date, policy: AffiliatePolicy): boolean {
  return date.getUTCDate() === policy.payoutDayOfMonth;
}

/** 제휴자별 지급 예정: 이월(carryover) 포함 합계가 최소 지급액 미만이면 다음 달로 이월. */
export function planPayout(commissions: Micro[], carryoverMicro: Micro, policy: AffiliatePolicy) {
  const total = commissions.reduce((a, c) => a + c, 0) + carryoverMicro;
  if (total < policy.minPayoutMicro) return { payMicro: 0, carryoverMicro: total };
  return { payMicro: total, carryoverMicro: 0 };
}
