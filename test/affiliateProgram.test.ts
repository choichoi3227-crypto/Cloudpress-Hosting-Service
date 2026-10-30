import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { MockPayPal } from "../src/lib/paypal.client";
import { handlePayPalWebhook } from "../src/lib/webhooks";
import { applyAffiliate, setAffiliateStatus, bindReferral, accrueCommission, settleAffiliates, approvePayout, markPayoutPaid, releasePayout, clearReferralFlag, saveAffiliatePolicy, loadAffiliatePolicy, affiliateSummary, normalizeEmailForCompare, generateCode, adminAffiliateOverview } from "../src/lib/affiliateProgram";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1, 12); // 2026-08-01
const VALID = { authAlgo: "a", certUrl: "https://api.paypal.com/c", transmissionId: "t", transmissionSig: MockPayPal.VALID_SIG, transmissionTime: "x" };
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];
const one = (raw: any, sql: string) => raw.prepare(sql).get() as any;
let n = 0;
const hook = (db: any, type: string, resource: any, now: number) => handlePayPalWebhook(db, new MockPayPal(), JSON.stringify({ id: `WH-af${++n}`, event_type: type, resource }), VALID, "W", now);

async function world() {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('admin','admin@x.co','h'),('aff','boss@aff.co','h'),('c1','cust1@x.co','h'),('c2','cust2@x.co','h')");
  raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('p1','ccs','CCS')");
  raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr1','p1',1,100000000)"); // $100
  const a = await applyAffiliate(db, "aff", "pay@aff.co", T0);
  await setAffiliateStatus(db, "admin", a.id, "approved", T0);
  return { db, raw, aff: a };
}
/** 고객이 추천 가입 후 구독 결제(웹훅 경유 = 실제 경로). */
async function customerPays(w: any, uid: string, subId: string, ppSub: string, saleId: string, at: number, total = "100.00", ref = w.aff.code) {
  if (ref) await bindReferral(w.db, { id: uid, email: `${uid}@x.co` }, ref, at);
  if (!one(w.raw, `select 1 x from subscriptions where id='${subId}'`)) w.raw.exec(`INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,status,paypal_subscription_id) VALUES('${subId}','${uid}','p1','pr1','incomplete','${ppSub}')`);
  return hook(w.db, "PAYMENT.SALE.COMPLETED", { id: saleId, state: "completed", billing_agreement_id: ppSub, amount: { total, currency: "USD" } }, at);
}

describe("제휴 가입·추천 연결", () => {
  it("신청→승인 전에는 링크 없음, 승인 후 링크 발급, 중복 신청은 같은 코드", async () => {
    const { db } = makeDb();
    const u = makeDb(); // dummy
    const w = await world();
    const sum = await affiliateSummary(w.db, "aff", "https://app.test");
    expect(sum).toMatchObject({ applied: true, status: "approved", code: w.aff.code, link: `https://app.test/register?ref=${w.aff.code}` });
    expect(await applyAffiliate(w.db, "aff", "other@x.co", T0)).toMatchObject({ code: w.aff.code });
    await expect(applyAffiliate(w.db, "c1", "not-an-email", T0)).rejects.toMatchObject({ code: "bad_email" });
    w.raw.exec("UPDATE affiliate_users SET status='pending'");
    expect((await affiliateSummary(w.db, "aff", "https://app.test") as any).link).toBeNull();
    expect(db).toBeTruthy(); expect(u).toBeTruthy();
  });
  it("추천 연결: 정상/잘못된 코드/미승인 제휴자/중복 연결, 코드 형식·이메일 정규화", async () => {
    const w = await world();
    expect(await bindReferral(w.db, { id: "c1", email: "cust1@x.co" }, w.aff.code.toLowerCase(), T0)).toEqual({ bound: true, flagged: false, reason: undefined });
    expect(await bindReferral(w.db, { id: "c1", email: "cust1@x.co" }, w.aff.code, T0)).toMatchObject({ bound: false, reason: "already_referred" });
    expect(await bindReferral(w.db, { id: "c2", email: "cust2@x.co" }, "ZZZZZZZZ", T0)).toMatchObject({ bound: false });
    expect(await bindReferral(w.db, { id: "c2", email: "cust2@x.co" }, "<script>", T0)).toMatchObject({ bound: false, reason: "invalid_code" });
    w.raw.exec("UPDATE affiliate_users SET status='suspended'");
    expect(await bindReferral(w.db, { id: "c2", email: "cust2@x.co" }, w.aff.code, T0)).toMatchObject({ bound: false, reason: "affiliate_unavailable" });
    expect(normalizeEmailForCompare("Boss+x@Gmail.com")).toBe("boss@gmail.com");
    expect(normalizeEmailForCompare("b.o.s.s@googlemail.com")).toBe("boss@gmail.com");
    expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
  it("자기추천(같은 사람의 다른 계정)·단시간 대량 가입은 flagged 로 기록되고 수수료가 없다", async () => {
    const w = await world();
    w.raw.exec("INSERT INTO users(id,email,password_hash) VALUES('me2','b.oss+2@aff.co','h')");
    expect(await bindReferral(w.db, { id: "me2", email: "boss+2@aff.co" }, w.aff.code, T0)).toMatchObject({ bound: true, flagged: true, reason: "self_referral" });
    await saveAffiliatePolicy(w.db, "admin", { velocityLimitPerHour: 2 }, T0);
    w.raw.exec("INSERT INTO users(id,email,password_hash) VALUES('v1','v1@x.co','h'),('v2','v2@x.co','h'),('v3','v3@x.co','h')");
    await bindReferral(w.db, { id: "v1", email: "v1@x.co" }, w.aff.code, T0 + 1000);
    expect((await bindReferral(w.db, { id: "v2", email: "v2@x.co" }, w.aff.code, T0 + 2000)).flagged).toBe(true);
    expect((await bindReferral(w.db, { id: "v3", email: "v3@x.co" }, w.aff.code, T0 + 3000)).flagged).toBe(true);
    const r = await customerPays(w, "me2", "s_me", "I-me", "S-me", T0 + 5000, "100.00", ""); expect(r.status).toBe(200);
    expect(await accrueCommission(w.db, "pay_S-me", T0)).toBe("skipped");
    expect(q(w.raw, "select * from affiliate_commissions")).toHaveLength(0);
    const f = q(w.raw, "select id from affiliate_referrals where flagged_fraud=1");
    expect(f).toHaveLength(3);
    await clearReferralFlag(w.db, "admin", f[0].id, T0);
    await expect(clearReferralFlag(w.db, "admin", f[0].id, T0)).rejects.toMatchObject({ code: "not_found" });
    expect((await adminAffiliateOverview(w.db)).flagged).toHaveLength(2);
  });
});

describe("수수료 적립(실제 결제 기준)", () => {
  it("결제 웹훅 → 15% 적립(pending), 재전송·중복 호출은 1건, 비추천 고객은 없음", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0 + DAY);
    expect(q(w.raw, "select amount_micro a, status s from affiliate_commissions")).toEqual([{ a: 15_000_000, s: "pending" }]);
    await customerPays(w, "c1", "s1", "I-1", "S1", T0 + DAY); // 같은 sale 재전송
    expect(await accrueCommission(w.db, "pay_S1", T0)).toBe("skipped");
    expect(q(w.raw, "select * from affiliate_commissions")).toHaveLength(1);
    await customerPays(w, "c2", "s2", "I-2", "S2", T0 + DAY, "100.00", "");
    expect(q(w.raw, "select * from affiliate_commissions")).toHaveLength(1);
    expect(one(w.raw, "select first_qualifying_payment_at f from affiliate_referrals").f).not.toBeNull();
  });
  it("서비스별로 따로 계산(같은 고객의 두 구독 = 수수료 2건), 정책 변경은 이후 결제에만 적용", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0);
    await saveAffiliatePolicy(w.db, "admin", { rateBp: 1000 }, T0);
    await customerPays(w, "c1", "s1b", "I-1b", "S1b", T0 + DAY, "50.00");
    expect(q(w.raw, "select amount_micro a, subscription_id s from affiliate_commissions order by created_at, rowid")).toEqual([{ a: 15_000_000, s: "s1" }, { a: 5_000_000, s: "s1b" }]);
  });
  it("첫 적격 결제로부터 12개월이 지난 결제는 수수료 없음", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0);
    await customerPays(w, "c1", "s1", "I-1", "S-late", T0 + 400 * DAY);
    expect(q(w.raw, "select * from affiliate_commissions")).toHaveLength(1);
  });
  it("USD 이외·미완료 결제는 수수료 대상이 아님(웹훅이 결제로 인정하지 않음)", async () => {
    const w = await world();
    await bindReferral(w.db, { id: "c1", email: "cust1@x.co" }, w.aff.code, T0);
    w.raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,status,paypal_subscription_id) VALUES('s1','c1','p1','pr1','incomplete','I-1')");
    await hook(w.db, "PAYMENT.SALE.COMPLETED", { id: "S1", state: "pending", billing_agreement_id: "I-1", amount: { total: "100.00", currency: "USD" } }, T0);
    expect(q(w.raw, "select * from affiliate_commissions")).toHaveLength(0);
  });
});

describe("정산(유지 조건·환불 회수·월 10일 지급)", () => {
  it("2개월 유지 전에는 pending, 유지 후 eligible, 2개월 전 해지·환불은 void", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0);
    await customerPays(w, "c2", "s2", "I-2", "S2", T0);
    w.raw.exec("UPDATE subscriptions SET status='active'");
    expect((await settleAffiliates(w.db, T0 + 30 * DAY)).promoted).toBe(0);
    w.raw.exec("UPDATE subscriptions SET status='canceled' WHERE id='s2'"); // 유지 전(10일차) 해지 → 5분 주기 정산이 즉시 무효 처리
    expect((await settleAffiliates(w.db, T0 + 10 * DAY)).voided).toBe(1);
    const r = await settleAffiliates(w.db, T0 + 63 * DAY);
    expect(r).toMatchObject({ promoted: 1, voided: 0 });
    expect(q(w.raw, "select status from affiliate_commissions order by rowid").map((x: any) => x.status)).toEqual(["eligible", "void"]);
  });
  it("환불·분쟁: 적격 전은 무효/비례 감액, 지급 예정·지급 후는 다음 정산에서 차감(회수)", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0);
    await customerPays(w, "c2", "s2", "I-2", "S2", T0);
    w.raw.exec("UPDATE subscriptions SET status='active'");
    await hook(w.db, "PAYMENT.SALE.REFUNDED", { id: "R1", sale_id: "S1", amount: { total: "40.00", currency: "USD" } }, T0 + DAY); // 부분 환불 40%
    await hook(w.db, "CUSTOMER.DISPUTE.CREATED", { dispute_id: "D1", disputed_transactions: [{ seller_transaction_id: "S2" }] }, T0 + DAY);
    await settleAffiliates(w.db, T0 + 63 * DAY);
    expect(q(w.raw, "select id, amount_micro a, status s, payment_id p from affiliate_commissions order by rowid").map((x: any) => [x.p, x.a, x.s])).toEqual([["pay_S1", 9_000_000, "eligible"], ["pay_S2", 15_000_000, "void"]]);
  });
  it("월 정산: 지급일(10일)·최소 $25·이월·멱등, 승인→송금 기록→paid, 반려/실패는 되돌려 다음 정산에 포함", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) { w.raw.exec(`INSERT OR IGNORE INTO users(id,email,password_hash) VALUES('k${i}','k${i}@x.co','h')`); await customerPays(w, `k${i}`, `sk${i}`, `Ik${i}`, `Sk${i}`, T0 + i * 1000); }
    w.raw.exec("UPDATE subscriptions SET status='active'");
    const tenth = Date.UTC(2026, 9, 10, 1);
    expect((await settleAffiliates(w.db, tenth - 2 * DAY)).payoutsCreated).toBe(0); // 지급일 아님(10일 아님)
    const r = await settleAffiliates(w.db, tenth);
    expect(r).toMatchObject({ payoutsCreated: 1 });
    const p = one(w.raw, "select * from affiliate_payouts");
    expect(p).toMatchObject({ amount_micro: 45_000_000, status: "pending", period: "2026-10" });
    expect((await settleAffiliates(w.db, tenth + 3600_000)).payoutsCreated).toBe(0); // 같은 달 중복 없음
    expect(q(w.raw, "select status from affiliate_commissions").every((c: any) => c.status === "payable")).toBe(true);
    await expect(markPayoutPaid(w.db, "admin", p.id, "TX1", tenth)).rejects.toMatchObject({ code: "bad_state" }); // 승인 전 완료 불가
    await releasePayout(w.db, "admin", p.id, "failed", "PayPal 계정 오류", tenth);
    expect(q(w.raw, "select status from affiliate_commissions").every((c: any) => c.status === "eligible")).toBe(true);
    const nov = Date.UTC(2026, 10, 10, 1);
    expect((await settleAffiliates(w.db, nov)).payoutsCreated).toBe(1); // 실패분이 다음 달에 포함
    const p2 = one(w.raw, "select * from affiliate_payouts where period='2026-11'");
    expect(p2.amount_micro).toBe(45_000_000);
    await approvePayout(w.db, "admin", p2.id, nov);
    await expect(approvePayout(w.db, "admin", p2.id, nov)).rejects.toMatchObject({ code: "bad_state" });
    await expect(markPayoutPaid(w.db, "admin", p2.id, "  ", nov)).rejects.toMatchObject({ code: "bad_reference" });
    await markPayoutPaid(w.db, "admin", p2.id, "PAYPAL-TX-123", nov);
    expect(one(w.raw, "select status, external_ref r from affiliate_payouts where id='" + p2.id + "'")).toEqual({ status: "paid", r: "PAYPAL-TX-123" });
    expect(q(w.raw, "select status from affiliate_commissions").every((c: any) => c.status === "paid")).toBe(true);
    const sum: any = await affiliateSummary(w.db, "aff", "https://app.test");
    expect(sum.amounts.paid).toBe(45_000_000);
  });
  it("최소 지급액 미달은 지급 예정을 만들지 않고 적격 수수료가 이월된다. 지급 후 환불은 다음 정산에서 차감", async () => {
    const w = await world();
    await customerPays(w, "c1", "s1", "I-1", "S1", T0); // $15 < $25
    w.raw.exec("UPDATE subscriptions SET status='active'");
    const tenth = Date.UTC(2026, 9, 10, 1);
    expect((await settleAffiliates(w.db, tenth)).payoutsCreated).toBe(0);
    expect(q(w.raw, "select status from affiliate_commissions")).toEqual([{ status: "eligible" }]); // 이월
    await customerPays(w, "c2", "s2", "I-2", "S2", T0 + 3 * DAY, "100.00");
    w.raw.exec("UPDATE subscriptions SET status='active'");
    await settleAffiliates(w.db, tenth);
    const p = one(w.raw, "select * from affiliate_payouts"); expect(p.amount_micro).toBe(30_000_000);
    await approvePayout(w.db, "admin", p.id, tenth); await markPayoutPaid(w.db, "admin", p.id, "TX", tenth);
    await hook(w.db, "PAYMENT.SALE.REFUNDED", { id: "RR", sale_id: "S1", amount: { total: "100.00", currency: "USD" } }, tenth + DAY);
    const rr = await settleAffiliates(w.db, tenth + 2 * DAY);
    expect(rr.adjusted).toBe(1);
    expect(one(w.raw, "select amount_micro a from affiliate_adjustments").a).toBe(-15_000_000);
    expect(((await affiliateSummary(w.db, "aff", "https://app.test")) as any).pendingAdjustmentMicro).toBe(-15_000_000);
    expect((await settleAffiliates(w.db, tenth + 3 * DAY)).adjusted).toBe(0); // 회수는 한 번만
  });
  it("정책 검증·변경", async () => {
    const w = await world();
    await expect(saveAffiliatePolicy(w.db, "a", { rateBp: 9000 }, T0)).rejects.toMatchObject({ code: "bad_policy" });
    await expect(saveAffiliatePolicy(w.db, "a", { payoutDayOfMonth: 31 }, T0)).rejects.toMatchObject({ code: "bad_policy" });
    await expect(saveAffiliatePolicy(w.db, "a", { minPayoutMicro: 25_000_001 }, T0)).rejects.toMatchObject({ code: "bad_policy" });
    expect((await saveAffiliatePolicy(w.db, "a", { rateBp: 2000, minPayoutMicro: 10_000_000 }, T0)).rateBp).toBe(2000);
    expect((await loadAffiliatePolicy(w.db)).payoutDayOfMonth).toBe(10);
  });
});
