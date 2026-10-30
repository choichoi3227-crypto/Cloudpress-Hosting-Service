const usd = (m: number | null | undefined) => (m == null ? '-' : '$' + (m / 1_000_000).toFixed(m % 10_000 === 0 ? 2 : 4));
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = (id: string) => document.getElementById(id)!;
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, data: await res.json().catch(() => ({})) as any };
}
const say = (m: string) => { const e = $('admin-ai-msg'); e.textContent = m; e.classList.remove('hidden'); };

export async function initAdminAi(): Promise<void> {
  async function load() {
    const r = await api('/api/admin/cas/overview');
    if (!r.ok) { say('불러오지 못했습니다: ' + (r.data.error ?? '')); return; }
    const kill = $('kill-btn'); kill.textContent = r.data.killSwitch ? '차단 해제' : '긴급 차단'; kill.dataset.on = r.data.killSwitch ? '1' : '0';
    $('admin-ai-rows').innerHTML = r.data.models.map((m: any) => `
      <tr class="border-t border-gray-100 dark:border-slate-800">
        <td class="p-3"><div class="font-medium">${esc(m.name)}</div><div class="text-xs text-gray-500 break-all">${esc(m.model_id)} · ${esc(m.task_type)}</div></td>
        <td><select data-tier="${esc(m.id)}" class="border rounded px-2 py-1 bg-white dark:bg-slate-800">${['general', 'performance', 'premium'].map((t) => `<option value="${t}" ${t === m.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td>${m.i ?? '-'} / ${m.o ?? '-'}${m.u ? ' · 단위 ' + m.u : ''} <span class="text-xs text-gray-500">(${esc(m.pricing_source)})</span></td>
        <td>${usd(m.sell)}</td><td>${m.requests}</td><td>${usd(m.billed)}</td><td>${usd(m.cost)}</td>
        <td>${m.official_status === 'removed' ? '공식 제거' : m.enabled ? '<span class="text-green-600">판매 중</span>' : '비활성'}${m.official_status === 'deprecating' ? ' <span class="text-amber-600">폐기 예정</span>' : ''}</td>
        <td>${m.official_status === 'removed' ? '' : `<button data-toggle="${esc(m.id)}" data-enabled="${m.enabled}" class="text-primary hover:underline">${m.enabled ? '비활성화' : '활성화'}</button>`}</td>
      </tr>`).join('');
  }
  $('sync-btn').addEventListener('click', async () => { const r = await api('/api/admin/cas/sync', 'POST'); say(r.ok ? `동기화 완료(${r.data.mode}): 확인 ${r.data.seen}, 신규 ${r.data.added}, 갱신 ${r.data.updated}, 제거 ${r.data.removed}` : r.data.message || r.data.error); await load(); });
  $('kill-btn').addEventListener('click', async () => { const on = $('kill-btn').dataset.on !== '1'; if (on && !confirm('모든 고객의 AI 호출을 즉시 중지할까요?')) return; await api('/api/admin/cas/kill', 'POST', { on }); await load(); });
  document.body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement; const id = t.getAttribute('data-toggle');
    if (!id) return;
    const r = await api(`/api/admin/cas/models/${encodeURIComponent(id)}`, 'PATCH', { enabled: t.getAttribute('data-enabled') !== '1' });
    if (!r.ok) say(r.data.message || r.data.error); await load();
  });
  document.body.addEventListener('change', async (e) => {
    const t = e.target as HTMLSelectElement; const id = t.getAttribute('data-tier');
    if (!id) return;
    const r = await api(`/api/admin/cas/models/${encodeURIComponent(id)}`, 'PATCH', { tier: t.value });
    if (!r.ok) say(r.data.message || r.data.error); await load();
  });
  await load();
}
