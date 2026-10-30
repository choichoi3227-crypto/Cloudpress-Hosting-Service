import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { seedWorkforce, runTick, createTask, decideApproval, completeHumanTask, companyOverview, gatherMetrics, scrub, parseLoose, openAiCompat, setSetting, loadSettings, MockLlm, seedAgents, type ProviderFactory } from "../src/lib/workforce";

const NOW = Date.UTC(2026, 9, 28, 9);
const q = (raw: any, sql: string) => raw.prepare(sql).all() as any[];
const one = (raw: any, sql: string) => raw.prepare(sql).get() as any;

async function world(opts: { enable?: string[]; settings?: Record<string, string> } = {}) {
  const { db, raw } = makeDb();
  raw.exec("INSERT INTO users(id,email,password_hash) VALUES('adm','a@x.co','h')");
  await seedWorkforce(db, NOW);
  for (const p of opts.enable ?? ["workers-ai-fast", "workers-ai-strong"]) raw.exec(`UPDATE ai_providers SET enabled=1 WHERE name='${p}'`);
  for (const [k, v] of Object.entries(opts.settings ?? {})) await setSetting(db, "t", k, v, NOW);
  const llm = new MockLlm();
  const factory: ProviderFactory = () => llm;
  return { db, raw, llm, factory };
}
const noRoutines = (raw: any) => raw.exec("UPDATE ai_routines SET enabled = 0");

describe("조직 시드", () => {
  it("9개 부서, 임원 1 + 부서별 팀장·선임·사원, 외부 AI 는 기본 비활성, 멱등", async () => {
    const w = await world({ enable: [] });
    expect(q(w.raw, "select * from ai_departments")).toHaveLength(9);
    expect(q(w.raw, "select * from ai_agents")).toHaveLength(1 + 9 * 3);
    expect(q(w.raw, "select rank, count(*) n from ai_agents group by rank order by rank")).toEqual([{ rank: "director", n: 9 }, { rank: "executive", n: 1 }, { rank: "junior", n: 9 }, { rank: "senior", n: 9 }]);
    expect(q(w.raw, "select enabled from ai_providers where external=1").every((p: any) => p.enabled === 0)).toBe(true);
    await seedWorkforce(w.db, NOW + 1);
    expect(q(w.raw, "select * from ai_agents")).toHaveLength(28);
    expect(seedAgents().every((a) => a.persona.length > 10)).toBe(true);
  });
});

describe("실행 엔진", () => {
  it("꺼져 있거나 일시정지면 아무것도 하지 않고, 간격 전에는 not_due", async () => {
    const w = await world();
    expect((await runTick(w.db, w.factory, NOW)).skipped).toBe("disabled");
    await setSetting(w.db, "t", "workforce_enabled", "true", NOW);
    await setSetting(w.db, "t", "workforce_paused", "true", NOW);
    expect((await runTick(w.db, w.factory, NOW)).skipped).toBe("paused");
    await setSetting(w.db, "t", "workforce_paused", "false", NOW);
    noRoutines(w.raw);
    expect((await runTick(w.db, w.factory, NOW)).skipped).toBeUndefined();
    expect((await runTick(w.db, w.factory, NOW + 60_000)).skipped).toBe("not_due");
    expect((await runTick(w.db, w.factory, NOW + 31 * 60_000)).skipped).toBeUndefined();
    expect(w.llm.calls).toHaveLength(0);
  });
  it("기본 업무: 사원이 작업 → 선임이 검토·승인 → 완료, 회의는 열지 않는다(팀플은 필요할 때만)", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    const id = await createTask(w.db, "adm", { department: "finance", title: "마진 점검", priority: 5 }, NOW);
    const r = await runTick(w.db, w.factory, NOW);
    expect(r).toMatchObject({ tasksProcessed: 1, meetings: 0 });
    expect(one(w.raw, `select status s, assignee_agent_id a from ai_tasks where id='${id}'`)).toEqual({ s: "done", a: "agent-finance-jun" });
    expect(q(w.raw, "select phase, agent_id from ai_runs order by ts, rowid").map((x: any) => [x.phase, x.agent_id])).toEqual([["work", "agent-finance-jun"], ["review", "agent-finance-sen"]]);
    expect(q(w.raw, "select * from ai_meetings")).toHaveLength(0);
    expect(one(w.raw, "select tasks_done n, status s from ai_agents where id='agent-finance-jun'")).toEqual({ n: 1, s: "idle" });
    expect(q(w.raw, "select kind from ai_activity order by rowid").map((a: any) => a.kind)).toEqual(["task_start", "review", "task_done"]);
  });
  it("우선순위 8 이상은 선임, 선임의 검토자는 팀장, 팀장 업무의 검토자는 임원(COO)", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    const id = await createTask(w.db, "adm", { department: "security", title: "긴급 점검", priority: 9 }, NOW);
    await runTick(w.db, w.factory, NOW);
    expect(one(w.raw, `select assignee_agent_id a from ai_tasks where id='${id}'`).a).toBe("agent-security-sen");
    expect(one(w.raw, "select agent_id a from ai_runs where phase='review'").a).toBe("agent-security-dir");
    w.raw.exec("UPDATE ai_agents SET status='paused' WHERE id IN ('agent-legal-jun','agent-legal-sen')");
    const id2 = await createTask(w.db, "adm", { department: "legal", title: "팀장 직접 처리", priority: 5 }, NOW);
    await runTick(w.db, w.factory, NOW + 3_600_000, { force: true });
    expect(one(w.raw, `select assignee_agent_id a from ai_tasks where id='${id2}'`).a).toBe("agent-legal-dir");
    expect(one(w.raw, "select agent_id a from ai_runs where phase='review' order by ts desc, rowid desc limit 1").a).toBe("agent-coo");
  });
  it("검토에서 수정 요청 → 재작성(피드백 반영), 2회 반복되면 운영자 승인 대기열로 에스컬레이션", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    let reviews = 0;
    w.llm.script = (_s, u) => u.includes('"verdict"') ? (++reviews <= 3 ? '{"verdict":"revise","feedback":"근거 부족"}' : null) : null;
    const id = await createTask(w.db, "adm", { department: "data", title: "추세", priority: 5 }, NOW);
    await runTick(w.db, w.factory, NOW);
    expect(one(w.raw, `select status s, revisions r from ai_tasks where id='${id}'`)).toEqual({ s: "needs_human", r: 3 });
    expect(q(w.raw, "select kind, status from ai_approvals")).toEqual([{ kind: "escalation", status: "pending" }]);
    expect(w.llm.calls.some((c) => c.user.includes("근거 부족"))).toBe(true); // 피드백이 다음 작성에 전달됨
  });
  it("협의가 필요하다고 한 경우에만 회의: 팀장들 발언 → 의장 결론 → 후속 업무 생성, 승인 필요한 행동은 대기열", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    w.llm.script = (_s, u) => {
      if (u.includes("결론을 이 JSON")) return '{"decision":"가격 인상 보류, 원가 재측정","follow_up_tasks":[{"department":"data","title":"원가 재측정","detail":"d","priority":6}],"proposed_actions":[{"kind":"pricing","title":"가격 조정","detail":"x","risk":"high"}]}';
      if (u.includes("[회의 안건]")) return "재무 관점 의견";
      if (u.includes('"verdict"')) return null;
      return u.includes("가격 검토") ? '{"summary":"협의 필요","deliverable":"x","needs_collab":["finance","legal","nope"]}' : null;
    };
    const id = await createTask(w.db, "adm", { department: "growth", title: "가격 검토", priority: 5 }, NOW);
    const r = await runTick(w.db, w.factory, NOW);
    expect(r.meetings).toBe(1);
    const m = one(w.raw, "select * from ai_meetings");
    expect(m).toMatchObject({ status: "done", decision: "가격 인상 보류, 원가 재측정", chair_agent_id: "agent-finance-dir" === m.chair_agent_id ? "agent-finance-dir" : m.chair_agent_id });
    expect(q(w.raw, "select agent_id from ai_meeting_messages")).toHaveLength(3); // 요청자 + finance 팀장 + legal 팀장(없는 부서는 제외)
    expect(one(w.raw, `select status s from ai_tasks where id='${id}'`).s).toBe("done");
    expect(q(w.raw, "select title, source, depth from ai_tasks where source='meeting'")).toEqual([{ title: "원가 재측정", source: "meeting", depth: 1 }]);
    expect(q(w.raw, "select kind, risk, status from ai_approvals")).toEqual([{ kind: "pricing", risk: "high", status: "pending" }]);
    expect(q(w.raw, "select status from ai_agents where status != 'idle'")).toHaveLength(0); // 회의 후 모두 복귀
  });
  it("제안된 실제 행동은 승인 전까지 실행되지 않고, 승인하면 '사람이 할 일'이 생긴다. 반려/중복 처리 거부", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    w.llm.script = (_s, u) => u.includes('"verdict"') ? null : u.includes("광고 집행") ? '{"summary":"s","deliverable":"d","proposed_actions":[{"kind":"spend","title":"광고비 $50 집행","detail":"x","risk":"medium"},{"kind":"???","title":"기타","risk":"???"}],"follow_up_tasks":[{"department":"ghost","title":"무시됨"}]}' : null;
    await createTask(w.db, "adm", { department: "growth", title: "광고 집행 검토" }, NOW);
    await runTick(w.db, w.factory, NOW);
    const ap = q(w.raw, "select id, kind, risk from ai_approvals order by rowid");
    expect(ap.map((a: any) => [a.kind, a.risk])).toEqual([["spend", "medium"], ["other", "high"]]); // 잘못된 값은 안전한 기본값(high)
    expect(q(w.raw, "select * from ai_tasks where title='무시됨'")).toHaveLength(0);
    await decideApproval(w.db, "adm", ap[0].id, true, "OK", NOW);
    expect(one(w.raw, "select title, assignee_human h, status s from ai_tasks where title like '승인된 조치%'")).toMatchObject({ h: 1, s: "needs_human" });
    await decideApproval(w.db, "adm", ap[1].id, false, "불필요", NOW);
    await expect(decideApproval(w.db, "adm", ap[0].id, false, "", NOW)).rejects.toMatchObject({ code: "bad_state" });
    await expect(decideApproval(w.db, "adm", "ghost", true, "", NOW)).rejects.toMatchObject({ code: "not_found" });
    const human = one(w.raw, "select id from ai_tasks where assignee_human=1");
    await completeHumanTask(w.db, "adm", human.id, NOW);
    await expect(completeHumanTask(w.db, "adm", human.id, NOW)).rejects.toMatchObject({ code: "not_found" });
  });
  it("루틴 업무는 간격마다 한 번만 생성된다", async () => {
    const w = await world({ settings: { workforce_enabled: "true", workforce_max_tasks_per_tick: "1" } });
    const r1 = await runTick(w.db, w.factory, NOW, { force: true });
    expect(r1.routinesCreated).toBe(9);
    const r2 = await runTick(w.db, w.factory, NOW + 3_600_000, { force: true });
    expect(r2.routinesCreated).toBe(0); // 간격(최소 6시간) 미경과
    expect(q(w.raw, "select * from ai_tasks where source='routine'")).toHaveLength(9);
    expect(r1.tasksProcessed).toBe(1); // 틱당 처리 상한
  });
});

describe("공급자 선택·안전장치", () => {
  it("기밀 업무는 외부 AI 로 보내지 않고, 외부로 가는 텍스트는 개인정보가 지워진다", async () => {
    const ext = new MockLlm(), cf = new MockLlm();
    const w = await world({ enable: ["workers-ai-fast", "groq-free"], settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    w.raw.exec("UPDATE ai_agents SET provider_pref='groq-free' WHERE id='agent-support-jun'");
    const factory: ProviderFactory = (r) => (r.external ? ext : cf);
    await createTask(w.db, "adm", { department: "support", title: "문의 안내", detail: "고객 kim@example.com 연락처 010-1234-5678 키 cpai_abcdefghij1234567890", confidential: true }, NOW);
    await runTick(w.db, factory, NOW);
    expect(ext.calls).toHaveLength(0);       // 기밀 → 외부 금지
    expect(cf.calls.length).toBeGreaterThan(0);
    await createTask(w.db, "adm", { department: "support", title: "일반 안내", detail: "고객 kim@example.com 연락처 010-1234-5678 키 cpai_abcdefghij1234567890" }, NOW);
    await runTick(w.db, factory, NOW + 3_600_000, { force: true });
    expect(ext.calls.length).toBeGreaterThan(0);
    const sent = ext.calls.map((c) => c.user).join("\n");
    expect(sent).not.toContain("kim@example.com"); expect(sent).not.toContain("1234-5678"); expect(sent).not.toContain("cpai_abcdefghij");
  });
  it("상위 직위는 상위 모델 우선, 공급자 실패 시 다음 공급자로 폴백하고 실패 기록", async () => {
    const w = await world({ enable: ["workers-ai-strong", "workers-ai-fast"], settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    const used: string[] = [];
    const factory: ProviderFactory = (r) => ({ complete: async (s, u) => { used.push(r.name); if (r.name === "workers-ai-strong") throw new Error("HTTP 429"); return new MockLlm().complete(s, u); } });
    await createTask(w.db, "adm", { department: "finance", title: "t" }, NOW);
    await runTick(w.db, factory, NOW);
    expect(used.slice(0, 2)).toEqual(["workers-ai-fast", "workers-ai-fast"]); // 사원·선임은 경량 우선
    used.length = 0;
    w.raw.exec("UPDATE ai_agents SET status='paused' WHERE id IN ('agent-data-jun','agent-data-sen')");
    await createTask(w.db, "adm", { department: "data", title: "팀장 직접" }, NOW);
    await runTick(w.db, factory, NOW + 3_600_000, { force: true });
    expect(used[0]).toBe("workers-ai-strong"); // 팀장은 상위 모델 우선 → 429 → 경량으로 폴백
    expect(used[1]).toBe("workers-ai-fast");
    const failed = q(w.raw, "select error from ai_runs where ok=0");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f: any) => f.error === "HTTP 429")).toBe(true); // 실패는 기록되고 업무는 폴백으로 완료됨
    expect(q(w.raw, "select status from ai_tasks").every((t: any) => t.status === "done")).toBe(true);
  });
  it("활성 공급자가 없거나 일일 한도를 넘으면 업무를 잃지 않고 대기열에 남긴다", async () => {
    const w = await world({ enable: [], settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    const id = await createTask(w.db, "adm", { department: "data", title: "t" }, NOW);
    const r = await runTick(w.db, w.factory, NOW);
    expect(r.errors[0]).toContain("AI 공급자");
    expect(one(w.raw, `select status s from ai_tasks where id='${id}'`).s).toBe("queued");
    w.raw.exec("UPDATE ai_providers SET enabled=1 WHERE name='workers-ai-fast'");
    await setSetting(w.db, "t", "workforce_daily_run_cap", "10", NOW);
    for (let i = 0; i < 10; i++) w.raw.exec(`INSERT INTO ai_runs(id,agent_id,phase,provider,ok,ts) VALUES('x${i}','agent-coo','work','workers-ai-fast',1,'${new Date(NOW).toISOString()}')`);
    const r2 = await runTick(w.db, w.factory, NOW + 3_600_000, { force: true });
    expect(r2.errors[0]).toContain("daily_run_cap");
    expect(one(w.raw, `select status s from ai_tasks where id='${id}'`).s).toBe("queued");
  });
  it("LLM 이 형식을 못 지켜도(일반 텍스트) 업무는 처리된다", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    w.llm.script = (_s, u) => (u.includes('"verdict"') ? "좋아 보입니다" : "JSON 이 아닌 그냥 답변입니다.");
    const id = await createTask(w.db, "adm", { department: "data", title: "t" }, NOW);
    await runTick(w.db, w.factory, NOW);
    expect(one(w.raw, `select status s, result_summary r from ai_tasks where id='${id}'`)).toEqual({ s: "done", r: "JSON 이 아닌 그냥 답변입니다." });
  });
});

describe("유틸·현황", () => {
  it("scrub / parseLoose / openAiCompat 주소 검증", async () => {
    expect(scrub("a@b.co +82 10-1234-5678 4111 1111 1111 1111 Bearer abcdefghijkl")).toBe("[이메일] [전화] [번호] Bearer [토큰]");
    expect(parseLoose('설명 {"a":1} 끝')).toEqual({ a: 1 });
    expect(parseLoose("그냥 글")._unstructured).toBe(true);
    expect(() => openAiCompat("http://api.example.com", "m", "k")).toThrow();
    expect(() => openAiCompat("https://localhost/v1", "m", "k")).toThrow();
    expect(() => openAiCompat("https://10.0.0.1/v1", "m", "k")).toThrow();
    const f = async (url: any, init: any) => ({ ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), _u: url, _i: init }) as any;
    expect(await openAiCompat("https://api.example.com/v1/", "m", "k", f).complete("s", "u")).toEqual({ text: "hi", inputTokens: 3, outputTokens: 2 });
  });
  it("회사 지표는 실제 DB 값, 개요에 부서·에이전트·승인·공급자 사용량이 포함된다", async () => {
    const w = await world({ settings: { workforce_enabled: "true" } }); noRoutines(w.raw);
    w.raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','c@x.co','h')");
    w.raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('p1','ccs','CCS')");
    w.raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr1','p1',1,12990000)");
    w.raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,status) VALUES('s1','u1','p1','pr1','active'),('s2','u1','p1','pr1','past_due')");
    expect(await gatherMetrics(w.db, NOW)).toMatchObject({ users: 2, activeSubscriptions: 1, mrrUsd: 12.99, pastDueSubscriptions: 1, subscriptionsByKind: { ccs: 1 }, aiMarginPct: null });
    await createTask(w.db, "adm", { department: "finance", title: "개요 테스트" }, NOW);
    await runTick(w.db, w.factory, NOW);
    const o = await companyOverview(w.db, NOW);
    expect(o.departments).toHaveLength(9);
    expect(o.departments.find((d: any) => d.id === "finance")!.agents).toHaveLength(3);
    expect(o.departments.find((d: any) => d.id === "finance")!.tasks).toEqual({ done: 1 });
    expect(o.providers.find((p: any) => p.name === "workers-ai-fast")).toMatchObject({ enabled: true, usedToday: 2 });
    expect(o.goals.find((g: any) => g.metric === "active_subscriptions")).toMatchObject({ current: 1, progressPct: 10 });
    expect(o.totals.runsToday).toBe(2);
    expect((await loadSettings(w.db)).maxTasksPerTick).toBe(3);
  });
  it("업무 생성 검증", async () => {
    const w = await world();
    await expect(createTask(w.db, "adm", { department: "finance", title: "  " }, NOW)).rejects.toMatchObject({ code: "bad_title" });
    await expect(createTask(w.db, "adm", { department: "ghost", title: "x" }, NOW)).rejects.toMatchObject({ code: "bad_department" });
    const id = await createTask(w.db, "adm", { department: "legal", title: "계약 서명", human: true, priority: 99 }, NOW);
    expect(one(w.raw, `select status s, assignee_human h, priority p from ai_tasks where id='${id}'`)).toEqual({ s: "needs_human", h: 1, p: 9 }); // 사람 업무는 AI 가 집지 않는다
  });
});
