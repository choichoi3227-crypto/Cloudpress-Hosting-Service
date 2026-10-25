export interface Invoice {
  id: string;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  totalMicro: number;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export async function loadBilling(): Promise<void> {
  try {
    const [invoicesRes, upcomingRes] = await Promise.all([
      fetch('/api/billing/invoices', { credentials: 'include' }),
      fetch('/api/billing/upcoming', { credentials: 'include' })
    ]);

    if (invoicesRes.ok) {
      const invoices: Invoice[] = await invoicesRes.json();
      const container = document.getElementById('invoices-list');
      if (container) {
        if (invoices.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-gray-500">청구 내역이 없습니다.</div>';
        } else {
          container.innerHTML = invoices.map(inv => `
            <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
              <div>
                <p class="font-medium">청구서 #${inv.id.slice(0,8)}</p>
                <p class="text-sm text-gray-500">${new Date(inv.periodStart).toLocaleDateString('ko-KR')} ~ ${new Date(inv.periodEnd).toLocaleDateString('ko-KR')}</p>
              </div>
              <div class="flex items-center gap-3">
                <span class="px-2 py-1 text-xs font-medium rounded-full ${getInvoiceStatusColor(inv.status)}">${getInvoiceStatusLabel(inv.status)}</span>
                <span class="font-medium tabular-nums">₩${(inv.totalMicro / 1000000).toLocaleString()}</span>
                <span class="text-sm text-gray-500">${new Date(inv.createdAt).toLocaleDateString('ko-KR')}</span>
              </div>
            </div>
          `).join('');
        }
      }

      // Upcoming invoice
      const upcomingContainer = document.getElementById('upcoming-list');
      if (upcomingContainer) {
        if (upcomingRes.ok) {
          const upcoming = await upcomingRes.json();
          if (upcoming && upcoming.totalMicro) {
            upcomingContainer.innerHTML = `
              <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800">
                <div>
                  <p class="font-medium">다음 결제 예정</p>
                  <p class="text-sm text-gray-500">${new Date(upcoming.periodStart).toLocaleDateString('ko-KR')} ~ ${new Date(upcoming.periodEnd).toLocaleDateString('ko-KR')}</p>
                </div>
                <span class="font-bold text-lg text-primary">₩${(upcoming.totalMicro / 1000000).toLocaleString()}</span>
              </div>
            `;
          } else {
            upcomingContainer.innerHTML = '<div class="text-center py-12 text-gray-500">예정된 결제가 없습니다.</div>';
          }
        } else {
          upcomingContainer.innerHTML = '<div class="text-center py-12 text-gray-500">불러오기 실패</div>';
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
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
  const labels: Record<string, string> = {
    paid: '결제완료',
    open: '미결제',
    draft: '초안',
    void: '무효',
    uncollectible: '회수불가'
  };
  return labels[status] || status;
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', loadBilling);
}
