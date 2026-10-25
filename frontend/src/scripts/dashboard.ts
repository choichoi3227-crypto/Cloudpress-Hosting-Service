export async function loadDashboard(): Promise<void> {
  try {
    const [servicesRes, invoicesRes] = await Promise.all([
      fetch('/api/subscriptions', { credentials: 'include' }),
      fetch('/api/billing/invoices', { credentials: 'include' })
    ]);
    
    if (servicesRes.ok) {
      const services = await servicesRes.json();
      const activeServicesEl = document.getElementById('active-services');
      const monthlyCostEl = document.getElementById('monthly-cost');
      
      if (activeServicesEl) activeServicesEl.textContent = services.filter((s: any) => s.status === 'active').length.toString();
      if (monthlyCostEl) monthlyCostEl.textContent = '$' + (services.reduce((sum: number, s: any) => sum + (s.product?.monthlyMicro || 0), 0) / 1000000).toFixed(2);
      
      const container = document.getElementById('services-list');
      if (container) {
        if (services.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-gray-500">등록된 서비스가 없습니다. <a href="/services/create" class="text-primary hover:underline ml-2">서비스 생성하기</a></div>';
        } else {
          container.innerHTML = services.slice(0, 5).map((s: any) => `
            <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
              <div class="flex items-center gap-4">
                <span class="px-2 py-1 text-xs font-medium rounded-full bg-primary/10 text-primary">${s.product?.kind || 'CCS'}</span>
                <div>
                  <p class="font-medium">${s.product?.nameKo || s.productId}</p>
                  <p class="text-sm text-gray-500">${s.id.slice(0,8)}... • ${s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString('ko-KR') : '기간 없음'}</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="px-2 py-1 text-xs font-medium rounded-full ${s.status === 'active' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : s.status === 'past_due' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}">${s.status}</span>
                <a href="/services/${s.id}" class="text-sm text-primary hover:underline">관리</a>
              </div>
            </div>
          `).join('');
        }
      }
    }
    
    if (invoicesRes.ok) {
      const invoices = await invoicesRes.json();
      const container = document.getElementById('invoices-list');
      if (container) {
        if (invoices.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-gray-500">청구 내역이 없습니다.</div>';
        } else {
          container.innerHTML = invoices.slice(0, 5).map((inv: any) => `
            <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
              <div>
                <p class="font-medium">청구서 #${inv.id.slice(0,8)}</p>
                <p class="text-sm text-gray-500">${new Date(inv.createdAt).toLocaleDateString('ko-KR')}</p>
              </div>
              <div class="flex items-center gap-3">
                <span class="px-2 py-1 text-xs font-medium rounded-full ${inv.status === 'paid' ? 'bg-green-100 text-green-800' : inv.status === 'open' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}">${inv.status}</span>
                <span class="font-medium tabular-nums">$${(inv.totalMicro / 1000000).toFixed(2)}</span>
              </div>
            </div>
          `).join('');
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', loadDashboard);
}
