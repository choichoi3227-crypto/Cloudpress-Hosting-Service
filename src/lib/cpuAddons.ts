import { type D1Like, newId, nowIso } from "./db";
import type { PayPalPort } from "./paypal.client";
import { OFFICIAL_INSTANCE_TYPES, type InstanceType } from "./catalog";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

/** 초기 판매가(USD micro). 관리자 설정(admin_settings.cpu_addon_policy)으로 덮어쓸 수 있다. Cloudflare 원가가 아니다. */
export interface CpuAddonPolicy {
  /** 추가 vCPU 개수 → 월 가격(micro USD) */
  prices: Record<string, number>;
  /** 한 서비스에 붙일 수 있는 추가 vCPU 합계 상한 */
  maxTotalAddVcpu: number;
  /** 추가 CPU 를 허용할 상품 종류 */
  allowedKinds: string[];
  /** 허용 인스턴스 사양(공식 지원 사양 안에서만) */
  allowedInstances: InstanceType[];
  /** 중간 증설 일할 계산 여부. PayPal 정기결제는 일할 청구가 불가능해 false 로 고정(true 는 거부). */
  prorate: boolean;
}
export const SEED_CPU_POLICY: CpuAddonPolicy = {
  prices: { "1": 6_990_000, "2": 12_990_000, "4": 23_990_000, "8": 43_990_000 },
  maxTotalAddVcpu: 8,
  allowedKinds: ["ccs", "wordpress", "cloudb", "cloudb_pg"],
  allowedInstances: ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"],
  prorate: false,
};

export async function loadCpuPolicy(db: D1Like): Promise<CpuAddonPolicy> {
  const r = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cpu_addon_policy'").first<{ value_json: string }>();
  if (!r) return SEED_CPU_POLICY;
  try { return { ...SEED_CPU_POLICY, ...(JSON.parse(r.value_json) as Partial<CpuAddonPolicy>) }; } catch { return SEED_CPU_POLICY; }
}

/** 관리자 설정 저장. 값 검증 후 저장하고 감사 로그를 남긴다. */
export async function saveCpuPolicy(db: D1Like, actorId: string, input: Partial<CpuAddonPolicy>, nowMs: number): Promise<CpuAddonPolicy> {
  const cur = await loadCpuPolicy(db);
  const next: CpuAddonPolicy = { ...cur, ...input, prices: { ...cur.prices, ...(input.prices ?? {}) } };
  for (const [k, v] of Object.entries(next.prices)) {
    if (!/^[1-9]\d*$/.test(k) || !Number.isInteger(v) || v <= 0 || v % 10_000 !== 0) throw new ServiceError("bad_policy", `가격 항목이 올바르지 않음: ${k}`);
  }
  if (!Number.isInteger(next.maxTotalAddVcpu) || next.maxTotalAddVcpu < 0 || next.maxTotalAddVcpu > 64) throw new ServiceError("bad_policy", "최대 추가량이 올바르지 않음");
  if (next.allowedInstances.some((i) => !(i in OFFICIAL_INSTANCE_TYPES))) throw new ServiceError("bad_policy", "공식 지원하지 않는 인스턴스 사양이 포함됨");
  if (next.prorate) throw new ServiceError("bad_policy", "PayPal 정기결제는 중간 증설 일할 청구를 지원하지 않습니다.");
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cpu_addon_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at")
    .bind(JSON.stringify(next), actorId, nowIso(nowMs)).run();
  await audit(db, { actorId, action: "admin.cpu_policy_update", detail: next }, nowMs);
  return next;
}

/**
 * 기본 사양(base)에 추가 vCPU 를 더했을 때 공식 지원 인스턴스 중 충족하는 가장 작은 사양을 고른다.
 * 없으면 null. Cloudflare Containers 는 임의 CPU 수를 지원하지 않으므로 사양이 정해진 인스턴스로만 올릴 수 있다.
 */
export function resolveInstance(base: InstanceType, totalAddVcpu: number, allowed: InstanceType[] = Object.keys(OFFICIAL_INSTANCE_TYPES) as InstanceType[]): InstanceType | null {
  const need = OFFICIAL_INSTANCE_TYPES[base].vcpu + totalAddVcpu;
  const c = (Object.entries(OFFICIAL_INSTANCE_TYPES) as [InstanceType, { vcpu: number }][])
    .filter(([t, v]) => allowed.includes(t) && v.vcpu >= need - 1e-9)
    .sort((a, b) => a[1].vcpu - b[1].vcpu || (OFFICIAL_INSTANCE_TYPES[a[0]].memoryMiB - OFFICIAL_INSTANCE_TYPES[b[0]].memoryMiB));
  return c[0]?.[0] ?? null;
}

interface Target { containerId: string; subId: string; base: InstanceType; current: InstanceType; kind: string }
async function loadTarget(db: D1Like, userId: string, subId: string): Promise<Target> {
  const r = await db.prepare(`SELECT s.id AS sid, s.status, p.kind, p.instance_type AS base, c.id AS cid, c.instance_type AS cur
    FROM subscriptions s JOIN products p ON p.id = s.product_id LEFT JOIN containers c ON c.subscription_id = s.id AND c.deleted_at IS NULL
    WHERE s.id = ? AND s.customer_id = ?`).bind(subId, userId).first<{ sid: string; status: string; kind: string; base: string | null; cid: string | null; cur: string | null }>();
  if (!r) throw new ServiceError("not_found", "서비스를 찾을 수 없습니다.");
  if (r.status !== "active") throw new ServiceError("bad_state", "이용 중인 서비스에만 추가 CPU 를 구매할 수 있습니다.");
  if (!r.base || !(r.base in OFFICIAL_INSTANCE_TYPES)) throw new ServiceError("unsupported_product", "이 상품은 추가 CPU 를 지원하지 않습니다.");
  if (!r.cid || !r.cur) throw new ServiceError("no_container", "컨테이너가 아직 생성되지 않았습니다. 생성이 끝난 뒤 다시 시도하세요.");
  return { containerId: r.cid, subId: r.sid, base: r.base as InstanceType, current: r.cur as InstanceType, kind: r.kind };
}

export interface CpuQuote { addVcpu: number; monthlyMicro: number; fromInstance: InstanceType; toInstance: InstanceType; totalAddVcpu: number;
  resulting: { vcpu: number; memoryMiB: number; diskGB: number }; note: string }

/** 구매 가능 여부와 결과 사양을 서버에서 계산한다. 지원되지 않는 조합은 안전하게 거부한다. */
export async function quoteCpuAddon(db: D1Like, userId: string, subId: string, addVcpu: number): Promise<CpuQuote & { containerId: string }> {
  const policy = await loadCpuPolicy(db);
  const price = policy.prices[String(addVcpu)];
  if (!Number.isInteger(addVcpu) || price === undefined) throw new ServiceError("bad_tier", `판매하지 않는 추가 CPU 수량입니다. 가능: ${Object.keys(policy.prices).join(", ")}`);
  const t = await loadTarget(db, userId, subId);
  if (!policy.allowedKinds.includes(t.kind)) throw new ServiceError("unsupported_product", "이 상품은 추가 CPU 를 지원하지 않습니다.");
  const existing = await db.prepare("SELECT COALESCE(SUM(add_vcpu),0) AS s FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'paid' AND cancel_at_period_end = 0").bind(subId).first<{ s: number }>();
  const total = (existing?.s ?? 0) + addVcpu;
  if (total > policy.maxTotalAddVcpu) throw new ServiceError("limit_exceeded", `추가 vCPU 합계는 최대 ${policy.maxTotalAddVcpu} 입니다.`);
  const to = resolveInstance(t.base, total, policy.allowedInstances);
  if (!to) throw new ServiceError("unsupported_spec", "요청한 CPU 를 제공하는 공식 지원 인스턴스 사양이 없습니다(Cloudflare Containers 최대 4 vCPU).");
  const spec = OFFICIAL_INSTANCE_TYPES[to];
  return { containerId: t.containerId, addVcpu, monthlyMicro: price, fromInstance: t.current, toInstance: to, totalAddVcpu: total,
    resulting: { vcpu: spec.vcpu, memoryMiB: spec.memoryMiB, diskGB: spec.diskGB },
    note: "Cloudflare 인스턴스 사양은 CPU·메모리·디스크가 함께 정해집니다. CPU 를 올리면 메모리·디스크도 해당 사양 값으로 바뀝니다." };
}

async function ensureCpuPlan(db: D1Like, paypal: PayPalPort, addVcpu: number, monthlyMicro: number, nowMs: number): Promise<string> {
  const ex = await db.prepare("SELECT paypal_plan_id AS p FROM cpu_addon_plans WHERE add_vcpu = ? AND monthly_micro = ?").bind(addVcpu, monthlyMicro).first<{ p: string }>();
  if (ex) return ex.p;
  const { planId } = await paypal.createMonthlyPlan({ name: `CloudPress 추가 CPU +${addVcpu} vCPU`, currency: "USD", amountMinor: monthlyMicro / 10_000, customId: `cpu:${addVcpu}` }, `cpuplan:${addVcpu}:${monthlyMicro}`);
  await db.prepare("INSERT OR IGNORE INTO cpu_addon_plans(add_vcpu,monthly_micro,paypal_plan_id,created_at) VALUES(?,?,?,?)").bind(addVcpu, monthlyMicro, planId, nowIso(nowMs)).run();
  return (await db.prepare("SELECT paypal_plan_id AS p FROM cpu_addon_plans WHERE add_vcpu = ? AND monthly_micro = ?").bind(addVcpu, monthlyMicro).first<{ p: string }>())!.p;
}

/** 구매 시작: 결제 대기(pending) 추가 CPU 를 만들고 PayPal 승인 URL 을 돌려준다. 결제 확정과 적용은 웹훅 → 작업 큐에서 한다. */
export async function purchaseCpuAddon(db: D1Like, paypal: PayPalPort, userId: string, subId: string, addVcpu: number, ctx: { appOrigin: string; nowMs: number }) {
  const q = await quoteCpuAddon(db, userId, subId, addVcpu);
  const pending = await db.prepare("SELECT id FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'pending' AND created_at > ?").bind(subId, nowIso(ctx.nowMs - 24 * 3_600_000)).first();
  if (pending) throw new ServiceError("pending_exists", "결제 대기 중인 추가 CPU 가 있습니다. 완료하거나 24시간 후 다시 시도하세요.");
  const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  const planId = await ensureCpuPlan(db, paypal, addVcpu, q.monthlyMicro, ctx.nowMs);
  const id = newId("cpu");
  const s = await paypal.createSubscription({ planId, customId: `cpu:${id}`, email: user!.email,
    returnUrl: `${ctx.appOrigin}/services/${encodeURIComponent(subId)}?cpu=success`, cancelUrl: `${ctx.appOrigin}/services/${encodeURIComponent(subId)}?cpu=cancel` }, `cpu:${id}`);
  await db.prepare("INSERT INTO cpu_addons(id,subscription_id,container_id,from_instance_type,to_instance_type,add_vcpu,monthly_micro,paypal_plan_id,paypal_subscription_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(id, subId, q.containerId, q.fromInstance, q.toInstance, addVcpu, q.monthlyMicro, planId, s.id, nowIso(ctx.nowMs)).run();
  await audit(db, { actorId: userId, action: "cpu_addon.purchase_start", targetType: "cpu_addon", targetId: id, detail: { subId, addVcpu } }, ctx.nowMs);
  return { id, url: s.approveUrl, quote: q };
}

/** 결제 확정 후 적용 작업을 만든다(중복 방지 키 포함). 구매 성공과 적용 성공은 별개 상태. */
export function enqueueResize(db: D1Like, subId: string, containerId: string, reason: string, nowMs: number) {
  return db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(newId("job"), "cpu_resize", subId, `cpu_resize:${containerId}:${reason}`, JSON.stringify({ containerId }), nowIso(nowMs), nowIso(nowMs));
}

/** 컨테이너가 가져야 할 인스턴스 사양 = 기본 사양 + 결제 유지 중인 추가 CPU 합계. */
export async function desiredInstance(db: D1Like, containerId: string): Promise<{ subId: string; instance: InstanceType; current: InstanceType } | null> {
  const r = await db.prepare(`SELECT c.subscription_id AS sid, c.instance_type AS cur, p.instance_type AS base FROM containers c JOIN subscriptions s ON s.id = c.subscription_id JOIN products p ON p.id = s.product_id WHERE c.id = ? AND c.deleted_at IS NULL`).bind(containerId).first<{ sid: string; cur: string; base: string }>();
  if (!r) return null;
  const sum = await db.prepare("SELECT COALESCE(SUM(add_vcpu),0) AS s FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'paid'").bind(r.sid).first<{ s: number }>();
  const inst = resolveInstance(r.base as InstanceType, sum?.s ?? 0);
  if (!inst) throw new Error("no_supported_instance_for_total_cpu");
  return { subId: r.sid, instance: inst, current: r.cur as InstanceType };
}

/** 결제 대기 24시간 초과 정리 + 취소 예약(기간 종료) 추가 CPU 를 해지하고 축소 작업을 만든다. */
export async function finalizeCpuAddons(db: D1Like, nowMs: number): Promise<{ expired: number; cancelled: number }> {
  const ex = await db.prepare("UPDATE cpu_addons SET purchase_status='cancelled' WHERE purchase_status='pending' AND created_at < ?").bind(nowIso(nowMs - 24 * 3_600_000)).run();
  const { results } = await db.prepare("SELECT id, subscription_id AS sid, container_id AS cid FROM cpu_addons WHERE purchase_status='paid' AND cancel_at_period_end=1 AND current_period_end IS NOT NULL AND current_period_end <= ?").bind(nowIso(nowMs)).all<{ id: string; sid: string; cid: string }>();
  for (const a of results) {
    await db.batch([
      db.prepare("UPDATE cpu_addons SET purchase_status='cancelled', apply_status='not_started' WHERE id=? AND purchase_status='paid'").bind(a.id),
      enqueueResize(db, a.sid, a.cid, `downsize:${a.id}`, nowMs),
    ]);
  }
  return { expired: ex.meta.changes, cancelled: results.length };
}
