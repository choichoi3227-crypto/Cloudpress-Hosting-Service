-- 0013: AI 직원 운영(부서·직위·업무·검토·회의·승인·현황). AI 는 제안·분석·초안만 만들고,
-- 돈·배포·가격·고객 연락 같은 실제 행동은 반드시 운영자 승인(ai_approvals)을 거친다.

CREATE TABLE IF NOT EXISTS ai_departments (
  id TEXT PRIMARY KEY,                -- 슬러그 (strategy, engineering, ...)
  name_ko TEXT NOT NULL,
  mission TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_agents (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES ai_departments(id),
  name TEXT NOT NULL,
  title TEXT NOT NULL,                -- 직함(표시용)
  rank TEXT NOT NULL CHECK (rank IN ('executive','director','senior','junior')),
  persona TEXT NOT NULL,              -- 역할·권한 지침(시스템 프롬프트)
  provider_pref TEXT,                 -- 선호 공급자 이름(없으면 자동 선택)
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','working','reviewing','meeting','paused')),
  tasks_done INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agents_dept ON ai_agents(department_id, rank);

-- LLM 공급자: Cloudflare Workers AI + 외부 무료 AI(OpenAI 호환). API 키는 DB 가 아니라 Cloudflare Secret(secret_name)에 둔다.
CREATE TABLE IF NOT EXISTS ai_providers (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('workers_ai','openai_compat')),
  base_url TEXT,                      -- openai_compat 전용(https)
  model TEXT NOT NULL,
  secret_name TEXT,                   -- openai_compat: Worker Secret 이름
  strong INTEGER NOT NULL DEFAULT 0,  -- 임원·팀장용 상위 모델 여부
  priority INTEGER NOT NULL DEFAULT 100,
  daily_limit INTEGER NOT NULL DEFAULT 200,
  external INTEGER NOT NULL DEFAULT 1, -- 외부 사업자 여부(1 이면 기밀 업무에 사용 금지, 입력은 마스킹)
  enabled INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS ai_tasks (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES ai_departments(id),
  title TEXT NOT NULL,
  detail TEXT,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 9),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','in_review','done','blocked','needs_human','cancelled')),
  assignee_agent_id TEXT REFERENCES ai_agents(id),
  assignee_human INTEGER NOT NULL DEFAULT 0,   -- 1 이면 사람(운영자)이 해야 하는 업무
  confidential INTEGER NOT NULL DEFAULT 0,     -- 1 이면 외부 공급자 금지(Workers AI 만)
  parent_id TEXT REFERENCES ai_tasks(id),
  depth INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'operator',     -- operator | routine | follow_up | meeting
  idempotency_key TEXT UNIQUE,
  result_summary TEXT,
  result_json TEXT,
  revisions INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_dept ON ai_tasks(department_id, status);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES ai_tasks(id),
  meeting_id TEXT,
  agent_id TEXT REFERENCES ai_agents(id),
  phase TEXT NOT NULL CHECK (phase IN ('work','review','meeting','summary')),
  provider TEXT,
  ok INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  error TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_ts ON ai_runs(ts);
CREATE INDEX IF NOT EXISTS idx_ai_runs_provider ON ai_runs(provider, ts);

CREATE TABLE IF NOT EXISTS ai_meetings (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES ai_tasks(id),
  topic TEXT NOT NULL,
  chair_agent_id TEXT REFERENCES ai_agents(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','failed')),
  decision TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_meeting_messages (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES ai_meetings(id),
  agent_id TEXT NOT NULL REFERENCES ai_agents(id),
  body TEXT NOT NULL,
  ts TEXT NOT NULL
);

-- 운영자 승인 대기열: AI 가 제안한 실제 행동은 승인 전까지 아무것도 실행되지 않는다.
CREATE TABLE IF NOT EXISTS ai_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES ai_tasks(id),
  agent_id TEXT REFERENCES ai_agents(id),
  kind TEXT NOT NULL,                  -- spend | deploy | pricing | customer_contact | legal | escalation | other
  title TEXT NOT NULL,
  detail TEXT,
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_approvals_status ON ai_approvals(status, created_at);

CREATE TABLE IF NOT EXISTS ai_activity (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- task_start | task_done | review | revise | meeting | approval | escalate | error | system
  agent_id TEXT,
  task_id TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_activity_ts ON ai_activity(ts DESC);

CREATE TABLE IF NOT EXISTS ai_routines (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES ai_departments(id),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  interval_hours INTEGER NOT NULL CHECK (interval_hours >= 1),
  priority INTEGER NOT NULL DEFAULT 5,
  confidential INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS company_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  metric TEXT NOT NULL,                -- 예: active_subscriptions, mrr_usd, ai_margin_pct
  target REAL NOT NULL,
  due TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
  created_at TEXT NOT NULL
);
