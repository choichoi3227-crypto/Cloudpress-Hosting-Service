export async function loadDomains(): Promise<void> {
  try {
    const res = await fetch('/api/domains', { credentials: 'include' });
    if (!res.ok) throw new Error('Failed');
    const domains = await res.json();
    const container = document.getElementById('domains-list');
    if (!container) return;
    
    if (domains.length === 0) {
      container.innerHTML = '<div class="text-center py-12 text-gray-500">등록된 도메인이 없습니다. <button id="add-first-domain" class="text-primary hover:underline ml-2">도메인 등록하기</button></div>';
      document.getElementById('add-first-domain')?.addEventListener('click', () => document.getElementById('domain-search')?.focus());
    } else {
      container.innerHTML = domains.map((d: any) => `
        <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-slate-800 last:border-0">
          <div class="flex items-center gap-4">
            <span class="font-mono text-lg font-medium">${d.hostname}</span>
            <div class="flex gap-2">
              <span class="px-2 py-1 text-xs font-medium rounded-full ${d.ownershipStatus === 'verified' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'}">${d.ownershipStatus}</span>
              <span class="px-2 py-1 text-xs font-medium rounded-full ${d.sslStatus === 'active' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'}">${d.sslStatus}</span>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-sm text-gray-500">${new Date(d.createdAt).toLocaleDateString('ko-KR')}</span>
            <button class="text-primary hover:underline text-sm" onclick="manageDomain('${d.id}')">관리</button>
          </div>
        </div>
      `).join('');
    }
  } catch (e) { console.error(e); }
}

export function initDomainSearch(): void {
  const searchBtn = document.getElementById('search-btn') as HTMLButtonElement;
  const searchInput = document.getElementById('domain-search') as HTMLInputElement;
  const resultsDiv = document.getElementById('search-results');
  
  if (!searchBtn || !searchInput || !resultsDiv) return;
  
  searchBtn.addEventListener('click', async () => {
    const hostname = searchInput.value.trim();
    if (!hostname) return alert('도메인 입력');
    
    resultsDiv.classList.remove('hidden');
    resultsDiv.innerHTML = '<div class="text-center py-4 text-gray-500">검색 중...</div>';
    
    try {
      const res = await fetch(`/api/domains/check?q=${encodeURIComponent(hostname)}`, { credentials: 'include' });
      const data = await res.json();
      
      if (data.available) {
        resultsDiv.innerHTML = `
          <div class="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <p class="font-medium text-green-800 dark:text-green-300">${hostname} 등록 가능!</p>
            <p class="text-sm text-green-600 dark:text-green-400 mt-1">예상 연간 비용: 약 $${(data.price / 1000000).toFixed(2)}</p>
            <button onclick="openDomainModal('${hostname}')" class="mt-3 bg-primary hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">등록 진행</button>
          </div>
        `;
      } else {
        resultsDiv.innerHTML = `<div class="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800"><p class="font-medium text-red-800 dark:text-red-300">${hostname} 이미 등록됨 또는 사용 불가</p></div>`;
      }
    } catch (e) { 
      resultsDiv.innerHTML = '<div class="p-4 text-red-600">검색 실패</div>'; 
    }
  });
}

export function initDomainModal(): void {
  const modal = document.getElementById('domain-modal');
  const form = document.getElementById('domain-form') as HTMLFormElement;
  const cancelBtn = document.getElementById('modal-cancel');
  
  if (!modal || !form) return;
  
  (window as any).openDomainModal = (hostname: string) => {
    const input = document.getElementById('modal-hostname') as HTMLInputElement;
    if (input) input.value = hostname;
    modal.classList.remove('hidden');
    form.reset();
  };
  
  cancelBtn?.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === e.currentTarget) modal.classList.add('hidden'); });
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const contact = {
      email: formData.get('email'),
      phone: formData.get('phone'),
      postal_info: {
        name: formData.get('name'),
        address: { street: formData.get('street'), city: formData.get('city'), state: '', postal_code: formData.get('postal'), country_code: 'KR' }
      }
    };
    
    const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    btn.disabled = true; 
    btn.textContent = '처리 중...';
    
    try {
      const res = await fetch('/api/domains/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ hostname: formData.get('hostname'), contact, currency: 'KRW' })
      });
      
      if (res.ok) {
        alert('견적이 생성되었습니다. 결제 페이지로 이동합니다.');
        modal.classList.add('hidden');
      } else {
        const err = await res.json();
        alert('실패: ' + err.error);
      }
    } catch { 
      alert('네트워크 오류'); 
    } finally { 
      btn.disabled = false; 
      btn.textContent = '견적 요청'; 
    }
  });
}

export function initDomainsPage(): void {
  loadDomains();
  initDomainSearch();
  initDomainModal();
  
  document.getElementById('add-domain-btn')?.addEventListener('click', () => document.getElementById('domain-search')?.focus());
  document.getElementById('add-first-domain')?.addEventListener('click', () => document.getElementById('domain-search')?.focus());
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initDomainsPage);
}
