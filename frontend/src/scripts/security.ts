// Security utilities for frontend

export function getCSRFToken(): string {
  // Read CSRF token from cookie or meta tag
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'csrf_token') return decodeURIComponent(value);
  }
  // Fallback to meta tag
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content') || '';
  return '';
}

export function setCSRFToken(token: string): void {
  document.cookie = `csrf_token=${encodeURIComponent(token)}; path=/; SameSite=Strict; Secure`;
}

export function addCSRFHeader(headers: HeadersInit = {}): HeadersInit {
  const token = getCSRFToken();
  if (token) {
    return {
      ...headers,
      'X-CSRF-Token': token
    };
  }
  return headers;
}

// Secure fetch wrapper with CSRF protection
export async function secureFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = addCSRFHeader(options.headers);
  return fetch(url, {
    ...options,
    headers,
    credentials: 'include'
  });
}

// XSS prevention - sanitize HTML
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Safe innerHTML setter
export function safeSetHTML(element: HTMLElement, html: string): void {
  // Only allow safe elements/attributes
  const template = document.createElement('template');
  template.innerHTML = html;
  // Remove script tags and event handlers
  const scripts = template.content.querySelectorAll('script');
  scripts.forEach(s => s.remove());
  const elements = template.content.querySelectorAll('*');
  elements.forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    });
  });
  element.innerHTML = '';
  element.appendChild(template.content);
}

// Content Security Policy nonce generator
export function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}
