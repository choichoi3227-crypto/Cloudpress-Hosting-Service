import { usd, mulMilli, type Micro } from "./money";
import type { DbEngine } from "./catalog";

export type PgProvider = "neon" | "supabase";
export type PgSizeId = "micro" | "small" | "medium" | "large";

/** 엔진별 백엔드 매핑. 허용되지 않는 조합은 D1 CHECK 제약으로도 막는다. */
export const ENGINE_BACKENDS: Record<DbEngine, { providers: readonly string[]; stateful: true; note: string }> = {
  mariadb: { providers: ["cloudb_container"], stateful: true, note: "Cloudflare Containers + R2 백업/binlog 전송" },
  mysql: { providers: ["cloudb_container"], stateful: true, note: "Cloudflare Containers + R2 백업/binlog 전송" },
  sqlite: { providers: ["d1"], stateful: true, note: "Cloudflare D1(컨테이너 불필요, 유휴 비용 거의 0)" },
  postgres: { providers: ["neon", "supabase"], stateful: true, note: "Neon 또는 Supabase(원가·성능·효율 점수로 선택)" },
};

/** 크기 등급 ↔ 두 제공자 사양 매핑. Neon 1 CU = 1 vCPU + 4 GiB. */
export const PG_CLASSES: Record<PgSizeId, { ramGiB: number; neonCuMilli: number; supabaseComputeMicro: Micro }> = {
  micro: { ramGiB: 1, neonCuMilli: 250, supabaseComputeMicro: usd("10") },
  small: { ramGiB: 2, neonCuMilli: 500, supabaseComputeMicro: usd("15") },
  medium: { ramGiB: 4, neonCuMilli: 1000, supabaseComputeMicro: usd("60") },
  large: { ramGiB: 8, neonCuMilli: 2000, supabaseComputeMicro: usd("110") },
};

/** 모든 값은 관리자 설정으로 덮어쓴다. 아래는 2026-10 조사 시드(출처: 공개 가격 페이지·2차 자료). */
export interface PgSelectorConfig {
  neonLaunchPerCuHour: Micro;
  neonScalePerCuHour: Micro;
  neonStoragePerGBMonth: Micro;
  /** 플랜별 프로젝트 수 상한(2차 자료 기준, 공식 확인 필요). */
  neonLaunchProjectCap: number;
  neonScaleProjectCap: number;
  neonIdleTimeoutMin: number;
  supabaseIncludedDiskGB: number;
  supabaseDiskPerGB: Micro;
  supabaseProjectCap: number;
  /** 가정값: 벤치마크 작업으로 실측해 교체해야 한다. */
  neonColdStartMs: number;
  weights: { cost: number; perf: number; reliability: number };
  /** 가정값(둘 다 공개 계약 SLA 없음 → 동일). 실측 가동률로 교체. */
  reliability: { neon: number; supabase: number };
  steadyPerf: { neon: number; supabase: number };
}

export const SEED_PG_CONFIG: PgSelectorConfig = {
  neonLaunchPerCuHour: usd("0.106"),
  neonScalePerCuHour: usd("0.222"),
  neonStoragePerGBMonth: usd("0.35"),
  neonLaunchProjectCap: 100,
  neonScaleProjectCap: 1000,
  neonIdleTimeoutMin: 5,
  supabaseIncludedDiskGB: 8,
  supabaseDiskPerGB: usd("0.125"),
  supabaseProjectCap: Number.POSITIVE_INFINITY,
  neonColdStartMs: 800,
  weights: { cost: 50, perf: 30, reliability: 20 },
  reliability: { neon: 50, supabase: 50 },
  steadyPerf: { neon: 80, supabase: 80 },
};

export interface PgWorkload {
  size: PgSizeId;
  /** 월 활성 시간(시간). 상시 가동이면 730. */
  activeHoursPerMonth: number;
  /** 월 깨어남(콜드 스타트) 횟수. */
  wakesPerMonth: number;
  storageGB: number;
  /** true 면 절전 불가(항상 켜짐). Neon 은 suspend 를 끄고 계속 과금. */
  alwaysOnRequired: boolean;
  /** 허용 가능한 콜드 스타트 지연(ms). */
  coldStartToleranceMs: number;
  haRequired: boolean;
}

export interface PgCapacity { neonProjectsUsed: number; supabaseProjectsUsed: number }

const HOURS = 730;

export function neonMonthlyCost(w: PgWorkload, cap: PgCapacity, c: PgSelectorConfig): { cost: Micro; plan: "launch" | "scale" } | null {
  const plan = cap.neonProjectsUsed < c.neonLaunchProjectCap ? "launch" : cap.neonProjectsUsed < c.neonScaleProjectCap ? "scale" : null;
  if (!plan) return null;
  const rate = plan === "launch" ? c.neonLaunchPerCuHour : c.neonScalePerCuHour;
  const idleTailHours = w.alwaysOnRequired ? 0 : (w.wakesPerMonth * c.neonIdleTimeoutMin) / 60;
  const hours = w.alwaysOnRequired ? HOURS : Math.min(HOURS, w.activeHoursPerMonth + idleTailHours);
  const compute = Math.round((PG_CLASSES[w.size].neonCuMilli * Math.round(hours * 1000) * rate) / 1_000_000);
  const storage = Math.round(w.storageGB * c.neonStoragePerGBMonth);
  return { cost: compute + storage, plan };
}

export function supabaseMonthlyCost(w: PgWorkload, cap: PgCapacity, c: PgSelectorConfig): Micro | null {
  if (cap.supabaseProjectsUsed >= c.supabaseProjectCap) return null;
  const extraGB = Math.max(0, w.storageGB - c.supabaseIncludedDiskGB);
  return PG_CLASSES[w.size].supabaseComputeMicro + Math.round(extraGB * c.supabaseDiskPerGB);
}

export interface PgDecision {
  primary: PgProvider;
  standby: PgProvider | null;
  costs: { neon: Micro | null; supabase: Micro | null };
  scores: { neon: number | null; supabase: number | null };
  reasons: string[];
}

/** PostgreSQL 제공자 선택: 결과는 항상 neon 또는 supabase. 동점이면 Neon(주 제공자) 우선. */
export function selectPostgresProvider(w: PgWorkload, cap: PgCapacity, c: PgSelectorConfig = SEED_PG_CONFIG): PgDecision {
  const neon = neonMonthlyCost(w, cap, c);
  const sb = supabaseMonthlyCost(w, cap, c);
  if (!neon && !sb) throw new Error("capacity_exhausted: Neon·Supabase 모두 신규 프로젝트를 만들 수 없음");
  const reasons: string[] = [];
  const costs = { neon: neon?.cost ?? null, supabase: sb };
  const present = [neon?.cost, sb].filter((x): x is number => x != null);
  const minCost = Math.min(...present);
  const tot = c.weights.cost + c.weights.perf + c.weights.reliability;
  const perfNeon = w.alwaysOnRequired || w.coldStartToleranceMs >= c.neonColdStartMs ? c.steadyPerf.neon : Math.min(c.steadyPerf.neon, 30);
  const score = (cost: number, perf: number, rel: number) => (c.weights.cost * (100 * minCost / cost) + c.weights.perf * perf + c.weights.reliability * rel) / tot;
  const scores = {
    neon: neon ? score(neon.cost, perfNeon, c.reliability.neon) : null,
    supabase: sb != null ? score(sb, c.steadyPerf.supabase, c.reliability.supabase) : null,
  };
  if (!neon) reasons.push("Neon 프로젝트 상한 도달로 제외");
  if (sb == null) reasons.push("Supabase 프로젝트 상한 도달로 제외");
  if (neon && perfNeon < c.steadyPerf.neon) reasons.push(`콜드 스타트 허용치(${w.coldStartToleranceMs}ms) < Neon 재개 지연 가정(${c.neonColdStartMs}ms)이라 성능 점수 감점`);
  if (neon?.plan === "scale") reasons.push("Neon Launch 프로젝트 상한 초과 → Scale 요금 적용");
  const primary: PgProvider = scores.supabase != null && (scores.neon == null || scores.supabase > scores.neon + 1e-9) ? "supabase" : "neon";
  reasons.push(`${primary} 선택: 월 원가 ${costs[primary] != null ? (costs[primary]! / 1e6).toFixed(2) : "?"} USD`);
  let standby: PgProvider | null = null;
  if (w.haRequired) {
    standby = primary === "neon" ? "supabase" : "neon";
    if (costs[standby] == null) throw new Error("ha_unavailable: 보조 제공자 용량 부족");
    reasons.push(`HA: 교차 제공자 보조 ${standby} (독립 장애 도메인)`);
  }
  return { primary, standby, costs, scores, reasons };
}

/** 이미 운영 중인 DB 의 제공자 이전은 절감액이 이전 비용을 기간 내 회수하고 임계치를 넘을 때만 권고(진동 방지). */
export function shouldMigrateProvider(savingPerMonth: Micro, migrationCost: Micro, opts = { horizonMonths: 6, minSavingPerMonth: usd("5"), minSavingRatioBp: 2500, currentMonthly: 0 }): boolean {
  if (savingPerMonth < opts.minSavingPerMonth) return false;
  if (opts.currentMonthly > 0 && (savingPerMonth * 10_000) / opts.currentMonthly < opts.minSavingRatioBp) return false;
  return savingPerMonth * opts.horizonMonths > migrationCost;
}

/** 읽기 캐시는 유료 Postgres 가 아니라 Workers Cache/KV 에서 처리한다(비용·지연 모두 유리). */
export const CACHE_LAYER_NOTE = "Supabase 는 캐시가 아니라 HA 보조(복제본) 용도. 읽기 캐시는 Workers Cache API/KV.";

export { mulMilli };
