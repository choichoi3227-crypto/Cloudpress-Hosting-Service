import { type D1Like, newId, nowIso } from "./db";
import { normalizeHostname, isApexDomain } from "./domainNames";
import { priceFor, driftAcceptable, SEED_DOMAIN_PRICING, type DomainPricingConfig } from "./domainPricing";
import type { RegistrarPort, RegistrantContact, RegistrationOutcome } from "./registrar";
import type { ZonesPort } from "./zones";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

export interface OrderRow { id: string; customer_id: string; hostname: string; status: string; registrar_cost_micro: number; renewal_cost_micro: number; price_micro: number; renewal_price_micro: number; quote_expires_at: string; registrant_enc: string | null; registrar_state: string | null; stripe_payment_intent_id: string | null }

const SEL = "id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,registrar_state,stripe_payment_intent_id";
const getOrder = (db: D1Like, id: string) => db.prepare(`SELECT ${SEL} FROM domain_orders WHERE id = ?`).bind(id).first<OrderRow>();

export interface Crypto { encrypt(plain: string, aad: string): Promise<string>; decrypt(token: string, aad: string): Promise<string> }

function validContact(c: RegistrantContact): boolean {
  const a = c?.postal_info?.address;
  return !!c && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email) && /^\+\d{1,3}\.\d{4,14}$/.test(c.phone) && !!c.postal_info.name?.trim() && !!a && [a.street, a.city, a.postal_code].every((x) => !!x?.trim()) && /^[A-Z]{2}$/.test(a.country_code);
}

/** 1단계: 견적. 실시간 가용성·원가를 확인하고 가격(결제 수수료 포함)을 확정한다. 결제 전에는 어떤 비용도 발생하지 않는다. */
export async function createQuote(db: D1Like, registrar: RegistrarPort, crypto: Crypto, p: { customerId: string; hostname: string; contact: RegistrantContact; nowMs: number; cfg?: DomainPricingConfig }) {
  const cfg = p.cfg ?? SEED_DOMAIN_PRICING;
  const hostname = normalizeHostname(p.hostname);
  if (!hostname || !isApexDomain(hostname)) throw new ServiceError("invalid_hostname", "등록할 수 있는 루트 도메인(example.com)만 가능");
  if (!validContact(p.contact)) throw new ServiceError("invalid_contact", "등록자 정보(이메일·전화 +국가.번호·이름·주소·국가코드)를 정확히 입력해야 함. 도메인의 법적 소유자는 입력한 등록자입니다.");
  const taken = await db.prepare("SELECT 1 AS x FROM domain_orders WHERE hostname = ? AND status IN ('paid','registering','registered','needs_review')").bind(hostname).first();
  if (taken) throw new ServiceError("unavailable", "이미 주문이 진행 중이거나 등록된 도메인");
  const [chk] = await registrar.check([hostname]);
  if (!chk || !chk.registrable || !chk.registrationCostMicro || !chk.renewalCostMicro) throw new ServiceError("unavailable", `등록할 수 없음${chk?.reason ? ` (${chk.reason})` : ""}`);
  const id = newId("dor");
  const price = priceFor(chk.registrationCostMicro, cfg);
  const renewalPrice = priceFor(chk.renewalCostMicro, cfg);
  const expires = nowIso(p.nowMs + cfg.quoteTtlMinutes * 60_000);
  await db.prepare("INSERT INTO domain_orders(id,customer_id,hostname,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, p.customerId, hostname, chk.registrationCostMicro, chk.renewalCostMicro, price, renewalPrice, expires, await crypto.encrypt(JSON.stringify(p.contact), `domain_order:${id}`), nowIso(p.nowMs), nowIso(p.nowMs)).run();
  await audit(db, { actorId: p.customerId, action: "domain.quote", targetType: "domain_order", targetId: id, detail: { hostname, price } }, p.nowMs);
  return { orderId: id, hostname, priceMicro: price, renewalPriceMicro: renewalPrice, quoteExpiresAt: expires, nonRefundableNotice: "도메인 등록이 완료되면 환불되지 않습니다." };
}

export async function expireQuotes(db: D1Like, nowMs: number): Promise<number> {
  const r = await db.prepare("UPDATE domain_orders SET status='quote_expired', updated_at=? WHERE status='awaiting_payment' AND quote_expires_at < ?").bind(nowIso(nowMs), nowIso(nowMs)).run();
  return r.meta.changes;
}

const refundJob = (db: D1Like, orderId: string, nowMs: number) =>
  db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "refund_domain_order", `refund:${orderId}`, JSON.stringify({ orderId }), nowIso(nowMs), nowIso(nowMs));
const toRefund = (db: D1Like, orderId: string, from: string[], reason: string, nowMs: number) => [
  db.prepare(`UPDATE domain_orders SET status='refund_due', failure_reason=?, updated_at=? WHERE id=? AND status IN (${from.map(() => "?").join(",")})`).bind(reason, nowIso(nowMs), orderId, ...from),
  refundJob(db, orderId, nowMs),
];

/** 2단계: 결제 확인(웹훅 기준). 같은 결제를 여러 번 받아도 한 번만 반영. 같은 도메인이 이미 다른 주문으로 확정됐다면 환불 대상으로 보낸다. */
export async function markPaid(db: D1Like, orderId: string, paymentIntentId: string, nowMs: number): Promise<"paid" | "duplicate" | "refund_due"> {
  try {
    const r = await db.prepare("UPDATE domain_orders SET status='paid', stripe_payment_intent_id=?, updated_at=? WHERE id=? AND status IN ('awaiting_payment','quote_expired')").bind(paymentIntentId, nowIso(nowMs), orderId).run();
    if (r.meta.changes === 1) return "paid";
  } catch {
    // 부분 유니크 인덱스 위반: 다른 주문이 이미 이 도메인을 확정함
    await db.batch([db.prepare("UPDATE domain_orders SET stripe_payment_intent_id=? WHERE id=?").bind(paymentIntentId, orderId), ...toRefund(db, orderId, ["awaiting_payment", "quote_expired"], "domain_taken_by_other_order", nowMs)]);
    return "refund_due";
  }
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "주문 없음");
  return o.stripe_payment_intent_id === paymentIntentId ? "duplicate" : (() => { throw new ServiceError("payment_mismatch", "다른 결제로 이미 처리된 주문"); })();
}

function applyOutcome(db: D1Like, o: OrderRow, out: RegistrationOutcome, nowMs: number) {
  switch (out.outcome) {
    case "succeeded": return [db.prepare("UPDATE domain_orders SET status='registered', registrar_state='succeeded', registered_at=?, expires_at=?, updated_at=? WHERE id=? AND status IN ('registering','needs_review')").bind(nowIso(nowMs), out.expiresAt || null, nowIso(nowMs), o.id)];
    case "in_progress": return [db.prepare("UPDATE domain_orders SET registrar_state='in_progress', updated_at=? WHERE id=? AND status='registering'").bind(nowIso(nowMs), o.id)];
    case "action_required": case "blocked": return [db.prepare("UPDATE domain_orders SET status='needs_review', registrar_state=?, failure_reason=?, updated_at=? WHERE id=? AND status='registering'").bind(out.outcome, `${out.code ?? out.outcome}`, nowIso(nowMs), o.id)];
    case "failed": return toRefund(db, o.id, ["registering"], `registrar_failed:${out.code ?? "unknown"}`, nowMs);
  }
}

/**
 * 3단계: 등록. 등록은 환불 불가이므로 '정확히 한 번'만 시도한다.
 * - 클레임(paid→registering)을 먼저 원자적으로 획득해 중복 실행을 막는다.
 * - 직전에 가용성·원가를 다시 확인하고, 불가·원가 급등이면 등록하지 않고 환불로 보낸다.
 * - 응답이 모호한 오류(타임아웃 등)는 재시도하지 않고 상태를 조회해 확인하며, 그래도 불분명하면 운영자 검토로 보낸다.
 */
export async function runRegistration(db: D1Like, registrar: RegistrarPort, crypto: Crypto, orderId: string, nowMs: number, cfg: DomainPricingConfig = SEED_DOMAIN_PRICING): Promise<string> {
  const claim = await db.prepare("UPDATE domain_orders SET status='registering', updated_at=? WHERE id=? AND status='paid'").bind(nowIso(nowMs), orderId).run();
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "주문 없음");
  if (claim.meta.changes === 0) return o.status; // 이미 다른 실행이 처리 중이거나 끝남(멱등)

  const [chk] = await registrar.check([o.hostname]);
  if (!chk?.registrable || chk.registrationCostMicro === undefined) { await db.batch(toRefund(db, o.id, ["registering"], `not_registrable:${chk?.reason ?? "unknown"}`, nowMs)); return "refund_due"; }
  if (!driftAcceptable(o.registrar_cost_micro, chk.registrationCostMicro, cfg)) { await db.batch(toRefund(db, o.id, ["registering"], "price_changed", nowMs)); return "refund_due"; }
  if (!o.registrant_enc) { await db.prepare("UPDATE domain_orders SET status='needs_review', failure_reason='missing_registrant', updated_at=? WHERE id=? AND status='registering'").bind(nowIso(nowMs), o.id).run(); return "needs_review"; }
  const contact = JSON.parse(await crypto.decrypt(o.registrant_enc, `domain_order:${o.id}`)) as RegistrantContact;

  let out: RegistrationOutcome;
  try {
    out = await registrar.register(o.hostname, contact);
  } catch {
    try { out = await registrar.status(o.hostname); } catch { out = { outcome: "blocked", code: "ambiguous_error" }; }
    if (out.outcome === "failed") out = { outcome: "blocked", code: "ambiguous_error" }; // 모호하면 환불·재시도 모두 하지 않고 검토
  }
  await db.batch(applyOutcome(db, o, out, nowMs));
  await audit(db, { actorId: null, action: "domain.register", targetType: "domain_order", targetId: o.id, detail: { outcome: out.outcome } }, nowMs);
  return (await getOrder(db, o.id))!.status;
}

/** 진행 중(in_progress) 등록을 조회. 호출 낭비를 줄이려면 호출 간격을 점점 늘린다. */
export async function pollRegistration(db: D1Like, registrar: RegistrarPort, orderId: string, nowMs: number): Promise<string> {
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "주문 없음");
  if (o.status !== "registering" || o.registrar_state !== "in_progress") return o.status;
  const out = await registrar.status(o.hostname);
  await db.batch(applyOutcome(db, o, out, nowMs));
  return (await getOrder(db, orderId))!.status;
}

export async function markRefunded(db: D1Like, orderId: string, nowMs: number): Promise<boolean> {
  const r = await db.prepare("UPDATE domain_orders SET status='refunded', updated_at=? WHERE id=? AND status='refund_due'").bind(nowIso(nowMs), orderId).run();
  return r.meta.changes === 1;
}

/** 등록 완료 후 영역을 확보한다(멱등). Cloudflare 에서 등록한 도메인이므로 네임서버는 Cloudflare 로 이미 지정된다. */
export async function adoptRegisteredZone(db: D1Like, zones: ZonesPort, orderId: string, nowMs: number) {
  const o = await getOrder(db, orderId);
  if (!o || o.status !== "registered") throw new ServiceError("not_registered", "등록이 완료된 주문만 영역을 만들 수 있음");
  const existing = await db.prepare("SELECT id FROM dns_zones WHERE hostname = ? AND status <> 'deleted'").bind(o.hostname).first<{ id: string }>();
  if (existing) return { zoneId: existing.id, created: false };
  const z = (await zones.findZone(o.hostname)) ?? (await zones.createZone(o.hostname));
  const id = newId("zon");
  await db.prepare("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin,status,name_servers_json,order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id, o.customer_id, o.hostname, z.id, "registered", "pending_nameservers", JSON.stringify(z.nameServers), o.id, nowIso(nowMs)).run();
  return { zoneId: id, created: true };
}
