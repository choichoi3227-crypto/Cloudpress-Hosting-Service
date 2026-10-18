import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { getProduct } from "../src/lib/catalog";
import { sqliteMonthly, postgresMonthly, cloudageMonthly, sumLines, ccsOverage, cpuUpgradeQuote, prorate, cswOverage, casUsage, wordpressMonthly } from "../src/lib/pricing";

describe("pricing", () => {
  it("Cloudage 기본 제공 10GB: 6GB·10GB 는 기본료만", () => {
    expect(sumLines(cloudageMonthly(6000))).toBe(usd("7.99"));
    expect(sumLines(cloudageMonthly(10_000))).toBe(usd("7.99"));
  });
  it("Cloudage 16GB = 7.99 + 6×0.79 = $12.73 (명령서 수식, 제공량 10GB 반영)", () => {
    expect(sumLines(cloudageMonthly(16_000))).toBe(usd("12.73"));
  });
  it("CCS 포함 가동 시간 이내는 초과 요금 없음(이중 청구 방지)", () => {
    const p = getProduct("ccs-standard");
    expect(ccsOverage(p, { activeMilliHours: 360_000, activeCpuMilliVcpuMinutes: 1_000_000, egressMilliGB: 0 })).toEqual([]);
  });
  it("CCS 초과 가동은 메모리·디스크 청구", () => {
    const p = getProduct("ccs-standard"); // 4GiB, 8GB
    const lines = ccsOverage(p, { activeMilliHours: 370_000, activeCpuMilliVcpuMinutes: 0, egressMilliGB: 0 });
    // 10시간 × 4GiB × 0.018 = 0.72, 10시간 × 8GB × 0.0005 = 0.04
    expect(sumLines(lines)).toBe(usd("0.76"));
  });
  it("CCS 송신 트래픽은 항상 청구", () => {
    const p = getProduct("ccs-lite");
    expect(sumLines(ccsOverage(p, { activeMilliHours: 0, activeCpuMilliVcpuMinutes: 0, egressMilliGB: 2000 }))).toBe(usd("0.20"));
  });
  it("추가 CPU = 상위 타입 차액", () => {
    expect(cpuUpgradeQuote("ccs-standard", "ccs-performance").deltaMicro).toBe(usd("25.00"));
  });
  it("지원되지 않는 전환 거부", () => {
    expect(() => cpuUpgradeQuote("ccs-performance", "ccs-standard")).toThrow();
    expect(() => cpuUpgradeQuote("ccs-basic", "wp-pro")).toThrow();
    expect(() => cpuUpgradeQuote("cloudage-bucket", "cloudage-bucket")).toThrow();
  });
  it("일할 계산 on/off", () => {
    expect(prorate(usd("30"), 15, 30, true)).toBe(usd("15"));
    expect(prorate(usd("30"), 15, 30, false)).toBe(0);
    expect(() => prorate(1, 31, 30, true)).toThrow();
  });
  it("CSW 포함량 내 무료, 초과분 청구", () => {
    expect(cswOverage(1_000_000, 10_000_000)).toEqual([]);
    expect(sumLines(cswOverage(3_000_000, 20_000_000))).toBe(usd("1.50") + usd("0.50"));
  });
  it("CAS Neurons 과금", () => {
    expect(casUsage("general", 50_000)).toBe(usd("1.00"));
    expect(casUsage("premium", 1_000)).toBe(usd("0.04"));
  });
  it("WordPress 포함 용량 이내는 통합 가격만", () => {
    const p = getProduct("wp-starter");
    expect(sumLines(wordpressMonthly(p, 5000))).toBe(usd("19.99"));
    expect(sumLines(wordpressMonthly(p, 7000))).toBe(usd("19.99") + usd("1.58"));
  });
  it("SQLite(D1): 포함량 내 기본료만, 초과 시 항목별 청구", () => {
    const p = getProduct("cloudb-sqlite");
    expect(sumLines(sqliteMonthly(p, { storageMilliGB: 2000, rowsWritten: 500_000, rowsRead: 50_000_000 }))).toBe(usd("4.99"));
    expect(sumLines(sqliteMonthly(p, { storageMilliGB: 4000, rowsWritten: 1_500_000, rowsRead: 150_000_000 }))).toBe(usd("4.99") + usd("3.00") + usd("2.00") + usd("0.20"));
  });
  it("PostgreSQL: 제공자와 무관한 고객 가격, 초과 저장·송신만 추가", () => {
    const p = getProduct("pg-small");
    expect(sumLines(postgresMonthly(p, { storageMilliGB: 8000, egressMilliGB: 250_000 }))).toBe(usd("26.99"));
    expect(sumLines(postgresMonthly(p, { storageMilliGB: 12_000, egressMilliGB: 350_000 }))).toBe(usd("26.99") + usd("1.00") + usd("18.00"));
  });
});
