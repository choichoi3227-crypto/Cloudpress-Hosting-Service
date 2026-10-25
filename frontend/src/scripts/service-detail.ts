export interface Subscription {
  id: string;
  productId: string;
  status: 'incomplete' | 'active' | 'past_due' | 'suspended' | 'canceling' | 'canceled' | 'refunded';
  currentPeriodEnd: string;
  product: {
    id: string;
    nameKo: string;
    kind: string;
    monthlyMicro: number;
  };
}

export interface Invoice {
  id: string;
  status: string;
  totalMicro: number;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export async function initServiceDetail(): Promise<void> {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const subId = pathParts[pathParts.length - 1];
  if (!subId) return;

  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(subId)}`, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) window.location.href = '/login';
      if (res.status === 404) window.location.href = '/services';
      return;
    }
    const sub = await res.json();
    renderServiceDetail(sub);

    const invoicesRes = await fetch(`/api/billing/invoices?subscription=${encodeURIComponent(subId)}`, { credentials: 'include' });
    if (invoicesRes.ok) {
      const invoices = await invoicesRes.json();
      renderInvoices(invoices);
    }

    setupActions(sub);
  } catch (e) {
    console.error(e);
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function formatDate(value: string): string {
  return value ? new Date(value).toLocaleDateString('ko-KR') : '-';
}

function renderServiceDetail(sub: any): void {
  const name = sub.product?.nameKo || sub.productId;
  document.getElementById('service-name')!.textContent = name;
  document.getElementById('info-product')!.textContent = name;
  document.getElementById('info-status')!.innerHTML =
    `<span class="px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(sub.status)}">${escapeHtml(getStatusLabel(sub.status))}</span>`;
  document.getElementById('info-price')!.textContent =
    '$' + ((sub.product?.monthlyMicro ?? 0) / 1000000).toFixed(2) + '/\uC6D4';
  document.getElementById('info-next-billing')!.textContent = formatDate(sub.currentPeriodEnd);
  document.getElementById('info-sub-id')!.textContent = sub.id;
  document.getElementById('info-created')!.textContent = formatDate(sub.createdAt || new Date().toISOString());
}

function renderInvoices(invoices: any[]): void {
  const container = document.getElementById('service-invoices');
  if (!container) return;

  if (!Array.isArray(invoices) || invoices.length === 0) {
    container.innerHTML = '<div class="text-center py-12 text-gray-500">청구 내역이 없습니다.</div>';
    return;
  }

  container.innerHTML = invoices.map((inv: any) => `
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
      <div>
        <p class="font-medium">청구서 #${escapeHtml(String(inv.id).slice(0, 8))}</p>
        <p class="text-sm text-gray-500">${formatDate(inv.periodStart)} ~ ${formatDate(inv.periodEnd)}</p>
      </div>
      <div class="flex items-center gap-3">
        <span class="px-2 py-1 text-xs font-medium rounded-full ${getInvoiceStatusColor(inv.status)}">${escapeHtml(getInvoiceStatusLabel(inv.status))}</span>
        <span class="font-medium tabular-nums">$${((inv.totalMicro ?? 0) / 1000000).toFixed(2)}</span>
        <span class="text-sm text-gray-500">${formatDate(inv.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

function setupActions(sub: any): void {
  const suspendBtn = document.getElementById('suspend-btn') as HTMLButtonElement | null;
  const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement | null;

  if (sub.status === 'active' || sub.status === 'past_due') {
    suspendBtn?.classList.remove('hidden');
  } else if (sub.status === 'suspended') {
    resumeBtn?.classList.remove('hidden');
  } else {
    cancelBtn?.classList.add('hidden');
  }

  suspendBtn?.addEventListener('click', () => handleAction(sub.id, 'suspend'));
  resumeBtn?.addEventListener('click', () => handleAction(sub.id, 'resume'));
  cancelBtn?.addEventListener('click', () => handleCancel(sub.id));
}

async function handleAction(subId: string, action: 'suspend' | 'resume'): Promise<void> {
  const msg = action === 'suspend' ? '서비스를 일시정지하시겠습니까?' : '서비스를 재개하시겠습니까?';
  if (!confirm(msg)) return;

  try {
    const res = await fetch(`/api/services/${encodeURIComponent(subId)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (res.ok) {
      alert(action === 'suspend' ? '일시정지되었습니다.' : '재개되었습니다.');
      window.location.reload();
    } else {
      const err = await res.json().catch(() => ({}));
      alert('실패: ' + (err.error || res.status));
    }
  } catch {
    alert('네트워크 오류');
  }
}

async function handleCancel(subId: string): Promise<void> {
  if (!confirm('정말로 구독을 취소하시겠습니까? 서비스가 중단되며 데이터는 30일 후 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.')) return;
  if (!confirm('최종 확인: 정말로 취소하시겠습니까?')) return;

  try {
    const res = await fetch(`/api/services/${encodeURIComponent(subId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (res.ok) {
      alert('구독이 취소되었습니다.');
      window.location.href = '/services';
    } else {
      const err = await res.json().catch(() => ({}));
      alert('실패: ' + (err.error || res.status));
    }
  } catch {
    alert('네트워크 오류');
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'past_due':
    case 'canceling': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'suspended': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: '활성', past_due: '연체', suspended: '일시정지', canceling: '취소예정',
    canceled: '취소됨', incomplete: '미완료', refunded: '환불됨',
  };
  return labels[status] || status;
}

function getInvoiceStatusColor(status: string): string {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
    case 'void': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getInvoiceStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    paid: '결제완료', open: '미결제', draft: '초안', void: '무효', uncollectible: '회수불가',
  };
  return labels[status] || status;
}
