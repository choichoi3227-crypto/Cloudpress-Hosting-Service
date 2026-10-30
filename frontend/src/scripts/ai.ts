const usd = (m: number | null | undefined) => (m == null ? '-' : '$' + (m / 1_000_000).toFixed(m % 10_000 === 0 ? 2 : 4));
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tierLabel: Record<string, string> = { general: '일반', performance: '고성능', premium: '프리미엄' };
const $ = (id: string) => document.getElementById(id)!;
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}
const show = (id: string, msg: string | null) => { const e = $(id); e.textContent = msg ?? ''; e.classList.toggle('hidden', !msg); };

export async function initAiPage(): Promise<void> {
  const flash = new URLSearchParams(location.search).get('topup');
  const msgs: Record<string, string> = { success: '충전이 완료되었습니다.', done: '이미 반영된 충전입니다.', pending: '결제 확인 중입니다. 잠시 후 새로고침하세요.', cancel: '충전을 취소했습니다.', invalid: '충전 정보를 확인할 수 없습니다.', error: '충전 처리 중 오류가 발생했습니다. 잠시 후 잔액을 확인하세요.' };
  if (flash && msgs[flash]) show('ai-flash', msgs[flash]!);

  async function load() {
    const [models, keys, usage] = await Promise.all([api('/api/cas/models'), api('/api/cas/keys'), api('/api/cas/usage')]);
    $('ai-balance').textContent = usage.ok ? usd(usage.data.balanceMicro) : '-';
    $('ai-models').innerHTML = (models.data.models ?? []).map((m: any) => `
      <div class="p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <div><div class="font-medium">${esc(m.name)} <span class="text-xs text-gray-500">${esc(tierLabel[m.tier] ?? m.tier)} · ${esc(m.task)}</span>${m.deprecating ? ' <span class="text-xs text-amber-600">(공식 폐기 예정)</span>' : ''}</div>
          <div class="text-gray-500 break-all">${esc(m.modelId)}</div>
          <div class="text-gray-500">월 ${usd(m.monthlyMicro)} + 1,000 Neurons당 ${usd(m.sellPer1kNeuronsMicro)}</div></div>
        ${m.subscribed ? '<span class="text-green-600">구독 중</span>' : `<button data-sub="${esc(m.id)}" class="bg-primary text-white px-3 py-2 rounded-lg">PayPal로 구독</button>`}
      </div>`).join('') || '<p class="p-4 text-sm text-gray-500">판매 중인 모델이 없습니다.</p>';
    $('ai-keys').innerHTML = (keys.data.keys ?? []).map((k: any) => `
      <div class="p-4 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div><span class="font-medium">${esc(k.name)}</span> <code class="text-gray-500">${esc(k.prefix)}…</code>
          <div class="text-gray-500">상태 ${esc(k.status)} · 분당 ${k.rateLimitPerMin}회${k.monthlyCapMicro != null ? ' · 월 상한 ' + usd(k.monthlyCapMicro) : ''}${k.lastUsedAt ? ' · 최근 사용 ' + esc(k.lastUsedAt.slice(0, 16)) : ''}</div></div>
        <div class="flex gap-3"><button data-rotate="${esc(k.id)}" class="text-primary hover:underline">재발급</button><button data-revoke="${esc(k.id)}" class="text-red-600 hover:underline">폐기</button></div>
      </div>`).join('') || '<p class="p-4 text-sm text-gray-500">발급된 키가 없습니다.</p>';
    const rows = usage.data.models ?? [];
    $('ai-usage').innerHTML = rows.length ? `<table class="w-full"><thead><tr class="text-left text-gray-500"><th class="py-1">모델</th><th>요청</th><th>추정 Neurons</th><th>청구</th></tr></thead><tbody>${rows.map((r: any) => `<tr><td class="py-1">${esc(r.name)}</td><td>${r.requests}</td><td>${r.neurons}</td><td>${usd(r.billed)}</td></tr>`).join('')}</tbody></table>` : '<p class="text-gray-500">이번 달 사용 내역이 없습니다.</p>';
  }

  document.body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const sub = t.getAttribute('data-sub'), rot = t.getAttribute('data-rotate'), rev = t.getAttribute('data-revoke');
    if (sub) { const r = await api('/api/cas/subscribe', 'POST', { modelId: sub }); if (r.ok && r.data.url) location.href = r.data.url; else show('key-error', r.data.message || r.data.error); }
    if (rot && confirm('키를 재발급할까요? 이전 키는 즉시 사용할 수 없게 됩니다.')) { const r = await api(`/api/cas/keys/${encodeURIComponent(rot)}/rotate`, 'POST'); if (r.ok) { showNew(r.data.key); await load(); } else show('key-error', r.data.message || r.data.error); }
    if (rev && confirm('이 키를 폐기할까요?')) { const r = await api(`/api/cas/keys/${encodeURIComponent(rev)}/revoke`, 'POST'); if (!r.ok) show('key-error', r.data.message || r.data.error); await load(); }
  });
  function showNew(key: string) { const b = $('key-new'); b.textContent = '새 API 키(지금만 표시됩니다): ' + key; b.classList.remove('hidden'); }
  $('key-create').addEventListener('click', async () => {
    show('key-error', null);
    const r = await api('/api/cas/keys', 'POST', { name: ($('key-name') as HTMLInputElement).value });
    if (r.ok) { showNew(r.data.key); ($('key-name') as HTMLInputElement).value = ''; await load(); } else show('key-error', r.data.message || r.data.error);
  });
  $('topup-btn').addEventListener('click', async () => {
    show('topup-error', null);
    const r = await api('/api/cas/credits/topup', 'POST', { amountUsd: Number(($('topup-amount') as HTMLInputElement).value) });
    if (r.ok && r.data.url) location.href = r.data.url; else show('topup-error', r.data.message || r.data.error);
  });
  await load();
}
