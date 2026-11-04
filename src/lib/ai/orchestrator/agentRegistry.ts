import { D1Like } from '../../db';
import { newId, nowIso } from '../../workforce';

export interface AgentConfig {
  id: string;
  name: string;
  department: string;
  role: string;
  title: string;
  persona: string;
  permissions: string[];
  preferredModels: string[];
  maxConcurrentTasks: number;
  budgetLimitUsd: number;
  tools: string[];
  systemPrompt: string;
}

export interface AgentState {
  id: string;
  status: 'idle' | 'busy' | 'waiting' | 'error' | 'offline';
  currentTaskId?: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalTokensUsed: number;
  totalCostMicro: number;
  lastActiveAt: string;
  currentActivity?: string;
}

export class AgentRegistry {
  private db: D1Like;
  private agents: Map<string, AgentConfig> = new Map();
  private states: Map<string, AgentState> = new Map();

  constructor(db: D1Like) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    const agents = await this.db.prepare(
      'SELECT * FROM ai_employees WHERE status = "active"'
    ).all<AgentConfig>();

    for (const agent of agents.results || []) {
      this.agents.set(agent.id, agent);
      this.states.set(agent.id, {
        id: agent.id,
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokensUsed: 0,
        totalCostMicro: 0,
        lastActiveAt: nowIso(Date.now()),
      });
    }

    if (this.agents.size === 0) {
      await this.createDefaultAgents();
    }
  }

  async createDefaultAgents(): Promise<void> {
    const defaultAgents: Omit<AgentConfig, 'id'>[] = [
      { name: 'CEO', department: 'executive', role: 'CEO', title: 'Chief Executive Officer',
        persona: '당신은 CloudPress의 AI CEO입니다. 전체 AI 직원의 업무 현황을 조율하고, 우선순위를 결정하며, 관리자에게 주요 의사결정 사항을 보고합니다. 실제 운영 작업은 직접 수행하지 않고 부서장들에게 업무를 위임합니다.',
        permissions: ['task.assign', 'task.prioritize', 'report.view', 'employee.manage'],
        preferredModels: ['gpt-4o', 'claude-3-opus'], maxConcurrentTasks: 3, budgetLimitUsd: 100,
        tools: ['task.create', 'task.assign', 'report.generate', 'employee.status'],
        systemPrompt: 'CEO system prompt' },
      { name: 'CTO', department: 'executive', role: 'CTO', title: 'Chief Technology Officer',
        persona: '당신은 CloudPress의 AI CTO입니다. 기술 아키텍처를 총괄하고, 기술적 의사결정을 내리며, 엔지니어링 부서를 지휘합니다. 코드 품질, 아키텍처 개선, 기술 부채 관리를 담당합니다.',
        permissions: ['architecture.review', 'code.approve', 'tech.decision', 'engineering.manage'],
        preferredModels: ['gpt-4o', 'claude-3-opus', 'gpt-4-turbo'], maxConcurrentTasks: 5, budgetLimitUsd: 200,
        tools: ['architecture.review', 'code.analyze', 'tech.decision', 'deployment.approve'],
        systemPrompt: 'CTO system prompt' },
      { name: 'CFO', department: 'executive', role: 'CFO', title: 'Chief Financial Officer',
        persona: '당신은 CloudPress의 AI CFO입니다. 비용 분석, 마진 계산, 수익성 분석, 가격 최적화를 담당합니다. 인프라 비용, AI 사용료, 결제 수수료 등을 실시간으로 모니터링하고 관리자에게 보고합니다.',
        permissions: ['finance.view', 'cost.analyze', 'pricing.recommend', 'budget.manage'],
        preferredModels: ['gpt-4o', 'gpt-4-turbo'], maxConcurrentTasks: 3, budgetLimitUsd: 50,
        tools: ['cost.analyze', 'margin.calculate', 'pricing.recommend', 'budget.track'],
        systemPrompt: 'CFO system prompt' },
      { name: 'Backend Engineer', department: 'engineering', role: 'Senior Backend Engineer', title: 'Senior Backend Engineer',
        persona: '당신은 CloudPress의 시니어 백엔드 엔지니어입니다. Cloudflare Workers, D1, Durable Objects, TypeScript를 전문으로 합니다. API 설계, 데이터베이스 최적화, 백엔드 버그 수정을 담당합니다.',
        permissions: ['code.read', 'code.write', 'api.modify', 'db.query', 'worker.deploy'],
        preferredModels: ['gpt-4o', 'claude-3.5-sonnet', 'deepseek-coder'], maxConcurrentTasks: 4, budgetLimitUsd: 150,
        tools: ['file.read', 'file.write', 'code.analyze', 'test.run', 'db.query', 'api.test'],
        systemPrompt: 'Backend Engineer system prompt' },
      { name: 'Frontend Engineer', department: 'engineering', role: 'Frontend Engineer', title: 'Frontend Engineer',
        persona: '당신은 CloudPress의 프론트엔드 엔지니어입니다. Astro, React, Tailwind CSS, TypeScript를 전문으로 합니다. 관리자 대시보드, 게임형 AI 오피스 UI, 반응형 디자인을 담당합니다.',
        permissions: ['code.read', 'code.write', 'ui.modify', 'component.create', 'style.modify'],
        preferredModels: ['gpt-4o', 'claude-3.5-sonnet'], maxConcurrentTasks: 4, budgetLimitUsd: 150,
        tools: ['file.read', 'file.write', 'ui.analyze', 'component.create', 'style.modify', 'accessibility.check'],
        systemPrompt: 'Frontend Engineer system prompt' },
      { name: 'Security Engineer', department: 'security', role: 'Security Engineer', title: 'Security Engineer',
        persona: '당신은 CloudPress의 보안 엔지니어입니다. 취약점 스캔, 보안 설정 검증, SQL Injection/XSS/CSRF/SSRF 탐지, 권한 상승 차단, 프롬프트 인젝션 방어를 담당합니다.',
        permissions: ['security.scan', 'vulnerability.assess', 'code.audit', 'incident.respond'],
        preferredModels: ['gpt-4o', 'claude-3-opus', 'gpt-4-turbo'], maxConcurrentTasks: 3, budgetLimitUsd: 100,
        tools: ['security.scan', 'vulnerability.check', 'code.audit', 'penetration.test', 'secret.scan'],
        systemPrompt: 'Security Engineer system prompt' },
      { name: 'QA Engineer', department: 'engineering', role: 'QA Engineer', title: 'QA Engineer',
        persona: '당신은 CloudPress의 QA 엔지니어입니다. 단위 테스트, 통합 테스트, 회귀 테스트, API 테스트, 보안 테스트를 작성하고 실행합니다. 코드 품질을 검증하고 릴리스 전 검증을 수행합니다.',
        permissions: ['test.write', 'test.run', 'test.analyze', 'quality.gate'],
        preferredModels: ['gpt-4o', 'gpt-4-turbo'], maxConcurrentTasks: 5, budgetLimitUsd: 100,
        tools: ['test.write', 'test.run', 'coverage.analyze', 'mutation.test', 'regression.check'],
        systemPrompt: 'QA Engineer system prompt' },
      { name: 'Infrastructure Engineer', department: 'engineering', role: 'Infrastructure Engineer', title: 'Infrastructure Engineer',
        persona: '당신은 CloudPress의 인프라 엔지니어입니다. Cloudflare Workers, Containers, Queues, D1, R2, Durable Objects를 관리합니다. 컨테이너 오케스트레이션, 자동 스케일링, 헬스체크, 복구를 담당합니다.',
        permissions: ['infra.view', 'infra.modify', 'container.manage', 'scaling.configure', 'monitoring.configure'],
        preferredModels: ['gpt-4o', 'claude-3.5-sonnet'], maxConcurrentTasks: 3, budgetLimitUsd: 100,
        tools: ['container.status', 'scaling.adjust', 'health.check', 'log.analyze', 'metric.query'],
        systemPrompt: 'Infrastructure Engineer system prompt' },
      { name: 'Support Engineer', department: 'operations', role: 'Support Engineer', title: 'Support Engineer',
        persona: '당신은 CloudPress의 지원 엔지니어입니다. 고객 문의를 분석하고, 기술적 문제 해결, 답변 초안 작성, FAQ 업데이트, 기술 문서 작성을 담당합니다.',
        permissions: ['support.view', 'support.respond', 'faq.manage', 'document.write'],
        preferredModels: ['gpt-4o', 'gpt-4-turbo', 'claude-3.5-sonnet'], maxConcurrentTasks: 5, budgetLimitUsd: 50,
        tools: ['ticket.analyze', 'draft.response', 'faq.update', 'doc.write', 'knowledge.search'],
        systemPrompt: 'Support Engineer system prompt' },
      { name: 'Announcement Writer', department: 'marketing', role: 'Announcement Writer', title: 'Announcement Writer',
        persona: '당신은 CloudPress의 공지 작성자입니다. 서비스 업데이트, 점검 공지, 장애 공지, 릴리스 노트, 기술 블로그 글을 작성합니다. 사실 기반으로 작성하며 관리자 승인 후 게시합니다.',
        permissions: ['announcement.write', 'announcement.schedule', 'doc.write', 'content.review'],
        preferredModels: ['gpt-4o', 'claude-3.5-sonnet'], maxConcurrentTasks: 3, budgetLimitUsd: 30,
        tools: ['announcement.draft', 'release.notes', 'faq.generate', 'content.review', 'schedule.post'],
        systemPrompt: 'Announcement Writer system prompt' },
      { name: 'Data Analyst', department: 'operations', role: 'Data Analyst', title: 'Data Analyst',
        persona: '당신은 CloudPress의 데이터 분석가입니다. 비즈니스 메트릭, 사용자 행동, 비용 추이, 수익성 분석을 수행하고 대시보드와 리포트를 생성합니다.',
        permissions: ['data.query', 'report.generate', 'metric.analyze', 'dashboard.create'],
        preferredModels: ['gpt-4o', 'claude-3.5-sonnet'], maxConcurrentTasks: 3, budgetLimitUsd: 50,
        tools: ['sql.query', 'metric.calculate', 'chart.generate', 'report.write', 'anomaly.detect'],
        systemPrompt: 'Data Analyst system prompt' },
    ];

    for (const agent of defaultAgents) {
      const id = newId('emp');
      const fullAgent = { ...agent, id };
      await this.db.prepare(
        'INSERT INTO ai_employees(id, name, department, role, title, persona, permissions, preferred_models, max_concurrent_tasks, budget_limit_usd, tools, system_prompt, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).bind(
        id, fullAgent.name, fullAgent.department, fullAgent.role, fullAgent.title,
        fullAgent.persona, JSON.stringify(fullAgent.permissions), JSON.stringify(fullAgent.preferredModels),
        fullAgent.maxConcurrentTasks, fullAgent.budgetLimitUsd, JSON.stringify(fullAgent.tools),
        fullAgent.systemPrompt, 'active', nowIso(Date.now())
      ).run();

      this.agents.set(id, fullAgent);
      this.states.set(id, {
        id,
        status: 'idle',
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokensUsed: 0,
        totalCostMicro: 0,
        lastActiveAt: nowIso(Date.now()),
      });
    }
  }

  getAgent(id: string): AgentConfig | undefined { return this.agents.get(id); }
  getAllAgents(): AgentConfig[] { return Array.from(this.agents.values()); }
  getAgentsByDepartment(department: string): AgentConfig[] { return Array.from(this.agents.values()).filter(a => a.department === department); }
  getState(id: string): AgentState | undefined { return this.states.get(id); }
  getAllStates(): AgentState[] { return Array.from(this.states.values()); }

  async updateState(id: string, updates: Partial<AgentState>): Promise<void> {
    const state = this.states.get(id);
    if (state) {
      this.states.set(id, { ...state, ...updates, lastActiveAt: nowIso(Date.now()) });
      await this.db.prepare(
        'UPDATE ai_employees SET status = ?, tasks_completed = ?, tasks_failed = ?, total_tokens = ?, total_cost_micro = ?, last_active_at = ? WHERE id = ?'
      ).bind(updates.status || state.status, updates.tasksCompleted ?? state.tasksCompleted, updates.tasksFailed ?? state.tasksFailed, updates.totalTokensUsed ?? state.totalTokensUsed, updates.totalCostMicro ?? state.totalCostMicro, nowIso(Date.now()), id).run();
    }
  }

  async assignTask(agentId: string, taskId: string): Promise<boolean> {
    const state = this.states.get(agentId);
    const agent = this.agents.get(agentId);
    if (!state || !agent) return false;
    if (state.status !== 'idle' && state.status !== 'waiting') return false;
    state.status = 'busy'; state.currentTaskId = taskId; state.currentActivity = '작업 시작';
    await this.updateState(agentId, state); return true;
  }

  async completeTask(agentId: string, success: boolean, tokensUsed: number = 0, costMicro: number = 0): Promise<void> {
    const state = this.states.get(agentId);
    if (!state) return;
    state.status = 'idle'; state.currentTaskId = undefined; state.currentActivity = '대기 중';
    state.tasksCompleted += success ? 1 : 0; state.tasksFailed += success ? 0 : 1;
    state.totalTokensUsed += tokensUsed; state.totalCostMicro += costMicro;
    await this.updateState(agentId, state);
  }

  async setActivity(agentId: string, activity: string): Promise<void> {
    const state = this.states.get(agentId);
    if (state) { state.currentActivity = activity; await this.updateState(agentId, state); }
  }
}