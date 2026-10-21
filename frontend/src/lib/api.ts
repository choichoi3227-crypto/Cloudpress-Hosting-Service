// API 클라이언트 - Worker 백엔드와 통신
const API_BASE = import.meta.env.PUBLIC_API_URL || '/api';

export interface User {
  id: string;
  email: string;
  role: 'customer' | 'admin' | 'affiliate_only';
}

export interface Subscription {
  id: string;
  productId: string;
  status: 'incomplete' | 'active' | 'past_due' | 'suspended' | 'canceling' | 'canceled' | 'refunded';
  currentPeriodEnd: string;
  product: {
    id: string;
    nameKo: string;
    kind: string;
  };
}

export interface Domain {
  id: string;
  hostname: string;
  ownershipStatus: 'pending' | 'verified' | 'failed';
  sslStatus: 'none' | 'pending' | 'active' | 'renewing' | 'failed';
  createdAt: string;
}

export interface Invoice {
  id: string;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  totalMicro: number;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

export interface Container {
  id: string;
  instanceType: string;
  state: 'provisioning' | 'running' | 'sleeping' | 'stopped' | 'failed' | 'deleting' | 'deleted';
  targetVcpu: number;
  actualVcpu: number;
}

export interface AdminSummary {
  totalUsers: number;
  activeSubscriptions: number;
  totalRevenueMicro: number;
  systemHealth: 'healthy' | 'degraded' | 'critical';
  wasteResources: Array<{
    resourceId: string;
    kind: string;
    action: string;
    detail: string;
  }>;
  pendingApprovals: number;
}

async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
    ...options,
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'unknown_error' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // 인증
  auth: {
    me: () => fetchApi<User>('/auth/me'),
    register: (email: string, password: string) => 
      fetchApi<{ ok: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
    login: (email: string, password: string) =>
      fetchApi<{ ok: boolean; csrfToken: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => fetchApi<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  },

  // 구독/서비스
  subscriptions: {
    list: () => fetchApi<Subscription[]>('/subscriptions'),
    get: (id: string) => fetchApi<Subscription>(`/subscriptions/${id}`),
    createCheckout: (productId: string, currency: 'KRW' | 'USD') =>
      fetchApi<{ url: string }>('/checkout/subscription', { method: 'POST', body: JSON.stringify({ productId, currency }) }),
    createPortal: () => fetchApi<{ url: string }>('/billing/portal', { method: 'POST' }),
  },

  // 도메인
  domains: {
    list: () => fetchApi<Domain[]>('/domains'),
    get: (id: string) => fetchApi<Domain>(`/domains/${id}`),
    checkAvailability: (hostname: string) =>
      fetchApi<{ available: boolean; price: number }>(`/domains/check?q=${encodeURIComponent(hostname)}`),
    createQuote: (hostname: string, contact: any, currency: 'KRW' | 'USD') =>
      fetchApi<{ orderId: string }>('/domains/quote', { method: 'POST', body: JSON.stringify({ hostname, contact, currency }) }),
    createCheckout: (orderId: string) =>
      fetchApi<{ url: string }>('/checkout/domain', { method: 'POST', body: JSON.stringify({ orderId }) }),
    getRecords: (id: string) => fetchApi<any[]>(`/domains/${id}/records`),
    updateRecords: (id: string, records: any[]) =>
      fetchApi<{ ok: boolean }>(`/domains/${id}/records`, { method: 'PUT', body: JSON.stringify({ records }) }),
  },

  // 컨테이너
  containers: {
    list: () => fetchApi<Container[]>('/containers'),
    get: (id: string) => fetchApi<Container>(`/containers/${id}`),
    suspend: (id: string) => fetchApi<{ ok: boolean }>(`/containers/${id}/suspend`, { method: 'POST' }),
    resume: (id: string) => fetchApi<{ ok: boolean }>(`/containers/${id}/resume`, { method: 'POST' }),
  },

  // 청구/인보이스
  billing: {
    invoices: () => fetchApi<Invoice[]>('/billing/invoices'),
    getInvoice: (id: string) => fetchApi<Invoice>(`/billing/invoices/${id}`),
  },

  // 관리자
  admin: {
    summary: () => fetchApi<AdminSummary>('/admin/summary'),
    users: () => fetchApi<User[]>('/admin/users'),
    subscriptions: () => fetchApi<Subscription[]>('/admin/subscriptions'),
    triggerBackup: (containerId: string, kind: 'full' | 'incremental' | 'binlog') =>
      fetchApi<{ jobId: string }>(`/admin/containers/${containerId}/backup`, { method: 'POST', body: JSON.stringify({ kind }) }),
    createSnapshot: (containerId: string) =>
      fetchApi<{ snapshotHandle: string }>(`/admin/containers/${containerId}/snapshot`, { method: 'POST' }),
    approveJob: (jobId: string) =>
      fetchApi<{ ok: boolean }>(`/admin/jobs/${jobId}/approve`, { method: 'POST' }),
    setFxRate: (wonPerUsd: number) =>
      fetchApi<{ status: string }>('/admin/fx', { method: 'POST', body: JSON.stringify({ wonPerUsd }) }),
  },
};
