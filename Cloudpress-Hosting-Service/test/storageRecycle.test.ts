import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { getProduct } from "../src/lib/catalog";
import { BYTES_PER_GB } from "../src/lib/storageOptimizer";
import { entitlementBytes, additionalLendable, neededBytes, matchLoans, applyProposals, planRecall, billableOverageBytes, writeAllowed, revenueImpactMicro, growthPerDay, DEFAULT_RECYCLE, type BucketLedger } from "../src/lib/storageRecycle";

const GB = BYTES_PER_GB, DAY = 86_400_000, NOW = Date.UTC(2026, 9, 18), CHUNK = DEFAULT_RECYCLE.chunkBytes;
const flat = (gb: number, days = 40) => Array.from({ length: days }, () => gb * GB);
const bucket = (id: string, o: Partial<BucketLedger> = {}): BucketLedger => ({ id, customerId: "c1", entitlementBytes: 10 * GB, dailyPeakBytes: flat(1), usedBytes: 1 * GB, lentBytes: 0, borrowedBytes: 0, createdAtMs: NOW - 60 * DAY, ...o });

describe("용량 약정", () => {
  it("Cloudage 기본 제공 10GB, WordPress Starter 5GB", () => {
    expect(entitlementBytes(getProduct("cloudage-bucket"))).toBe(10 * GB);
    expect(entitlementBytes(getProduct("wp-starter"))).toBe(5 * GB);
  });
});

describe("대여 가능량 계산(남는 용량의 50%)", () => {
  it("30일간 1GB 만 쓴 10GB 버킷: 유휴(10−1−1완충=8GB)의 50% = 4GB 를 청크 단위로 대여 가능", () => {
    const l = additionalLendable(bucket("a"), NOW);
    expect(l).toBe(Math.floor((0.5 * 8 * GB) / CHUNK) * CHUNK);
    expect(l).toBeLessThanOrEqual(0.5 * 8 * GB);
    expect(l % CHUNK).toBe(0);
  });
  it("이력 부족(30일 미만)·최근 회수 직후·차용 중이면 대여 불가", () => {
    expect(additionalLendable(bucket("a", { dailyPeakBytes: flat(1, 10) }), NOW)).toBe(0);
    expect(additionalLendable(bucket("a", { lastRecallAtMs: NOW - 2 * DAY }), NOW)).toBe(0);
    expect(additionalLendable(bucket("a", { borrowedBytes: CHUNK }), NOW)).toBe(0);
  });
  it("대여자의 최대 사용량 + 완충 + 유휴의 절반은 항상 남는다(약정 보호)", () => {
    for (const peakGb of [0.5, 2, 5, 8]) {
      const b = bucket("a", { dailyPeakBytes: flat(peakGb), usedBytes: peakGb * GB });
      const lend = additionalLendable(b, NOW);
      expect(b.entitlementBytes - lend).toBeGreaterThanOrEqual(peakGb * GB + 0.1 * b.entitlementBytes);
    }
  });
  it("성장 중인 버킷은 더 적게 빌려줌", () => {
    const growing = Array.from({ length: 40 }, (_, i) => (1 + i * 0.1) * GB);
    expect(growthPerDay(growing)).toBeGreaterThan(0);
    expect(additionalLendable(bucket("g", { dailyPeakBytes: growing, usedBytes: 4.9 * GB }), NOW)).toBeLessThan(additionalLendable(bucket("a"), NOW));
  });
  it("꽉 찬 버킷은 대여하지 않음", () => {
    expect(additionalLendable(bucket("f", { dailyPeakBytes: flat(9.5), usedBytes: 9.5 * GB }), NOW)).toBe(0);
  });
});

describe("매칭", () => {
  const lender = bucket("lender");
  const needy = bucket("needy", { entitlementBytes: 5 * GB, dailyPeakBytes: flat(4.8), usedBytes: 4.8 * GB });
  it("같은 고객의 남는 용량을 부족한 서비스에 이동(청크 단위)", () => {
    const props = matchLoans([lender, needy], NOW);
    expect(props.length).toBe(1);
    expect(props[0]).toMatchObject({ lenderId: "lender", borrowerId: "needy" });
    expect(props[0]!.bytes % CHUNK).toBe(0);
    expect(props[0]!.bytes).toBeGreaterThan(0);
  });
  it("기본 범위(customer)에서는 다른 고객 간 대여 금지, platform 범위에서만 허용", () => {
    const other = { ...needy, customerId: "c2" };
    expect(matchLoans([lender, other], NOW)).toEqual([]);
    expect(matchLoans([lender, other], NOW, { ...DEFAULT_RECYCLE, scope: "platform" }).length).toBe(1);
  });
  it("대여자는 차용자를 겸하지 않으며, 합계가 보존됨", () => {
    const b2 = bucket("l2");
    const props = matchLoans([lender, b2, needy], NOW);
    const after = applyProposals([lender, b2, needy], props);
    expect(after.reduce((a, b) => a + b.lentBytes, 0)).toBe(after.reduce((a, b) => a + b.borrowedBytes, 0));
    expect(after.filter((b) => b.lentBytes > 0 && b.borrowedBytes > 0)).toEqual([]);
  });
  it("부족하지 않은 버킷은 빌리지 않음", () => {
    expect(neededBytes(bucket("x"))).toBe(0);
    expect(matchLoans([lender, bucket("y")], NOW)).toEqual([]);
  });
});

describe("회수·과금·쓰기 제어", () => {
  it("대여자 사용량이 늘면 최근 대여부터 필요한 만큼만 회수", () => {
    const b = bucket("a", { lentBytes: 6 * GB, usedBytes: 3.6 * GB });
    const r = planRecall(b, [{ id: "old", bytes: 3 * GB, createdAtMs: 1 }, { id: "new", bytes: 3 * GB, createdAtMs: 2 }]);
    expect(r.recall).toEqual(["new"]);
    expect(planRecall(bucket("a", { lentBytes: 2 * GB, usedBytes: 1 * GB }), [{ id: "x", bytes: 2 * GB, createdAtMs: 1 }]).recall).toEqual([]);
  });
  it("대여자는 대여 때문에 초과 과금되지 않음, 차용자는 차용분만큼 초과 과금 감소", () => {
    expect(billableOverageBytes({ usedBytes: 9 * GB, entitlementBytes: 10 * GB, borrowedBytes: 0 })).toBe(0);
    expect(billableOverageBytes({ usedBytes: 12 * GB, entitlementBytes: 10 * GB, borrowedBytes: 0 })).toBe(2 * GB);
    expect(billableOverageBytes({ usedBytes: 12 * GB, entitlementBytes: 10 * GB, borrowedBytes: 1.5 * GB })).toBe(0.5 * GB);
  });
  it("쓰기 허용: 약정+차용+허용한 유료 초과분 한도까지", () => {
    const b = { usedBytes: 10 * GB, entitlementBytes: 10 * GB, borrowedBytes: 1 * GB };
    expect(writeAllowed(b, 1 * GB, 0)).toBe(true);
    expect(writeAllowed(b, 1.1 * GB, 0)).toBe(false);
    expect(writeAllowed(b, 1.1 * GB, 1 * GB)).toBe(true);
  });
  it("platform 범위 대여의 매출 감소분 계산", () => {
    expect(revenueImpactMicro(2 * GB, 3 * GB, usd("0.79"))).toBe(usd("1.58"));
    expect(revenueImpactMicro(2 * GB, 0, usd("0.79"))).toBe(0);
  });
});

describe("시뮬레이션: 60일간 무작위 사용량에서도 불변식 유지", () => {
  it("합계 보존·약정 보호·청크 단위·순환 없음", () => {
    let seed = 42; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    let bs: BucketLedger[] = Array.from({ length: 12 }, (_, i) => bucket(`b${i}`, { customerId: `c${i % 3}`, dailyPeakBytes: [], usedBytes: 0 }));
    let everLent = 0, everRecalled = 0;
    for (let day = 0; day < 60; day++) {
      const now = NOW + day * DAY;
      bs = bs.map((b) => {
        const target = (i: number) => (i % 4 === 0 ? 9.5 : 1.5) * GB * (0.6 + 0.4 * rnd());
        const used = Math.min(b.entitlementBytes + b.borrowedBytes, target(Number(b.id.slice(1))));
        return { ...b, usedBytes: used, dailyPeakBytes: [...b.dailyPeakBytes, used].slice(-60) };
      });
      // 회수 먼저
      bs = bs.map((b) => { if (b.lentBytes === 0) return b; const r = planRecall(b, [{ id: "x", bytes: b.lentBytes, createdAtMs: 0 }]); if (r.recall.length) everRecalled++; return r.recall.length ? { ...b, lentBytes: 0, lastRecallAtMs: now } : b; });
      const lentTotal = bs.reduce((a, b) => a + b.lentBytes, 0);
      // 대여자 회수로 풀린 만큼 차용자에서도 차감(요약: 전체 차용 재계산)
      if (lentTotal === 0) bs = bs.map((b) => ({ ...b, borrowedBytes: 0 }));
      const props = matchLoans(bs, now);
      everLent += props.length;
      bs = applyProposals(bs, props);
      expect(bs.reduce((a, b) => a + b.lentBytes, 0)).toBe(bs.reduce((a, b) => a + b.borrowedBytes, 0));
      for (const b of bs) {
        expect(b.lentBytes % CHUNK).toBe(0);
        expect(b.lentBytes === 0 || b.borrowedBytes === 0).toBe(true);
        expect(b.lentBytes).toBeLessThanOrEqual(0.5 * b.entitlementBytes);
        if (b.lentBytes > 0) expect(b.entitlementBytes - b.lentBytes).toBeGreaterThanOrEqual(Math.max(...b.dailyPeakBytes.slice(-30)) * 1.0);
      }
    }
    expect(everLent).toBeGreaterThan(0); // 시뮬레이션이 실제로 대여를 발생시켰음을 확인
    console.info(`시뮬레이션: 대여 ${everLent}건, 회수 ${everRecalled}건`);
  });
});
