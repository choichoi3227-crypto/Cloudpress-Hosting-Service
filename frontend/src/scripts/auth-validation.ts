export interface ValidationResult {
  valid: boolean;
  message: string;
}

export function validateEmail(email: string): ValidationResult {
  if (!email) return { valid: false, message: '이메일을 입력해주세요.' };
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return { valid: false, message: '올바른 이메일 형식이 아닙니다.' };
  if (email.length > 254) return { valid: false, message: '이메일이 너무 깁니다.' };
  return { valid: true, message: '' };
}

export function validatePassword(password: string): ValidationResult {
  if (!password) return { valid: false, message: '비밀번호를 입력해주세요.' };
  if (password.length < 8) return { valid: false, message: '비밀번호는 최소 8자 이상이어야 합니다.' };
  if (password.length > 128) return { valid: false, message: '비밀번호가 너무 깁니다.' };
  return { valid: true, message: '' };
}

export function sanitizeInput(input: string): string {
  return input.trim().replace(/[<>]/g, '');
}

export function generateCSRFToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
