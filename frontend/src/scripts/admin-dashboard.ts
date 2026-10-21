export async function loadAdminDashboard(): Promise<void> {
  try {
    const res = await fetch('/api/admin/summary', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed to load');
    const data = await res.json();

    const totalUsersEl = document.getElementById('total-users');
    const activeSubsEl = document.getElementById('active-subs');
    const monthlyRevenueEl = document.getElementById('monthly-revenue');
    const healthIndicatorEl = document.getElementById('health-indicator');
    const healthTextEl = document.getElementById('health-text');

    if (totalUsersEl) totalUsersEl.textContent = (data.totalUsers ?? 0).toLocaleString();
    if (activeSubsEl) activeSubsEl.textContent = (data.activeSubscriptions ?? 0).toLocaleString();
    if (monthlyRevenueEl) monthlyRevenueEl.textContent = '₩' + ((data.totalRevenueMicro ?? 0) / 1000000).toLocaleString();

    const healthMap = { 
      healthy: { color: 'bg-green-500', text: '정상' }, 
      degraded: { color: 'bg-amber-500', text: '주의' }, 
      critical: { color: 'bg-red-500', text: '위험' } 
    };
    const health = healthMap[data.systemHealth as keyof typeof healthMap] || { color: 'bg-gray-500', text: '알 수 없음' };
    if (healthIndicatorEl) healthIndicatorEl.className = 'w-3 h-3 rounded-full ' + health.color;
    if (healthTextEl) healthTextEl.textContent = health.text;

    // 낭비 리소스
    const wasteContainer = document.getElementById('waste-list');
    const wasteCountEl = document.getElementById('waste-count');
    const wasteCount = data.wasteResources?.length ?? 0;
    if (wasteCountEl) wasteCountEl.textContent = wasteCount + '건';
    
    if (wasteContainer) {
      if (wasteCount > 0) {
        wasteContainer.innerHTML = data.wasteResources.map((w: any) => `
          <div class="py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
            <p class="font-medium text-sm">${w.resourceId}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">${w.kind}: ${w.detail}</p>
            <p class="text-xs text-primary mt-1">권장: ${w.action}</p>
          </div>
        `).join('');
      } else {
        wasteContainer.innerHTML = '<div class="text-center py-8 text-gray-500">감지된 낭비 리소스 없음 ✓</div>';
      }
    }

    // 승인 대기
    const pendingCountEl = document.getElementById('pending-count');
    const pendingListEl = document.getElementById('pending-list');
    const pendingCount = data.pendingApprovals ?? 0;
    if (pendingCountEl) pendingCountEl.textContent = pendingCount + '건';
    if (pendingListEl) {
      pendingListEl.innerHTML = pendingCount > 0 
        ? '<div class="text-center py-8 text-gray-500">승인 대기 작업 있음 (상세 API 연동 필요)</div>'
        : '<div class="text-center py-8 text-gray-500">대기 중인 작업 없음 ✓</div>';
    }

  } catch (e) {
    console.error(e);
  }
}

export function initFxRateHandler(): void {
  const btn = document.getElementById('fx-rate-btn') as HTMLButtonElement;
  const input = document.getElementById('fx-rate-input') as HTMLInputElement;
  
  if (!btn || !input) return;

  btn.addEventListener('click', async () => {
    const won = parseInt(input.value);
    if (!won || won < 100 || won > 100000) return alert('100~100,000 사이 값 입력');
    
    btn.disabled = true; 
    btn.textContent = '적용 중...';
    
    try {
      const res = await fetch('/api/admin/fx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ wonPerUsd: won })
      });
      if (res.ok) {
        alert('환율이 업데이트되었습니다.');
        loadAdminDashboard();
      } else {
        const err = await res.json();
        alert('실패: ' + err.error);
      }
    } catch {
      alert('네트워크 오류');
    } finally {
      btn.disabled = false; 
      btn.textContent = '적용';
    }
  });
}

// Auto-init when DOM ready
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadAdminDashboard();
    initFxRateHandler();
  });
}
