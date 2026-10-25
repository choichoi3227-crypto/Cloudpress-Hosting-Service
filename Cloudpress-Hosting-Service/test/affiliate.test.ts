import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { commissionFor, planPayout, isPayoutDay, type AffiliatePolicy } from "../src/lib/affiliate";

const policy: AffiliatePolicy = { rateBp: 1500, minMaintainedMonths: 2, minPayoutMicro: usd("25"), maxCommissionMonths: 12, payoutDayOfMonth: 10 };
const T0 = Date.UTC(2026, 0, 1);
const pay = (o = {}) => ({ paymentId: "p1", subscriptionId: "s1", paidMicro: usd("100"), refundedMicro: 0, chargebackMicro: 0, unpaid: false, paidAtMs: T0 + 40 * 86400_000, ...o });
const facts = (o = {}) => ({ firstQualifyingPaymentAtMs: T0, maintainedMonths: 2, referralValid: true, selfReferral: false, ...o });

describe("affiliate", () => {
  it("15% 수수료", () => expect(commissionFor(pay(), facts(), policy)).toBe(usd("15")));
  it("환불·차지백 제외", () => {
    expect(commissionFor(pay({ refundedMicro: usd("40") }), facts(), policy)).toBe(usd("9"));
    expect(commissionFor(pay({ chargebackMicro: usd("100") }), facts(), policy)).toBe(0);
  });
  it("미납·자기추천·무효 추천·유지기간 미달은 0", () => {
    expect(commissionFor(pay({ unpaid: true }), facts(), policy)).toBe(0);
    expect(commissionFor(pay(), facts({ selfReferral: true }), policy)).toBe(0);
    expect(commissionFor(pay(), facts({ referralValid: false }), policy)).toBe(0);
    expect(commissionFor(pay(), facts({ maintainedMonths: 1 }), policy)).toBe(0);
  });
  it("12개월 지급 기간 초과 시 0", () => {
    expect(commissionFor(pay({ paidAtMs: T0 + 400 * 86400_000 }), facts(), policy)).toBe(0);
  });
  it("최소 지급액 미만은 이월", () => {
    expect(planPayout([usd("10")], 0, policy)).toEqual({ payMicro: 0, carryoverMicro: usd("10") });
    expect(planPayout([usd("10")], usd("20"), policy)).toEqual({ payMicro: usd("30"), carryoverMicro: 0 });
  });
  it("매월 10일(UTC) 판정", () => {
    expect(isPayoutDay(new Date(Date.UTC(2026, 10, 10)), policy)).toBe(true);
    expect(isPayoutDay(new Date(Date.UTC(2026, 10, 11)), policy)).toBe(false);
  });
});
