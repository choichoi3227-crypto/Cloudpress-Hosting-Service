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

export async function loadServices(): Promise<void> {
  try {
    const res = await fetch('/api/subscriptions', { credentials: 'include' });
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      throw new Error('Failed to load');
    }
    const services: Subscription[] = await res.json();
    const container = document.getElementById('services-list');
    const emptyState = document.getElementById('empty-state');
    
    if (!container || !emptyState) return;

    if (services.length === 0) {
      container.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    container.classList.remove('hidden');
    emptyState.classList.add('hidden');

    container.innerHTML = services.map(s => `
      <div class="flex flex-col md:flex-row md:items-center justify-between py-4 border-b border-gray-100 dark:border-slate-800 last:border-0">
        <div class="flex items-center gap-4 mb-3 md:mb-0">
          <span class="px-3 py-1 text-xs font-medium rounded-full bg-primary/10 text-primary">${s.product?.kind || 'CCS'}</span>
          <div>
            <p class="font-medium text-gray-900 dark:text-white">${s.product?.nameKo || s.productId}</p>
            <p class="text-sm text-gray-500 dark:text-gray-400">${s.id.slice(0,8)}... • ${s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString('ko-KR') : '기간 없음'}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="px-3 py-1 text-xs font-medium rounded-full ${getStatusColor(s.status)}">${getStatusLabel(s.status)}</span>
          <a href="/services/${s.id}" class="text-sm text-primary hover:underline font-medium">관리</a>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error(e);
    const container = document.getElementById('services-list');
    if (container) {
      container.innerHTML = '<div class="text-center py-12 text-red-600">서비스를 불러오는데 실패했습니다.</div>';
    }
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
  const labels: Record<string, string> = {
    active: '활성',
    past_due: '연체',
    suspended: '일시정지',
    canceling: '취소예정',
    canceled: '취소됨',
    incomplete: '미완료',
    refunded: '환불됨'
  };
  return labels[status] || status;
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', loadServices);
}
