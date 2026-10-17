import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { downtimeBudgetSeconds, availabilityPercent, seriesAvailability, parallelAvailability, slaCreditMicro, burnRate, downSecondsFromProbes } from "../src/lib/sla";

const MONTH = 30 * 86400;
describe("sla", () => {
  it("99.99% 월 허용 장애는 약 259초", () => {
    expect(downtimeBudgetSeconds(99.99, MONTH)).toBe(259);
  });
  it("가동률 계산과 점검 시간 제외", () => {
    expect(availabilityPercent(MONTH, 0)).toBe(100);
    expect(availabilityPercent(1000, 100, 0)).toBeCloseTo(90);
    expect(availabilityPercent(1000, 100, 500)).toBeCloseTo(80);
  });
  it("직렬 의존은 가용성을 낮추고 병렬 이중화는 높인다", () => {
    expect(seriesAvailability([99.9, 99.9])).toBeCloseTo(99.8, 2);
    expect(parallelAvailability([99.86, 99.86])).toBeGreaterThan(99.99);
  });
  it("장애 전환이 실패하면 이중화 효과가 줄어든다", () => {
    const ideal = parallelAvailability([99.9, 99.9], 1);
    const half = parallelAvailability([99.9, 99.9], 0.5);
    expect(half).toBeLessThan(ideal);
    expect(half).toBeGreaterThan(99.9);
  });
  it("SLA 크레딧 단계와 상한", () => {
    const fee = usd("100");
    expect(slaCreditMicro(99.995, 99.99, fee)).toBe(0);
    expect(slaCreditMicro(99.95, 99.99, fee)).toBe(usd("10"));
    expect(slaCreditMicro(99.5, 99.99, fee)).toBe(usd("25"));
    expect(slaCreditMicro(98, 99.99, fee)).toBe(usd("50"));
    expect(slaCreditMicro(90, 99.99, fee)).toBe(fee);
  });
  it("번 레이트", () => {
    expect(burnRate(0, 100, 99.99)).toBe(0);
    expect(burnRate(26, 259_000, 99.99)).toBeCloseTo(1, 0);
  });
  it("프로브: 단발 실패는 장애 아님, 연속 실패만 인정", () => {
    const s = (ok: boolean[]) => ok.map((o, i) => ({ ts: i * 30, ok: o }));
    expect(downSecondsFromProbes(s([true, false, true, true]), 30)).toBe(0);
    expect(downSecondsFromProbes(s([true, false, false, true]), 30)).toBe(60);
    expect(downSecondsFromProbes(s([true, false, false, false, true]), 30)).toBe(90);
  });
});
