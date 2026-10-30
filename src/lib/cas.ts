import { type D1Like, newId, nowIso } from "./db";
import { randomToken, sha256Hex } from "./crypto";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";
import { valueToCents } from "./paypal.client";

/** Cloudflare Workers AI 공식: 1,000 Neurons = $0.011 → 1 Neuron = 11 micro-USD. */
export const COST_MICRO_PER_NEURON = 11;

export type Tier = "general" | "performance" | "premium";
/** 초기 판매 정책(관리자가 ai_model_prices 새 버전으로 변경). 월 기본 요금 / 1,000 Neurons 당 판매가(micro USD). */
export const SEED_TIER_PRICES: Record<Tier, { monthlyMicro: number; sellPer1kMicro: number }> = {
  general: { monthlyMicro: 990_000, sellPer1kMicro: 20_000 },
  performance: { monthlyMicro: 2_990_000, sellPer1kMicro: 30_000 },
  premium: { monthlyMicro: 4_990_000, sellPer1kMicro: 40_000 },
};

const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/** 토큰 사용량 → 추정 Neurons(정수, 올림). API 는 요청별 실제 Neurons 를 주지 않으므로 공식 단가 환산 추정치다. */
export function estimateNeurons(m: { input_neurons_per_m: number | null; output_neurons_per_m: number | null; unit_neurons: number | null }, u: { inputTokens?: number; outputTokens?: number; units?: number }): number {
  let n = 0;
  if (m.unit_neurons && u.units) n += m.unit_neurons * u.units;
  if (m.input_neurons_per_m && u.inputTokens) n += ceilDiv(m.input_neurons_per_m * u.inputTokens, 1_000_000);
  if (m.output_neurons_per_m && u.outputTokens) n += ceilDiv(m.output_neurons_per_m * u.outputTokens, 1_000_000);
  return n;
}
export const sellMicro = (neurons: number, sellPer1kMicro: number) => ceilDiv(neurons * sellPer1kMicro, 1000);
export const costMicro = (neurons: number) => neurons * COST_MICRO_PER_NEURON;

/* ───────── 모델 동기화 ───────── */

export interface CfModel { name?: string; id?: string; description?: string; task?: { name?: string }; properties?: { property_id?: string; value?: unknown }[] }

/** 공식 가격 속성("per M input tokens" 등, USD)을 Neurons 로 환산. 형식이 다르면 null(→ 관리자 입력 전까지 판매 불가). */
export function neuronsFromProperties(props: CfModel["properties"]): { inputM: number | null; outputM: number | null; unit: number | null } {
  const out = { inputM: null as number | null, outputM: null as number | null, unit: null as number | null };
  const price = props?.find((p) => p.property_id === "price")?.value;
  if (!Array.isArray(price)) return out;
  for (const e of price as { unit?: string; price?: number; currency?: string }[]) {
    if (typeof e?.price !== "number" || (e.currency && e.currency !== "USD")) continue;
    const neurons = Math.round(e.price / 0.000011); // $0.011 / 1000 neurons
    const unit = String(e.unit ?? "").toLowerCase();
    if (unit.includes("input") && unit.includes("token")) out.inputM = neurons;
    else if (unit.includes("output") && unit.includes("token")) out.outputM = neurons;
    else if (unit.length) out.unit = neurons;
  }
  return out;
}

export interface SyncResult { seen: number; added: number; updated: number; removed: number }

/** Cloudflare 공식 모델 목록과 동기화. 새 모델은 비활성(enabled=0)·판매불가로 들어오고 관리자가 분류·활성화한다. 사라진 모델은 삭제하지 않고 removed 로 표시·비활성. */
export async function syncModels(db: D1Like, models: CfModel[], nowMs: number): Promise<SyncResult> {
  const r: SyncResult = { seen: 0, added: 0, updated: 0, removed: 0 };
  const seen = new Set<string>();
  for (const m of models) {
    const modelId = m.name ?? m.id;
    if (typeof modelId !== "string" || !modelId.startsWith("@")) continue;
    seen.add(modelId); r.seen++;
    const rates = neuronsFromProperties(m.properties);
    const task = m.task?.name ?? "unknown";
    const deprecated = m.properties?.some((p) => p.property_id === "planned_deprecation_date") ?? false;
    const ex = await db.prepare("SELECT id, pricing_source FROM ai_models WHERE model_id = ?").bind(modelId).first<{ id: string; pricing_source: string }>();
    if (!ex) {
      await db.prepare("INSERT INTO ai_models(id,model_id,name,task_type,tier,official_status,uses_neurons,enabled,last_synced_at,input_neurons_per_m,output_neurons_per_m,unit_neurons,pricing_source) VALUES(?,?,?,?,'general',?,1,0,?,?,?,?,?)")
        .bind(newId("aim"), modelId, modelId.split("/").pop()!, task, deprecated ? "deprecating" : "listed", nowIso(nowMs), rates.inputM, rates.outputM, rates.unit, rates.inputM || rates.outputM || rates.unit ? "cloudflare_api" : "none").run();
      r.added++;
    } else {
      // 관리자가 직접 입력한 단가는 동기화가 덮어쓰지 않는다.
      const keep = ex.pricing_source === "admin";
      await db.prepare(`UPDATE ai_models SET task_type=?, official_status=?, last_synced_at=?${keep ? "" : ", input_neurons_per_m=?, output_neurons_per_m=?, unit_neurons=?, pricing_source=CASE WHEN ? THEN 'cloudflare_api' ELSE 'none' END"} WHERE id=?`)
        .bind(...[task, deprecated ? "deprecating" : "listed", nowIso(nowMs), ...(keep ? [] : [rates.inputM, rates.outputM, rates.unit, rates.inputM || rates.outputM || rates.unit ? 1 : 0]), ex.id]).run();
      r.updated++;
    }
  }
  const { results } = await db.prepare("SELECT model_id FROM ai_models WHERE official_status != 'removed'").all<{ model_id: string }>();
  for (const row of results) if (!seen.has(row.model_id)) {
    await db.prepare("UPDATE ai_models SET official_status='removed', enabled=0, last_synced_at=? WHERE model_id=?").bind(nowIso(nowMs), row.model_id).run(); r.removed++;
  }
  return r;
}

/** 모델 활성화·분류·가격 버전(새 행). 단가가 없는 모델은 활성화할 수 없다(판매 불가 모델 노출 방지). */
export async function adminSetModel(db: D1Like, actorId: string, modelPk: string, p: { enabled?: boolean; tier?: Tier; inputNeuronsPerM?: number; outputNeuronsPerM?: number; unitNeurons?: number; monthlyMicro?: number; sellPer1kMicro?: number }, nowMs: number): Promise<void> {
  const m = await db.prepare("SELECT id, tier, input_neurons_per_m i, output_neurons_per_m o, unit_neurons u FROM ai_models WHERE id = ?").bind(modelPk).first<{ id: string; tier: Tier; i: number | null; o: number | null; u: number | null }>();
  if (!m) throw new ServiceError("not_found", "모델 없음");
  if (p.tier && !(p.tier in SEED_TIER_PRICES)) throw new ServiceError("bad_tier", "분류가 올바르지 않음");
  const ints = [p.inputNeuronsPerM, p.outputNeuronsPerM, p.unitNeurons, p.monthlyMicro, p.sellPer1kMicro];
  if (ints.some((v) => v !== undefined && (!Number.isInteger(v) || v < 0))) throw new ServiceError("bad_value", "숫자는 0 이상의 정수여야 합니다.");
  const priced = (p.inputNeuronsPerM ?? m.i) || (p.outputNeuronsPerM ?? m.o) || (p.unitNeurons ?? m.u);
  if (p.enabled && !priced) throw new ServiceError("no_pricing", "Neurons 단가가 없는 모델은 활성화할 수 없습니다. 단가를 입력하세요.");
  const stmts = [];
  if (p.inputNeuronsPerM !== undefined || p.outputNeuronsPerM !== undefined || p.unitNeurons !== undefined)
    stmts.push(db.prepare("UPDATE ai_models SET input_neurons_per_m=COALESCE(?,input_neurons_per_m), output_neurons_per_m=COALESCE(?,output_neurons_per_m), unit_neurons=COALESCE(?,unit_neurons), pricing_source='admin' WHERE id=?").bind(p.inputNeuronsPerM ?? null, p.outputNeuronsPerM ?? null, p.unitNeurons ?? null, m.id));
  if (p.tier) stmts.push(db.prepare("UPDATE ai_models SET tier=? WHERE id=?").bind(p.tier, m.id));
  if (p.enabled !== undefined) stmts.push(db.prepare("UPDATE ai_models SET enabled=? WHERE id=?").bind(p.enabled ? 1 : 0, m.id));
  const tier = p.tier ?? m.tier;
  if (p.monthlyMicro !== undefined || p.sellPer1kMicro !== undefined || p.tier) {
    const cur = await currentPrice(db, m.id);
    const seed = SEED_TIER_PRICES[tier];
    stmts.push(db.prepare("INSERT INTO ai_model_prices(id,model_id,version,monthly_micro,sell_per_1k_micro,cost_per_1k_micro,active_from) VALUES(?,?,?,?,?,?,?)")
      .bind(newId("aip"), m.id, (cur?.version ?? 0) + 1, p.monthlyMicro ?? (p.tier ? seed.monthlyMicro : cur?.monthly_micro ?? seed.monthlyMicro), p.sellPer1kMicro ?? (p.tier ? seed.sellPer1kMicro : cur?.sell_per_1k_micro ?? seed.sellPer1kMicro), COST_MICRO_PER_NEURON * 1000, nowIso(nowMs)));
  }
  if (stmts.length) await db.batch(stmts);
  await audit(db, { actorId, action: "admin.cas_model_update", targetType: "ai_model", targetId: m.id, detail: p }, nowMs);
}

export interface PriceRow { version: number; monthly_micro: number; sell_per_1k_micro: number; cost_per_1k_micro: number }
export async function currentPrice(db: D1Like, modelPk: string): Promise<PriceRow | null> {
  return db.prepare("SELECT version, monthly_micro, sell_per_1k_micro, cost_per_1k_micro FROM ai_model_prices WHERE model_id = ? ORDER BY version DESC LIMIT 1").bind(modelPk).first<PriceRow>();
}

/* ───────── API 키 ───────── */

export interface IssuedKey { id: string; key: string; prefix: string }
/** 키 발급: 원문은 이 응답에서만 볼 수 있다. DB 에는 SHA-256 해시만 저장한다. */
export async function issueKey(db: D1Like, customerId: string, name: string, nowMs: number, o: { rateLimitPerMin?: number; monthlyCapMicro?: number | null } = {}): Promise<IssuedKey> {
  const n = name.trim();
  if (!n || n.length > 60) throw new ServiceError("bad_name", "키 이름은 1~60자여야 합니다.");
  const cnt = await db.prepare("SELECT COUNT(*) AS c FROM ai_api_keys WHERE customer_id = ? AND status = 'active'").bind(customerId).first<{ c: number }>();
  if ((cnt?.c ?? 0) >= 10) throw new ServiceError("limit_exceeded", "활성 키는 최대 10개입니다.");
  const rate = o.rateLimitPerMin ?? 60;
  if (!Number.isInteger(rate) || rate < 1 || rate > 6000) throw new ServiceError("bad_value", "분당 요청 제한은 1~6000 이어야 합니다.");
  if (o.monthlyCapMicro != null && (!Number.isInteger(o.monthlyCapMicro) || o.monthlyCapMicro < 0)) throw new ServiceError("bad_value", "월 상한이 올바르지 않습니다.");
  const key = `cpai_${randomToken()}`;
  const id = newId("aik");
  await db.prepare("INSERT INTO ai_api_keys(id,customer_id,name,prefix,key_hash,rate_limit_per_min,monthly_cap_micro,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(id, customerId, n, key.slice(0, 11), await sha256Hex(key), rate, o.monthlyCapMicro ?? null, nowIso(nowMs)).run();
  await audit(db, { actorId: customerId, action: "cas.key_issue", targetType: "ai_key", targetId: id }, nowMs);
  return { id, key, prefix: key.slice(0, 11) };
}
export async function revokeKey(db: D1Like, customerId: string, keyId: string, nowMs: number): Promise<void> {
  const r = await db.prepare("UPDATE ai_api_keys SET status='revoked', revoked_at=? WHERE id=? AND customer_id=? AND status!='revoked'").bind(nowIso(nowMs), keyId, customerId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "키를 찾을 수 없습니다.");
  await audit(db, { actorId: customerId, action: "cas.key_revoke", targetType: "ai_key", targetId: keyId }, nowMs);
}
/** 재발급: 기존 키는 즉시 폐기하고 같은 설정으로 새 키를 만든다. */
export async function rotateKey(db: D1Like, customerId: string, keyId: string, nowMs: number): Promise<IssuedKey> {
  const k = await db.prepare("SELECT name, rate_limit_per_min r, monthly_cap_micro c FROM ai_api_keys WHERE id=? AND customer_id=? AND status='active'").bind(keyId, customerId).first<{ name: string; r: number; c: number | null }>();
  if (!k) throw new ServiceError("not_found", "활성 키를 찾을 수 없습니다.");
  await revokeKey(db, customerId, keyId, nowMs);
  return issueKey(db, customerId, k.name, nowMs, { rateLimitPerMin: k.r, monthlyCapMicro: k.c });
}

/* ───────── 크레딧 원장 ───────── */

export async function creditBalance(db: D1Like, customerId: string): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) AS b FROM ai_credit_ledger WHERE customer_id = ?").bind(customerId).first<{ b: number }>();
  return r?.b ?? 0;
}
/** 충전 반영(멱등: 같은 ref 는 한 번만). */
export async function creditTopup(db: D1Like, customerId: string, amountMicro: number, ref: string, nowMs: number): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO ai_credit_ledger(id,customer_id,kind,amount_micro,ref,created_at) VALUES(?,?,'topup',?,?,?)").bind(newId("led"), customerId, amountMicro, ref, nowIso(nowMs)).run();
  return r.meta.changes > 0;
}
export const MIN_TOPUP_MICRO = 5_000_000, MAX_TOPUP_MICRO = 500_000_000;

/* ───────── 게이트웨이 ───────── */

export interface Runner { run(model: string, input: Record<string, unknown>): Promise<{ result: unknown; usage: { inputTokens?: number; outputTokens?: number; units?: number } }> }
export class MockAiRunner implements Runner {
  calls: { model: string; input: unknown }[] = [];
  async run(model: string, input: Record<string, unknown>) {
    this.calls.push({ model, input });
    const text = String(input.prompt ?? "");
    return { result: { response: `[mock] ${text.slice(0, 80)}`, mock: true }, usage: { inputTokens: Math.ceil(text.length / 4) + 1, outputTokens: 20 } };
  }
}

export type GatewayResult = { ok: true; result: unknown; usage: { inputTokens?: number; outputTokens?: number; units?: number }; neurons: number; billedMicro: number; balanceMicro: number }
  | { ok: false; status: number; error: string; message: string };
const fail = (status: number, error: string, message: string): GatewayResult => ({ ok: false, status, error, message });

export interface GatewayOpts { nowMs: number; requestId: string; maxOutputTokens?: number }

/**
 * 고객 API 키 요청 처리. 순서: 키 확인 → 긴급 차단 → 모델·구독 권한 → 분당 제한 → 월 상한 → 크레딧(최악 비용 선검사)
 * → 실행 → 실제 사용량 기록 + 크레딧 차감(한 트랜잭션) → 이상 사용 감지.
 */
export async function runGateway(db: D1Like, runner: Runner, bearer: string | null, body: { model?: unknown; input?: unknown }, o: GatewayOpts): Promise<GatewayResult> {
  if (!bearer || !bearer.startsWith("cpai_")) return fail(401, "unauthorized", "API 키가 필요합니다.");
  const key = await db.prepare("SELECT id, customer_id, status, rate_limit_per_min r, monthly_cap_micro cap FROM ai_api_keys WHERE key_hash = ?").bind(await sha256Hex(bearer)).first<{ id: string; customer_id: string; status: string; r: number; cap: number | null }>();
  if (!key || key.status !== "active") return fail(401, "unauthorized", "유효하지 않은 API 키입니다.");
  const kill = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cas_kill_switch'").first<{ value_json: string }>();
  if (kill?.value_json === "true") return fail(503, "service_paused", "운영자가 AI 서비스를 일시 중지했습니다.");
  if (typeof body.model !== "string" || typeof body.input !== "object" || body.input === null) return fail(400, "bad_request", "model(문자열)과 input(객체)이 필요합니다.");
  const user = await db.prepare("SELECT status FROM users WHERE id = ?").bind(key.customer_id).first<{ status: string }>();
  if (user?.status !== "active") return fail(403, "account_inactive", "계정이 활성 상태가 아닙니다.");

  const model = await db.prepare("SELECT id, model_id, enabled, input_neurons_per_m, output_neurons_per_m, unit_neurons FROM ai_models WHERE model_id = ?").bind(body.model).first<{ id: string; model_id: string; enabled: number; input_neurons_per_m: number | null; output_neurons_per_m: number | null; unit_neurons: number | null }>();
  if (!model || !model.enabled) return fail(404, "model_not_found", "사용할 수 없는 모델입니다.");
  const access = await db.prepare("SELECT a.subscription_id AS sid FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND a.model_id = ? AND s.status IN ('active','canceling','past_due') LIMIT 1").bind(key.customer_id, model.id).first<{ sid: string }>();
  if (!access) return fail(403, "no_subscription", "이 모델의 CAS 구독이 없거나 활성 상태가 아닙니다.");
  const price = await currentPrice(db, model.id);
  if (!price) return fail(503, "not_priced", "가격이 설정되지 않은 모델입니다.");

  const since = nowIso(o.nowMs - 60_000);
  const rate = await db.prepare("SELECT COUNT(*) AS c FROM ai_usage_records WHERE api_key_id = ? AND ts > ?").bind(key.id, since).first<{ c: number }>();
  if ((rate?.c ?? 0) >= key.r) return fail(429, "rate_limited", `분당 요청 제한(${key.r})을 초과했습니다.`);

  const monthStart = new Date(o.nowMs); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  if (key.cap !== null) {
    const spent = await db.prepare("SELECT COALESCE(SUM(billed_micro),0) AS s FROM ai_usage_records WHERE api_key_id = ? AND ts >= ?").bind(key.id, nowIso(monthStart.getTime())).first<{ s: number }>();
    if ((spent?.s ?? 0) >= key.cap) return fail(429, "monthly_cap", "이 키의 월 비용 상한에 도달했습니다.");
  }
  // 최악 비용(최대 출력 토큰 가정)을 잔액이 감당할 때만 실행한다. 실제 차감은 사용량 기준.
  const maxOut = Math.min(Math.max(o.maxOutputTokens ?? 2048, 1), 32768);
  const worstNeurons = estimateNeurons(model, { inputTokens: JSON.stringify(body.input).length, outputTokens: maxOut, units: 1 });
  const balance = await creditBalance(db, key.customer_id);
  if (balance < sellMicro(worstNeurons, price.sell_per_1k_micro)) return fail(402, "insufficient_credit", "크레딧이 부족합니다. 충전 후 다시 시도하세요.");

  let out;
  try { out = await runner.run(model.model_id, body.input as Record<string, unknown>); }
  catch (e) { return fail(502, "upstream_error", "AI 실행에 실패했습니다(과금되지 않았습니다)."); }

  const neurons = estimateNeurons(model, out.usage);
  const billed = sellMicro(neurons, price.sell_per_1k_micro);
  await db.batch([
    db.prepare("INSERT INTO ai_usage_records(id,subscription_id,api_key_id,model_id,request_id,neurons,input_tokens,output_tokens,cost_micro,billed_micro,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(newId("aiu"), access.sid, key.id, model.id, o.requestId, neurons, out.usage.inputTokens ?? null, out.usage.outputTokens ?? null, costMicro(neurons), billed, nowIso(o.nowMs)),
    db.prepare("INSERT OR IGNORE INTO ai_credit_ledger(id,customer_id,kind,amount_micro,ref,created_at) VALUES(?,?,'usage',?,?,?)").bind(newId("led"), key.customer_id, -billed, `use:${o.requestId}`, nowIso(o.nowMs)),
    db.prepare("UPDATE ai_api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(o.nowMs), key.id),
  ]);
  await detectAnomaly(db, key.id, key.customer_id, o.nowMs);
  return { ok: true, result: out.result, usage: out.usage, neurons, billedMicro: billed, balanceMicro: balance - billed };
}

/** 이상 사용 감지: 10분 안의 판매 금액이 임계값(기본 $20)을 넘으면 키를 자동 차단하고 운영자에게 알린다. */
export async function detectAnomaly(db: D1Like, keyId: string, customerId: string, nowMs: number): Promise<boolean> {
  const th = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cas_anomaly_micro_10m'").first<{ value_json: string }>();
  const limit = th ? Number(th.value_json) : 20_000_000;
  const s = await db.prepare("SELECT COALESCE(SUM(billed_micro),0) AS s FROM ai_usage_records WHERE api_key_id = ? AND ts > ?").bind(keyId, nowIso(nowMs - 600_000)).first<{ s: number }>();
  if ((s?.s ?? 0) <= limit) return false;
  const r = await db.prepare("UPDATE ai_api_keys SET status='blocked' WHERE id=? AND status='active'").bind(keyId).run();
  if (r.meta.changes === 0) return false; // 이미 차단됨: 알림 중복 방지
  await db.batch([
    db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", "AI 키 자동 차단", `키 ${keyId} 가 10분 안에 임계 금액을 초과해 차단되었습니다.`, nowIso(nowMs)),
    db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), customerId, "warning", "AI API 키가 차단되었습니다", "비정상적으로 빠른 사용이 감지되어 키를 차단했습니다. 지원팀에 문의하세요.", nowIso(nowMs)),
  ]);
  return true;
}

export const microFromPaypal = (v: string | number) => valueToCents(v) * 10_000;
