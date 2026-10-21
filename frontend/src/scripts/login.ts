import { validateEmail, validatePassword } from './auth-validation.ts';

export function initLogin(): void {
  const form = document.getElementById('login-form') as HTMLFormElement;
  const emailInput = document.getElementById('email') as HTMLInputElement;
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  const btn = document.getElementById('login-btn') as HTMLButtonElement;
  const errorDiv = document.getElementById('login-error') as HTMLDivElement;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorDiv.classList.add('hidden');

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!validateEmail(email).valid) {
      errorDiv.textContent = '올바른 이메일을 입력해주세요.';
      errorDiv.classList.remove('hidden');
      return;
    }
    if (!validatePassword(password).valid) {
      errorDiv.textContent = '비밀번호를 입력해주세요.';
      errorDiv.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = '로그인 중...';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (res.ok) {
        window.location.href = '/dashboard';
      } else {
        errorDiv.textContent = data.message || data.error || '로그인 실패';
        errorDiv.classList.remove('hidden');
      }
    } catch {
      errorDiv.textContent = '네트워크 오류가 발생했습니다.';
      errorDiv.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '로그인';
    }
  });
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initLogin);
}
