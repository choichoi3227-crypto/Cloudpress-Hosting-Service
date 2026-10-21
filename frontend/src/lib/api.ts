import { secureFetch } from '../scripts/security.ts';

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
    monthlyMicro: number;
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

export interface ComingSoonResponse {
  comingSoon: boolean;
  feature: string;
  message: string;
}

async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await secureFetch(`${API_BASE}${path}`, options);

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'unknown_error' }));
    if (res.status === 501 && error.comingSoon) {
      throw { comingSoon: true, feature: error.feature, message: error.message };
    }
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    me: () => fetchApi<User>('/auth/me'),
    register: (email: string, password: string) => 
      fetchApi<{ ok: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
    login: (email: string, password: string) =>
      fetchApi<{ ok: boolean; csrfToken: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => fetchApi<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  },

  subscriptions: {
    list: () => fetchApi<Subscription[]>('/subscriptions'),
    get: (id: string) => fetchApi<Subscription>(`/subscriptions/${id}`),
    createCheckout: (productId: string, currency: 'KRW' | 'USD') =>
      fetchApi<{ url: string }>('/checkout/subscription', { method: 'POST', body: JSON.stringify({ productId, currency }) }),
    createPortal: () => fetchApi<{ url: string }>('/billing/portal', { method: 'POST' }),
    suspend: (id: string) => fetchApi<{ ok: boolean }>(`/services/${id}/suspend`, { method: 'POST' }),
    resume: (id: string) => fetchApi<{ ok: boolean }>(`/services/${id}/resume`, { method: 'POST' }),
    cancel: (id: string) => fetchApi<{ ok: boolean }>(`/services/${id}/cancel`, { method: 'POST' }),
  },

  domains: {
    list: () => fetchApi<any[]>('/domains'),
    get: (id: string) => fetchApi<any>(`/domains/${id}`),
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

  containers: {
    list: () => fetchApi<any[]>('/containers'),
    get: (id: string) => fetchApi<any>(`/containers/${id}`),
    suspend: (id: string) => fetchApi<{ ok: boolean }>(`/containers/${id}/suspend`, { method: 'POST' }),
    resume: (id: string) => fetchApi<{ ok: boolean }>(`/containers/${id}/resume`, { method: 'POST' }),
  },

  billing: {
    invoices: () => fetchApi<any[]>('/billing/invoices'),
    getInvoice: (id: string) => fetchApi<any>(`/billing/invoices/${id}`),
    upcoming: () => fetchApi<any>('/billing/upcoming'),
  },

  admin: {
    summary: () => fetchApi<any>('/admin/summary'),
    users: () => fetchApi<any[]>('/admin/users'),
    subscriptions: () => fetchApi<any[]>('/admin/subscriptions'),
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
