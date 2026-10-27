// 서비스 상세 화면의 추가 CPU 구매/관리. 가격·가능 여부는 모두 서버가 계산한다(여기서는 표시만).
interface Tier { addVcpu: number; monthlyMicro: number }
interface Addon { id: string; addVcpu: number; monthlyMicro: number; fromInstance: string; toInstance: string; purchaseStatus: string; applyStatus: string; lastError: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
interface Info { tiers: Tier[]; maxTotalAddVcpu: number; container: { instanceType: string; targetVcpu: number; actualVcpu: number } | null; addons: Addon[] }

const usd = (m: number) => '$' + (m / 1_000_000).toFixed(2);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const purchaseLabel: Record<string, string> = { pending: '결제 대기', paid: '결제 완료', cancelled: '취소됨', refunded: '환불됨' };
const applyLabel: Record<string, string> = { not_started: '적용 대기', queued: '적용 대기열', applying: '적용 중', applied: '적용 완료', failed: '적용 실패(운영자 확인 중)', rolled_back: '원복됨' };

export async function initCpuAddons(): Promise<void> {
  const subId = window.location.pathname.replace(/\/+$/, '').split('/').pop();
  if (!subId || subId === '_') return;
  const $ = (id: string) => document.getElementById(id)!;
  const err = (msg: string | null) => { const e = $('cpu-error'); e.textContent = msg ?? ''; e.classList.toggle('hidden', !msg); };
  let buyQuote: number | null = null;

  async function load() {
    const res = await fetch(`/api/services/${encodeURIComponent(subId!)}/cpu-addons`, { credentials: 'include' });
    if (!res.ok) return;
    const info = await res.json() as Info;
    if (!info.container) return; // 컨테이너 기반 서비스가 아니거나 아직 생성 전
    $('cpu-card').classList.remove('hidden');
    $('cpu-current').textContent = `현재 사양: ${info.container.instanceType} (실제 ${info.container.actualVcpu} vCPU). 추가 vCPU 합계 최대 ${info.maxTotalAddVcpu}.`;
    ($('cpu-tier') as HTMLSelectElement).innerHTML = info.tiers.map((t) => `<option value="${t.addVcpu}">+${t.addVcpu} vCPU — ${usd(t.monthlyMicro)}/월</option>`).join('');
    $('cpu-list').innerHTML = info.addons.length ? info.addons.map((a) => `
      <div class="py-3 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div><span class="font-medium">+${a.addVcpu} vCPU</span> · ${usd(a.monthlyMicro)}/월 · ${esc(a.fromInstance)} → ${esc(a.toInstance)}
          <div class="text-gray-500">구매: ${esc(purchaseLabel[a.purchaseStatus] ?? a.purchaseStatus)} · 실제 적용: ${esc(applyLabel[a.applyStatus] ?? a.applyStatus)}${a.cancelAtPeriodEnd ? ' · 다음 갱신일에 해지' : ''}${a.lastError ? ' · ' + esc(a.lastError) : ''}</div></div>
        ${a.purchaseStatus === 'paid' && !a.cancelAtPeriodEnd ? `<button data-cancel="${esc(a.id)}" class="text-red-600 hover:underline">해지</button>` : ''}
      </div>`).join('') : '<p class="text-sm text-gray-500 py-2">구매한 추가 CPU가 없습니다.</p>';
  }

  $('cpu-quote-btn').addEventListener('click', async () => {
    err(null); buyQuote = null; $('cpu-buy-btn').classList.add('hidden');
    const addVcpu = Number(($('cpu-tier') as HTMLSelectElement).value);
    const res = await fetch(`/api/services/${encodeURIComponent(subId!)}/cpu-addons/quote`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addVcpu }) });
    const d = await res.json();
    if (!res.ok) { $('cpu-quote').textContent = ''; err(d.message || d.error); return; }
    $('cpu-quote').textContent = `${d.fromInstance} → ${d.toInstance} (${d.resulting.vcpu} vCPU · 메모리 ${d.resulting.memoryMiB} MiB · 디스크 ${d.resulting.diskGB} GB). ${d.note}`;
    buyQuote = addVcpu; $('cpu-buy-btn').classList.remove('hidden');
  });

  $('cpu-buy-btn').addEventListener('click', async () => {
    if (buyQuote === null) return;
    err(null);
    const res = await fetch(`/api/services/${encodeURIComponent(subId!)}/cpu-addons`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addVcpu: buyQuote }) });
    const d = await res.json();
    if (res.ok && d.url) { window.location.href = d.url; return; }
    err(d.message || d.error);
  });

  $('cpu-list').addEventListener('click', async (e) => {
    const id = (e.target as HTMLElement).getAttribute('data-cancel');
    if (!id || !confirm('추가 CPU를 해지할까요? 이미 결제한 기간이 끝나면 기본 사양으로 돌아갑니다.')) return;
    const res = await fetch(`/api/cpu-addons/${encodeURIComponent(id)}/cancel`, { method: 'POST', credentials: 'include' });
    if (!res.ok) { const d = await res.json(); err(d.message || d.error); return; }
    await load();
  });

  await load();
}
