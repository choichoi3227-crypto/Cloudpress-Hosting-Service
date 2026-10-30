const usd = (m: number | null | undefined) => '$' + ((m ?? 0) / 1_000_000).toFixed(2);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = (id: string) => document.getElementById(id)!;
const STATUS: Record<string, string> = { pending: '승인 대기', approved: '승인됨', suspended: '정지', rejected: '거절' };
const COM: Record<string, string> = { pending: '유지 확인 중', eligible: '지급 가능', payable: '지급 예정', paid: '지급 완료', void: '무효(환불·해지)', clawed_back: '회수됨' };
const PAY: Record<string, string> = { pending: '승인 대기', approved: '지급 처리 중', paid: '지급 완료', failed: '실패(다음 정산에 포함)', rejected: '반려' };

export async function initAffiliate(): Promise<void> {
  async function load() {
    const res = await fetch('/api/affiliate', { credentials: 'include' });
    if (!res.ok) return;
    const d = await res.json();
    const p = d.policy;
    $('aff-policy').textContent = `적격 매출의 ${p.ratePct}% · 서비스를 ${p.minMaintainedMonths}개월 이상 유지해야 확정 · 최초 결제부터 최대 ${p.maxCommissionMonths}개월 · 매월 ${p.payoutDayOfMonth}일 정산(최소 ${usd(p.minPayoutMicro)}, 미달 시 이월). 환불·차지백은 수수료에서 제외·회수됩니다.`;
    $('aff-apply').classList.toggle('hidden', d.applied);
    $('aff-main').classList.toggle('hidden', !d.applied);
    if (!d.applied) return;
    $('aff-status').textContent = STATUS[d.status] ?? d.status;
    $('aff-link-box').classList.toggle('hidden', !d.link);
    ($('aff-link') as HTMLInputElement).value = d.link ?? '';
    const a = d.amounts ?? {};
    const kpi = (l: string, v: string) => `<div class="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 p-4"><div class="text-xs text-gray-500">${l}</div><div class="text-xl font-bold">${v}</div></div>`;
    $('aff-kpi').innerHTML = kpi('추천 가입', `${d.referrals.total}명 (결제 ${d.referrals.paying}명)`) + kpi('확인 중', usd(a.pending)) + kpi('지급 가능·예정', usd((a.eligible ?? 0) + (a.payable ?? 0) + (d.pendingAdjustmentMicro ?? 0))) + kpi('지급 완료', usd(a.paid));
    $('aff-comm').innerHTML = d.commissions.length ? d.commissions.map((c: any) => `<div class="p-3 flex justify-between"><span>${esc(c.product)} <span class="text-gray-500">· ${esc(COM[c.status] ?? c.status)}</span></span><span class="font-medium">${usd(c.amount_micro)}</span></div>`).join('') : '<p class="p-4 text-gray-500">아직 수수료가 없습니다.</p>';
    $('aff-pay').innerHTML = d.payouts.length ? d.payouts.map((x: any) => `<div class="p-3 flex justify-between"><span>${esc(x.period)} · ${esc(PAY[x.status] ?? x.status)}${x.failure_reason ? ' · ' + esc(x.failure_reason) : ''}</span><span class="font-medium">${usd(x.amount_micro)}</span></div>`).join('') : '<p class="p-4 text-gray-500">지급 내역이 없습니다.</p>';
  }
  $('aff-submit').addEventListener('click', async () => {
    const res = await fetch('/api/affiliate/apply', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payoutEmail: ($('aff-email') as HTMLInputElement).value }) });
    const d = await res.json(); const m = $('aff-msg'); m.textContent = res.ok ? '신청했습니다. 운영자 승인을 기다려 주세요.' : (d.message || d.error); m.classList.remove('hidden');
    await load();
  });
  $('aff-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(($('aff-link') as HTMLInputElement).value); $('aff-copy').textContent = '복사됨'; } catch { /* 무시 */ } });
  await load();
}
