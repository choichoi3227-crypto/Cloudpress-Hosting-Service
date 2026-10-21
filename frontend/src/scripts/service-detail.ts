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
  const pathParts = window.location.pathname.split('/');
  const subId = pathParts[pathParts.length - 1];
  if (!subId) return;

  try {
    const res = await fetch(\/api/subscriptions/\\, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) window.location.href = '/login';
      if (res.status === 404) window.location.href = '/services';
      return;
    }
    const sub = await res.json();
    renderServiceDetail(sub);

    const invoicesRes = await fetch(\/api/billing/invoices?subscription=\\, { credentials: 'include' });
    if (invoicesRes.ok) {
      const invoices = await invoicesRes.json();
      renderInvoices(invoices);
    }

    setupActions(sub);
  } catch (e) {
    console.error(e);
  }
}

function renderServiceDetail(sub: any): void {
  document.getElementById('service-name')!.textContent = sub.product?.nameKo || sub.productId;
  document.getElementById('info-product')!.textContent = sub.product?.nameKo || sub.productId;
  document.getElementById('info-status')!.innerHTML = \<span class=\"px-2 py-1 text-xs font-medium rounded-full \\">\</span>\;
  document.getElementById('info-price')!.textContent = '\u20A9' + (sub.product?.monthlyMicro / 1000000).toLocaleString() + '/\uC6D4';
  document.getElementById('info-next-billing')!.textContent = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('ko-KR') : '-';
  document.getElementById('info-sub-id')!.textContent = sub.id;
  document.getElementById('info-created')!.textContent = new Date().toLocaleDateString('ko-KR');
}

function renderInvoices(invoices: any[]): void {
  const container = document.getElementById('service-invoices');
  if (!container) return;
  
  if (invoices.length === 0) {
    container.innerHTML = '<div class=\"text-center py-12 text-gray-500\">청구 내역이 없습니다.</div>';
    return;
  }

  container.innerHTML = invoices.map((inv: any) => \
    <div class=\"flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0\">
      <div>
        <p class=\"font-medium\">청구서 #\</p>
        <p class=\"text-sm text-gray-500\">\ ~ \</p>
      </div>
      <div class=\"flex items-center gap-3\">
        <span class=\"px-2 py-1 text-xs font-medium rounded-full \\">\</span>
        <span class=\"font-medium tabular-nums\">\u20A9\</span>
        <span class=\"text-sm text-gray-500\">\</span>
      </div>
    </div>
  \).join('');
}

function setupActions(sub: any): void {
  const suspendBtn = document.getElementById('suspend-btn') as HTMLButtonElement;
  const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

  if (sub.status === 'active' || sub.status === 'past_due') {
    suspendBtn.classList.remove('hidden');
    cancelBtn.textContent = '구독 취소';
  } else if (sub.status === 'suspended') {
    resumeBtn.classList.remove('hidden');
    cancelBtn.textContent = '구독 취소';
  } else {
    cancelBtn.classList.add('hidden');
  }

  suspendBtn?.addEventListener('click', () => handleAction(sub.id, 'suspend'));
  cancelBtn?.addEventListener('click', () => handleCancel(sub.id));
}

async function handleAction(subId: string, action: 'suspend' | 'resume'): Promise<void> {
  if (!confirm(action === 'suspend' ? '\uC77C\uC2DC\uC815\uC9C0\uD558\uC2DC\uAC00\uC5B4\uC2B4\uC2DC\uC5EC\uD558\uC2B5\uB2C8\uAE4C?' : '\uC7AC\uAC00\uD558\uC2DC\uAC00\uC5B4\uC2B4\uC2DC\uC5EB\uC2B5\uB2C8\uAE4C?')) return;
  
  try {
    const res = await fetch(\/api/services/\/\\, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (res.ok) {
      alert(action === 'suspend' ? '\uC77C\uC2DC\uC815\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.' : '\uC7AC\uAC00\uB418\uC5C8\uC2B5\uB2C8\uB2E4.');
      window.location.reload();
    } else {
      const err = await res.json();
      alert('실패: ' + err.error);
    }
  } catch {
    alert('네트워크 오류');
  }
}

async function handleCancel(subId: string): Promise<void> {
  if (!confirm('\uC815\uB9D0\uB85C \uAD6C\uB3C5\uC744 \uCDE8\uC18C\uD558\uC2DC\uAC00\uC5B4\uC2B4\uC2EB\uB2C8\uAE4C? \uC9C1\uC811 \uC911\uB2E8\uB418\uBA74\uC11C \uB370\uC774\uD130\uB294 30\uC77C \uD6C4 \uC601\uAD6C \uC0AD\uC81C\uB429\uB2C8\uB2E4. \uC774 \uC791\uC5C5\uC740 \uB418\uB3C8\uB9AC\uC9C4 \uC546\uC2B5\uB2C8\uB2E4.')) return;
  if (!confirm('\uCD5C\uC885 \uD655\uC778: \uC815\uB9D0\uB85C \uCDE8\uC18C\uD558\uC2DC\uAC00\uC5B4\uC2B7\uB2C8\uAE4C?')) return;

  try {
    const res = await fetch(\/api/services/\/cancel\, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (res.ok) {
      alert('\uAD6C\uB3C5\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.');
      window.location.href = '/services';
    } else {
      const err = await res.json();
      alert('실패: ' + err.error);
    }
  } catch {
    alert('네트워크 오류');
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'past_due': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'suspended': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    case 'canceling': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'canceled': return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = { active: '\uD65C\uC131', past_due: '\uC5F0\uCCF4', suspended: '\uC77C\uC2DC\uC815\uC9C0', canceling: '\uCDE8\uC18C\uC608\uC815', canceled: '\uCDE8\uC18C\uB41C', incomplete: '\uBBF8\uC644\uB8CC', refunded: '\uD658\uBDC8\uB41C' };
  return labels[status] || status;
}

function getInvoiceStatusColor(status: string): string {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
    case 'draft': return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    case 'void': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getInvoiceStatusLabel(status: string): string {
  const labels: Record<string, string> = { paid: '\uACB0\uC81C\uC64C\uB8CC', open: '\uBBF8\uACB0\uC81C', draft: '\uCD08\uC548', void: '\uBB34\uD654', uncollectible: '\uD68F\uC218\uBDC8\uAC00' };
  return labels[status] || status;
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // Extract subscription ID from URL
    const pathParts = window.location.pathname.split('/');
    const subId = pathParts[pathParts.length - 1];
    if (subId) initServiceDetail(subId);
  }
};

async function initServiceDetail(subId: string): Promise<void> {
  try {
    const res = await fetch(\/api/subscriptions/\\, { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) window.location.href = '/login';
      if (res.status === 404) window.location.href = '/services';
      return;
    }
    const sub = await res.json();
    renderServiceDetail(sub);

    const invoicesRes = await fetch(\/api/billing/invoices?subscription=\\, { credentials: 'include' });
    if (invoicesRes.ok) {
      const invoices = await invoicesRes.json();
      renderInvoices(invoices);
    }

    setupActions(sub);
  } catch (e) {
    console.error(e);
  }
}

function renderServiceDetail(sub: any): void {
  document.getElementById('service-name')!.textContent = sub.product?.nameKo || sub.productId;
  document.getElementById('info-product')!.textContent = sub.product?.nameKo || sub.productId;
  document.getElementById('info-status')!.innerHTML = \<span class=\"px-2 py-1 text-xs font-medium rounded-full \\">\</span>\;
  document.getElementById('info-price')!.textContent = '\u20A9' + (sub.product?.monthlyMicro / 1000000).toLocaleString() + '/\uC6D4';
  document.getElementById('info-next-billing')!.textContent = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('ko-KR') : '-';
  document.getElementById('info-sub-id')!.textContent = sub.id;
  document.getElementById('info-created')!.textContent = new Date().toLocaleDateString('ko-KR');
}

function renderInvoices(invoices: any[]): void {
  const container = document.getElementById('service-invoices');
  if (!container) return;
  
  if (invoices.length === 0) {
    container.innerHTML = '<div class=\"text-center py-12 text-gray-500\">청구 내역이 없습니다.</div>';
    return;
  }

  container.innerHTML = invoices.map((inv: any) => \
    <div class=\"flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0\">
      <div>
        <p class=\"font-medium\">청구서 #\</p>
        <p class=\"text-sm text-gray-500\">\ ~ \</p>
      </div>
      <div class=\"flex items-center gap-3\">
        <span class=\"px-2 py-1 text-xs font-medium rounded-full \\">\</span>
        <span class=\"font-medium tabular-nums\">\u20A9\</span>
        <span class=\"text-sm text-gray-500\">\</span>
      </div>
    </div>
  \).join('');
}

function setupActions(sub: any): void {
  const suspendBtn = document.getElementById('suspend-btn') as HTMLButtonElement;
  const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

  if (sub.status === 'active' || sub.status === 'past_due') {
    suspendBtn.classList.remove('hidden');
    cancelBtn.textContent = '\uAD6C\uB3C5 \uCDE8\uC18C';
  } else if (sub.status === 'suspended') {
    resumeBtn.classList.remove('hidden');
    cancelBtn.textContent = '\uAD6C\uB3C5 \uCDE8\uC18C';
  } else {
    cancelBtn.classList.add('hidden');
  }

  suspendBtn?.addEventListener('click', () => handleAction(sub.id, 'suspend'));
  cancelBtn?.addEventListener('click', () => handleCancel(sub.id));
}

async function handleAction(subId: string, action: 'suspend' | 'resume'): Promise<void> {
  if (!confirm(action === 'suspend' ? '\uC77C\uC2DC\uC815\uC9C0\uD558\uC2DC\uAC00\uC5B4\uC2B4\uC2EB\uB2C8\uAE4C?' : '\uC7AC\uAC00\uD558\uC2DC\uAC00\uC5B4\uC2B7\uB2C8\uAE4C?')) return;
  
  try {
    const res = await fetch(\/api/services/\/\\, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (res.ok) {
      alert(action === 'suspend' ? '\uC77C\uC2DC\uC815\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4.' : '\uC7AC\uAC00\uB418\uC5C8\uC2B5\uB2C8\uB2E4.');
      window.location.reload();
    } else {
      const err = await res.json();
      alert('실패: ' + err.error);
    }
  } catch {
    alert('\uB370\uD06C\uC6CC\uD06C \uC624\uB958');
  }
}

async function handleCancel(subId: string): Promise<void> {
  if (!confirm('\uC815\uB9D0\uB85C \uAD6C\uB3C5\uC744 \uCDE8\uC18C\uD558\uC2DC\uAC00\uC5B4\uC2B7\uB2C8\uAE4C? \uC9C1\uC811 \uC911\uB2E8\uB418\uBA74\uC11C \uB370\uC774\uD130\uB294 30\uC77C \uD6C4 \uC601\uAD6C \uC0AD\uC81C\uB429\uB2C8\uB2E4. \uC774 \uC791\uC5C5\uC740 \uB418\uB3C8\uB9AC\uC9C4 \uC546\uC2B5\uB2C8\uB2E4.')) return;
  if (!confirm('\uCD5C\uC885 \uD655\uC778: \uC815\uB9D0\uB85C \uCDE8\uC18C\uD558\uC2DC\uAC00\uC5B4\uC2B7\uB2C8\uAE4C?')) return;

  try {
    const res = await fetch(\/api/services/\/cancel\, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (res.ok) {
      alert('\uAD6C\uB3C5\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.');
      window.location.href = '/services';
    } else {
      const err = await res.json();
      alert('실패: ' + err.error);
    }
  } catch {
    alert('\uB370\uD06C\uC6CC\uD06C \uC624\uB958');
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'past_due': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'suspended': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    case 'canceling': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400';
    case 'canceled': return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getStatusLabel(status: string): string {
  const labels: Record<string, string> = { active: '\uD65C\uC131', past_due: '\uC5F0\uCCF4', suspended: '\uC77C\uC2DC\uC815\uC9C0', canceling: '\uCDE8\uC18C\uC608\uC815', canceled: '\uCDE8\uC18C\uB41C', incomplete: '\uBBF8\uC644\uB8CC', refunded: '\uD658\uBDC8\uB41C' };
  return labels[status] || status;
}

function getInvoiceStatusColor(status: string): string {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400';
    case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400';
    case 'draft': return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    case 'void': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400';
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
  }
}

function getInvoiceStatusLabel(status: string): string {
  const labels: Record<string, string> = { paid: '\uACB0\uC81C\uC64C\uB8CC', open: '\uBBF8\uACB0\uC81C', draft: '\uCD08\uC548', void: '\uBB34\uD654', uncollectible: '\uD68F\uC218\uBDC8\uAC00' };
  return labels[status] || status;
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const pathParts = window.location.pathname.split('/');
    const subId = pathParts[pathParts.length - 1];
    if (subId) initServiceDetail(subId);
  }
}