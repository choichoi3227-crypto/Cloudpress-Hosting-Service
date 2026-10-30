import { validateEmail, validatePassword } from './auth-validation.ts';

export function initRegister(): void {
  const form = document.getElementById('register-form') as HTMLFormElement;
  const emailInput = document.getElementById('email') as HTMLInputElement;
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  // HTML 마크업의 실제 ID인 'confirm-password'에 맞게 수정
  const confirmInput = document.getElementById('confirm-password') as HTMLInputElement;
  const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
  const errorDiv = document.getElementById('error-message') as HTMLDivElement;

  if (!form || !emailInput || !passwordInput || !confirmInput) {
    return; // 필수 요소가 없으면 실행 중지 (다른 페이지에서의 에러 방지)
  }

  function showError(input: HTMLInputElement, message: string) {
    const errorEl = document.getElementById(`${input.id}-error`) as HTMLParagraphElement;
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
    input.classList.add('border-red-500', 'focus:ring-red-500');
    input.classList.remove('border-gray-300', 'dark:border-slate-700');
  }

  function clearError(input: HTMLInputElement) {
    const errorEl = document.getElementById(`${input.id}-error`) as HTMLParagraphElement;
    if (errorEl) {
      errorEl.classList.add('hidden');
    }
    input.classList.remove('border-red-500', 'focus:ring-red-500');
    input.classList.add('border-gray-300', 'dark:border-slate-700');
  }

  emailInput.addEventListener('blur', () => {
    const result = validateEmail(emailInput.value);
    if (!result.valid) showError(emailInput, result.message);
    else clearError(emailInput);
  });

  passwordInput.addEventListener('blur', () => {
    const result = validatePassword(passwordInput.value);
    if (!result.valid) showError(passwordInput, result.message);
    else clearError(passwordInput);
  });

  confirmInput.addEventListener('blur', () => {
    if (confirmInput.value !== passwordInput.value) {
      showError(confirmInput, '비밀번호가 일치하지 않습니다.');
    } else {
      clearError(confirmInput);
    }
  });

  [emailInput, passwordInput, confirmInput].forEach(input => {
    if (input) {
      input.addEventListener('input', () => clearError(input));
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorDiv) {
      errorDiv.classList.add('hidden');
    }

    const emailValid = validateEmail(emailInput.value);
    const passwordValid = validatePassword(passwordInput.value);
    const passwordsMatch = passwordInput.value === confirmInput.value;

    if (!emailValid.valid) {
      showError(emailInput, emailValid.message);
      return;
    }
    if (!passwordValid.valid) {
      showError(passwordInput, passwordValid.message);
      return;
    }
    if (!passwordsMatch) {
      showError(confirmInput, '비밀번호가 일치하지 않습니다.');
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '가입 중...';
    }

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: emailInput.value, password: passwordInput.value, ref: storedRef() })
      });

      const data = await res.json() as { message?: string; error?: string };

      if (res.ok) {
        alert('회원가입이 완료되었습니다. 로그인 페이지로 이동합니다.');
        window.location.href = '/login';
      } else {
        if (errorDiv) {
          errorDiv.textContent = data.message || data.error || '회원가입 실패';
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
        btn.textContent = '가입하기';
      }
    }
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRegister);
  } else {
    initRegister();
  }
}

function storedRef(): string | undefined {
  try {
    const v = JSON.parse(localStorage.getItem('cp_ref') ?? 'null') as { code?: string; ts?: number } | null;
    return v?.code && v.ts && Date.now() - v.ts < 60 * 86_400_000 ? v.code : undefined;
  } catch { return undefined; }
}
