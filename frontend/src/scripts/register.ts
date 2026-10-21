import { validateEmail, validatePassword } from './auth-validation.ts';

export function initRegister(): void {
  const form = document.getElementById('register-form') as HTMLFormElement;
  const emailInput = document.getElementById('email') as HTMLInputElement;
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  const confirmInput = document.getElementById('password-confirm') as HTMLInputElement;
  const btn = document.getElementById('register-btn') as HTMLButtonElement;
  const errorDiv = document.getElementById('register-error') as HTMLDivElement;

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
    input.addEventListener('input', () => clearError(input));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorDiv.classList.add('hidden');

    const emailValid = validateEmail(emailInput.value);
    const passwordValid = validatePassword(passwordInput.value);
    const passwordsMatch = passwordInput.value === confirmInput.value;

    if (!emailValid.valid) { showError(emailInput, emailValid.message); return; }
    if (!passwordValid.valid) { showError(passwordInput, passwordValid.message); return; }
    if (!passwordsMatch) { showError(confirmInput, '비밀번호가 일치하지 않습니다.'); return; }

    btn.disabled = true;
    btn.textContent = '가입 중...';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
      });

      const data = await res.json();
      if (res.ok) {
        alert('회원가입이 완료되었습니다. 로그인 페이지로 이동합니다.');
        window.location.href = '/login';
      } else {
        errorDiv.textContent = data.message || data.error || '회원가입 실패';
        errorDiv.classList.remove('hidden');
      }
    } catch {
      errorDiv.textContent = '네트워크 오류가 발생했습니다.';
      errorDiv.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '가입하기';
    }
  });

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
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initRegister);
}
