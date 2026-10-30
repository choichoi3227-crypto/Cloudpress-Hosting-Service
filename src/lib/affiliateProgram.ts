import { type D1Like, newId, nowIso } from "./db";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";
import { commissionFor, planPayout, isPayoutDay, type AffiliatePolicy } from "./affiliate";

export interface ProgramPolicy extends AffiliatePolicy { velocityLimitPerHour: number }
/** 초기 정책(관리자가 admin_settings.affiliate_policy 로 변경). */
export const SEED_AFFILIATE_POLICY: ProgramPolicy = { rateBp: 1500, minMaintainedMonths: 2, minPayoutMicro: 25_000_000, maxCommissionMonths: 12, payoutDayOfMonth: 10, velocityLimitPerHour: 10 };
const MONTH_MS = 30.4375 * 24 * 3600 * 1000;

export async function loadAffiliatePolicy(db: D1Like): Promise<ProgramPolicy> {
  const r = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'affiliate_policy'").first<{ value_json: string }>();
  if (!r) return SEED_AFFILIATE_POLICY;
  try { return { ...SEED_AFFILIATE_POLICY, ...(JSON.parse(r.value_json) as Partial<ProgramPolicy>) }; } catch { return SEED_AFFILIATE_POLICY; }
}
export async function saveAffiliatePolicy(db: D1Like, actor: string, input: Partial<ProgramPolicy>, nowMs: number): Promise<ProgramPolicy> {
  const n = { ...(await loadAffiliatePolicy(db)), ...input };
  const int = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(n.rateBp, 0, 5000)) throw new ServiceError("bad_policy", "수수료율은 0~50%(0~5000bp) 정수여야 합니다.");
  if (!int(n.minMaintainedMonths, 0, 24) || !int(n.maxCommissionMonths, 1, 60)) throw new ServiceError("bad_policy", "유지 기간·지급 기간이 올바르지 않습니다.");
  if (!int(n.minPayoutMicro, 0, 10_000_000_000) || n.minPayoutMicro % 10_000 !== 0) throw new ServiceError("bad_policy", "최소 지급액이 올바르지 않습니다(센트 단위).");
  if (!int(n.payoutDayOfMonth, 1, 28)) throw new ServiceError("bad_policy", "지급일은 1~28 이어야 합니다.");
  if (!int(n.velocityLimitPerHour, 1, 1000)) throw new ServiceError("bad_policy", "시간당 추천 한도가 올바르지 않습니다.");
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('affiliate_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(JSON.stringify(n), actor, nowIso(nowMs)).run();
  await audit(db, { actorId: actor, action: "admin.affiliate_policy", detail: n }, nowMs);
  return n;
}

/** 같은 사람의 다중 계정 판별용 이메일 정규화(+태그 제거, gmail 점 제거). */
export function normalizeEmailForCompare(email: string): string {
  const [l = "", d = ""] = email.trim().toLowerCase().split("@");
  const domain = d === "googlemail.com" ? "gmail.com" : d;
  const local = l.split("+")[0]!;
  return `${domain === "gmail.com" ? local.replace(/\./g, "") : local}@${domain}`;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
}

export async function applyAffiliate(db: D1Like, userId: string, payoutEmail: string, nowMs: number): Promise<{ id: string; code: string; status: string }> {
  const email = payoutEmail.trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) throw new ServiceError("bad_email", "지급받을 PayPal 이메일이 올바르지 않습니다.");
  const ex = await db.prepare("SELECT id, code, status FROM affiliate_users WHERE user_id = ?").bind(userId).first<{ id: string; code: string; status: string }>();
  if (ex) return ex;
  for (let i = 0; i < 5; i++) {
    const id = newId("aff"), code = generateCode();
    const r = await db.prepare("INSERT OR IGNORE INTO affiliate_users(id,user_id,code,status,payout_method,payout_email,created_at) VALUES(?,?,?,'pending','paypal',?,?)").bind(id, userId, code, email, nowIso(nowMs)).run();
    if (r.meta.changes) { await audit(db, { actorId: userId, action: "affiliate.apply", targetType: "affiliate", targetId: id }, nowMs); return { id, code, status: "pending" }; }
    const again = await db.prepare("SELECT id, code, status FROM affiliate_users WHERE user_id = ?").bind(userId).first<{ id: string; code: string; status: string }>();
    if (again) return again; // 동시 신청
  }
  throw new ServiceError("code_collision", "추천 코드를 만들지 못했습니다. 다시 시도하세요.");
}

export async function setAffiliateStatus(db: D1Like, actor: string, affId: string, status: "approved" | "suspended" | "rejected", nowMs: number): Promise<void> {
  const r = await db.prepare("UPDATE affiliate_users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE id = ?").bind(status, status, nowIso(nowMs), affId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "제휴자를 찾을 수 없습니다.");
  await audit(db, { actorId: actor, action: "admin.affiliate_status", targetType: "affiliate", targetId: affId, detail: { status } }, nowMs);
}

/** 가입 시 추천 코드 연결. 실패해도 가입을 막지 않는다(호출자가 try/catch). 자기추천·다중계정·단시간 대량 가입은 flagged 로 기록하고 수수료를 주지 않는다. */
export async function bindReferral(db: D1Like, user: { id: string; email: string }, rawCode: string, nowMs: number): Promise<{ bound: boolean; flagged?: boolean; reason?: string }> {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return { bound: false, reason: "invalid_code" };
  const aff = await db.prepare("SELECT a.id, a.user_id, a.status, u.email FROM affiliate_users a JOIN users u ON u.id = a.user_id WHERE a.code = ?").bind(code).first<{ id: string; user_id: string; status: string; email: string }>();
  if (!aff || aff.status !== "approved") return { bound: false, reason: "affiliate_unavailable" };
  const policy = await loadAffiliatePolicy(db);
  let reason: string | null = null;
  if (aff.user_id === user.id || normalizeEmailForCompare(aff.email) === normalizeEmailForCompare(user.email)) reason = "self_referral";
  else {
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM affiliate_referrals WHERE affiliate_id = ? AND created_at > ?").bind(aff.id, nowIso(nowMs - 3_600_000)).first<{ n: number }>();
    if ((recent?.n ?? 0) >= policy.velocityLimitPerHour) reason = "velocity";
  }
  const r = await db.prepare("INSERT OR IGNORE INTO affiliate_referrals(id,affiliate_id,referred_user_id,flagged_fraud,flag_reason,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ref"), aff.id, user.id, reason ? 1 : 0, reason, nowIso(nowMs)).run();
  if (r.meta.changes === 0) return { bound: false, reason: "already_referred" };
  return { bound: true, flagged: !!reason, reason: reason ?? undefined };
}

/** 실제 결제 완료(payments.succeeded)를 기준으로 수수료를 원장에 적립(멱등). 환불·분쟁은 settleAffiliates 가 회수한다. */
export async function accrueCommission(db: D1Like, paymentId: string, nowMs: number): Promise<"accrued" | "skipped"> {
  const p = await db.prepare("SELECT p.id, p.customer_id, p.amount_micro, p.status, p.paid_at, i.subscription_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?").bind(paymentId).first<{ id: string; customer_id: string; amount_micro: number; status: string; paid_at: string | null; subscription_id: string | null }>();
  if (!p || p.status !== "succeeded" || !p.subscription_id || !p.paid_at) return "skipped";
  const ref = await db.prepare("SELECT r.id, r.affiliate_id, r.flagged_fraud, r.first_qualifying_payment_at AS fq, a.status, a.user_id FROM affiliate_referrals r JOIN affiliate_users a ON a.id = r.affiliate_id WHERE r.referred_user_id = ?").bind(p.customer_id).first<{ id: string; affiliate_id: string; flagged_fraud: number; fq: string | null; status: string; user_id: string }>();
  if (!ref || ref.flagged_fraud || ref.status !== "approved" || ref.user_id === p.customer_id) return "skipped";
  const policy = await loadAffiliatePolicy(db);
  const paidAt = Date.parse(p.paid_at);
  const first = ref.fq ? Date.parse(ref.fq) : paidAt;
  if (!ref.fq) await db.prepare("UPDATE affiliate_referrals SET first_qualifying_payment_at = ? WHERE id = ? AND first_qualifying_payment_at IS NULL").bind(p.paid_at, ref.id).run();
  const amount = commissionFor({ paymentId: p.id, subscriptionId: p.subscription_id, paidMicro: p.amount_micro, refundedMicro: 0, chargebackMicro: 0, unpaid: false, paidAtMs: paidAt },
    { firstQualifyingPaymentAtMs: first, maintainedMonths: policy.minMaintainedMonths, referralValid: true, selfReferral: false }, policy); // 유지 기간은 정산 단계에서 별도로 검증
  if (amount <= 0) return "skipped";
  const r = await db.prepare("INSERT OR IGNORE INTO affiliate_commissions(id,affiliate_id,referral_id,subscription_id,payment_id,amount_micro,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").bind(newId("com"), ref.affiliate_id, ref.id, p.subscription_id, p.id, amount, nowIso(nowMs)).run();
  return r.meta.changes ? "accrued" : "skipped";
}

export interface SettleReport { voided: number; adjusted: number; promoted: number; payoutsCreated: number }

/** 주기 작업(멱등): ① 환불·분쟁 회수 ② 유지 조건 충족 시 지급 가능 승격 / 미충족 해지 시 무효 ③ 지급일(기본 10일)에 월 정산 지급 예정 원장 생성. */
export async function settleAffiliates(db: D1Like, nowMs: number, o: { forcePayout?: boolean } = {}): Promise<SettleReport> {
  const rep: SettleReport = { voided: 0, adjusted: 0, promoted: 0, payoutsCreated: 0 };
  const policy = await loadAffiliatePolicy(db);
  const ts = nowIso(nowMs);

  // ① 환불·분쟁
  const rev = (await db.prepare(`SELECT c.id, c.affiliate_id, c.amount_micro, c.status, p.amount_micro AS pay, p.status AS pstatus,
      COALESCE((SELECT SUM(amount_micro) FROM refunds WHERE payment_id = p.id AND kind = 'refund'),0) AS refunded
    FROM affiliate_commissions c JOIN payments p ON p.id = c.payment_id WHERE c.status IN ('pending','eligible','payable','paid') AND p.status IN ('refunded','partially_refunded','disputed')`).all<{ id: string; affiliate_id: string; amount_micro: number; status: string; pay: number; pstatus: string; refunded: number }>()).results;
  for (const c of rev) {
    const full = c.pstatus === "refunded" || c.pstatus === "disputed" || c.refunded >= c.pay;
    const keep = full ? 0 : Math.floor((c.amount_micro * Math.max(0, c.pay - c.refunded)) / c.pay);
    const lose = c.amount_micro - keep;
    if (lose <= 0) continue;
    if (c.status === "pending" || c.status === "eligible") {
      if (keep === 0) { await db.prepare("UPDATE affiliate_commissions SET status='void' WHERE id=?").bind(c.id).run(); rep.voided++; }
      else { await db.prepare("UPDATE affiliate_commissions SET amount_micro=? WHERE id=?").bind(keep, c.id).run(); rep.voided++; }
    } else { // 이미 지급 예정/지급된 수수료 → 다음 정산에서 차감(회수)
      const r = await db.prepare("INSERT OR IGNORE INTO affiliate_adjustments(id,affiliate_id,commission_id,amount_micro,reason,created_at) VALUES(?,?,?,?,?,?)").bind(newId("adj"), c.affiliate_id, c.id, -lose, c.pstatus === "disputed" ? "차지백/분쟁" : "환불", ts).run();
      if (r.meta.changes) { await db.prepare("UPDATE affiliate_commissions SET status = CASE WHEN status='paid' THEN 'clawed_back' ELSE status END WHERE id=?").bind(c.id).run(); rep.adjusted++; }
    }
  }

  // ② 유지 조건
  const pend = (await db.prepare(`SELECT c.id, s.status AS sstatus,
      (SELECT MIN(p2.paid_at) FROM payments p2 JOIN invoices i2 ON i2.id = p2.invoice_id WHERE i2.subscription_id = c.subscription_id AND p2.status IN ('succeeded','partially_refunded')) AS first_paid
    FROM affiliate_commissions c JOIN subscriptions s ON s.id = c.subscription_id WHERE c.status = 'pending'`).all<{ id: string; sstatus: string; first_paid: string | null }>()).results;
  for (const c of pend) {
    const maintained = c.first_paid !== null && nowMs - Date.parse(c.first_paid) >= policy.minMaintainedMonths * MONTH_MS;
    if (["canceled", "refunded", "incomplete"].includes(c.sstatus) && !maintained) { await db.prepare("UPDATE affiliate_commissions SET status='void' WHERE id=?").bind(c.id).run(); rep.voided++; }
    else if (maintained && ["active", "canceling", "canceled"].includes(c.sstatus)) { await db.prepare("UPDATE affiliate_commissions SET status='eligible' WHERE id=?").bind(c.id).run(); rep.promoted++; }
  }

  // ③ 월 정산(지급일 또는 운영자 수동 실행)
  if (isPayoutDay(new Date(nowMs), policy) || o.forcePayout) {
    const period = ts.slice(0, 7);
    const affs = (await db.prepare("SELECT id FROM affiliate_users WHERE status = 'approved'").all<{ id: string }>()).results;
    for (const a of affs) {
      if (await db.prepare("SELECT 1 AS x FROM affiliate_payouts WHERE affiliate_id = ? AND period = ?").bind(a.id, period).first()) continue;
      const elig = (await db.prepare("SELECT id, amount_micro FROM affiliate_commissions WHERE affiliate_id = ? AND status = 'eligible' ORDER BY created_at").bind(a.id).all<{ id: string; amount_micro: number }>()).results;
      const adj = (await db.prepare("SELECT id, amount_micro FROM affiliate_adjustments WHERE affiliate_id = ? AND applied_payout_id IS NULL").bind(a.id).all<{ id: string; amount_micro: number }>()).results;
      const plan = planPayout([...elig.map((e) => e.amount_micro), ...adj.map((x) => x.amount_micro)], 0, policy);
      if (plan.payMicro <= 0) continue; // 최소 지급액 미달: 적격 수수료는 그대로 이월된다
      const pid = newId("pay");
      const ins = await db.prepare("INSERT OR IGNORE INTO affiliate_payouts(id,affiliate_id,period,amount_micro,carryover_micro,status,created_at) VALUES(?,?,?,?,0,'pending',?)").bind(pid, a.id, period, plan.payMicro, ts).run();
      if (!ins.meta.changes) continue;
      await db.batch([
        ...elig.map((e) => db.prepare("UPDATE affiliate_commissions SET status='payable', payout_id=? WHERE id=? AND status='eligible'").bind(pid, e.id)),
        ...adj.map((x) => db.prepare("UPDATE affiliate_adjustments SET applied_payout_id=? WHERE id=? AND applied_payout_id IS NULL").bind(pid, x.id)),
      ]);
      rep.payoutsCreated++;
    }
  }
  return rep;
}

/* ── 지급 승인·기록 ── */
async function payoutRow(db: D1Like, id: string) {
  const p = await db.prepare("SELECT id, affiliate_id, status FROM affiliate_payouts WHERE id = ?").bind(id).first<{ id: string; affiliate_id: string; status: string }>();
  if (!p) throw new ServiceError("not_found", "지급 요청을 찾을 수 없습니다.");
  return p;
}
export async function approvePayout(db: D1Like, actor: string, id: string, nowMs: number): Promise<void> {
  const p = await payoutRow(db, id);
  if (p.status !== "pending") throw new ServiceError("bad_state", "승인할 수 없는 상태입니다.");
  await db.prepare("UPDATE affiliate_payouts SET status='approved', approved_by=? WHERE id=?").bind(actor, id).run();
  await audit(db, { actorId: actor, action: "admin.payout_approve", targetType: "affiliate_payout", targetId: id }, nowMs);
}
/** 운영자가 PayPal 로 송금한 뒤 참조번호를 기록한다(시스템이 자동 송금하지 않는다). */
export async function markPayoutPaid(db: D1Like, actor: string, id: string, reference: string, nowMs: number): Promise<void> {
  const ref = reference.trim();
  if (!ref || ref.length > 120) throw new ServiceError("bad_reference", "송금 참조번호(1~120자)가 필요합니다.");
  const p = await payoutRow(db, id);
  if (p.status !== "approved") throw new ServiceError("bad_state", "승인된 지급만 완료 처리할 수 있습니다.");
  await db.batch([
    db.prepare("UPDATE affiliate_payouts SET status='paid', external_ref=?, paid_at=? WHERE id=?").bind(ref, nowIso(nowMs), id),
    db.prepare("UPDATE affiliate_commissions SET status='paid' WHERE payout_id=? AND status='payable'").bind(id),
  ]);
  await audit(db, { actorId: actor, action: "admin.payout_paid", targetType: "affiliate_payout", targetId: id, detail: { reference: ref } }, nowMs);
}
/** 반려/실패: 수수료와 조정을 되돌려 다음 정산에 다시 포함한다. */
export async function releasePayout(db: D1Like, actor: string, id: string, outcome: "failed" | "rejected", reason: string, nowMs: number): Promise<void> {
  const p = await payoutRow(db, id);
  if (!["pending", "approved"].includes(p.status)) throw new ServiceError("bad_state", "처리할 수 없는 상태입니다.");
  await db.batch([
    db.prepare("UPDATE affiliate_payouts SET status=?, failure_reason=? WHERE id=?").bind(outcome, reason.slice(0, 300), id),
    db.prepare("UPDATE affiliate_commissions SET status='eligible', payout_id=NULL WHERE payout_id=? AND status='payable'").bind(id),
    db.prepare("UPDATE affiliate_adjustments SET applied_payout_id=NULL WHERE applied_payout_id=?").bind(id),
  ]);
  await audit(db, { actorId: actor, action: `admin.payout_${outcome}`, targetType: "affiliate_payout", targetId: id, detail: { reason } }, nowMs);
}
export async function clearReferralFlag(db: D1Like, actor: string, referralId: string, nowMs: number): Promise<void> {
  const r = await db.prepare("UPDATE affiliate_referrals SET flagged_fraud = 0 WHERE id = ? AND flagged_fraud = 1").bind(referralId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "검토할 추천이 없습니다.");
  await audit(db, { actorId: actor, action: "admin.referral_clear_flag", targetType: "affiliate_referral", targetId: referralId }, nowMs);
}

/** 제휴자 본인 화면용 요약. */
export async function affiliateSummary(db: D1Like, userId: string, origin: string) {
  const a = await db.prepare("SELECT id, code, status, payout_email FROM affiliate_users WHERE user_id = ?").bind(userId).first<{ id: string; code: string; status: string; payout_email: string | null }>();
  const policy = await loadAffiliatePolicy(db);
  if (!a) return { applied: false, policy: pub(policy) };
  const sums = (await db.prepare("SELECT status, COALESCE(SUM(amount_micro),0) s, COUNT(*) n FROM affiliate_commissions WHERE affiliate_id = ? GROUP BY status").bind(a.id).all<{ status: string; s: number; n: number }>()).results;
  const refs = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(first_qualifying_payment_at IS NOT NULL),0) paying FROM affiliate_referrals WHERE affiliate_id = ? AND flagged_fraud = 0").bind(a.id).first<{ n: number; paying: number }>();
  const adj = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) s FROM affiliate_adjustments WHERE affiliate_id = ? AND applied_payout_id IS NULL").bind(a.id).first<{ s: number }>();
  return {
    applied: true, status: a.status, code: a.code, link: a.status === "approved" ? `${origin}/register?ref=${a.code}` : null, payoutEmail: a.payout_email,
    referrals: { total: refs?.n ?? 0, paying: refs?.paying ?? 0 },
    amounts: Object.fromEntries(sums.map((x) => [x.status, x.s])), pendingAdjustmentMicro: adj?.s ?? 0,
    commissions: (await db.prepare("SELECT c.id, c.amount_micro, c.status, c.created_at, p.name_ko product FROM affiliate_commissions c JOIN subscriptions s ON s.id = c.subscription_id JOIN products p ON p.id = s.product_id WHERE c.affiliate_id = ? ORDER BY c.created_at DESC LIMIT 20").bind(a.id).all()).results,
    payouts: (await db.prepare("SELECT id, period, amount_micro, status, paid_at, failure_reason FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 12").bind(a.id).all()).results,
    policy: pub(policy),
  };
}
const pub = (p: ProgramPolicy) => ({ ratePct: p.rateBp / 100, minMaintainedMonths: p.minMaintainedMonths, minPayoutMicro: p.minPayoutMicro, maxCommissionMonths: p.maxCommissionMonths, payoutDayOfMonth: p.payoutDayOfMonth });

export async function adminAffiliateOverview(db: D1Like) {
  const q = async (sql: string) => (await db.prepare(sql).all()).results as any[];
  return {
    policy: await loadAffiliatePolicy(db),
    affiliates: await q(`SELECT a.id, a.code, a.status, a.payout_email, u.email, a.created_at,
        (SELECT COUNT(*) FROM affiliate_referrals WHERE affiliate_id = a.id) AS referrals,
        (SELECT COALESCE(SUM(amount_micro),0) FROM affiliate_commissions WHERE affiliate_id = a.id AND status IN ('pending','eligible')) AS outstanding,
        (SELECT COALESCE(SUM(amount_micro),0) FROM affiliate_commissions WHERE affiliate_id = a.id AND status = 'paid') AS paid
      FROM affiliate_users a JOIN users u ON u.id = a.user_id ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`),
    flagged: await q("SELECT r.id, r.flag_reason, r.created_at, a.code, u.email AS referred_email FROM affiliate_referrals r JOIN affiliate_users a ON a.id = r.affiliate_id JOIN users u ON u.id = r.referred_user_id WHERE r.flagged_fraud = 1 ORDER BY r.created_at DESC LIMIT 50"),
    payouts: await q("SELECT p.id, p.period, p.amount_micro, p.status, p.external_ref, p.paid_at, p.failure_reason, a.code, a.payout_email, u.email FROM affiliate_payouts p JOIN affiliate_users a ON a.id = p.affiliate_id JOIN users u ON u.id = a.user_id ORDER BY p.created_at DESC LIMIT 50"),
  };
}
