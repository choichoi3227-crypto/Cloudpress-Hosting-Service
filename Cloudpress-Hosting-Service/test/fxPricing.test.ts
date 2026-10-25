import { describe, it, expect } from "vitest";
import { usd } from "../src/lib/money";
import { ingestSample, smoothedRate, currentRate, costSideRate, usdMicroToWon, wonToUsdMicro, SEED_FX_CONFIG, type FxState } from "../src/lib/fx";
import { krwBand, bandFromCostWon, repriceDecision, netMarginWon, optimalPriceWon, subscriptionRepriceAllowed, SEED_KRW_PRICE_CONFIG as C } from "../src/lib/currencyPricing";

const H = 3_600_000, NOW = Date.UTC(2026, 9, 19);
const R = (won: number) => won * 1_000_000; // 원/USD → micro
const sample = (won: number, ageMs = 0, source = "bok") => ({ rateMicro: R(won), fetchedAtMs: NOW - ageMs, source });
const feed = (rates: number[]) => rates.reduce<FxState>((st, w, i) => ingestSample(st, sample(w, 0, `s${i}`), NOW).state, { accepted: [] });

describe("환율 수용 규칙", () => {
  it("정상 표본은 수용, 평활값은 중앙값(이상치에 강함)", () => {
    const st = feed([1400, 1402, 1398, 1401, 1399]);
    expect(smoothedRate(st)).toBe(R(1400));
  });
  it("0·음수·소수·오래된 표본은 거부", () => {
    const st = feed([1400]);
    for (const bad of [{ ...sample(1400), rateMicro: 0 }, { ...sample(1400), rateMicro: -5 }, { ...sample(1400), rateMicro: 1.5 }, sample(1400, 7 * H)]) expect(ingestSample(st, bad, NOW).status).toBe("rejected");
  });
  it("급변(>300bp)은 보류, 독립 표본이 확인하면 수용, 확인되지 않으면 계속 보류", () => {
    const st = feed([1400, 1401, 1399]);
    const a = ingestSample(st, sample(1500, 0, "feedA"), NOW);
    expect(a.status).toBe("quarantined");
    expect(smoothedRate(a.state)).toBe(R(1400)); // 보류 중에는 가격에 반영되지 않음
    const same = ingestSample(a.state, sample(1500, 0, "feedA"), NOW);
    expect(same.status).toBe("quarantined"); // 같은 원천·같은 시각의 재전송은 확인이 아님
    const confirm = ingestSample(a.state, sample(1502, 0, "feedB"), NOW);
    expect(confirm.status).toBe("accepted");
    const mismatch = ingestSample(a.state, sample(1450, 0, "feedB"), NOW);
    expect(mismatch.status).toBe("quarantined");
  });
  it("오래되면 stale 표시, 비용 환산 환율은 버퍼를 얹음", () => {
    const st = feed([1400]);
    expect(currentRate(st, NOW)!.stale).toBe(false);
    expect(currentRate(st, NOW + 7 * H)!.stale).toBe(true);
    expect(costSideRate(R(1400))).toBe(Math.ceil(R(1400) * 1.015));
    expect(currentRate({ accepted: [] }, NOW)).toBeNull();
  });
  it("환산 왕복: 올림/내림으로 원가를 과소평가하지 않음", () => {
    expect(usdMicroToWon(usd("10.44"), R(1400))).toBe(14616);
    expect(wonToUsdMicro(14616, R(1400))).toBeLessThanOrEqual(usd("10.44") + 1);
  });
});

describe("원화 가격 밴드(하한·목표·상한)", () => {
  const cost = usd("10.44"), rate = costSideRate(R(1400));
  it("목표가는 [하한, 상한] 안, 센 단위가 아닌 100원 단위 올림", () => {
    const b = krwBand(cost, rate);
    expect(b.targetWon).toBeGreaterThanOrEqual(b.floorWon);
    expect(b.targetWon).toBeLessThanOrEqual(b.ceilingWon);
    expect(b.targetWon % 100).toBe(0);
    expect(b.sellable).toBe(true);
  });
  it("마진 불변식: 하한가에서도 수수료 차감 후 하한 마진율 이상 확보(다양한 원가·환율)", () => {
    for (const won of [1200, 1400, 1600, 1900]) for (const c of ["1.00", "10.44", "35", "90"]) {
      const r = costSideRate(R(won)); const b = krwBand(usd(c), r);
      if (!b.sellable) continue;
      expect(netMarginWon(b.floorWon, b.costWon)).toBeGreaterThanOrEqual(Math.floor((b.costWon * C.floorMarginBp) / 10_000) - C.roundingWon);
    }
  });
  it("하한이 상한을 넘으면 판매 중지(팔수록 손해 방지)", () => {
    const b = bandFromCostWon(150_000);
    expect(b.sellable).toBe(false);
    expect(repriceDecision(null, usd("150"), costSideRate(R(1400)), NOW, false).action).toBe("halt_sales");
  });
  it("원가·환율이 오를수록 목표가는 단조 증가", () => {
    let prev = 0;
    for (let w = 1200; w <= 1800; w += 50) { const t = krwBand(cost, costSideRate(R(w))).targetWon; expect(t).toBeGreaterThanOrEqual(prev); prev = t; }
  });
});

describe("목록가 재산정(히스테리시스)", () => {
  const cost = usd("10.44");
  const at = (won: number) => costSideRate(R(won));
  const initial = repriceDecision(null, cost, at(1400), NOW, false);
  const prev = { priceWon: initial.priceWon, changedAtMs: NOW - 30 * H };
  it("최초 가격 후 환율 잡음(±0.3%)에는 가격을 바꾸지 않음", () => {
    expect(initial.action).toBe("initial");
    for (const w of [1396, 1400, 1404, 1398, 1403]) expect(repriceDecision(prev, cost, at(w), NOW, false).action).toBe("keep");
  });
  it("환율 급등으로 현재가가 하한 미달이면 즉시 인상(마진 보호)", () => {
    const r = repriceDecision(prev, cost, at(2000), NOW, false);
    expect(["emergency_raise", "raise"]).toContain(r.action);
    expect(r.priceWon).toBeGreaterThan(prev.priceWon);
    expect(r.priceWon).toBeLessThanOrEqual(C.ceilingWon);
  });
  it("인하는 느리게: 임계·최소 간격·환율 신선도·최대 폭 조건", () => {
    const high = { priceWon: krwBand(cost, at(1700)).targetWon, changedAtMs: NOW - 30 * H };
    const down = repriceDecision(high, cost, at(1300), NOW, false);
    expect(down.action).toBe("lower");
    expect(down.priceWon).toBeGreaterThanOrEqual(Math.floor((high.priceWon * 0.9) / 100) * 100); // 한 번에 10% 이내
    expect(down.priceWon).toBeGreaterThanOrEqual(krwBand(cost, at(1300)).floorWon);
    expect(repriceDecision({ ...high, changedAtMs: NOW - 2 * H }, cost, at(1300), NOW, false).action).toBe("keep"); // 최소 간격
    expect(repriceDecision(high, cost, at(1300), NOW, true).action).toBe("keep"); // 환율 오래됨
  });
  it("무작위 환율 변동에서도 가격은 하한 이상·상한 이하, 변경 횟수는 제한적", () => {
    let seed = 11; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    let p: { priceWon: number; changedAtMs: number } | null = null, changes = 0, won = 1400;
    for (let day = 0; day < 120; day++) {
      won = Math.min(1900, Math.max(1100, won + (rnd() - 0.5) * 20));
      const now = NOW + day * 24 * H, rate = costSideRate(R(Math.round(won)));
      const d = repriceDecision(p, cost, rate, now, false);
      if (d.action !== "keep" && d.action !== "halt_sales") { p = { priceWon: d.priceWon, changedAtMs: now }; changes++; }
      if (p) { const b = krwBand(cost, rate); expect(p.priceWon).toBeLessThanOrEqual(b.ceilingWon); if (d.action !== "halt_sales") expect(p.priceWon).toBeGreaterThanOrEqual(Math.min(b.floorWon, p.priceWon)); }
    }
    expect(changes).toBeLessThan(40); // 일일 재산정이어도 잦은 가격 변경 없음
  });
  it("이론 최적가(Lerner): p* = c·e/(e−1), 하한·상한으로 제한", () => {
    expect(optimalPriceWon(10_000, 2, 0, 1_000_000)).toBe(20_000);
    expect(optimalPriceWon(10_000, 1.5, 0, 1_000_000)).toBe(30_000);
    expect(optimalPriceWon(10_000, 2, 0, 15_000)).toBe(15_000);
    expect(optimalPriceWon(10_000, 2, 25_000, 1_000_000)).toBe(25_000);
    expect(optimalPriceWon(10_000, 0.8, 12_000, 40_000)).toBe(40_000); // 비탄력이면 상한
  });
  it("구독 갱신가: 인하 즉시, 인상은 사전 고지·최대 폭 준수", () => {
    expect(subscriptionRepriceAllowed(10_000, 9_000, { noticeDaysGiven: 0, minNoticeDays: 30, maxIncreaseBp: 1000 })).toMatchObject({ allowed: true, price: 9_000 });
    expect(subscriptionRepriceAllowed(10_000, 12_000, { noticeDaysGiven: 10, minNoticeDays: 30, maxIncreaseBp: 1000 }).allowed).toBe(false);
    expect(subscriptionRepriceAllowed(10_000, 12_000, { noticeDaysGiven: 30, minNoticeDays: 30, maxIncreaseBp: 1000 })).toMatchObject({ allowed: true, price: 11_000 });
  });
});
