// 운영자 전용 AI 회사 현황 대시보드. 모든 값은 서버(DB)에서 받아 escape 후 표시한다.
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = (id: string) => document.getElementById(id)!;
const RANK: Record<string, { ko: string; cls: string }> = {
  executive: { ko: '임원', cls: 'bg-purple-100 text-purple-800' }, director: { ko: '팀장', cls: 'bg-blue-100 text-blue-800' },
  senior: { ko: '선임', cls: 'bg-teal-100 text-teal-800' }, junior: { ko: '사원', cls: 'bg-gray-100 text-gray-700' },
};
const STATE: Record<string, { ko: string; dot: string }> = {
  idle: { ko: '대기', dot: 'bg-gray-300' }, working: { ko: '업무 중', dot: 'bg-green-500 animate-pulse' }, reviewing: { ko: '검토 중', dot: 'bg-blue-500 animate-pulse' },
  meeting: { ko: '회의 중', dot: 'bg-purple-500 animate-pulse' }, paused: { ko: '중지', dot: 'bg-red-500' },
};
const TASK_ST: Record<string, { ko: string; bar: string }> = {
  queued: { ko: '대기', bar: 'bg-gray-300' }, in_progress: { ko: '진행', bar: 'bg-green-500' }, in_review: { ko: '검토', bar: 'bg-blue-500' },
  done: { ko: '완료', bar: 'bg-emerald-600' }, blocked: { ko: '막힘', bar: 'bg-red-500' }, needs_human: { ko: '사람 필요', bar: 'bg-amber-500' }, cancelled: { ko: '취소', bar: 'bg-gray-400' },
};
const KIND: Record<string, { icon: string; cls: string }> = {
  task_start: { icon: '▶', cls: 'text-green-600' }, task_done: { icon: '✔', cls: 'text-emerald-700' }, review: { icon: '👁', cls: 'text-blue-600' },
  revise: { icon: '↺', cls: 'text-amber-600' }, meeting: { icon: '👥', cls: 'text-purple-600' }, approval: { icon: '✋', cls: 'text-amber-700' },
  escalate: { icon: '⚠', cls: 'text-red-600' }, error: { icon: '✖', cls: 'text-red-600' }, system: { icon: '•', cls: 'text-gray-500' },
};
const RISK: Record<string, string> = { low: 'bg-green-100 text-green-800', medium: 'bg-amber-100 text-amber-800', high: 'bg-red-100 text-red-800' };
const KIND_KO: Record<string, string> = { spend: '지출', deploy: '배포', pricing: '가격', customer_contact: '고객 연락', legal: '법무', escalation: '검토 불통과', other: '기타' };

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, data: await res.json().catch(() => ({})) as any };
}
const say = (m: string) => { const e = $('wf-msg'); e.textContent = m; e.classList.remove('hidden'); };
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? '방금' : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`; };

export async function initCompany(): Promise<void> {
  let deptOptions = '';
  async function load() {
    const r = await api('/api/admin/company/overview');
    if (!r.ok) { say('불러오지 못했습니다: ' + (r.data.error ?? '')); return; }
    const o = r.data;
    const st = o.settings;
    const pill = $('wf-pill');
    pill.textContent = st.paused ? '⏸ 일시정지' : st.enabled ? '● 가동 중' : '○ 꺼짐';
    pill.className = 'px-3 py-1 rounded-full text-sm font-medium ' + (st.paused ? 'bg-red-100 text-red-800' : st.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700');
    $('wf-toggle').textContent = st.enabled ? 'AI 직원 끄기' : 'AI 직원 켜기';
    $('wf-pause').textContent = st.paused ? '재개' : '긴급 일시정지';
    const m = o.metrics;
    const kpi = (label: string, value: string, tone = '') => `<div class="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 p-4"><div class="text-xs text-gray-500">${label}</div><div class="text-2xl font-bold ${tone}">${value}</div></div>`;
    $('kpis').innerHTML = kpi('활성 구독', String(m.activeSubscriptions)) + kpi('월 반복 매출', '$' + m.mrrUsd.toFixed(2)) + kpi('가입자', String(m.users))
      + kpi('AI 마진(30일)', m.aiMarginPct === null ? '-' : m.aiMarginPct + '%') + kpi('승인 대기', String(m.pendingApprovals), m.pendingApprovals ? 'text-amber-600' : '')
      + kpi('작업 오류(dead)', String(m.deadJobs), m.deadJobs ? 'text-red-600' : '');
    $('goals').innerHTML = o.goals.filter((g: any) => g.status === 'active').map((g: any) => `
      <div class="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 p-4">
        <div class="flex justify-between text-sm"><span class="font-medium">🎯 ${esc(g.title)}</span><span class="text-gray-500">${g.current ?? '-'} / ${g.target}</span></div>
        <div class="h-2 mt-2 rounded bg-gray-100 dark:bg-slate-800 overflow-hidden"><div class="h-2 bg-primary" style="width:${g.progressPct ?? 0}%"></div></div></div>`).join('');

    $('apr-count').textContent = o.approvals.length ? `(${o.approvals.length})` : '';
    $('approvals').innerHTML = o.approvals.length ? o.approvals.map((a: any) => `
      <div class="p-4 text-sm">
        <div class="flex flex-wrap items-center gap-2"><span class="px-2 py-0.5 rounded ${RISK[a.risk] ?? ''}">위험 ${esc(a.risk)}</span><span class="px-2 py-0.5 rounded bg-gray-100 text-gray-700">${esc(KIND_KO[a.kind] ?? a.kind)}</span><span class="font-medium">${esc(a.title)}</span></div>
        <p class="mt-1 text-gray-600 dark:text-gray-400 whitespace-pre-wrap">${esc(a.detail)}</p>
        <div class="mt-2 flex items-center gap-2"><span class="text-xs text-gray-500">${esc(a.agent_title ?? '')} ${esc(a.agent_name ?? '')} · ${ago(a.created_at)}</span><span class="flex-1"></span>
          <button data-apr="${esc(a.id)}" data-ok="1" class="px-3 py-1 rounded bg-green-600 text-white">승인</button><button data-apr="${esc(a.id)}" data-ok="0" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">반려</button></div>
      </div>`).join('') : '<p class="p-4 text-sm text-gray-500">대기 중인 승인이 없습니다. 👍</p>';
    $('human').innerHTML = o.humanTasks.length ? o.humanTasks.map((t: any) => `
      <div class="p-4 text-sm"><div class="font-medium">${esc(t.title)}</div><div class="text-gray-500 whitespace-pre-wrap">${esc(t.detail)}</div>
        <button data-done="${esc(t.id)}" class="mt-2 px-3 py-1 rounded bg-primary text-white">완료</button></div>`).join('') : '<p class="p-4 text-sm text-gray-500">지금 대표님이 할 일은 없습니다.</p>';

    deptOptions = o.departments.map((d: any) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    if (!($('t-dept') as HTMLSelectElement).options.length) $('t-dept').innerHTML = deptOptions;
    $('depts').innerHTML = o.departments.map((d: any) => {
      const total = Object.values(d.tasks).reduce((a: number, b: any) => a + b, 0) as number;
      const bar = total ? Object.entries(d.tasks).map(([k, n]: any) => `<div class="${TASK_ST[k]?.bar ?? 'bg-gray-300'}" style="width:${(n / total) * 100}%" title="${esc(TASK_ST[k]?.ko ?? k)} ${n}"></div>`).join('') : '';
      const legend = Object.entries(d.tasks).map(([k, n]: any) => `${esc(TASK_ST[k]?.ko ?? k)} ${n}`).join(' · ');
      return `<div class="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 p-4">
        <div class="font-semibold">${esc(d.name)}</div><div class="text-xs text-gray-500 mb-2">${esc(d.mission)}</div>
        <div class="flex h-2 rounded overflow-hidden bg-gray-100 dark:bg-slate-800">${bar}</div><div class="text-xs text-gray-500 mt-1 mb-3">${legend || '업무 없음'}</div>
        <ul class="space-y-1">${d.agents.map((a: any) => `<li class="flex items-center gap-2 text-sm"><span class="w-2.5 h-2.5 rounded-full ${STATE[a.status]?.dot ?? 'bg-gray-300'}"></span>
          <span class="px-1.5 rounded text-xs ${RANK[a.rank]?.cls ?? ''}">${RANK[a.rank]?.ko ?? a.rank}</span><span class="font-medium">${esc(a.name)}</span>
          <span class="text-xs text-gray-500">${esc(STATE[a.status]?.ko ?? a.status)} · 완료 ${a.tasks_done}</span><span class="flex-1"></span>
          <button data-pause="${esc(a.id)}" data-p="${a.status === 'paused' ? '0' : '1'}" class="text-xs text-gray-400 hover:text-red-600">${a.status === 'paused' ? '재개' : '중지'}</button></li>`).join('')}</ul></div>`;
    }).join('');

    $('activity').innerHTML = o.activity.length ? o.activity.map((a: any) => `<li class="flex gap-2"><span class="${KIND[a.kind]?.cls ?? ''} w-5 text-center">${KIND[a.kind]?.icon ?? '•'}</span><span class="flex-1">${esc(a.message)}</span><span class="text-xs text-gray-400 whitespace-nowrap">${ago(a.ts)}</span></li>`).join('') : '<li class="text-gray-500">아직 활동이 없습니다. "AI 직원 켜기" 후 "지금 실행"을 눌러 보세요.</li>';
    $('tasks').innerHTML = o.recentTasks.map((t: any) => `<tr class="border-t border-gray-100 dark:border-slate-800"><td class="p-3"><div class="font-medium">${esc(t.title)}</div><div class="text-xs text-gray-500">${esc(t.result_summary ?? '')}</div></td>
      <td class="whitespace-nowrap text-xs">${esc(o.departments.find((d: any) => d.id === t.department_id)?.name ?? '')}</td><td class="text-xs">${esc(t.agent_name ?? '-')}</td>
      <td class="pr-3"><span class="px-2 py-0.5 rounded text-xs text-white ${TASK_ST[t.status]?.bar ?? 'bg-gray-400'}">${esc(TASK_ST[t.status]?.ko ?? t.status)}</span></td></tr>`).join('') || '<tr><td class="p-4 text-gray-500">업무가 없습니다.</td></tr>';
    $('meetings').innerHTML = o.meetings.length ? o.meetings.map((x: any) => `<div class="p-3"><div class="font-medium">${esc(x.topic)}</div><div class="text-xs text-gray-500">의장 ${esc(x.chair ?? '-')} · ${esc(x.status)} · ${ago(x.created_at)}</div><div class="text-gray-600 dark:text-gray-400">${esc(x.decision ?? '')}</div></div>`).join('') : '<p class="p-3 text-gray-500">부서 간 협의가 필요한 업무가 생기면 자동으로 열립니다.</p>';
    $('providers').innerHTML = o.providers.map((p: any) => {
      const pct = p.dailyLimit ? Math.min(100, Math.round((p.usedToday / p.dailyLimit) * 100)) : 0;
      return `<div class="border border-gray-200 dark:border-slate-800 rounded-lg p-3 text-sm">
        <div class="flex items-center gap-2"><span class="font-medium">${esc(p.name)}</span><span class="px-1.5 rounded text-xs ${p.external ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}">${p.external ? '외부' : 'Cloudflare'}</span>${p.strong ? '<span class="px-1.5 rounded text-xs bg-purple-100 text-purple-800">상위</span>' : ''}<span class="flex-1"></span>
          <button data-prov="${esc(p.name)}" data-en="${p.enabled ? '0' : '1'}" data-ext="${p.external ? '1' : '0'}" class="px-3 py-1 rounded ${p.enabled ? 'bg-green-600 text-white' : 'bg-gray-200 dark:bg-slate-700'}">${p.enabled ? '사용 중' : '꺼짐'}</button></div>
        <div class="text-xs text-gray-500 break-all mt-1">${esc(p.model)}${p.configured === false ? ' · ⚠ 키(Secret) 미등록' : ''}</div>
        <div class="h-1.5 mt-2 rounded bg-gray-100 dark:bg-slate-800 overflow-hidden"><div class="h-1.5 ${pct > 85 ? 'bg-red-500' : 'bg-primary'}" style="width:${pct}%"></div></div>
        <div class="text-xs text-gray-500 mt-1">오늘 ${p.usedToday} / ${p.dailyLimit}회 · ${esc(p.note ?? '')}</div></div>`;
    }).join('');
    window.__company = o.settings;
  }

  $('wf-toggle').addEventListener('click', async () => { const s = (window as any).__company; await api('/api/admin/company/settings', 'POST', { enabled: !s.enabled }); await load(); });
  $('wf-pause').addEventListener('click', async () => { const s = (window as any).__company; if (!s.paused && !confirm('모든 AI 직원의 자동 실행을 즉시 멈출까요?')) return; await api('/api/admin/company/settings', 'POST', { paused: !s.paused }); await load(); });
  $('wf-tick').addEventListener('click', async () => {
    const b = $('wf-tick') as HTMLButtonElement; b.disabled = true; b.textContent = '실행 중...';
    const r = await api('/api/admin/company/tick', 'POST');
    say(r.ok ? (r.data.skipped ? `건너뜀: ${r.data.skipped}` : `처리 ${r.data.tasksProcessed}건, 회의 ${r.data.meetings}회, 승인 요청 ${r.data.approvalsCreated}건${r.data.errors?.length ? ' · 오류: ' + r.data.errors[0] : ''}`) : (r.data.message || r.data.error));
    b.disabled = false; b.textContent = '지금 실행'; await load();
  });
  $('t-submit').addEventListener('click', async () => {
    const r = await api('/api/admin/company/tasks', 'POST', { department: ($('t-dept') as HTMLSelectElement).value, title: ($('t-title') as HTMLInputElement).value, detail: ($('t-detail') as HTMLTextAreaElement).value,
      priority: Number(($('t-prio') as HTMLInputElement).value), confidential: ($('t-conf') as HTMLInputElement).checked, human: ($('t-human') as HTMLInputElement).checked });
    if (r.ok) { ($('t-title') as HTMLInputElement).value = ''; ($('t-detail') as HTMLTextAreaElement).value = ''; say('업무를 등록했습니다.'); await load(); } else say(r.data.message || r.data.error);
  });
  document.body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const apr = t.getAttribute('data-apr'), done = t.getAttribute('data-done'), pause = t.getAttribute('data-pause'), prov = t.getAttribute('data-prov');
    if (apr) { const ok = t.getAttribute('data-ok') === '1'; const note = prompt(ok ? '승인 메모(선택)' : '반려 사유(선택)') ?? ''; const r = await api(`/api/admin/company/approvals/${encodeURIComponent(apr)}/decide`, 'POST', { approve: ok, note }); if (!r.ok) say(r.data.message || r.data.error); await load(); }
    if (done) { await api(`/api/admin/company/tasks/${encodeURIComponent(done)}/complete`, 'POST'); await load(); }
    if (pause) { await api(`/api/admin/company/agents/${encodeURIComponent(pause)}/pause`, 'POST', { paused: t.getAttribute('data-p') === '1' }); await load(); }
    if (prov) {
      const en = t.getAttribute('data-en') === '1'; const ext = t.getAttribute('data-ext') === '1';
      if (en && ext && !confirm('외부 무료 AI 를 켜면 (개인정보를 지운) 업무 텍스트가 해당 사업자로 전송됩니다. 무료 한도·약관을 확인하셨나요?')) return;
      const r = await api(`/api/admin/company/providers/${encodeURIComponent(prov)}`, 'PATCH', { enabled: en, acknowledgeExternal: ext && en ? true : undefined });
      if (!r.ok) say(r.data.message || r.data.error); await load();
    }
  });
  await load();
  setInterval(load, 15000);
}
declare global { interface Window { __company?: unknown } }
