import { type D1Like, newId, nowIso } from "./db";
import { ServiceError } from "./zoneService";
import { audit } from "./auth";

/* ═══════════ 조직 정의(시드) ═══════════ */

export type Rank = "executive" | "director" | "senior" | "junior";
export const RANK_LEVEL: Record<Rank, number> = { executive: 4, director: 3, senior: 2, junior: 1 };
export const RANK_KO: Record<Rank, string> = { executive: "임원", director: "팀장", senior: "선임", junior: "사원" };

const DEPTS: { id: string; name: string; mission: string }[] = [
  { id: "strategy", name: "경영전략실", mission: "회사 목표(OKR) 수립과 부서 간 우선순위 조율, 일일 경영 브리핑" },
  { id: "engineering", name: "제품·개발팀", mission: "기능 개선안, 기술부채·테스트 품질 관리, 버그 분석" },
  { id: "infra", name: "인프라·SRE팀", mission: "서비스 안정성, 작업 큐·웹훅·컨테이너 상태 점검과 장애 대응안" },
  { id: "security", name: "보안팀", mission: "이상 사용·권한·비밀정보 관리 점검, 보안 위험 평가" },
  { id: "support", name: "고객지원팀", mission: "결제 실패·문의 대응안 작성, 고객 경험 개선" },
  { id: "growth", name: "마케팅·성장팀", mission: "비용이 들지 않는 채널 중심의 고객 확보 실험 설계" },
  { id: "finance", name: "재무·수익성팀", mission: "매출·원가·수수료·기여이익 분석, 가격 정책 위험 경고" },
  { id: "legal", name: "법무·컴플라이언스팀", mission: "약관·개인정보·결제/클라우드 사업자 정책 준수 점검" },
  { id: "data", name: "데이터·분석팀", mission: "핵심 지표 추세 분석과 이상 징후 보고" },
];

const NAMES: Record<string, [string, string, string]> = {
  strategy: ["하늘", "바다", "나래"], engineering: ["도윤", "서준", "지호"], infra: ["하람", "이든", "시우"], security: ["여울", "라온", "다온"],
  support: ["새봄", "아라", "보람"], growth: ["가온", "누리", "슬기"], finance: ["다솜", "한결", "미르"], legal: ["온유", "해든", "은솔"], data: ["별이", "이레", "소담"],
};

export const COMMON_RULES = `업무 원칙:
1) 돈을 쓰거나, 배포하거나, 가격을 바꾸거나, 고객에게 연락하거나, 계약·법적 조치를 하는 등 "실제 행동"은 절대 직접 실행하지 않는다. 필요하면 proposed_actions 로 제안만 한다(운영자가 승인한다).
2) 사실은 제공된 "회사 지표"와 "업무 내용"만 근거로 한다. 근거가 없으면 모른다고 쓰고 추측을 사실처럼 쓰지 않는다.
3) 고객의 개인정보·비밀키·비밀번호를 요청하거나 출력하지 않는다.
4) 다른 부서의 협의가 정말 필요할 때만 needs_collab 에 부서 ID 를 적는다. 혼자 처리할 수 있으면 협의를 요청하지 않는다.
5) 출력은 지정한 JSON 한 개만 낸다(설명 문장·코드블록 금지).`;

export function seedAgents() {
  const out: { id: string; dept: string; name: string; title: string; rank: Rank; persona: string }[] = [];
  out.push({ id: "agent-coo", dept: "strategy", name: "마루", title: "COO(최고운영 AI)", rank: "executive", persona: "회사 전체 운영을 총괄한다. 부서 간 충돌을 조율하고 최종 우선순위를 정한다. 운영자(대표)에게 결정이 필요한 사안만 올린다." });
  for (const d of DEPTS) {
    const [dir, sen, jun] = NAMES[d.id]!;
    out.push({ id: `agent-${d.id}-dir`, dept: d.id, name: dir, title: `${d.name} 팀장`, rank: "director", persona: `${d.name}의 책임자. 팀 산출물을 검토·승인하고 위험한 제안을 걸러낸다. 담당 업무: ${d.mission}` });
    out.push({ id: `agent-${d.id}-sen`, dept: d.id, name: sen, title: `${d.name} 선임`, rank: "senior", persona: `${d.name} 선임 담당자. 복잡하거나 우선순위가 높은 업무를 맡는다. 담당 업무: ${d.mission}` });
    out.push({ id: `agent-${d.id}-jun`, dept: d.id, name: jun, title: `${d.name} 사원`, rank: "junior", persona: `${d.name} 사원. 정형 업무와 초안을 빠르게 만든다. 담당 업무: ${d.mission}` });
  }
  return out;
}

/** 외부 무료 AI 는 기본 비활성. 모델·무료 한도·약관은 수시로 바뀌므로 운영자가 확인한 뒤 활성화한다. 키는 Worker Secret 에만 둔다. */
const PROVIDERS = [
  { name: "workers-ai-strong", kind: "workers_ai", base_url: null, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", secret: null, strong: 1, priority: 10, limit: 120, external: 0, note: "Cloudflare Workers AI(상위). 모델 ID 는 CAS 모델 동기화 목록에서 확인." },
  { name: "workers-ai-fast", kind: "workers_ai", base_url: null, model: "@cf/meta/llama-3.1-8b-instruct", secret: null, strong: 0, priority: 20, limit: 400, external: 0, note: "Cloudflare Workers AI(경량). 무료 하루 10,000 Neurons 초과분은 과금." },
  { name: "gemini-free", kind: "openai_compat", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", secret: "GEMINI_API_KEY", strong: 1, priority: 30, limit: 150, external: 1, note: "예시(무료 한도·약관·모델명 확인 필요). 입력은 개인정보 마스킹 후 전송." },
  { name: "groq-free", kind: "openai_compat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", secret: "GROQ_API_KEY", strong: 1, priority: 40, limit: 150, external: 1, note: "예시(무료 한도·약관·모델명 확인 필요)." },
  { name: "openrouter-free", kind: "openai_compat", base_url: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", secret: "OPENROUTER_API_KEY", strong: 0, priority: 50, limit: 100, external: 1, note: "예시(':free' 모델은 자주 바뀜)." },
];

const ROUTINES = [
  { id: "r-strategy-brief", dept: "strategy", title: "일일 경영 브리핑", detail: "회사 지표와 목표를 비교해 오늘의 우선순위 3가지와 부서별 지시 사항을 정리한다.", hours: 24, priority: 7 },
  { id: "r-finance-margin", dept: "finance", title: "수익성·원가 점검", detail: "활성 구독·월 반복 매출·AI 사용 원가/매출을 바탕으로 마진 위험과 가격 정책 개선안을 요약한다.", hours: 24, priority: 7 },
  { id: "r-infra-health", dept: "infra", title: "시스템 건강 점검", detail: "실패한 작업(dead)·웹훅 실패·대기 작업 수를 보고 원인 가설과 조치 제안을 작성한다.", hours: 6, priority: 6 },
  { id: "r-security-review", dept: "security", title: "보안 점검", detail: "차단된 API 키·이상 사용·계정 정지 지표를 보고 위험 징후와 권고를 작성한다.", hours: 24, priority: 6, conf: 1 },
  { id: "r-support-queue", dept: "support", title: "고객 대응 대기열 점검", detail: "결제 실패·미해결 알림 지표를 보고 고객 안내 문안 초안(발송은 승인 필요)을 작성한다.", hours: 12, priority: 5, conf: 1 },
  { id: "r-growth-ideas", dept: "growth", title: "무료 채널 성장 실험 제안", detail: "비용 0원으로 가능한 고객 확보 실험 3가지를 가설·측정지표와 함께 제안한다.", hours: 48, priority: 4 },
  { id: "r-legal-check", dept: "legal", title: "정책 준수 점검 목록", detail: "개인정보·결제(PayPal)·클라우드(Cloudflare) 정책 관점에서 이번 주 확인해야 할 항목을 정리한다(법률 자문이 아님을 명시).", hours: 168, priority: 4 },
  { id: "r-data-trends", dept: "data", title: "핵심 지표 추세 보고", detail: "가입·구독·매출·AI 사용 지표의 변화와 이상 징후를 요약한다.", hours: 24, priority: 5 },
  { id: "r-eng-backlog", dept: "engineering", title: "개발 백로그 정리 제안", detail: "알려진 한계(컨테이너 매니저 미연결, 제휴 정산 미구현 등)를 기준으로 다음 개발 우선순위를 제안한다.", hours: 72, priority: 4 },
];

export async function seedWorkforce(db: D1Like, nowMs: number): Promise<void> {
  const st = [];
  for (const d of DEPTS) st.push(db.prepare("INSERT OR IGNORE INTO ai_departments(id,name_ko,mission,sort) VALUES(?,?,?,?)").bind(d.id, d.name, d.mission, DEPTS.indexOf(d)));
  for (const a of seedAgents()) st.push(db.prepare("INSERT OR IGNORE INTO ai_agents(id,department_id,name,title,rank,persona) VALUES(?,?,?,?,?,?)").bind(a.id, a.dept, a.name, a.title, a.rank, a.persona));
  for (const p of PROVIDERS) st.push(db.prepare("INSERT OR IGNORE INTO ai_providers(name,kind,base_url,model,secret_name,strong,priority,daily_limit,external,enabled,note) VALUES(?,?,?,?,?,?,?,?,?,0,?)").bind(p.name, p.kind, p.base_url, p.model, p.secret, p.strong, p.priority, p.limit, p.external, p.note));
  for (const r of ROUTINES) st.push(db.prepare("INSERT OR IGNORE INTO ai_routines(id,department_id,title,detail,interval_hours,priority,confidential) VALUES(?,?,?,?,?,?,?)").bind(r.id, r.dept, r.title, r.detail, r.hours, r.priority, r.conf ?? 0));
  st.push(db.prepare("INSERT OR IGNORE INTO company_goals(id,title,metric,target,status,created_at) VALUES('g-subs','활성 구독 10개 달성','active_subscriptions',10,'active',?)").bind(nowIso(nowMs)));
  st.push(db.prepare("INSERT OR IGNORE INTO company_goals(id,title,metric,target,status,created_at) VALUES('g-mrr','월 반복 매출 $200 달성','mrr_usd',200,'active',?)").bind(nowIso(nowMs)));
  await db.batch(st);
}

/* ═══════════ LLM 공급자 ═══════════ */

export interface LlmResult { text: string; inputTokens: number; outputTokens: number }
export interface LlmProvider { complete(system: string, user: string, o?: { maxTokens?: number }): Promise<LlmResult> }
export interface ProviderRow { name: string; kind: "workers_ai" | "openai_compat"; base_url: string | null; model: string; secret_name: string | null; strong: number; priority: number; daily_limit: number; external: number; enabled: number }
/** 설정이 안 된 공급자(키 없음 등)는 null → 자동으로 건너뛴다. */
export type ProviderFactory = (row: ProviderRow) => LlmProvider | null;

/** 외부 사업자로 나가는 텍스트에서 개인정보·비밀값을 지운다. 기밀 업무는 애초에 외부로 보내지 않는다. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[이메일]")
    .replace(/\bcpai_[A-Za-z0-9_-]+/g, "[API키]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [토큰]")
    .replace(/(?<![\d-])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?![\d-])|\b\d{13,19}\b/g, "[번호]")
    .replace(/\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{4}\b/g, "[전화]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[비밀값]");
}

const hostOk = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(x.hostname) && x.hostname.includes("."); } catch { return false; } };

/** OpenAI 호환 채팅 API(Gemini·Groq·OpenRouter 등). 키는 호출 시점에 Secret 에서 읽는다. */
export function openAiCompat(baseUrl: string, model: string, apiKey: string, f: typeof fetch = fetch): LlmProvider {
  if (!hostOk(baseUrl)) throw new Error("base_url 은 공개 https 주소여야 합니다.");
  return {
    async complete(system, user, o) {
      const res = await f(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: o?.maxTokens ?? 1200, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("empty_response");
      return { text, inputTokens: j?.usage?.prompt_tokens ?? Math.ceil((system.length + user.length) / 4), outputTokens: j?.usage?.completion_tokens ?? Math.ceil(text.length / 4) };
    },
  };
}

export function workersAi(ai: { run(model: string, input: unknown): Promise<any> }, model: string): LlmProvider {
  return {
    async complete(system, user, o) {
      const r = await ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: o?.maxTokens ?? 1200 });
      const text = typeof r?.response === "string" ? r.response : typeof r?.result?.response === "string" ? r.result.response : null;
      if (text === null) throw new Error("empty_response");
      return { text, inputTokens: r?.usage?.prompt_tokens ?? Math.ceil((system.length + user.length) / 4), outputTokens: r?.usage?.completion_tokens ?? Math.ceil(text.length / 4) };
    },
  };
}

/* ═══════════ 설정·지표 ═══════════ */

export interface WfSettings { enabled: boolean; paused: boolean; maxTasksPerTick: number; tickMinutes: number; dailyRunCap: number }
async function setting(db: D1Like, key: string): Promise<string | null> { return (await db.prepare("SELECT value_json v FROM admin_settings WHERE key = ?").bind(key).first<{ v: string }>())?.v ?? null; }
export async function setSetting(db: D1Like, actor: string, key: string, value: string, nowMs: number): Promise<void> {
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(key, value, actor, nowIso(nowMs)).run();
}
export async function loadSettings(db: D1Like): Promise<WfSettings> {
  const n = async (k: string, d: number, lo: number, hi: number) => { const v = Number(await setting(db, k)); return Number.isFinite(v) && v >= lo && v <= hi && (await setting(db, k)) !== null ? Math.floor(v) : d; };
  return { enabled: (await setting(db, "workforce_enabled")) === "true", paused: (await setting(db, "workforce_paused")) === "true",
    maxTasksPerTick: await n("workforce_max_tasks_per_tick", 3, 1, 20), tickMinutes: await n("workforce_tick_minutes", 30, 5, 1440), dailyRunCap: await n("workforce_daily_run_cap", 300, 10, 5000) };
}

export interface Metrics { users: number; activeSubscriptions: number; subscriptionsByKind: Record<string, number>; mrrUsd: number; pastDueSubscriptions: number; deadJobs: number; failedWebhooks: number; unreadOperatorAlerts: number; aiRevenueUsd30d: number; aiCostUsd30d: number; aiMarginPct: number | null; pendingApprovals: number }
/** 에이전트가 근거로 삼는 실제 회사 지표(DB 집계). 추측이 아니라 이 숫자만 사실로 쓴다. */
export async function gatherMetrics(db: D1Like, nowMs: number): Promise<Metrics> {
  const c = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())?.n ?? 0;
  const since = nowIso(nowMs - 30 * 86400_000);
  const byKind = await db.prepare("SELECT p.kind k, COUNT(*) n FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.status = 'active' GROUP BY p.kind").all<{ k: string; n: number }>();
  const mrr = (await db.prepare("SELECT COALESCE(SUM(pr.monthly_micro * s.quantity),0) AS n FROM subscriptions s JOIN prices pr ON pr.id = s.price_version_id WHERE s.status = 'active'").first<{ n: number }>())?.n ?? 0;
  const rev = (await db.prepare("SELECT COALESCE(SUM(billed_micro),0) r, COALESCE(SUM(cost_micro),0) c FROM ai_usage_records WHERE ts >= ?").bind(since).first<{ r: number; c: number }>()) ?? { r: 0, c: 0 };
  return {
    users: await c("SELECT COUNT(*) n FROM users WHERE status != 'deleted'"), activeSubscriptions: await c("SELECT COUNT(*) n FROM subscriptions WHERE status = 'active'"),
    subscriptionsByKind: Object.fromEntries(byKind.results.map((r) => [r.k, r.n])), mrrUsd: Math.round(mrr / 10_000) / 100,
    pastDueSubscriptions: await c("SELECT COUNT(*) n FROM subscriptions WHERE status = 'past_due'"), deadJobs: await c("SELECT COUNT(*) n FROM deployment_jobs WHERE state = 'dead'"),
    failedWebhooks: await c("SELECT COUNT(*) n FROM webhook_events WHERE status = 'failed'"), unreadOperatorAlerts: await c("SELECT COUNT(*) n FROM notifications WHERE audience = 'operator' AND read_at IS NULL"),
    aiRevenueUsd30d: Math.round(rev.r / 10_000) / 100, aiCostUsd30d: Math.round(rev.c / 10_000) / 100, aiMarginPct: rev.r > 0 ? Math.round(((rev.r - rev.c) / rev.r) * 1000) / 10 : null,
    pendingApprovals: await c("SELECT COUNT(*) n FROM ai_approvals WHERE status = 'pending'"),
  };
}

/* ═══════════ 실행 엔진 ═══════════ */

interface AgentRow { id: string; department_id: string; name: string; title: string; rank: Rank; persona: string; provider_pref: string | null; status: string }
interface TaskRow { id: string; department_id: string; title: string; detail: string | null; priority: number; status: string; assignee_agent_id: string | null; confidential: number; depth: number; revisions: number; parent_id: string | null }

const log = (db: D1Like, nowMs: number, kind: string, message: string, agentId?: string | null, taskId?: string | null) =>
  db.prepare("INSERT INTO ai_activity(id,ts,kind,agent_id,task_id,message) VALUES(?,?,?,?,?,?)").bind(newId("act"), nowIso(nowMs), kind, agentId ?? null, taskId ?? null, message.slice(0, 500)).run();

export function parseLoose(text: string): Record<string, any> {
  const s = text.indexOf("{");
  if (s >= 0) {
    for (let e = text.lastIndexOf("}"); e > s; e = text.lastIndexOf("}", e - 1)) {
      try { const v = JSON.parse(text.slice(s, e + 1)); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* 다음 후보 */ }
    }
  }
  return { summary: text.trim().slice(0, 300), deliverable: text.trim(), _unstructured: true };
}

async function runsToday(db: D1Like, nowMs: number, provider?: string): Promise<number> {
  const d = new Date(nowMs); d.setUTCHours(0, 0, 0, 0);
  const r = provider ? await db.prepare("SELECT COUNT(*) n FROM ai_runs WHERE ts >= ? AND provider = ?").bind(nowIso(d.getTime()), provider).first<{ n: number }>()
    : await db.prepare("SELECT COUNT(*) n FROM ai_runs WHERE ts >= ?").bind(nowIso(d.getTime())).first<{ n: number }>();
  return r?.n ?? 0;
}

interface CallCtx { db: D1Like; factory: ProviderFactory; nowMs: number; settings: WfSettings }
/** 후보 공급자를 순서대로 시도한다(상위 직위는 상위 모델 우선, 기밀 업무는 외부 금지, 공급자별 일일 한도·전체 일일 상한 준수). 모두 실패하면 던진다. */
async function callLlm(x: CallCtx, agent: AgentRow, phase: "work" | "review" | "meeting" | "summary", task: { id?: string; confidential?: boolean }, system: string, user: string, meetingId?: string): Promise<string> {
  if ((await runsToday(x.db, x.nowMs)) >= x.settings.dailyRunCap) throw new Error("daily_run_cap");
  const { results } = await x.db.prepare("SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY priority").all<ProviderRow>();
  const strongWanted = RANK_LEVEL[agent.rank] >= RANK_LEVEL.director;
  const cands = results.filter((p) => !(task.confidential && p.external)).sort((a, b) =>
    (a.name === agent.provider_pref ? -1 : 0) - (b.name === agent.provider_pref ? -1 : 0) || (strongWanted ? b.strong - a.strong : a.strong - b.strong) || a.priority - b.priority);
  const errs: string[] = [];
  for (const p of cands) {
    if ((await runsToday(x.db, x.nowMs, p.name)) >= p.daily_limit) { errs.push(`${p.name}: 일일 한도`); continue; }
    let llm: LlmProvider | null = null;
    try { llm = x.factory(p); } catch (e) { errs.push(`${p.name}: 설정 오류`); continue; }
    if (!llm) { errs.push(`${p.name}: 미설정`); continue; }
    const t0 = Date.now();
    try {
      const r = await llm.complete(p.external ? scrub(system) : system, p.external ? scrub(user) : user);
      await x.db.prepare("INSERT INTO ai_runs(id,task_id,meeting_id,agent_id,phase,provider,ok,input_tokens,output_tokens,latency_ms,ts) VALUES(?,?,?,?,?,?,1,?,?,?,?)").bind(newId("run"), task.id ?? null, meetingId ?? null, agent.id, phase, p.name, r.inputTokens, r.outputTokens, Date.now() - t0, nowIso(x.nowMs)).run();
      return r.text;
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      errs.push(`${p.name}: ${m}`);
      await x.db.prepare("INSERT INTO ai_runs(id,task_id,meeting_id,agent_id,phase,provider,ok,latency_ms,error,ts) VALUES(?,?,?,?,?,?,0,?,?,?)").bind(newId("run"), task.id ?? null, meetingId ?? null, agent.id, phase, p.name, Date.now() - t0, m, nowIso(x.nowMs)).run();
    }
  }
  throw new Error(`사용 가능한 AI 공급자가 없습니다(${errs.join("; ") || "활성 공급자 없음"})`);
}

const sysFor = (a: AgentRow, deptName: string) => `당신은 CloudPress(클라우드 호스팅 SaaS)의 ${deptName} 소속 ${a.title} "${a.name}"(AI)입니다.\n${a.persona}\n\n${COMMON_RULES}`;

async function pickAgent(db: D1Like, deptId: string, priority: number): Promise<AgentRow | null> {
  const want: Rank[] = priority >= 8 ? ["senior", "director"] : ["junior", "senior", "director"];
  for (const r of want) {
    const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = ? AND status != 'paused' ORDER BY (status='idle') DESC, tasks_done ASC LIMIT 1").bind(deptId, r).first<AgentRow>();
    if (a) return a;
  }
  return null;
}
async function pickReviewer(db: D1Like, author: AgentRow): Promise<AgentRow | null> {
  const higher = (Object.keys(RANK_LEVEL) as Rank[]).filter((r) => RANK_LEVEL[r] > RANK_LEVEL[author.rank]).sort((a, b) => RANK_LEVEL[a] - RANK_LEVEL[b]);
  for (const r of higher) {
    const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = ? AND status != 'paused' LIMIT 1").bind(r === "executive" ? "strategy" : author.department_id, r).first<AgentRow>();
    if (a) return a;
  }
  return null;
}
const setStatus = (db: D1Like, id: string, status: string, nowMs: number) => db.prepare("UPDATE ai_agents SET status = ?, last_active_at = ? WHERE id = ?").bind(status, nowIso(nowMs), id).run();

const KINDS = new Set(["spend", "deploy", "pricing", "customer_contact", "legal", "escalation", "other"]);
const RISKS = new Set(["low", "medium", "high"]);
const trunc = (v: unknown, n: number) => String(v ?? "").slice(0, n);

export interface TickReport { skipped?: string; tasksProcessed: number; meetings: number; approvalsCreated: number; errors: string[]; routinesCreated: number }

/** 정해진 시간마다 한 번 호출된다(또는 운영자가 수동 실행). 비활성·일시정지·한도 초과면 아무것도 하지 않는다. */
export async function runTick(db: D1Like, factory: ProviderFactory, nowMs: number, o: { force?: boolean } = {}): Promise<TickReport> {
  const rep: TickReport = { tasksProcessed: 0, meetings: 0, approvalsCreated: 0, errors: [], routinesCreated: 0 };
  const settings = await loadSettings(db);
  if (settings.paused) return { ...rep, skipped: "paused" };
  if (!settings.enabled && !o.force) return { ...rep, skipped: "disabled" };
  if (!o.force) {
    const last = Number(await setting(db, "workforce_last_tick")) || 0;
    if (nowMs - last < settings.tickMinutes * 60_000) return { ...rep, skipped: "not_due" };
  }
  await setSetting(db, "system", "workforce_last_tick", String(nowMs), nowMs);
  rep.routinesCreated = await createRoutineTasks(db, nowMs);
  const { results } = await db.prepare("SELECT * FROM ai_tasks WHERE status = 'queued' AND assignee_human = 0 ORDER BY priority DESC, created_at LIMIT ?").bind(settings.maxTasksPerTick).all<TaskRow>();
  const x: CallCtx = { db, factory, nowMs, settings };
  for (const t of results) {
    try { const r = await processTask(x, t); rep.tasksProcessed++; rep.meetings += r.meeting ? 1 : 0; rep.approvalsCreated += r.approvals; }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      rep.errors.push(`${t.title}: ${m}`);
      // 공급자 없음/한도 초과는 업무 문제가 아니므로 대기열로 되돌려 다음 틱에 재시도한다.
      const transient = /AI 공급자|daily_run_cap/.test(m);
      await db.prepare("UPDATE ai_tasks SET status = ?, updated_at = ? WHERE id = ?").bind(transient ? "queued" : "blocked", nowIso(nowMs), t.id).run();
      if (t.assignee_agent_id) await setStatus(db, t.assignee_agent_id, "idle", nowMs);
      await log(db, nowMs, "error", `업무 "${t.title}" 처리 실패: ${m}`, t.assignee_agent_id, t.id);
      if (transient) break;
    }
  }
  return rep;
}

async function createRoutineTasks(db: D1Like, nowMs: number): Promise<number> {
  const { results } = await db.prepare("SELECT * FROM ai_routines WHERE enabled = 1").all<{ id: string; department_id: string; title: string; detail: string; interval_hours: number; priority: number; confidential: number; last_run_at: string | null }>();
  let n = 0;
  for (const r of results) {
    if (r.last_run_at && nowMs - Date.parse(r.last_run_at) < r.interval_hours * 3_600_000) continue;
    const ins = await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'routine',?,'routine',?,?)")
      .bind(newId("task"), r.department_id, r.title, r.detail, r.priority, r.confidential, `routine:${r.id}:${Math.floor(nowMs / (r.interval_hours * 3_600_000))}`, nowIso(nowMs), nowIso(nowMs)).run();
    await db.prepare("UPDATE ai_routines SET last_run_at = ? WHERE id = ?").bind(nowIso(nowMs), r.id).run();
    n += ins.meta.changes;
  }
  return n;
}

async function processTask(x: CallCtx, t: TaskRow): Promise<{ meeting: boolean; approvals: number }> {
  const { db, nowMs } = x;
  const dept = await db.prepare("SELECT name_ko FROM ai_departments WHERE id = ?").bind(t.department_id).first<{ name_ko: string }>();
  const agent = t.assignee_agent_id ? await db.prepare("SELECT * FROM ai_agents WHERE id = ?").bind(t.assignee_agent_id).first<AgentRow>() : await pickAgent(db, t.department_id, t.priority);
  if (!agent || !dept) throw new Error("담당자를 찾을 수 없습니다");
  await db.prepare("UPDATE ai_tasks SET status='in_progress', assignee_agent_id=?, updated_at=? WHERE id=?").bind(agent.id, nowIso(nowMs), t.id).run();
  await setStatus(db, agent.id, "working", nowMs);
  await log(db, nowMs, "task_start", `${agent.title} ${agent.name}: "${t.title}" 시작`, agent.id, t.id);

  const metrics = await gatherMetrics(db, nowMs);
  const goals = (await db.prepare("SELECT title, metric, target FROM company_goals WHERE status = 'active'").all()).results;
  const ctxText = `[회사 지표]\n${JSON.stringify(metrics)}\n[활성 목표]\n${JSON.stringify(goals)}`;
  const schema = `{"summary":"한 줄 요약","deliverable":"결과물 본문","needs_collab":["부서ID"...](선택),"proposed_actions":[{"kind":"spend|deploy|pricing|customer_contact|legal|other","title":"","detail":"","risk":"low|medium|high"}](선택),"follow_up_tasks":[{"department":"부서ID","title":"","detail":"","priority":1-9}](선택),"needs_human":true|false(선택)}`;
  let feedback = "";
  let out: Record<string, any> = {};
  for (let attempt = 0; attempt <= 2; attempt++) {
    const text = await callLlm(x, agent, "work", { id: t.id, confidential: !!t.confidential }, sysFor(agent, dept.name_ko),
      `${ctxText}\n\n[업무]\n제목: ${t.title}\n내용: ${t.detail ?? ""}${feedback ? `\n\n[검토자 피드백 — 반영해서 다시 작성]\n${feedback}` : ""}\n\n다음 JSON 형식으로만 답하세요:\n${schema}`);
    out = parseLoose(text);
    // 협의가 필요하다고 한 경우에만 회의를 연다(팀플은 필요할 때만).
    const collab: string[] = Array.isArray(out.needs_collab) ? out.needs_collab.filter((d: unknown) => typeof d === "string" && d !== t.department_id).slice(0, 3) : [];
    if (collab.length && attempt === 0 && t.depth < 2) {
      const ok = await holdMeeting(x, t, agent, dept.name_ko, collab, ctxText);
      if (ok) { await setStatus(db, agent.id, "idle", nowMs); return { meeting: true, approvals: 0 }; }
    }
    // 상위 직위 검토
    const reviewer = await pickReviewer(db, agent);
    if (!reviewer) break;
    await db.prepare("UPDATE ai_tasks SET status='in_review', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
    await setStatus(db, reviewer.id, "reviewing", nowMs);
    let verdict: Record<string, any>;
    try {
      const rtxt = await callLlm(x, reviewer, "review", { id: t.id, confidential: !!t.confidential }, sysFor(reviewer, dept.name_ko),
        `[업무]\n${t.title}\n${t.detail ?? ""}\n\n[담당자(${agent.title} ${agent.name}) 산출물]\n${trunc(out.deliverable ?? out.summary, 3500)}\n\n사실 근거(회사 지표)에 어긋나거나 위험한 실제 행동이 직접 실행되도록 쓰였는지 검토하세요. 이 JSON 으로만 답하세요: {"verdict":"approve|revise","feedback":"수정 요청 사항"}\n${ctxText}`);
      verdict = parseLoose(rtxt);
    } finally { await setStatus(db, reviewer.id, "idle", nowMs); }
    const approve = String(verdict.verdict ?? "approve").toLowerCase() !== "revise"; // 명시적으로 revise 일 때만 반려(형식을 못 지킨 검토로 인한 무한 반려 방지)
    await log(db, nowMs, "review", `${reviewer.title} ${reviewer.name}: "${t.title}" ${approve ? "승인" : "수정 요청"}`, reviewer.id, t.id);
    if (approve) break;
    feedback = trunc(verdict.feedback, 800);
    await db.prepare("UPDATE ai_tasks SET revisions = revisions + 1, status='in_progress', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
    await log(db, nowMs, "revise", `"${t.title}" 수정 ${attempt + 1}회차`, agent.id, t.id);
    if (attempt === 2) { // 두 번 수정해도 통과 못 하면 사람에게 올린다.
      await db.prepare("UPDATE ai_tasks SET status='needs_human', result_summary=?, result_json=?, updated_at=? WHERE id=?").bind(trunc(out.summary, 300), JSON.stringify(out).slice(0, 20000), nowIso(nowMs), t.id).run();
      await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,'escalation',?,?,'medium',?)").bind(newId("apr"), t.id, agent.id, `검토 반복 실패: ${t.title}`, `수정 요청이 2회 반복되었습니다. 마지막 피드백: ${feedback}`, nowIso(nowMs)).run();
      await log(db, nowMs, "escalate", `"${t.title}" 운영자 확인 필요(검토 2회 불통과)`, agent.id, t.id);
      await setStatus(db, agent.id, "idle", nowMs);
      return { meeting: false, approvals: 1 };
    }
  }

  // 승인된 산출물 확정 + 제안 행동은 운영자 승인 대기열로(자동 실행 없음) + 후속 업무 생성
  let approvals = 0;
  const actions: any[] = Array.isArray(out.proposed_actions) ? out.proposed_actions.slice(0, 5) : [];
  for (const a of actions) {
    if (!a || typeof a.title !== "string") continue;
    await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(newId("apr"), t.id, agent.id, KINDS.has(a.kind) ? a.kind : "other", trunc(a.title, 200), trunc(a.detail, 1500), RISKS.has(a.risk) ? a.risk : "high", nowIso(nowMs)).run();
    approvals++;
  }
  const follow: any[] = Array.isArray(out.follow_up_tasks) ? out.follow_up_tasks.slice(0, 3) : [];
  for (const f of follow) {
    if (!f || typeof f.title !== "string" || t.depth >= 2) continue;
    const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(f.department).first();
    if (!dep) continue;
    await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,parent_id,depth,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'follow_up',?,?,?,?)")
      .bind(newId("task"), f.department, trunc(f.title, 200), trunc(f.detail, 1500), Math.min(Math.max(Number(f.priority) || 5, 1), 9), t.confidential, t.id, t.depth + 1, `follow:${t.id}:${trunc(f.title, 60)}`, agent.id, nowIso(nowMs), nowIso(nowMs)).run();
  }
  const human = out.needs_human === true;
  await db.prepare("UPDATE ai_tasks SET status=?, result_summary=?, result_json=?, completed_at=?, updated_at=? WHERE id=?").bind(human ? "needs_human" : "done", trunc(out.summary, 300), JSON.stringify(out).slice(0, 20000), nowIso(nowMs), nowIso(nowMs), t.id).run();
  await db.prepare("UPDATE ai_agents SET tasks_done = tasks_done + 1 WHERE id = ?").bind(agent.id).run();
  await setStatus(db, agent.id, "idle", nowMs);
  await log(db, nowMs, "task_done", `${agent.name}: "${t.title}" 완료 — ${trunc(out.summary, 120)}`, agent.id, t.id);
  if (approvals) await log(db, nowMs, "approval", `"${t.title}" 에서 승인 요청 ${approvals}건 생성`, agent.id, t.id);
  return { meeting: false, approvals };
}

/** 부서 간 협의가 필요한 업무만 회의를 연다: 참석자(각 부서 팀장)가 1회씩 발언 → 의장(최고 직위)이 결론을 정리 → 후속 업무로 전환. */
async function holdMeeting(x: CallCtx, t: TaskRow, requester: AgentRow, deptName: string, depts: string[], ctxText: string): Promise<boolean> {
  const { db, nowMs } = x;
  const people: AgentRow[] = [];
  for (const d of depts) { const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = 'director' AND status != 'paused' LIMIT 1").bind(d).first<AgentRow>(); if (a) people.push(a); }
  if (!people.length) return false;
  const chair = [requester, ...people].sort((a, b) => RANK_LEVEL[b.rank] - RANK_LEVEL[a.rank])[0]!;
  const mid = newId("mtg");
  await db.prepare("INSERT INTO ai_meetings(id,task_id,topic,chair_agent_id,created_at) VALUES(?,?,?,?,?)").bind(mid, t.id, t.title, chair.id, nowIso(nowMs)).run();
  await db.prepare("UPDATE ai_tasks SET status='in_progress', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
  await log(db, nowMs, "meeting", `회의 소집: "${t.title}" (${[requester, ...people].map((p) => p.name).join(", ")})`, chair.id, t.id);
  const said: string[] = [];
  try {
    for (const p of [requester, ...people]) {
      await setStatus(db, p.id, "meeting", nowMs);
      const dn = (await db.prepare("SELECT name_ko FROM ai_departments WHERE id = ?").bind(p.department_id).first<{ name_ko: string }>())?.name_ko ?? deptName;
      const body = await callLlm(x, p, "meeting", { id: t.id, confidential: !!t.confidential }, sysFor(p, dn),
        `[회의 안건]\n${t.title}\n${t.detail ?? ""}\n[지금까지 발언]\n${said.join("\n") || "(없음)"}\n\n당신 부서 관점의 의견·위험·필요한 조건을 5문장 이내 일반 텍스트로 말하세요.\n${ctxText}`, mid);
      const line = `${p.name}(${dn}): ${trunc(body, 800)}`;
      said.push(line);
      await db.prepare("INSERT INTO ai_meeting_messages(id,meeting_id,agent_id,body,ts) VALUES(?,?,?,?,?)").bind(newId("msg"), mid, p.id, trunc(body, 2000), nowIso(nowMs)).run();
    }
    const sum = await callLlm(x, chair, "summary", { id: t.id, confidential: !!t.confidential }, sysFor(chair, deptName),
      `[회의 안건]\n${t.title}\n[발언 기록]\n${said.join("\n")}\n\n결론을 이 JSON 으로만 정리하세요: {"decision":"결정 내용","follow_up_tasks":[{"department":"부서ID","title":"","detail":"","priority":1-9}],"proposed_actions":[{"kind":"","title":"","detail":"","risk":"low|medium|high"}]}`, mid);
    const dec = parseLoose(sum);
    await db.prepare("UPDATE ai_meetings SET status='done', decision=?, closed_at=? WHERE id=?").bind(trunc(dec.decision ?? dec.summary, 2000), nowIso(nowMs), mid).run();
    let appr = 0;
    for (const a of (Array.isArray(dec.proposed_actions) ? dec.proposed_actions.slice(0, 5) : [])) {
      if (!a || typeof a.title !== "string") continue;
      await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(newId("apr"), t.id, chair.id, KINDS.has(a.kind) ? a.kind : "other", trunc(a.title, 200), trunc(a.detail, 1500), RISKS.has(a.risk) ? a.risk : "high", nowIso(nowMs)).run(); appr++;
    }
    for (const f of (Array.isArray(dec.follow_up_tasks) ? dec.follow_up_tasks.slice(0, 4) : [])) {
      if (!f || typeof f.title !== "string") continue;
      const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(f.department).first();
      if (!dep) continue;
      await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,parent_id,depth,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'meeting',?,?,?,?)")
        .bind(newId("task"), f.department, trunc(f.title, 200), trunc(f.detail, 1500), Math.min(Math.max(Number(f.priority) || 5, 1), 9), t.confidential, t.id, t.depth + 1, `meet:${mid}:${trunc(f.title, 60)}`, chair.id, nowIso(nowMs), nowIso(nowMs)).run();
    }
    await db.prepare("UPDATE ai_tasks SET status='done', result_summary=?, result_json=?, completed_at=?, updated_at=? WHERE id=?").bind(`회의 결론: ${trunc(dec.decision ?? dec.summary, 250)}`, JSON.stringify({ meetingId: mid, decision: dec.decision }), nowIso(nowMs), nowIso(nowMs), t.id).run();
    await log(db, nowMs, "meeting", `회의 종료: "${t.title}" — ${trunc(dec.decision ?? dec.summary, 120)}`, chair.id, t.id);
    return true;
  } catch (e) {
    await db.prepare("UPDATE ai_meetings SET status='failed', closed_at=? WHERE id=?").bind(nowIso(nowMs), mid).run();
    throw e;
  } finally { for (const p of [requester, ...people]) await setStatus(db, p.id, "idle", nowMs); }
}

/* ═══════════ 운영자 조작 ═══════════ */

export async function createTask(db: D1Like, actor: string, p: { department: string; title: string; detail?: string; priority?: number; confidential?: boolean; human?: boolean }, nowMs: number): Promise<string> {
  const title = (p.title ?? "").trim();
  if (!title || title.length > 200) throw new ServiceError("bad_title", "제목은 1~200자여야 합니다.");
  const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(p.department).first();
  if (!dep) throw new ServiceError("bad_department", "없는 부서입니다.");
  const id = newId("task");
  await db.prepare("INSERT INTO ai_tasks(id,department_id,title,detail,priority,confidential,assignee_human,status,source,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'operator',?,?,?)")
    .bind(id, p.department, title, (p.detail ?? "").slice(0, 3000), Math.min(Math.max(Math.floor(p.priority ?? 5), 1), 9), p.confidential ? 1 : 0, p.human ? 1 : 0, p.human ? "needs_human" : "queued", actor, nowIso(nowMs), nowIso(nowMs)).run();
  await audit(db, { actorId: actor, action: "company.task_create", targetType: "ai_task", targetId: id }, nowMs);
  return id;
}

/** 승인/반려 기록. 승인은 "실행 허가"일 뿐 시스템이 자동으로 실행하지 않는다 — 실행할 사람 업무를 만들어 추적한다. */
export async function decideApproval(db: D1Like, actor: string, id: string, approve: boolean, note: string, nowMs: number): Promise<void> {
  const a = await db.prepare("SELECT id, task_id, kind, title, detail, status FROM ai_approvals WHERE id = ?").bind(id).first<{ id: string; task_id: string | null; kind: string; title: string; detail: string | null; status: string }>();
  if (!a) throw new ServiceError("not_found", "승인 요청이 없습니다.");
  if (a.status !== "pending") throw new ServiceError("bad_state", "이미 처리된 요청입니다.");
  await db.prepare("UPDATE ai_approvals SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?").bind(approve ? "approved" : "rejected", actor, nowIso(nowMs), note.slice(0, 500), id).run();
  if (approve && a.kind !== "escalation") {
    await db.prepare("INSERT INTO ai_tasks(id,department_id,title,detail,priority,assignee_human,status,parent_id,source,created_by,created_at,updated_at) VALUES(?,?,?,?,7,1,'needs_human',?,'follow_up',?,?,?)")
      .bind(newId("task"), (a.task_id ? (await db.prepare("SELECT department_id d FROM ai_tasks WHERE id = ?").bind(a.task_id).first<{ d: string }>())?.d : null) ?? "strategy", `승인된 조치 실행: ${a.title}`.slice(0, 200), a.detail ?? "", a.task_id, actor, nowIso(nowMs), nowIso(nowMs)).run();
  }
  await log(db, nowMs, "approval", `운영자가 "${a.title}" ${approve ? "승인" : "반려"}${note ? ` — ${note.slice(0, 80)}` : ""}`);
  await audit(db, { actorId: actor, action: approve ? "company.approve" : "company.reject", targetType: "ai_approval", targetId: id, detail: { title: a.title } }, nowMs);
}

export async function completeHumanTask(db: D1Like, actor: string, id: string, nowMs: number): Promise<void> {
  const r = await db.prepare("UPDATE ai_tasks SET status='done', completed_at=?, updated_at=? WHERE id=? AND status='needs_human'").bind(nowIso(nowMs), nowIso(nowMs), id).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "완료할 수 있는 업무가 아닙니다.");
  await log(db, nowMs, "task_done", `운영자가 업무 완료 처리: ${id}`);
}

/* ═══════════ 현황(대시보드) ═══════════ */

export async function companyOverview(db: D1Like, nowMs: number) {
  const q = async <T = any>(sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<T>()).results;
  const settings = await loadSettings(db);
  const departments = await q("SELECT * FROM ai_departments ORDER BY sort");
  const agents = await q("SELECT id, department_id, name, title, rank, status, tasks_done, last_active_at FROM ai_agents ORDER BY department_id, CASE rank WHEN 'executive' THEN 0 WHEN 'director' THEN 1 WHEN 'senior' THEN 2 ELSE 3 END");
  const counts = await q("SELECT department_id d, status s, COUNT(*) n FROM ai_tasks GROUP BY department_id, status");
  const d = new Date(nowMs); d.setUTCHours(0, 0, 0, 0);
  const metrics = await gatherMetrics(db, nowMs);
  const goals = (await q("SELECT id, title, metric, target, status FROM company_goals ORDER BY created_at")).map((g: any) => {
    const cur = g.metric === "active_subscriptions" ? metrics.activeSubscriptions : g.metric === "mrr_usd" ? metrics.mrrUsd : g.metric === "ai_margin_pct" ? metrics.aiMarginPct : null;
    return { ...g, current: cur, progressPct: cur === null ? null : Math.min(100, Math.round((cur / g.target) * 100)) };
  });
  return {
    settings, metrics, goals,
    totals: { agents: agents.length, working: agents.filter((a: any) => a.status !== "idle" && a.status !== "paused").length, runsToday: await runsToday(db, nowMs) },
    departments: departments.map((dp: any) => ({ id: dp.id, name: dp.name_ko, mission: dp.mission,
      agents: agents.filter((a: any) => a.department_id === dp.id),
      tasks: Object.fromEntries(counts.filter((c: any) => c.d === dp.id).map((c: any) => [c.s, c.n])) })),
    activity: await q("SELECT a.id, a.ts, a.kind, a.message, g.name agent_name FROM ai_activity a LEFT JOIN ai_agents g ON g.id = a.agent_id ORDER BY a.ts DESC, a.rowid DESC LIMIT 40"),
    approvals: await q("SELECT p.id, p.kind, p.title, p.detail, p.risk, p.created_at, g.name agent_name, g.title agent_title FROM ai_approvals p LEFT JOIN ai_agents g ON g.id = p.agent_id WHERE p.status = 'pending' ORDER BY p.created_at"),
    humanTasks: await q("SELECT id, title, detail, department_id, priority FROM ai_tasks WHERE status = 'needs_human' AND assignee_human = 1 ORDER BY priority DESC, created_at LIMIT 20"),
    recentTasks: await q("SELECT t.id, t.title, t.status, t.priority, t.department_id, t.result_summary, t.source, g.name agent_name FROM ai_tasks t LEFT JOIN ai_agents g ON g.id = t.assignee_agent_id ORDER BY t.updated_at DESC LIMIT 30"),
    meetings: await q("SELECT m.id, m.topic, m.status, m.decision, m.created_at, g.name chair FROM ai_meetings m LEFT JOIN ai_agents g ON g.id = m.chair_agent_id ORDER BY m.created_at DESC LIMIT 8"),
    providers: await Promise.all((await q<ProviderRow & { note: string | null }>("SELECT * FROM ai_providers ORDER BY priority")).map(async (p) => ({ name: p.name, kind: p.kind, model: p.model, external: !!p.external, strong: !!p.strong, enabled: !!p.enabled, dailyLimit: p.daily_limit, usedToday: await runsToday(db, nowMs, p.name), configured: p.kind === "workers_ai" ? null : !!p.secret_name, note: p.note }))),
  };
}

/** 개발·테스트용 가짜 LLM(결정적). 실제 AI 가 아니다. 프롬프트 종류를 보고 형식에 맞는 응답을 만든다. */
export class MockLlm implements LlmProvider {
  calls: { system: string; user: string }[] = [];
  /** 테스트에서 응답을 바꾸는 훅. null 을 돌려주면 기본 응답을 쓴다. */
  script: ((system: string, user: string) => string | null) | null = null;
  async complete(system: string, user: string): Promise<LlmResult> {
    this.calls.push({ system, user });
    const custom = this.script?.(system, user);
    const text = custom ?? (user.includes('"verdict"') ? '{"verdict":"approve","feedback":""}'
      : user.includes("결론을 이 JSON") ? '{"decision":"[mock] 협의 결과 진행","follow_up_tasks":[],"proposed_actions":[]}'
      : user.includes("[회의 안건]") ? "[mock] 우리 부서 관점의 의견입니다."
      : '{"summary":"[mock] 업무 처리 요약","deliverable":"[mock] 결과물"}');
    return { text, inputTokens: Math.ceil((system.length + user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
}
