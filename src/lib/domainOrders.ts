import { type D1Like, newId, nowIso } from "./db";
import { normalizeHostname, isApexDomain } from "./domainNames";
import { priceFor, driftAcceptable, SEED_DOMAIN_PRICING, type DomainPricingConfig } from "./domainPricing";
import type { RegistrarPort, RegistrantContact, RegistrationOutcome, NameserverPort } from "./registrar";
import { routeDomain, SEED_ROUTER_CONFIG, type PortMap, type RouterConfig } from "./registrarRouter";
import { bandFromCostWon, SEED_KRW_PRICE_CONFIG, type KrwPriceConfig } from "./currencyPricing";
import { wonToUsdMicro } from "./fx";
import type { ZonesPort } from "./zones";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

export interface OrderRow { id: string; customer_id: string; hostname: string; status: string; registrar_cost_micro: number; renewal_cost_micro: number; price_micro: number; renewal_price_micro: number; quote_expires_at: string; registrant_enc: string | null; registrar_state: string | null; stripe_payment_intent_id: string | null; registrar_provider: string; fx_rate_micro: number | null }

const SEL = "id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,registrar_state,stripe_payment_intent_id,registrar_provider,fx_rate_micro";
const getOrder = (db: D1Like, id: string) => db.prepare(`SELECT ${SEL} FROM domain_orders WHERE id = ?`).bind(id).first<OrderRow>();

/** 단일 등록기관 포트 또는 주문의 등록기관(provider)별 포트를 돌려주는 함수. */
export type PortSource = RegistrarPort | ((provider: string) => RegistrarPort);
const portOf = (src: PortSource, provider: string): RegistrarPort => (typeof src === "function" ? src(provider) : src);

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
export async function runRegistration(db: D1Like, ports: PortSource, crypto: Crypto, orderId: string, nowMs: number, cfg: DomainPricingConfig = SEED_DOMAIN_PRICING): Promise<string> {
  const claim = await db.prepare("UPDATE domain_orders SET status='registering', updated_at=? WHERE id=? AND status='paid'").bind(nowIso(nowMs), orderId).run();
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "주문 없음");
  if (claim.meta.changes === 0) return o.status; // 이미 다른 실행이 처리 중이거나 끝남(멱등)

  const registrar = portOf(ports, o.registrar_provider);
  const [chk] = await registrar.check([o.hostname]);
  // 원화 공급가(가비아)는 견적 시점 환율로 환산해 같은 기준으로 비교한다(환율 잡음이 원가 변동으로 오판되지 않게).
  const currentCost = chk?.registrationCostMicro ?? (chk?.registrationCostWon !== undefined && o.fx_rate_micro ? wonToUsdMicro(chk.registrationCostWon, o.fx_rate_micro) : undefined);
  if (!chk?.registrable || currentCost === undefined) { await db.batch(toRefund(db, o.id, ["registering"], `not_registrable:${chk?.reason ?? "unknown"}`, nowMs)); return "refund_due"; }
  if (!driftAcceptable(o.registrar_cost_micro, currentCost, cfg)) { await db.batch(toRefund(db, o.id, ["registering"], "price_changed", nowMs)); return "refund_due"; }
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
export async function pollRegistration(db: D1Like, ports: PortSource, orderId: string, nowMs: number): Promise<string> {
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "주문 없음");
  if (o.status !== "registering" || o.registrar_state !== "in_progress") return o.status;
  const out = await portOf(ports, o.registrar_provider).status(o.hostname);
  await db.batch(applyOutcome(db, o, out, nowMs));
  return (await getOrder(db, orderId))!.status;
}

export async function markRefunded(db: D1Like, orderId: string, nowMs: number): Promise<boolean> {
  const r = await db.prepare("UPDATE domain_orders SET status='refunded', updated_at=? WHERE id=? AND status='refund_due'").bind(nowIso(nowMs), orderId).run();
  return r.meta.changes === 1;
}

/**
 * 등록 완료 후 영역을 확보한다(멱등).
 * 보안: 도메인이 구매되기 전에 다른 고객이 같은 이름으로 먼저 '연결'해 둔 영역(선점)이 있으면, 실제 구매자가 소유자이므로
 * 선점 영역을 삭제하고 구매자 영역을 새로 만든다. 같은 구매자의 영역이면 그대로 재사용한다.
 */
export async function adoptRegisteredZone(db: D1Like, zones: ZonesPort, orderId: string, nowMs: number) {
  const o = await getOrder(db, orderId);
  if (!o || o.status !== "registered") throw new ServiceError("not_registered", "등록이 완료된 주문만 영역을 만들 수 있음");
  const existing = await db.prepare("SELECT id, customer_id, cf_zone_id FROM dns_zones WHERE hostname = ? AND status <> 'deleted'").bind(o.hostname).first<{ id: string; customer_id: string; cf_zone_id: string }>();
  if (existing && existing.customer_id === o.customer_id) return { zoneId: existing.id, created: false };
  if (existing) {
    await zones.deleteZone(existing.cf_zone_id);
    await db.prepare("UPDATE dns_zones SET status='deleted' WHERE id=?").bind(existing.id).run();
    await audit(db, { actorId: null, action: "domain.squatter_zone_removed", targetType: "dns_zone", targetId: existing.id, detail: { hostname: o.hostname, order: o.id } }, nowMs);
  }
  const found = await zones.findZone(o.hostname);
  // Cloudflare 등록 도메인은 영역이 자동 생성될 수 있다. 가비아 등록 도메인은 새로 만들어야 하며, 추적되지 않는 기존 영역은 확인 전까지 건드리지 않는다.
  if (found && o.registrar_provider !== "cloudflare") throw new ServiceError("zone_conflict", "추적되지 않는 기존 영역이 있어 운영자 확인이 필요함");
  const z = found ?? (await zones.createZone(o.hostname));
  const id = newId("zon");
  await db.prepare("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin,status,name_servers_json,order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id, o.customer_id, o.hostname, z.id, "registered", "pending_nameservers", JSON.stringify(z.nameServers), o.id, nowIso(nowMs)).run();
  return { zoneId: id, created: true };
}

/** 타사 등록기관(가비아) 도메인의 네임서버를 Cloudflare 영역의 네임서버로 위임. 실패해도 안전하게 재시도할 수 있다(멱등). */
export async function delegateNameservers(db: D1Like, nsPort: NameserverPort, orderId: string, nowMs: number): Promise<{ delegated: boolean; nameServers: string[] }> {
  const o = await getOrder(db, orderId);
  if (!o || o.status !== "registered") throw new ServiceError("not_registered", "등록이 완료된 주문만 위임할 수 있음");
  const z = await db.prepare("SELECT name_servers_json AS ns FROM dns_zones WHERE order_id = ? AND status <> 'deleted'").bind(orderId).first<{ ns: string }>();
  if (!z) throw new ServiceError("no_zone", "영역이 먼저 만들어져야 함");
  const ns = JSON.parse(z.ns) as string[];
  if (o.registrar_provider === "cloudflare") return { delegated: true, nameServers: ns }; // Cloudflare 등록 도메인은 이미 Cloudflare 네임서버
  await nsPort.setNameservers(o.hostname, ns);
  await db.prepare("UPDATE domain_orders SET ns_delegated_at=?, updated_at=? WHERE id=?").bind(nowIso(nowMs), nowIso(nowMs), orderId).run();
  return { delegated: true, nameServers: ns };
}

export interface RoutedQuoteInput {
  customerId: string; hostname: string; contact: RegistrantContact; nowMs: number;
  currency: "KRW" | "USD";
  rate: { smoothedRateMicro: number; costRateMicro: number };
  krwCfg?: KrwPriceConfig; usdCfg?: DomainPricingConfig; routerCfg?: RouterConfig;
}

/**
 * 다중 등록기관·다중 통화 견적: 등록기관 선택 → 판매가 산정(KRW: 환율·하한/상한 밴드, USD: 원가+수수료) → 주문에 환율·통화 고정.
 * 하한이 상한을 넘으면(팔수록 손해) 견적을 내지 않는다.
 */
export async function createQuoteRouted(db: D1Like, ports: PortMap, crypto: Crypto, p: RoutedQuoteInput) {
  const usdCfg = p.usdCfg ?? SEED_DOMAIN_PRICING, krwCfg = p.krwCfg ?? SEED_KRW_PRICE_CONFIG;
  const hostname = normalizeHostname(p.hostname);
  if (!hostname || !isApexDomain(hostname)) throw new ServiceError("invalid_hostname", "등록할 수 있는 루트 도메인(example.com)만 가능");
  if (!validContact(p.contact)) throw new ServiceError("invalid_contact", "등록자 정보를 정확히 입력해야 함");
  const taken = await db.prepare("SELECT 1 AS x FROM domain_orders WHERE hostname = ? AND status IN ('paid','registering','registered','needs_review')").bind(hostname).first();
  if (taken) throw new ServiceError("unavailable", "이미 주문이 진행 중이거나 등록된 도메인");
  const route = await routeDomain(ports, hostname, p.rate, p.routerCfg ?? SEED_ROUTER_CONFIG).catch((e) => { throw new ServiceError("unavailable", e instanceof Error ? e.message : "조회 실패"); });
  const b = route.best;
  let chargeAmount: number, renewalAmount: number, priceUsdEq: number;
  if (p.currency === "KRW") {
    const reg = bandFromCostWon(b.regWon, krwCfg), ren = bandFromCostWon(b.renWon, krwCfg);
    if (!reg.sellable || !ren.sellable) throw new ServiceError("unsellable", "현재 원가·환율에서는 시장 상한가 안에서 마진을 확보할 수 없어 판매를 중지함");
    chargeAmount = reg.targetWon; renewalAmount = ren.targetWon;
    priceUsdEq = wonToUsdMicro(chargeAmount, p.rate.smoothedRateMicro);
  } else {
    chargeAmount = Math.round(priceFor(b.regUsdMicro, usdCfg) / 10_000); // 센트
    renewalAmount = Math.round(priceFor(b.renUsdMicro, usdCfg) / 10_000);
    priceUsdEq = chargeAmount * 10_000;
  }
  const id = newId("dor");
  const expires = nowIso(p.nowMs + usdCfg.quoteTtlMinutes * 60_000);
  await db.prepare(`INSERT INTO domain_orders(id,customer_id,hostname,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,created_at,updated_at,registrar_provider,charge_currency,charge_amount,renewal_charge_amount,fx_rate_micro) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, p.customerId, hostname, b.regUsdMicro, b.renUsdMicro, Math.max(1, priceUsdEq), Math.max(1, p.currency === "KRW" ? wonToUsdMicro(renewalAmount, p.rate.smoothedRateMicro) : renewalAmount * 10_000), expires,
      await crypto.encrypt(JSON.stringify(p.contact), `domain_order:${id}`), nowIso(p.nowMs), nowIso(p.nowMs), b.provider, p.currency, chargeAmount, renewalAmount, p.rate.smoothedRateMicro).run();
  await audit(db, { actorId: p.customerId, action: "domain.quote", targetType: "domain_order", targetId: id, detail: { hostname, provider: b.provider, currency: p.currency, chargeAmount } }, p.nowMs);
  return { orderId: id, hostname, provider: b.provider, currency: p.currency, chargeAmount, renewalChargeAmount: renewalAmount, quoteExpiresAt: expires, reasons: route.reasons, nonRefundableNotice: "도메인 등록이 완료되면 환불되지 않습니다." };
}
