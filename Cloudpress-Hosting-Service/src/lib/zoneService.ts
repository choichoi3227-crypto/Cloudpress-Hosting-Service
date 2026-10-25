import { type D1Like, newId, nowIso } from "./db";
import { normalizeHostname, isApexDomain } from "./domainNames";
import { validateRecord, checkConflicts, type DnsRecord, type DnsRecordInput } from "./dnsRecords";
import { planSettings, validateRule, SEED_RULE_QUOTAS, type RulePhase, type RuleInput, type SettingsPatch, SETTINGS } from "./zoneSettings";
import type { ZonesPort } from "./zones";
import { audit } from "./auth";

export class ServiceError extends Error { constructor(public code: string, message: string) { super(message); } }
export interface ZoneRow { id: string; customer_id: string; hostname: string; cf_zone_id: string; status: string; origin: string; name_servers_json: string; created_at: string; activation_checks: number }

/** 소유 영역 조회. 다른 고객의 영역은 존재 여부도 알 수 없게 not_found 로 응답한다. */
export async function getOwnedZone(db: D1Like, customerId: string, zoneId: string): Promise<ZoneRow> {
  const z = await db.prepare("SELECT id,customer_id,hostname,cf_zone_id,status,origin,name_servers_json,created_at,activation_checks FROM dns_zones WHERE id = ? AND customer_id = ? AND status <> 'deleted'").bind(zoneId, customerId).first<ZoneRow>();
  if (!z) throw new ServiceError("not_found", "영역을 찾을 수 없음");
  return z;
}

export const NS_INSTRUCTIONS = "도메인을 구입한 등록기관의 네임서버를 아래 값으로 변경하세요. 전파에는 최대 24~48시간이 걸릴 수 있습니다. 변경이 확인되면 자동으로 활성화됩니다.";

/**
 * 기존 도메인 연결(전체 영역/네임서버 방식). 운영 계정에 이미 있는 영역(운영자 본인 도메인 포함)은 절대 가져가지 못하게 거부한다.
 */
export async function connectDomain(db: D1Like, zones: ZonesPort, customerId: string, rawHostname: string, nowMs: number) {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname) throw new ServiceError("invalid_hostname", "올바른 도메인 이름이 아님");
  if (!isApexDomain(hostname)) throw new ServiceError("not_apex", "루트 도메인(example.com)만 연결할 수 있음. 서브도메인은 별도 방식으로 연결합니다.");
  const dup = await db.prepare("SELECT 1 AS x FROM dns_zones WHERE hostname = ? AND status <> 'deleted'").bind(hostname).first();
  if (dup) throw new ServiceError("already_connected", "이미 연결된 도메인");
  if (await zones.findZone(hostname)) throw new ServiceError("domain_in_platform_account", "이 도메인은 플랫폼 계정에 이미 존재하여 연결할 수 없음. 지원팀에 문의하세요.");
  const z = await zones.createZone(hostname);
  const id = newId("zon");
  try {
    await db.prepare("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin,status,name_servers_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, customerId, hostname, z.id, "connected", "pending_nameservers", JSON.stringify(z.nameServers), nowIso(nowMs)).run();
  } catch (e) {
    await zones.deleteZone(z.id).catch(() => {}); // DB 실패 시 고아 영역 정리
    throw e;
  }
  await audit(db, { actorId: customerId, action: "domain.connect", targetType: "dns_zone", targetId: id, detail: { hostname } }, nowMs);
  return { zoneId: id, hostname, nameServers: z.nameServers, instructions: NS_INSTRUCTIONS };
}

/** 활성화 확인 간격: 호출 낭비를 막기 위해 점점 늘린다(분). 7일 넘게 미활성이면 정리 대상. */
export const ACTIVATION_DELAYS_MIN = [5, 15, 60, 180, 360, 720, 1440];
export const nextActivationDelayMin = (checks: number) => ACTIVATION_DELAYS_MIN[Math.min(checks, ACTIVATION_DELAYS_MIN.length - 1)]!;
export const PENDING_ZONE_TTL_DAYS = 7;

export async function checkActivation(db: D1Like, zones: ZonesPort, z: ZoneRow, nowMs: number): Promise<"active" | "pending" | "expired"> {
  if (z.status === "active") return "active";
  const info = await zones.getZone(z.cf_zone_id);
  if (info.status === "active") {
    await db.prepare("UPDATE dns_zones SET status='active', activated_at=?, last_checked_at=?, activation_checks=activation_checks+1 WHERE id=?").bind(nowIso(nowMs), nowIso(nowMs), z.id).run();
    return "active";
  }
  if (nowMs - Date.parse(z.created_at) > PENDING_ZONE_TTL_DAYS * 86_400_000) {
    await zones.deleteZone(z.cf_zone_id); // 플랫폼 계정의 영역 한도를 낭비하지 않도록 방치된 영역 삭제
    await db.prepare("UPDATE dns_zones SET status='deleted', last_checked_at=? WHERE id=?").bind(nowIso(nowMs), z.id).run();
    return "expired";
  }
  await zones.recheckActivation(z.cf_zone_id);
  await db.prepare("UPDATE dns_zones SET last_checked_at=?, activation_checks=activation_checks+1 WHERE id=?").bind(nowIso(nowMs), z.id).run();
  return "pending";
}

const MAX_RECORDS = 200;

export async function addRecord(db: D1Like, zones: ZonesPort, customerId: string, zoneId: string, input: DnsRecordInput, nowMs: number, maxRecords = MAX_RECORDS) {
  const z = await getOwnedZone(db, customerId, zoneId);
  const v = validateRecord(z.hostname, input);
  if (!v.ok) throw new ServiceError("invalid_record", v.error);
  const { results } = await db.prepare("SELECT cf_record_id AS id,type,name,content,ttl,proxied,priority FROM dns_records WHERE zone_id = ?").bind(z.id).all<{ id: string; type: DnsRecord["type"]; name: string; content: string; ttl: number; proxied: number; priority: number | null }>();
  const existing: DnsRecord[] = results.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied === 1, ...(r.priority !== null ? { priority: r.priority } : {}) }));
  const conflict = checkConflicts(existing, v.record, maxRecords);
  if (conflict) throw new ServiceError("conflict", conflict);
  const cfId = await zones.createRecord(z.cf_zone_id, v.record);
  await db.prepare("INSERT INTO dns_records(id,zone_id,cf_record_id,type,name,content,ttl,proxied,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(newId("rec"), z.id, cfId, v.record.type, v.record.name, v.record.content, v.record.ttl, v.record.proxied ? 1 : 0, v.record.priority ?? null, nowIso(nowMs)).run();
  await audit(db, { actorId: customerId, action: "dns.add", targetType: "dns_zone", targetId: z.id, detail: { type: v.record.type, name: v.record.name } }, nowMs);
  return { cfRecordId: cfId, record: v.record };
}

export async function deleteRecord(db: D1Like, zones: ZonesPort, customerId: string, zoneId: string, cfRecordId: string, nowMs: number) {
  const z = await getOwnedZone(db, customerId, zoneId);
  const r = await db.prepare("SELECT 1 AS x FROM dns_records WHERE zone_id = ? AND cf_record_id = ?").bind(z.id, cfRecordId).first();
  if (!r) throw new ServiceError("not_found", "레코드를 찾을 수 없음");
  await zones.deleteRecord(z.cf_zone_id, cfRecordId);
  await db.prepare("DELETE FROM dns_records WHERE zone_id = ? AND cf_record_id = ?").bind(z.id, cfRecordId).run();
  await audit(db, { actorId: customerId, action: "dns.delete", targetType: "dns_zone", targetId: z.id, detail: { cfRecordId } }, nowMs);
}

/** 설정 적용: 허용된 값만, 실제로 바뀌는 항목만 호출한다. 부분 실패 시 성공한 항목만 기록하고 실패 목록을 반환한다. */
export async function applySettings(db: D1Like, zones: ZonesPort, customerId: string, zoneId: string, desired: SettingsPatch, nowMs: number) {
  const z = await getOwnedZone(db, customerId, zoneId);
  if (z.status !== "active") throw new ServiceError("zone_not_active", "네임서버 변경이 확인된 후에 설정할 수 있음");
  const { results } = await db.prepare("SELECT setting_key AS k, value_json AS v FROM zone_settings WHERE zone_id = ?").bind(z.id).all<{ k: string; v: string }>();
  const current = Object.fromEntries(results.map((r) => [r.k, JSON.parse(r.v)]));
  const plan = planSettings(current, desired);
  const applied: string[] = [];
  const failed: { key: string; reason: string }[] = [];
  for (const { key, value } of plan.changes) {
    try {
      if (SETTINGS[key]!.kind === "dnssec") await zones.setDnssec(z.cf_zone_id, value as "active" | "disabled");
      else await zones.setSetting(z.cf_zone_id, key, value);
      await db.prepare("INSERT INTO zone_settings(zone_id,setting_key,value_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(zone_id,setting_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
        .bind(z.id, key, JSON.stringify(value), nowIso(nowMs)).run();
      applied.push(key);
    } catch (e) { failed.push({ key, reason: e instanceof Error ? e.message : "오류" }); }
  }
  await audit(db, { actorId: customerId, action: "zone.settings", targetType: "dns_zone", targetId: z.id, detail: { applied, rejected: plan.rejected.map((r) => r.key) } }, nowMs);
  return { applied, unchanged: plan.unchanged, rejected: plan.rejected, failed };
}

/** 규칙 교체(단계별 전체 목록). 각 규칙을 검증하고 단계별 한도를 지킨다. */
export async function replaceRules(db: D1Like, zones: ZonesPort, customerId: string, zoneId: string, phase: string, rules: RuleInput[], nowMs: number, quotas = SEED_RULE_QUOTAS) {
  const z = await getOwnedZone(db, customerId, zoneId);
  if (z.status !== "active") throw new ServiceError("zone_not_active", "네임서버 변경이 확인된 후에 설정할 수 있음");
  for (let i = 0; i < rules.length; i++) {
    const err = validateRule(phase, rules[i]!, i, quotas);
    if (err) throw new ServiceError("invalid_rule", `규칙 ${i + 1}: ${err}`);
  }
  await zones.putRules(z.cf_zone_id, phase as RulePhase, rules);
  await db.batch([
    db.prepare("DELETE FROM zone_rules WHERE zone_id = ? AND phase = ?").bind(z.id, phase),
    ...rules.map((r, i) => db.prepare("INSERT INTO zone_rules(id,zone_id,phase,position,rule_json,created_at) VALUES(?,?,?,?,?,?)").bind(newId("rul"), z.id, phase, i, JSON.stringify(r), nowIso(nowMs))),
  ]);
  await audit(db, { actorId: customerId, action: "zone.rules", targetType: "dns_zone", targetId: z.id, detail: { phase, count: rules.length } }, nowMs);
  return { phase, count: rules.length };
}
