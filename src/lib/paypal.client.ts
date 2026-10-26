import type { Cur } from "./currency";

/**
 * PayPal REST 클라이언트(구독 Billing API v1 + Orders API v2 + Payments v2 + Webhooks v1).
 *
 * 플랫폼 제약(공식 문서 확인):
 * - PayPal 은 KRW 결제를 지원하지 않는다 → USD 만 사용한다.
 * - 한국에 등록된 PayPal 계정은 한국 밖 구매자의 결제만 받을 수 있다(국내 결제 불가).
 */

export class PayPalError extends Error {
  constructor(public status: number, public code: string | undefined, message: string) { super(message); }
  /** 네트워크 오류(status 0)·429·5xx 는 재시도 가능. 그 외 4xx 는 요청 자체의 문제라 재시도해도 같다. */
  get retryable() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

/** USD 센트(정수) → PayPal 금액 문자열("12.99"). 부동소수점을 쓰지 않는다. */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("invalid_cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
/** PayPal 금액 문자열("12.99") → 센트(정수). */
export function valueToCents(v: string | number): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
  if (!m) throw new Error(`invalid_amount:${v}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}

export interface WebhookHeaders {
  authAlgo: string | null; certUrl: string | null; transmissionId: string | null; transmissionSig: string | null; transmissionTime: string | null;
}

export interface PayPalPort {
  /** 월 구독 플랜(상품 포함)을 만든다. 같은 idem 키는 같은 결과를 돌려준다. */
  createMonthlyPlan(p: { name: string; currency: Cur; amountMinor: number; customId: string }, idem: string): Promise<{ planId: string }>;
  /** 구독을 만들고 구매자가 승인할 URL 을 돌려준다. 결제 확정은 웹훅으로만 한다. */
  createSubscription(p: { planId: string; customId: string; email: string; returnUrl: string; cancelUrl: string }, idem: string): Promise<{ id: string; approveUrl: string }>;
  getSubscription(id: string): Promise<{ id: string; status: string; nextBillingTime: string | null; lastPaymentTime: string | null }>;
  cancelSubscription(id: string, reason: string): Promise<void>;
  suspendSubscription(id: string, reason: string): Promise<void>;
  activateSubscription(id: string, reason: string): Promise<void>;
  /** 일회성 결제(도메인 등). */
  createOrder(p: { customId: string; currency: Cur; amountMinor: number; description: string; returnUrl: string; cancelUrl: string }, idem: string): Promise<{ id: string; approveUrl: string }>;
  captureOrder(orderId: string, idem: string): Promise<{ orderId: string; captureId: string; status: string; customId: string | null; currency: string; amountMinor: number }>;
  /** 캡처(구독 결제 포함, 트랜잭션 ID) 환불. amountMinor 생략 시 전액. */
  refundCapture(p: { captureId: string; amountMinor?: number; currency?: Cur; note?: string }, idem: string): Promise<{ id: string; status: string }>;
  /** 웹훅 서명 검증(PayPal verify-webhook-signature). */
  verifyWebhook(p: { headers: WebhookHeaders; webhookId: string; rawBody: string }): Promise<boolean>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<any> }>;

export const PAYPAL_BASE = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;

export class PayPalHttp implements PayPalPort {
  private token: { value: string; exp: number } | null = null;
  constructor(private o: { clientId: string; clientSecret: string; env: "sandbox" | "live"; fetch?: Fetch; now?: () => number }) {
    if (!o.clientId || !o.clientSecret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET 누락");
  }
  private get base() { return PAYPAL_BASE[this.o.env]; }
  private f: Fetch = (u, i) => (this.o.fetch ?? ((url, init) => fetch(url, init) as Promise<{ status: number; json(): Promise<any> }>))(u, i);
  private nowMs() { return (this.o.now ?? Date.now)(); }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > this.nowMs() + 60_000) return this.token.value;
    let res: { status: number; json(): Promise<any> };
    try {
      res = await this.f(`${this.base}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${this.o.clientId}:${this.o.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
    } catch { throw new PayPalError(0, "network_error", "PayPal 인증 연결 실패"); }
    const j = await res.json().catch(() => null);
    if (res.status >= 400 || !j?.access_token) throw new PayPalError(res.status, j?.error, j?.error_description ?? `PayPal 인증 실패 HTTP ${res.status}`);
    this.token = { value: j.access_token, exp: this.nowMs() + Number(j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: "POST" | "GET" | "PATCH", path: string, body: unknown, idem?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (idem) headers["PayPal-Request-Id"] = idem.slice(0, 108);
    let res: { status: number; json(): Promise<any> };
    try { res = await this.f(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new PayPalError(0, "network_error", "PayPal 연결 실패"); }
    // 204 No Content(취소·정지 등)는 본문이 없다.
    const j = res.status === 204 ? {} : await res.json().catch(() => null);
    if (res.status >= 400 || j === null) throw new PayPalError(res.status, j?.name, j?.message ?? `HTTP ${res.status}`);
    return j as T;
  }

  async createMonthlyPlan(p: { name: string; currency: Cur; amountMinor: number; customId: string }, idem: string) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal 은 USD 만 지원합니다.");
    const product = await this.call<{ id: string }>("POST", "/v1/catalogs/products", { name: p.name.slice(0, 127), type: "SERVICE", category: "SOFTWARE" }, `product:${idem}`);
    const plan = await this.call<{ id: string }>("POST", "/v1/billing/plans", {
      product_id: product.id, name: p.name.slice(0, 127), status: "ACTIVE", description: p.name.slice(0, 127),
      billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: centsToValue(p.amountMinor), currency_code: "USD" } } }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3, setup_fee_failure_action: "CANCEL" },
    }, `plan:${idem}`);
    return { planId: plan.id };
  }

  async createSubscription(p: { planId: string; customId: string; email: string; returnUrl: string; cancelUrl: string }, idem: string) {
    const s = await this.call<{ id: string; links: { rel: string; href: string }[] }>("POST", "/v1/billing/subscriptions", {
      plan_id: p.planId, custom_id: p.customId.slice(0, 127), subscriber: { email_address: p.email },
      application_context: { brand_name: "CloudPress", locale: "ko-KR", user_action: "SUBSCRIBE_NOW", shipping_preference: "NO_SHIPPING",
        payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" }, return_url: p.returnUrl, cancel_url: p.cancelUrl },
    }, idem);
    const approve = s.links?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new PayPalError(502, "no_approve_link", "PayPal 승인 URL 이 없습니다.");
    return { id: s.id, approveUrl: approve };
  }

  async getSubscription(id: string) {
    const s = await this.call<any>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`, undefined);
    return { id: s.id, status: s.status, nextBillingTime: s.billing_info?.next_billing_time ?? null, lastPaymentTime: s.billing_info?.last_payment?.time ?? null };
  }
  async cancelSubscription(id: string, reason: string) { await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 128) }); }
  async suspendSubscription(id: string, reason: string) { await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/suspend`, { reason: reason.slice(0, 128) }); }
  async activateSubscription(id: string, reason: string) { await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/activate`, { reason: reason.slice(0, 128) }); }

  async createOrder(p: { customId: string; currency: Cur; amountMinor: number; description: string; returnUrl: string; cancelUrl: string }, idem: string) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal 은 USD 만 지원합니다.");
    const o = await this.call<{ id: string; links: { rel: string; href: string }[] }>("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ custom_id: p.customId.slice(0, 127), description: p.description.slice(0, 127), amount: { currency_code: "USD", value: centsToValue(p.amountMinor) } }],
      payment_source: { paypal: { experience_context: { brand_name: "CloudPress", locale: "ko-KR", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: p.returnUrl, cancel_url: p.cancelUrl } } },
    }, idem);
    const approve = o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approve) throw new PayPalError(502, "no_approve_link", "PayPal 승인 URL 이 없습니다.");
    return { id: o.id, approveUrl: approve };
  }

  async captureOrder(orderId: string, idem: string) {
    const o = await this.call<any>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, idem);
    const pu = o.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];
    if (!cap) throw new PayPalError(502, "no_capture", "캡처 결과가 없습니다.");
    return { orderId: o.id, captureId: cap.id as string, status: cap.status as string, customId: (cap.custom_id ?? pu?.custom_id ?? null) as string | null, currency: cap.amount?.currency_code as string, amountMinor: valueToCents(cap.amount?.value) };
  }

  async refundCapture(p: { captureId: string; amountMinor?: number; currency?: Cur; note?: string }, idem: string) {
    const body: Record<string, unknown> = {};
    if (p.amountMinor) body.amount = { value: centsToValue(p.amountMinor), currency_code: p.currency ?? "USD" };
    if (p.note) body.note_to_payer = p.note.slice(0, 255);
    const r = await this.call<{ id: string; status: string }>("POST", `/v2/payments/captures/${encodeURIComponent(p.captureId)}/refund`, body, idem);
    return { id: r.id, status: r.status };
  }

  async verifyWebhook(p: { headers: WebhookHeaders; webhookId: string; rawBody: string }) {
    const h = p.headers;
    if (!h.authAlgo || !h.certUrl || !h.transmissionId || !h.transmissionSig || !h.transmissionTime) return false;
    // 인증서 URL 은 PayPal 도메인이어야 한다(서명 검증을 가짜 서버로 유도하는 공격 방지는 PayPal API 가 하지만 입력도 거른다).
    try { if (!/(^|\.)paypal\.com$/.test(new URL(h.certUrl).hostname)) return false; } catch { return false; }
    let event: unknown;
    try { event = JSON.parse(p.rawBody); } catch { return false; }
    const r = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h.authAlgo, cert_url: h.certUrl, transmission_id: h.transmissionId, transmission_sig: h.transmissionSig, transmission_time: h.transmissionTime,
      webhook_id: p.webhookId, webhook_event: event,
    });
    return r.verification_status === "SUCCESS";
  }
}

/** 개발·테스트용 가짜 PayPal. 실제 결제는 일어나지 않는다. 모든 호출을 기록한다. */
export class MockPayPal implements PayPalPort {
  calls: { op: string; args: unknown; idem?: string }[] = [];
  private memo = new Map<string, unknown>();
  failNext: PayPalError | null = null;
  /** verifyWebhook 은 `paypal-transmission-sig` 가 이 값일 때만 통과한다(테스트 전용). */
  static readonly VALID_SIG = "mock-valid-signature";
  private n = 0;
  /** 재시작해도 로컬 DB 의 기존 ID 와 겹치지 않게 호출 시점에 난수 접미사를 붙인다(전역 스코프에서는 난수 생성 금지). */
  private uid() { return `${++this.n}${crypto.randomUUID().slice(0, 6)}`; }
  private run<T>(op: string, args: unknown, idem: string | undefined, make: () => T): T {
    this.calls.push({ op, args, idem });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    if (idem && this.memo.has(`${op}:${idem}`)) return this.memo.get(`${op}:${idem}`) as T;
    const v = make(); if (idem) this.memo.set(`${op}:${idem}`, v); return v;
  }
  async createMonthlyPlan(p: { name: string; currency: Cur; amountMinor: number; customId: string }, idem: string) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal 은 USD 만 지원합니다.");
    return this.run("plan", p, idem, () => ({ planId: `P-MOCK${this.uid()}` }));
  }
  async createSubscription(p: { planId: string; customId: string; email: string; returnUrl: string; cancelUrl: string }, idem: string) {
    return this.run("subscription", p, idem, () => { const id = `I-MOCK${this.uid()}`; return { id, approveUrl: `https://www.sandbox.paypal.test/webapps/billing/subscriptions?ba_token=${id}` }; });
  }
  async getSubscription(id: string) { return this.run("get_subscription", { id }, undefined, () => ({ id, status: "ACTIVE", nextBillingTime: null, lastPaymentTime: null })); }
  async cancelSubscription(id: string, reason: string) { this.run("cancel_subscription", { id, reason }, undefined, () => undefined); }
  async suspendSubscription(id: string, reason: string) { this.run("suspend_subscription", { id, reason }, undefined, () => undefined); }
  async activateSubscription(id: string, reason: string) { this.run("activate_subscription", { id, reason }, undefined, () => undefined); }
  async createOrder(p: { customId: string; currency: Cur; amountMinor: number; description: string; returnUrl: string; cancelUrl: string }, idem: string) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal 은 USD 만 지원합니다.");
    return this.run("order", p, idem, () => { const id = `ORD-MOCK${this.uid()}`; return { id, approveUrl: `https://www.sandbox.paypal.test/checkoutnow?token=${id}` }; });
  }
  async captureOrder(orderId: string, idem: string) {
    return this.run("capture", { orderId }, idem, () => ({ orderId, captureId: `CAP-MOCK${this.uid()}`, status: "COMPLETED", customId: null, currency: "USD", amountMinor: 0 }));
  }
  async refundCapture(p: { captureId: string; amountMinor?: number; currency?: Cur; note?: string }, idem: string) {
    return this.run("refund", p, idem, () => ({ id: `REF-MOCK${this.uid()}`, status: "COMPLETED" }));
  }
  async verifyWebhook(p: { headers: WebhookHeaders; webhookId: string; rawBody: string }) {
    this.calls.push({ op: "verify_webhook", args: { webhookId: p.webhookId } });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    return p.headers.transmissionSig === MockPayPal.VALID_SIG;
  }
}
