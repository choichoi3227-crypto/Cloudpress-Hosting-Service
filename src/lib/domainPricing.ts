import { usd, type Micro } from "./money";

/** 관리자 설정으로 변경 가능. Cloudflare Registrar 는 원가(마크업 없음)로 판매하므로 우리 수수료를 별도로 얹는다. */
export interface DomainPricingConfig {
  markupBp: number;
  minFeeMicro: Micro;
  stripeRateBp: number;
  stripeFixedMicro: Micro;
  /** 견적 후 등록 시점에 원가가 올라도 감수하는 한도. 초과하면 등록하지 않고 환불. */
  driftToleranceMicro: Micro;
  quoteTtlMinutes: number;
}
export const SEED_DOMAIN_PRICING: DomainPricingConfig = { markupBp: 1500, minFeeMicro: usd("2.00"), stripeRateBp: 290, stripeFixedMicro: usd("0.30"), driftToleranceMicro: usd("0.25"), quoteTtlMinutes: 15 };

const ceilCents = (m: Micro) => Math.ceil(m / 10_000) * 10_000;

/** 고객 판매가 = 원가 + 수수료를 Stripe 수수료까지 감안해 올림(센트 단위). 수수료 하한 보장: 결제 수수료를 빼고도 minFee 이상 남는다. */
export function priceFor(costMicro: Micro, c: DomainPricingConfig = SEED_DOMAIN_PRICING): Micro {
  const fee = Math.max(c.minFeeMicro, Math.round((costMicro * c.markupBp) / 10_000));
  const base = costMicro + fee;
  return ceilCents(Math.ceil(((base + c.stripeFixedMicro) * 10_000) / (10_000 - c.stripeRateBp)));
}

export function netMarginMicro(priceMicro: Micro, costMicro: Micro, c: DomainPricingConfig = SEED_DOMAIN_PRICING): Micro {
  return priceMicro - Math.round((priceMicro * c.stripeRateBp) / 10_000) - c.stripeFixedMicro - costMicro;
}

export const driftAcceptable = (quotedCost: Micro, currentCost: Micro, c: DomainPricingConfig = SEED_DOMAIN_PRICING) => currentCost - quotedCost <= c.driftToleranceMicro;

/** 갱신 상태. Registrar API 베타는 갱신을 지원하지 않으므로 운영자가 대시보드에서 수동 갱신해야 한다. */
export type RenewalState = "ok" | "collect_payment" | "operator_renewal_required" | "expiring_soon" | "expired";
export function renewalState(expiresAtMs: number, nowMs: number, renewalPaid: boolean): RenewalState {
  const days = (expiresAtMs - nowMs) / 86_400_000;
  if (days <= 0) return "expired";
  if (renewalPaid) return days <= 14 ? "operator_renewal_required" : "ok";
  if (days <= 14) return "expiring_soon";
  return days <= 45 ? "collect_payment" : "ok";
}
