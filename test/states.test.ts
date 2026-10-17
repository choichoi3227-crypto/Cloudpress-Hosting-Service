import { describe, it, expect } from "vitest";
import { assertTransition, SUBSCRIPTION_TRANSITIONS, JOB_TRANSITIONS, PAYOUT_TRANSITIONS } from "../src/lib/states";

describe("상태 전이", () => {
  it("허용 전이", () => {
    expect(() => assertTransition(SUBSCRIPTION_TRANSITIONS, "incomplete", "active")).not.toThrow();
    expect(() => assertTransition(JOB_TRANSITIONS, "failed", "retrying")).not.toThrow();
    expect(() => assertTransition(PAYOUT_TRANSITIONS, "approved", "paid")).not.toThrow();
  });
  it("금지 전이", () => {
    expect(() => assertTransition(SUBSCRIPTION_TRANSITIONS, "canceled", "active")).toThrow();
    expect(() => assertTransition(JOB_TRANSITIONS, "succeeded", "running")).toThrow();
    expect(() => assertTransition(PAYOUT_TRANSITIONS, "pending", "paid")).toThrow(); // 승인 없이 지급 불가
  });
});
