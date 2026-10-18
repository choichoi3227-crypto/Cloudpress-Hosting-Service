import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { SEED_PRODUCTS, type InstanceType } from "../src/lib/catalog";
import { rightSize, tuneSleepAfter, detectWaste, planBackupPrune, choosePlacement, budgetState, type WindowStats, type ResourceFacts } from "../src/lib/optimizer";

const price: Record<string, number> = { lite: usd("4.99"), basic: usd("12.99"), "standard-1": usd("34.99"), "standard-2": usd("44.99"), "standard-3": usd("59.99"), "standard-4": usd("120") };
const opts = { allowedTypes: ["lite", "basic", "standard-1", "standard-2", "standard-3"] as InstanceType[], priceOf: (t: InstanceType) => price[t]! };
const healthy: WindowStats = { samples: 5000, days: 14, cpuP95Vcpu: 0.02, memP99MiB: 300, diskUsedGB: 1, oomKills: 0, cpuThrottleRatio: 0, restarts: 0 };

describe("rightSize", () => {
  it("여유가 큰 standard-1 은 basic 으로 하향 권고(절감액 양수)", () => {
    const r = rightSize(healthy, "standard-1", opts);
    expect(r.action).toBe("downsize");
    expect(r.target).toBe("basic");
    expect(r.deltaMicroPerMonth).toBe(usd("22.00"));
  });
  it("성능 보호: OOM 이 있으면 절대 하향하지 않고 상향", () => {
    const r = rightSize({ ...healthy, oomKills: 1, memP99MiB: 900 }, "basic", opts);
    expect(r.action).toBe("upsize");
    expect(["standard-1", "standard-2", "standard-3"]).toContain(r.target);
  });
  it("스로틀링·재시작·표본 부족·쿨다운이면 하향 보류", () => {
    expect(rightSize({ ...healthy, restarts: 1 }, "standard-1", opts).action).toBe("keep");
    expect(rightSize({ ...healthy, samples: 10 }, "standard-1", opts).action).toBe("keep");
    expect(rightSize({ ...healthy }, "standard-1", { ...opts, daysSinceLastChange: 2 }).action).toBe("keep");
    expect(rightSize({ ...healthy, cpuThrottleRatio: 0.2 }, "basic", opts).action).toBe("upsize");
  });
  it("하향 결과는 헤드룸(메모리 +25%, CPU +30%, 디스크 +30%)을 항상 만족", () => {
    for (const mem of [100, 400, 900, 1800]) for (const cpu of [0.01, 0.1, 0.4]) {
      const r = rightSize({ ...healthy, memP99MiB: mem, cpuP95Vcpu: cpu }, "standard-3", opts);
      if (r.action === "downsize") {
        const spec = { lite: [256, 1 / 16], basic: [1024, 1 / 4], "standard-1": [4096, 1 / 2], "standard-2": [6144, 1], "standard-3": [8192, 2] }[r.target as string]!;
        expect(spec[0]!).toBeGreaterThanOrEqual(mem * 1.25);
        expect(spec[1]!).toBeGreaterThanOrEqual(cpu * 1.3);
      }
    }
  });
  it("디스크 부족은 메모리가 여유로워도 하향 금지", () => {
    expect(rightSize({ ...healthy, diskUsedGB: 3.9 }, "standard-1", opts).target).not.toBe("lite");
    expect(rightSize({ ...healthy, diskUsedGB: 7 }, "standard-1", opts).action).not.toBe("downsize");
  });
  it("허용 상위 타입이 없으면 upsize_blocked(운영자 확인)", () => {
    const r = rightSize({ ...healthy, oomKills: 3, memP99MiB: 8000 }, "standard-3", { ...opts, allowedTypes: ["standard-3"] });
    expect(r.action).toBe("upsize_blocked");
  });
});

describe("tuneSleepAfter", () => {
  const gaps = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  const p = { warmCostPerSecMicro: 20, coldStartPenaltyMicro: 5_000, coldStartBudget: 0.1, stateful: false };
  it("상태 저장 서비스는 항상 never(데이터 보호)", () => {
    expect(tuneSleepAfter(gaps(100, () => 3600), { ...p, stateful: true }).sleepAfterSec).toBe("never");
  });
  it("표본 부족 시 보수적 기본값", () => {
    expect(tuneSleepAfter([10, 20], p)).toMatchObject({ sleepAfterSec: 600 });
  });
  it("드문 긴 유휴가 많으면 절전, 콜드 스타트 비율은 예산 이하", () => {
    const g = gaps(100, (i) => (i % 10 === 0 ? 20_000 : 20)); // 90% 짧음, 10% 매우 김
    const r = tuneSleepAfter(g, p);
    expect(r.sleepAfterSec).not.toBe("never");
    expect(r.coldStartFraction).toBeLessThanOrEqual(0.1);
  });
  it("콜드 스타트 예산을 만족할 수 없으면 상시 가동(성능 우선)", () => {
    const g = gaps(100, (i) => (i % 2 === 0 ? 20_000 : 20)); // 50% 가 긴 유휴 → 예산 10% 초과
    const r = tuneSleepAfter(g, { ...p, coldStartBudget: 0.05, coldStartPenaltyMicro: 1_000_000_000 });
    expect(r.sleepAfterSec === "never" || (r.sleepAfterSec as number) >= 7200).toBe(true);
    expect(r.coldStartFraction).toBeLessThanOrEqual(0.05);
  });
  it("항상 예산 준수(무작위 분포 속성 검사)", () => {
    let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let k = 0; k < 50; k++) {
      const g = gaps(200, () => Math.floor(rnd() ** 3 * 10_000));
      const r = tuneSleepAfter(g, { ...p, coldStartBudget: 0.02 });
      expect(r.coldStartFraction).toBeLessThanOrEqual(0.02);
    }
  });
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 17);
const rf = (o: Partial<ResourceFacts>): ResourceFacts => ({ type: "container", id: "r", subscriptionStatus: "active", requests30d: 100, createdAtMs: NOW - 90 * DAY, lastRequestAtMs: NOW - DAY, ...o });

describe("detectWaste", () => {
  it("사용 중인 유료 자원은 건드리지 않음", () => expect(detectWaste([rf({})], NOW)).toEqual([]));
  it("취소 후 유예 중이면 중지만(데이터 보존), 유예 경과 시 삭제 '검토'만 요청(자동 삭제 없음)", () => {
    expect(detectWaste([rf({ subscriptionStatus: "canceled", canceledAtMs: NOW - 5 * DAY })], NOW)[0]).toMatchObject({ kind: "orphan_suspend", action: "suspend_keep_data" });
    const f = detectWaste([rf({ subscriptionStatus: "canceled", canceledAtMs: NOW - 40 * DAY })], NOW)[0]!;
    expect(f).toMatchObject({ kind: "orphan_delete_review", action: "request_two_step_deletion" });
  });
  it("분쟁·미납 중(suspended/past_due) 자원은 어떤 정리도 하지 않음", () => {
    expect(detectWaste([rf({ subscriptionStatus: "suspended" }), rf({ subscriptionStatus: "past_due", id: "x" })], NOW)).toEqual([]);
  });
  it("장기 무요청 상시 가동 컨테이너만 절전 권고, 상태 저장 DB 는 제외", () => {
    const idle = rf({ sleepPolicy: "never", requests30d: 0, lastRequestAtMs: NOW - 30 * DAY });
    expect(detectWaste([idle], NOW)[0]).toMatchObject({ kind: "idle_always_on" });
    expect(detectWaste([{ ...idle, stateful: true }], NOW)).toEqual([]);
  });
  it("사용 이력 없는 빈 버킷은 고객 알림만", () => {
    const f = detectWaste([rf({ type: "bucket", requests30d: 0, storedBytes: 0, createdAtMs: NOW - 60 * DAY, lastRequestAtMs: undefined })], NOW);
    expect(f[0]).toMatchObject({ kind: "never_used", action: "notify_customer" });
  });
});

describe("planBackupPrune", () => {
  const b = (id: string, kind: any, ageDays: number, verified = true) => ({ id, kind, createdAtMs: NOW - ageDays * DAY, verified, sizeBytes: 1000 });
  it("보존 기간 내 + 복구 체인 앵커 이후는 유지, 그 이전만 정리", () => {
    const bs = [b("f0", "full", 20), b("f1", "full", 9), b("i1", "incremental", 8), b("f2", "full", 2), b("l1", "binlog", 1), b("old-i", "incremental", 15)];
    const r = planBackupPrune(bs, NOW, 7);
    expect(r.prune.sort()).toEqual(["f0", "old-i"]); // 앵커 f1(9일, ≤cutoff 중 최신) 이후 모두 유지
    expect(r.keep).toEqual(expect.arrayContaining(["f1", "i1", "f2", "l1"]));
  });
  it("앵커가 없으면 아무것도 지우지 않음", () => {
    const r = planBackupPrune([b("f2", "full", 2), b("l1", "binlog", 1)], NOW, 7);
    expect(r.prune).toEqual([]);
  });
  it("검증된 전체 백업이 0개가 되는 삭제는 불가(최신 검증 full 항상 유지)", () => {
    const r = planBackupPrune([b("f1", "full", 30), b("x", "incremental", 29)], NOW, 7);
    expect(r.keep).toContain("f1");
  });
  it("미검증 full 은 앵커가 될 수 없음, 법적 보존이면 전부 유지", () => {
    const r = planBackupPrune([b("fu", "full", 30, false), b("f1", "full", 20), b("old", "incremental", 25)], NOW, 7);
    expect(r.prune.sort()).toEqual(["fu", "old"]); // 미검증 full(fu)은 앵커가 아니므로 정리 대상
    expect(r.keep).toContain("f1");
    expect(planBackupPrune([b("a", "full", 100)], NOW, 7, true).prune).toEqual([]);
  });
});

describe("choosePlacement / budgetState", () => {
  const c = (id: string, o = {}) => ({ id, healthy: true, supportsType: true, freeMemMiB: 4096, freeVcpu: 2, cpuLoad: 0.3, queueDepth: 0, errorRate: 0, restarts7d: 0, estCostPerHourMicro: 100, latencyMs: 20, ...o });
  it("비정상·과부하·용량 부족 후보는 제외, 없으면 null", () => {
    expect(choosePlacement([c("a", { healthy: false }), c("b", { cpuLoad: 0.95 }), c("c", { freeMemMiB: 10 })], { memMiB: 1024, vcpu: 0.25 })).toBeNull();
  });
  it("부하·장애 이력이 낮은 후보를 선택, 결과는 결정적", () => {
    const best = choosePlacement([c("busy", { cpuLoad: 0.8, queueDepth: 80 }), c("flaky", { errorRate: 0.1, restarts7d: 5 }), c("good")], { memMiB: 1024, vcpu: 0.25 })!;
    expect(best.id).toBe("good");
    expect(choosePlacement([c("x"), c("y")], { memMiB: 1, vcpu: 0.1 })!.id).toBe("x"); // 동점은 ID 순
  });
  it("지출 상한: 80% 경고, 100% 차단, 예상 초과도 경고", () => {
    expect(budgetState(usd("100"), usd("10"), 0.5)).toBe("ok");
    expect(budgetState(usd("100"), usd("45"), 0.5)).toBe("warn"); // 월말 예상 $90 ≥ 80%
    expect(budgetState(usd("100"), usd("85"), 0.9)).toBe("warn");
    expect(budgetState(usd("100"), usd("100"), 0.9)).toBe("block");
  });
});
