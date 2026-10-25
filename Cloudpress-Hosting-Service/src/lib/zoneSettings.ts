/**
 * 고객이 변경할 수 있는 Cloudflare 영역 설정·규칙 카탈로그.
 * 영역은 운영 계정에 있으므로 플랫폼 보안 정책에 맞는 값만 허용하고(예: 취약한 TLS·SSL 끔 금지),
 * 요금제별 규칙 수 한도를 로컬에서 먼저 검사해 불필요한 API 호출·오류를 줄인다.
 */
export interface SettingDef { key: string; label: string; risk: "low" | "medium" | "high"; validate: (v: unknown) => boolean; kind: "zone_setting" | "dnssec" }

const oneOf = (...vals: string[]) => (v: unknown) => typeof v === "string" && vals.includes(v);
const onOff = oneOf("on", "off");
const BROWSER_TTLS = new Set([0, 30, 60, 120, 300, 1200, 1800, 3600, 7200, 10800, 14400, 18000, 28800, 43200, 57600, 72000, 86400, 172800, 259200, 345600, 432000, 691200, 1382400, 2073600, 2678400, 5356800, 16070400, 31536000]);

export const SETTINGS: Record<string, SettingDef> = Object.fromEntries(([
  ["ssl", "SSL/TLS 모드", "high", oneOf("full", "strict")], // off/flexible 은 플랫폼 정책상 금지
  ["always_use_https", "항상 HTTPS 사용", "low", onOff],
  ["min_tls_version", "최소 TLS 버전", "medium", oneOf("1.2", "1.3")], // 1.0/1.1 금지
  ["tls_1_3", "TLS 1.3", "low", oneOf("on", "off", "zrt")],
  ["automatic_https_rewrites", "자동 HTTPS 재작성", "low", onOff],
  ["http3", "HTTP/3(QUIC)", "low", onOff],
  ["brotli", "Brotli 압축", "low", onOff],
  ["early_hints", "Early Hints", "low", onOff],
  ["0rtt", "0-RTT", "medium", onOff],
  ["ipv6", "IPv6", "low", onOff],
  ["websockets", "WebSockets", "low", onOff],
  ["opportunistic_encryption", "기회적 암호화", "low", onOff],
  ["browser_cache_ttl", "브라우저 캐시 TTL(초)", "low", (v) => typeof v === "number" && BROWSER_TTLS.has(v)],
  ["cache_level", "캐시 수준", "medium", oneOf("basic", "simplified", "aggressive")],
  ["security_level", "보안 수준", "medium", oneOf("low", "medium", "high", "under_attack")],
  ["challenge_ttl", "챌린지 통과 유지 시간(초)", "low", (v) => typeof v === "number" && [300, 900, 1800, 2700, 3600, 7200, 10800, 14400, 28800, 57600, 86400].includes(v)],
  ["browser_check", "브라우저 무결성 검사", "low", onOff],
  ["email_obfuscation", "이메일 주소 난독화", "low", onOff],
  ["hotlink_protection", "핫링크 보호", "low", onOff],
  ["rocket_loader", "Rocket Loader", "medium", onOff], // WordPress 에서 깨질 수 있어 중간 위험
  ["development_mode", "개발 모드(3시간 캐시 우회)", "low", onOff],
] as [string, string, SettingDef["risk"], SettingDef["validate"]][]).map(([key, label, risk, validate]) => [key, { key, label, risk, validate, kind: "zone_setting" } satisfies SettingDef]));
SETTINGS["dnssec"] = { key: "dnssec", label: "DNSSEC", risk: "medium", validate: oneOf("active", "disabled"), kind: "dnssec" };

export type SettingsPatch = Record<string, unknown>;
export interface SettingsPlan { changes: { key: string; value: unknown }[]; rejected: { key: string; reason: string }[]; unchanged: string[] }

/** 현재 값과 비교해 실제로 바뀌는 항목만 API 호출 대상으로 만든다(호출 최소화). */
export function planSettings(current: SettingsPatch, desired: SettingsPatch): SettingsPlan {
  const out: SettingsPlan = { changes: [], rejected: [], unchanged: [] };
  for (const [key, value] of Object.entries(desired)) {
    const def = SETTINGS[key];
    if (!def) { out.rejected.push({ key, reason: "허용되지 않는 설정" }); continue; }
    if (!def.validate(value)) { out.rejected.push({ key, reason: "허용되지 않는 값" }); continue; }
    if (current[key] === value) out.unchanged.push(key); else out.changes.push({ key, value });
  }
  return out;
}

/** 용도별 권장 프리셋. */
export const PRESETS: Record<string, SettingsPatch> = {
  wordpress: { ssl: "strict", always_use_https: "on", min_tls_version: "1.2", tls_1_3: "on", automatic_https_rewrites: "on", http3: "on", brotli: "on", early_hints: "on", rocket_loader: "off", browser_cache_ttl: 14400, security_level: "medium" },
  static_site: { ssl: "strict", always_use_https: "on", min_tls_version: "1.2", http3: "on", brotli: "on", early_hints: "on", cache_level: "aggressive", browser_cache_ttl: 86400 },
  api: { ssl: "strict", always_use_https: "on", min_tls_version: "1.3", http3: "on", brotli: "on", cache_level: "basic", browser_check: "off", rocket_loader: "off", websockets: "on" },
};

/* ── 규칙(Rulesets) ── */
export const RULE_PHASES = {
  http_request_cache_settings: { label: "캐시 규칙", actions: ["set_cache_settings"] },
  http_request_dynamic_redirect: { label: "리디렉션 규칙", actions: ["redirect"] },
  http_request_firewall_custom: { label: "WAF 사용자 지정 규칙", actions: ["block", "challenge", "managed_challenge", "js_challenge", "log"] },
  http_ratelimit: { label: "속도 제한 규칙", actions: ["block", "challenge", "managed_challenge", "log"] },
  http_request_transform: { label: "URL 재작성", actions: ["rewrite"] },
  http_request_late_transform: { label: "요청 헤더 변환", actions: ["rewrite"] },
  http_response_headers_transform: { label: "응답 헤더 변환", actions: ["rewrite"] },
  http_config_settings: { label: "구성 규칙", actions: ["set_config"] },
} as const;
export type RulePhase = keyof typeof RULE_PHASES;

/** 요금제별 규칙 수 한도. 값은 공식 한도 확인 전 보수적 시드이며 관리자 설정으로 덮어쓴다. */
export const SEED_RULE_QUOTAS: Record<RulePhase, number> = {
  http_request_cache_settings: 10, http_request_dynamic_redirect: 10, http_request_firewall_custom: 5, http_ratelimit: 1,
  http_request_transform: 10, http_request_late_transform: 10, http_response_headers_transform: 10, http_config_settings: 10,
};

export interface RuleInput { expression: string; action: string; description?: string; enabled?: boolean; action_parameters?: Record<string, unknown> }

export function validateRule(phase: string, r: RuleInput, existingInPhase: number, quotas = SEED_RULE_QUOTAS): string | null {
  const p = RULE_PHASES[phase as RulePhase];
  if (!p) return "허용되지 않는 규칙 단계";
  if (existingInPhase >= quotas[phase as RulePhase]) return `${p.label}은 최대 ${quotas[phase as RulePhase]}개`;
  if (!(p.actions as readonly string[]).includes(r.action)) return `${p.label}에서 허용되지 않는 동작: ${r.action}`;
  if (typeof r.expression !== "string" || r.expression.trim().length === 0 || r.expression.length > 4096) return "표현식은 1~4096자";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.expression)) return "표현식에 제어 문자 불가";
  if (r.description !== undefined && r.description.length > 200) return "설명은 200자 이하";
  if (JSON.stringify(r.action_parameters ?? {}).length > 8192) return "동작 매개변수가 너무 큼";
  return null;
}
