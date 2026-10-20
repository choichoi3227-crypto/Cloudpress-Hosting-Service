import type { Cur } from "./currency";

export class StripeError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
  /** 네트워크 오류(status 0)·429·5xx 만 재시도. 카드 거절 등 4xx 는 요청 자체의 문제. */
  get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

/** Stripe 는 JSON 이 아니라 form-urlencoded(대괄호 중첩)를 받는다. */
export function encodeForm(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => { if (item !== null && typeof item === "object") out.push(...encodeForm(item as Record<string, unknown>, `${key}[${i}]`)); else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`); });
    else if (typeof v === "object") out.push(...encodeForm(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export interface CheckoutParams {
  mode: "subscription" | "payment";
  customer: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  metadata: Record<string, string>;
  /** 구독: 미리 만든 Stripe Price. */
  priceId?: string;
  /** 일회성(도메인): 인라인 가격. amount 는 통화 최소 단위(USD 센트, KRW 원). */
  inline?: { currency: Cur; amountMinor: number; name: string };
  expiresAtSec?: number;
}

export interface StripePort {
  createCustomer(p: { email: string; metadata: Record<string, string> }, idem: string): Promise<{ id: string }>;
  createMonthlyPrice(p: { name: string; currency: Cur; amountMinor: number; metadata: Record<string, string> }, idem: string): Promise<{ priceId: string }>;
  createCheckoutSession(p: CheckoutParams, idem: string): Promise<{ id: string; url: string }>;
  createPortalSession(p: { customer: string; returnUrl: string }): Promise<{ url: string }>;
  createRefund(p: { paymentIntent: string; amountMinor?: number; metadata?: Record<string, string> }, idem: string): Promise<{ id: string; status: string }>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

/** Stripe REST 어댑터. 모든 쓰기 요청에 Idempotency-Key 를 보낸다. apiVersion 은 운영자가 고정해서 주입(코드에 임의 버전을 넣지 않음). */
export class StripeHttp implements StripePort {
  constructor(private o: { secretKey: string; apiVersion?: string; fetch?: Fetch }) { if (!/^(sk|rk)_/.test(o.secretKey)) throw new Error("STRIPE_SECRET_KEY 형식 오류"); }
  private async call<T>(method: "POST" | "GET", path: string, body: Record<string, unknown> | undefined, idem?: string): Promise<T> {
    const f: Fetch = this.o.fetch ?? ((u, i) => fetch(u, i) as Promise<{ status: number; json(): Promise<any> }>);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" };
    if (idem) headers["Idempotency-Key"] = idem;
    if (this.o.apiVersion) headers["Stripe-Version"] = this.o.apiVersion;
    let res: { status: number; json(): Promise<any> };
    try { res = await f(`https://api.stripe.com${path}`, { method, headers, body: body ? encodeForm(body).join("&") : undefined }); } catch { throw new StripeError(0, "network_error", "Stripe 연결 실패"); }
    const j = await res.json().catch(() => null);
    if (res.status >= 400 || !j) throw new StripeError(res.status, j?.error?.code, j?.error?.message ?? `HTTP ${res.status}`);
    return j as T;
  }
  createCustomer(p: { email: string; metadata: Record<string, string> }, idem: string) { return this.call<{ id: string }>("POST", "/v1/customers", { email: p.email, metadata: p.metadata }, idem); }
  async createMonthlyPrice(p: { name: string; currency: Cur; amountMinor: number; metadata: Record<string, string> }, idem: string) {
    const r = await this.call<{ id: string }>("POST", "/v1/prices", { currency: p.currency.toLowerCase(), unit_amount: p.amountMinor, recurring: { interval: "month" }, product_data: { name: p.name }, metadata: p.metadata }, idem);
    return { priceId: r.id };
  }
  async createCheckoutSession(p: CheckoutParams, idem: string) {
    const body: Record<string, unknown> = {
      mode: p.mode, customer: p.customer, success_url: p.successUrl, cancel_url: p.cancelUrl, client_reference_id: p.clientReferenceId, metadata: p.metadata,
      ...(p.mode === "subscription" ? { line_items: [{ price: p.priceId, quantity: 1 }], subscription_data: { metadata: p.metadata } } : { line_items: [{ quantity: 1, price_data: { currency: p.inline!.currency.toLowerCase(), unit_amount: p.inline!.amountMinor, product_data: { name: p.inline!.name } } }], payment_intent_data: { metadata: p.metadata } }),
      ...(p.expiresAtSec ? { expires_at: p.expiresAtSec } : {}),
    };
    const r = await this.call<{ id: string; url: string }>("POST", "/v1/checkout/sessions", body, idem);
    return { id: r.id, url: r.url };
  }
  async createPortalSession(p: { customer: string; returnUrl: string }) { const r = await this.call<{ url: string }>("POST", "/v1/billing_portal/sessions", { customer: p.customer, return_url: p.returnUrl }); return { url: r.url }; }
  async createRefund(p: { paymentIntent: string; amountMinor?: number; metadata?: Record<string, string> }, idem: string) {
    const r = await this.call<{ id: string; status: string }>("POST", "/v1/refunds", { payment_intent: p.paymentIntent, ...(p.amountMinor ? { amount: p.amountMinor } : {}), ...(p.metadata ? { metadata: p.metadata } : {}) }, idem);
    return { id: r.id, status: r.status };
  }
}

/** 모의 모드·테스트용. 같은 멱등 키는 같은 결과를 돌려준다(Stripe 동작과 동일). */
export class MockStripe implements StripePort {
  calls: { op: string; args: unknown; idem?: string }[] = [];
  private memo = new Map<string, unknown>();
  failNext: StripeError | null = null;
  private n = 0;
  private run<T>(op: string, args: unknown, idem: string | undefined, make: () => T): T {
    this.calls.push({ op, args, idem });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    if (idem && this.memo.has(`${op}:${idem}`)) return this.memo.get(`${op}:${idem}`) as T;
    const v = make(); if (idem) this.memo.set(`${op}:${idem}`, v); return v;
  }
  async createCustomer(p: { email: string; metadata: Record<string, string> }, idem: string) { return this.run("customer", p, idem, () => ({ id: `cus_mock${++this.n}` })); }
  async createMonthlyPrice(p: { name: string; currency: Cur; amountMinor: number; metadata: Record<string, string> }, idem: string) { return this.run("price", p, idem, () => ({ priceId: `price_mock${++this.n}` })); }
  async createCheckoutSession(p: CheckoutParams, idem: string) { return this.run("checkout", p, idem, () => ({ id: `cs_mock${++this.n}`, url: `https://checkout.stripe.test/c/${this.n}` })); }
  async createPortalSession(p: { customer: string; returnUrl: string }) { return this.run("portal", p, undefined, () => ({ url: `https://billing.stripe.test/p/${p.customer}` })); }
  async createRefund(p: { paymentIntent: string; amountMinor?: number }, idem: string) { return this.run("refund", p, idem, () => ({ id: `re_mock${++this.n}`, status: "succeeded" })); }
}
