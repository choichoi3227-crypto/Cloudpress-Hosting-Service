import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { selectPostgresProvider, shouldMigrateProvider, neonMonthlyCost, supabaseMonthlyCost, SEED_PG_CONFIG, ENGINE_BACKENDS, type PgWorkload } from "../src/lib/dbEngines";

const base: PgWorkload = { size: "micro", activeHoursPerMonth: 100, wakesPerMonth: 60, storageGB: 2, alwaysOnRequired: false, coldStartToleranceMs: 5000, haRequired: false };
const cap = { neonProjectsUsed: 0, supabaseProjectsUsed: 0 };

describe("PostgreSQL 제공자 선택(Neon vs Supabase)", () => {
  it("가끔 쓰는 소형 DB는 Neon(절전으로 유휴 비용 절감)", () => {
    const d = selectPostgresProvider(base, cap);
    expect(d.primary).toBe("neon");
    expect(d.costs.neon!).toBeLessThan(d.costs.supabase!);
  });
  it("상시 가동 소형 DB는 Supabase 가 더 저렴", () => {
    const d = selectPostgresProvider({ ...base, size: "small", alwaysOnRequired: true, activeHoursPerMonth: 730 }, cap);
    expect(d.primary).toBe("supabase");
  });
  it("지연 허용치가 낮으면 Neon 콜드 스타트 감점으로 성능 반영", () => {
    const tolerant = selectPostgresProvider({ ...base, activeHoursPerMonth: 300 }, cap);
    const strict = selectPostgresProvider({ ...base, activeHoursPerMonth: 300, coldStartToleranceMs: 100 }, cap);
    expect(strict.scores.neon!).toBeLessThan(tolerant.scores.neon!);
  });
  it("결과는 항상 neon 또는 supabase", () => {
    for (const size of ["micro", "small", "medium", "large"] as const)
      for (const hrs of [10, 200, 730]) for (const ao of [true, false]) {
        const d = selectPostgresProvider({ ...base, size, activeHoursPerMonth: hrs, alwaysOnRequired: ao }, cap);
        expect(["neon", "supabase"]).toContain(d.primary);
      }
  });
  it("Neon Launch 프로젝트 상한 초과 시 Scale 요금(2.09배 compute) 적용 및 이유 기록", () => {
    const launch = neonMonthlyCost({ ...base, alwaysOnRequired: true }, cap, SEED_PG_CONFIG)!;
    const scale = neonMonthlyCost({ ...base, alwaysOnRequired: true }, { ...cap, neonProjectsUsed: 100 }, SEED_PG_CONFIG)!;
    expect(scale.plan).toBe("scale");
    expect(scale.cost).toBeGreaterThan(launch.cost * 1.8);
    expect(selectPostgresProvider(base, { ...cap, neonProjectsUsed: 100 }).reasons.join()).toContain("Scale");
  });
  it("한쪽 용량 소진 시 다른 쪽, 둘 다 소진되면 오류(가짜 배치 금지)", () => {
    expect(selectPostgresProvider(base, { neonProjectsUsed: 1000, supabaseProjectsUsed: 0 }).primary).toBe("supabase");
    const cfg = { ...SEED_PG_CONFIG, supabaseProjectCap: 5 };
    expect(selectPostgresProvider(base, { neonProjectsUsed: 0, supabaseProjectsUsed: 5 }, cfg).primary).toBe("neon");
    expect(() => selectPostgresProvider(base, { neonProjectsUsed: 1000, supabaseProjectsUsed: 5 }, cfg)).toThrow(/capacity_exhausted/);
  });
  it("HA 는 교차 제공자 보조를 지정(주≠보조)", () => {
    const d = selectPostgresProvider({ ...base, haRequired: true }, cap);
    expect(d.standby).not.toBeNull();
    expect(d.standby).not.toBe(d.primary);
  });
  it("관리자 가중치로 결과가 바뀔 수 있음(성능 100%·신뢰도 편향)", () => {
    const cfg = { ...SEED_PG_CONFIG, weights: { cost: 0, perf: 0, reliability: 100 }, reliability: { neon: 40, supabase: 90 } };
    expect(selectPostgresProvider(base, cap, cfg).primary).toBe("supabase");
  });
  it("동점이면 Neon(주 제공자) 우선, 결정은 결정적", () => {
    const cfg = { ...SEED_PG_CONFIG, weights: { cost: 0, perf: 0, reliability: 100 } };
    expect(selectPostgresProvider(base, cap, cfg).primary).toBe("neon");
    expect(selectPostgresProvider(base, cap)).toEqual(selectPostgresProvider(base, cap));
  });
  it("원가 계산 검증: Supabase micro 2GB = $10, Neon 0.25CU×100h 기본", () => {
    expect(supabaseMonthlyCost(base, cap, SEED_PG_CONFIG)).toBe(usd("10"));
    // 활성 100h + 깨어남 60회×5분(=5h) → 105h × 0.25CU × 0.106 = 2.7825 + 저장 0.70
    expect(neonMonthlyCost(base, cap, SEED_PG_CONFIG)!.cost).toBe(usd("2.7825") + usd("0.70"));
  });
  it("이전 권고는 절감 임계·회수 기간을 만족할 때만(진동 방지)", () => {
    expect(shouldMigrateProvider(usd("3"), usd("1"))).toBe(false);
    expect(shouldMigrateProvider(usd("10"), usd("100"))).toBe(false);
    expect(shouldMigrateProvider(usd("10"), usd("30"), { horizonMonths: 6, minSavingPerMonth: usd("5"), minSavingRatioBp: 2500, currentMonthly: usd("30") })).toBe(true);
    expect(shouldMigrateProvider(usd("10"), usd("30"), { horizonMonths: 6, minSavingPerMonth: usd("5"), minSavingRatioBp: 2500, currentMonthly: usd("100") })).toBe(false);
  });
  it("엔진별 백엔드: 모든 엔진이 정의되고 Postgres 는 Neon/Supabase 만", () => {
    expect(Object.keys(ENGINE_BACKENDS).sort()).toEqual(["mariadb", "mysql", "postgres", "sqlite"]);
    expect(ENGINE_BACKENDS.postgres.providers).toEqual(["neon", "supabase"]);
    expect(ENGINE_BACKENDS.sqlite.providers).toEqual(["d1"]);
  });
});
