import { describe, it, expect } from "vitest";
import { usd, toCents, formatUsd, mulMilli } from "../src/lib/money";

describe("money", () => {
  it("십진 문자열을 정수 micro-USD로 변환", () => {
    expect(usd("12.99")).toBe(12_990_000);
    expect(usd("0.0025")).toBe(2_500);
    expect(usd("0.1") + usd("0.2")).toBe(usd("0.3")); // 부동소수점 오차 없음
  });
  it("잘못된 입력 거부", () => {
    expect(() => usd("1e3")).toThrow();
    expect(() => usd("1.1234567")).toThrow();
    expect(() => usd("abc")).toThrow();
  });
  it("센트 반올림 half-up", () => {
    expect(toCents(usd("0.005"))).toBe(1);
    expect(toCents(usd("0.0049"))).toBe(0);
    expect(formatUsd(usd("1234.5"))).toBe("$1,234.50");
  });
  it("mulMilli 정수 연산", () => {
    expect(mulMilli(usd("0.79"), 5000)).toBe(usd("3.95"));
    expect(() => mulMilli(1, 1.5)).toThrow();
  });
});
