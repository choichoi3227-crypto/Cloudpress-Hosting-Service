const usd = (m: number | null | undefined) => '$' + ((m ?? 0) / 1_000_000).toFixed(2);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = (id: string) => document.getElementById(id)!;
const REASON: Record<string, string> = { self_referral: '자기추천 의심', velocity: '단시간 대량 가입' };
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(path, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: res.ok, data: await res.json().catch(() => ({})) as any };
}
const say = (m: string) => { const e = $('aff-admin-msg'); e.textContent = m; e.classList.remove('hidden'); };

export async function initAdminAffiliate(): Promise<void> {
  async function load() {
    const r = await api('/api/admin/affiliate/overview');
    if (!r.ok) { say('불러오지 못했습니다'); return; }
    const o = r.data; const p = o.policy;
    const f = (id: string, label: string, v: number) => `<label class="text-xs text-gray-500">${label}<input id="${id}" type="number" value="${v}" class="block w-28 mt-1 px-2 py-1 border rounded bg-white dark:bg-slate-800 text-sm text-gray-900 dark:text-white" /></label>`;
    $('aff-policy-view').innerHTML = f('p-rate', '수수료율(bp, 1500=15%)', p.rateBp) + f('p-months', '유지 개월', p.minMaintainedMonths) + f('p-min', '최소 지급(micro USD)', p.minPayoutMicro) + f('p-win', '지급 기간(개월)', p.maxCommissionMonths) + f('p-day', '지급일', p.payoutDayOfMonth) + f('p-vel', '시간당 추천 한도', p.velocityLimitPerHour) + '<button id="p-save" class="px-4 py-2 rounded-lg bg-primary text-white">저장</button>';
    $('aff-payouts').innerHTML = o.payouts.length ? o.payouts.map((x: any) => `<div class="p-3 flex flex-wrap items-center gap-3"><span class="font-medium">${esc(x.period)}</span><span>${esc(x.email)} → ${esc(x.payout_email ?? '-')}</span><span class="font-bold">${usd(x.amount_micro)}</span><span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-800">${esc(x.status)}</span><span class="text-gray-500">${esc(x.external_ref ?? x.failure_reason ?? '')}</span><span class="flex-1"></span>
      ${x.status === 'pending' ? `<button data-pay="${esc(x.id)}" data-act="approve" class="px-3 py-1 rounded bg-green-600 text-white">승인</button><button data-pay="${esc(x.id)}" data-act="reject" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">반려</button>` : ''}
      ${x.status === 'approved' ? `<button data-pay="${esc(x.id)}" data-act="paid" class="px-3 py-1 rounded bg-primary text-white">송금 완료 기록</button><button data-pay="${esc(x.id)}" data-act="fail" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">실패</button>` : ''}</div>`).join('') : '<p class="p-4 text-gray-500">지급 요청이 없습니다(매월 지급일에 자동 생성).</p>';
    $('aff-list').innerHTML = o.affiliates.length ? o.affiliates.map((a: any) => `<div class="p-3 flex flex-wrap items-center gap-3"><span class="font-medium">${esc(a.email)}</span><code>${esc(a.code)}</code><span class="text-gray-500">PayPal ${esc(a.payout_email ?? '-')}</span><span>추천 ${a.referrals}명 · 미확정 ${usd(a.outstanding)} · 지급 ${usd(a.paid)}</span><span class="px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-800">${esc(a.status)}</span><span class="flex-1"></span>
      ${a.status !== 'approved' ? `<button data-aff="${esc(a.id)}" data-st="approved" class="px-3 py-1 rounded bg-green-600 text-white">승인</button>` : `<button data-aff="${esc(a.id)}" data-st="suspended" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">정지</button>`}
      ${a.status === 'pending' ? `<button data-aff="${esc(a.id)}" data-st="rejected" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">거절</button>` : ''}</div>`).join('') : '<p class="p-4 text-gray-500">신청한 제휴자가 없습니다.</p>';
    $('aff-flagged').innerHTML = o.flagged.length ? o.flagged.map((x: any) => `<div class="p-3 flex flex-wrap items-center gap-3"><span>${esc(REASON[x.flag_reason] ?? x.flag_reason)}</span><code>${esc(x.code)}</code><span class="text-gray-500">${esc(x.referred_email)}</span><span class="flex-1"></span><button data-clear="${esc(x.id)}" class="px-3 py-1 rounded bg-gray-200 dark:bg-slate-700">정상으로 처리</button></div>`).join('') : '<p class="p-4 text-gray-500">검토할 의심 추천이 없습니다.</p>';
  }
  document.body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const pay = t.getAttribute('data-pay'), aff = t.getAttribute('data-aff'), clr = t.getAttribute('data-clear');
    if (t.id === 'p-save') {
      const v = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
      const r = await api('/api/admin/affiliate/policy', 'PUT', { rateBp: v('p-rate'), minMaintainedMonths: v('p-months'), minPayoutMicro: v('p-min'), maxCommissionMonths: v('p-win'), payoutDayOfMonth: v('p-day'), velocityLimitPerHour: v('p-vel') });
      say(r.ok ? '정책을 저장했습니다(이후 결제부터 적용).' : (r.data.message || r.data.error)); await load();
    }
    if (pay) {
      const act = t.getAttribute('data-act')!; let body: unknown = {};
      if (act === 'paid') { const ref = prompt('PayPal 송금 거래번호(참조번호)'); if (!ref) return; body = { reference: ref }; }
      if (act === 'fail' || act === 'reject') { const reason = prompt('사유'); if (reason === null) return; body = { reason }; }
      const r = await api(`/api/admin/affiliate/payouts/${encodeURIComponent(pay)}/${act}`, 'POST', body); if (!r.ok) say(r.data.message || r.data.error); await load();
    }
    if (aff) { const r = await api(`/api/admin/affiliate/${encodeURIComponent(aff)}/status`, 'POST', { status: t.getAttribute('data-st') }); if (!r.ok) say(r.data.message || r.data.error); await load(); }
    if (clr) { const r = await api(`/api/admin/affiliate/referrals/${encodeURIComponent(clr)}/clear-flag`, 'POST'); if (!r.ok) say(r.data.message || r.data.error); await load(); }
  });
  $('aff-settle').addEventListener('click', async () => { const r = await api('/api/admin/affiliate/settle', 'POST', {}); say(r.ok ? `정산 실행: 승격 ${r.data.promoted} · 무효 ${r.data.voided} · 회수 ${r.data.adjusted} · 지급 요청 ${r.data.payoutsCreated}` : (r.data.message || r.data.error)); await load(); });
  await load();
}
