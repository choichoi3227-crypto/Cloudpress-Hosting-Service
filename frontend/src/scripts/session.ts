// 모든 페이지 공통: 세션 확인, CSRF 토큰 발급, 내비게이션 갱신, 보호 페이지 접근 제어.
const PUBLIC_PATHS = new Set(['/', '/login', '/register']);

declare global { interface Window { csrfToken?: string; cpUser?: { id: string; email: string; role: string } } }

function normPath(p: string): string { return p.length > 1 ? p.replace(/\/+$/, '') : p; }

// 같은 출처의 변경 요청(POST/PUT/PATCH/DELETE)에 CSRF 토큰을 자동으로 붙인다.
let resolveToken: (t: string) => void = () => {};
const tokenReady = new Promise<string>((r) => { resolveToken = r; });
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
  const isAuthEntry = /\/api\/auth\/(login|register|csrf)(\?|$)/.test(url);
  if (sameOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !isAuthEntry) {
    const token = window.csrfToken || await Promise.race([tokenReady, new Promise<string>((r) => setTimeout(() => r(''), 5000))]);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    if (!init.credentials) init = { ...init, credentials: 'include' };
    init = { ...init, headers };
  }
  return nativeFetch(input, init);
};

export async function initSession(): Promise<void> {
  const path = normPath(window.location.pathname);
  const isPublic = PUBLIC_PATHS.has(path);
  let ok = false;
  try {
    const res = await fetch('/api/auth/csrf', { credentials: 'include' });
    const data0 = res.ok ? await res.json() as { authenticated?: boolean; csrfToken?: string; user?: { id: string; email: string; role: string } } : null;
    if (data0?.authenticated && data0.csrfToken && data0.user) {
      const data = { csrfToken: data0.csrfToken, user: data0.user };
      window.csrfToken = data.csrfToken;
      resolveToken(data.csrfToken);
      window.cpUser = data.user;
      ok = true;
    }
  } catch { /* 네트워크 오류는 비로그인으로 취급 */ }

  if (!ok) resolveToken('');
  if (!ok && !isPublic) { window.location.replace('/login'); return; }
  if (ok && (path === '/login' || path === '/register')) { window.location.replace('/dashboard'); return; }
  const operatorOnly = path.startsWith('/admin') || ['/gateway', '/mesh', '/observability', '/fleet'].some((p) => path === p || path.startsWith(p + '/'));
  if (operatorOnly && window.cpUser?.role !== 'admin') { window.location.replace('/dashboard'); return; }

  const $ = (id: string) => document.getElementById(id);
  if (ok && window.cpUser) {
    $('nav-login')?.classList.add('hidden');
    const u = $('nav-user'); if (u) { u.textContent = window.cpUser.email; u.classList.remove('hidden'); }
    $('nav-logout')?.classList.remove('hidden');
    if (window.cpUser.role === 'admin') { $('nav-admin')?.classList.remove('hidden'); const op = $('nav-operator'); op?.classList.remove('hidden'); op?.classList.add('flex'); }
  }
  $('nav-logout')?.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': window.csrfToken ?? '' } }); } catch { /* 무시 */ }
    window.location.href = '/login';
  });
}

initSession();
