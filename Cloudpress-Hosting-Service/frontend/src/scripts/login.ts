import { validateEmail, validatePassword } from './auth-validation.ts';

export function initLogin(): void {
  const form = document.getElementById('login-form') as HTMLFormElement;
  const emailInput = document.getElementById('email') as HTMLInputElement;
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  
  // 실제 로그인 페이지의 버튼 및 에러 메시지 ID에 맞게 조정 (또는 일반 쿼리 셀렉터 사용)
  const btn = (document.getElementById('login-btn') || document.querySelector('button[type="submit"]')) as HTMLButtonElement;
  const errorDiv = (document.getElementById('login-error') || document.getElementById('error-message')) as HTMLDivElement;

  if (!form || !emailInput || !passwordInput) {
    return; // 필수 요소가 없으면 실행 중지 (다른 페이지에서의 에러 방지)
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorDiv) {
      errorDiv.classList.add('hidden');
    }

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      if (errorDiv) {
        errorDiv.textContent = emailCheck.message || '올바른 이메일을 입력해주세요.';
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      if (errorDiv) {
        errorDiv.textContent = passwordCheck.message || '비밀번호를 입력해주세요.';
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '로그인 중...';
    }

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });

      const data = await res.json() as { message?: string; error?: string };

      if (res.ok) {
        window.location.href = '/dashboard';
      } else {
        if (errorDiv) {
          errorDiv.textContent = data.message || data.error || '로그인 실패';
          errorDiv.classList.remove('hidden');
        }
      }
    } catch {
      if (errorDiv) {
        errorDiv.textContent = '네트워크 오류가 발생했습니다.';
        errorDiv.classList.remove('hidden');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '로그인';
      }
    }
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogin);
  } else {
    initLogin();
  }
}
