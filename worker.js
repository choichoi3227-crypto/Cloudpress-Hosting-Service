var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/lib/db.ts
var nowIso = /* @__PURE__ */ __name((ms = Date.now()) => new Date(ms).toISOString(), "nowIso");
var newId = /* @__PURE__ */ __name((prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`, "newId");

// src/lib/crypto.ts
var enc = new TextEncoder();
function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(b64urlEncode, "b64urlEncode");
function b64urlDecode(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
__name(b64urlDecode, "b64urlDecode");
var randomToken = /* @__PURE__ */ __name((bytes = 32) => b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes))), "randomToken");
async function sha256Hex(input) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function constantTimeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
__name(constantTimeEqual, "constantTimeEqual");
var PBKDF2_ITERATIONS = 1e5;
async function pbkdf2(password, salt, iterations) {
  const k = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, 256);
  return new Uint8Array(bits);
}
__name(pbkdf2, "pbkdf2");
async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const [scheme, algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || algo !== "sha256" || !iterStr || !saltB64 || !hashB64) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = b64urlEncode(await pbkdf2(password, b64urlDecode(saltB64), iterations));
  return constantTimeEqual(actual, hashB64);
}
__name(verifyPassword, "verifyPassword");
async function aesKey(keyB64) {
  const raw = b64urlDecode(keyB64);
  if (raw.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (base64url)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
__name(aesKey, "aesKey");
async function encryptSecret(plaintext, keyB64, aad = "") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(keyB64), enc.encode(plaintext));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}
__name(encryptSecret, "encryptSecret");
async function decryptSecret(token, keyB64, aad = "") {
  const [v, iv, ct] = token.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad secret format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv), additionalData: enc.encode(aad) }, await aesKey(keyB64), b64urlDecode(ct));
  return new TextDecoder().decode(pt);
}
__name(decryptSecret, "decryptSecret");

// src/lib/auth.ts
var SESSION_COOKIE = "__Host-cp_session";
var SESSION_TTL_SEC = 7 * 24 * 3600;
var EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
function normalizeEmail(raw) {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
__name(normalizeEmail, "normalizeEmail");
function validatePassword(pw) {
  if (pw.length < 12) return "\uBE44\uBC00\uBC88\uD638\uB294 12\uC790 \uC774\uC0C1\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.";
  if (pw.length > 128) return "\uBE44\uBC00\uBC88\uD638\uB294 128\uC790 \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4.";
  if (/^(.)\1+$/.test(pw)) return "\uB108\uBB34 \uB2E8\uC21C\uD55C \uBE44\uBC00\uBC88\uD638\uC785\uB2C8\uB2E4.";
  return null;
}
__name(validatePassword, "validatePassword");
async function registerUser(db, emailRaw, password, nowMs) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { ok: false, code: "invalid_email", message: "\uC774\uBA54\uC77C \uD615\uC2DD\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." };
  const weak = validatePassword(password);
  if (weak) return { ok: false, code: "weak_password", message: weak };
  const id = newId("usr");
  const hash = await hashPassword(password);
  const r = await db.prepare("INSERT OR IGNORE INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)").bind(id, email, hash, nowIso(nowMs), nowIso(nowMs)).run();
  if (r.meta.changes === 0) return { ok: false, code: "email_taken", message: "\uC774\uBBF8 \uAC00\uC785\uB41C \uC774\uBA54\uC77C\uC785\uB2C8\uB2E4." };
  await audit(db, { actorId: id, action: "user.register", targetType: "user", targetId: id }, nowMs);
  return { ok: true, userId: id };
}
__name(registerUser, "registerUser");
async function hashPasswordForUser(pw) {
  const weak = validatePassword(pw);
  if (weak) return { ok: false, message: weak };
  return { ok: true, hash: await hashPassword(pw) };
}
__name(hashPasswordForUser, "hashPasswordForUser");
var dummyHash = `pbkdf2$sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
async function login(db, emailRaw, password, nowMs) {
  const email = normalizeEmail(emailRaw) ?? "";
  const row = await db.prepare("SELECT id,email,role,status,password_hash FROM users WHERE email = ?").bind(email).first();
  const ok = await verifyPassword(password, row?.password_hash ?? dummyHash);
  if (!row || !ok) {
    await audit(db, { actorId: row?.id ?? null, action: "user.login_failed", targetType: "user", targetId: row?.id ?? null }, nowMs);
    return { ok: false, code: "invalid_credentials" };
  }
  if (row.status !== "active") return { ok: false, code: "suspended" };
  const token = randomToken();
  const csrfToken = randomToken();
  await db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ses"), row.id, await sha256Hex(token), await sha256Hex(csrfToken), nowIso(nowMs + SESSION_TTL_SEC * 1e3), nowIso(nowMs)).run();
  await audit(db, { actorId: row.id, action: "user.login", targetType: "user", targetId: row.id }, nowMs);
  return { ok: true, token, csrfToken, user: { id: row.id, email: row.email, role: row.role, status: row.status } };
}
__name(login, "login");
async function rotateCsrf(db, sessionId) {
  const t = randomToken();
  await db.prepare("UPDATE user_sessions SET csrf_hash = ? WHERE id = ?").bind(await sha256Hex(t), sessionId).run();
  return t;
}
__name(rotateCsrf, "rotateCsrf");
async function getSession(db, token, nowMs) {
  if (!token) return null;
  const r = await db.prepare(
    `SELECT s.id AS sid, s.csrf_hash, s.expires_at, s.revoked_at, u.id, u.email, u.role, u.status
       FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!r || r.revoked_at || r.status !== "active" || Date.parse(r.expires_at) <= nowMs) return null;
  return { sessionId: r.sid, csrfHash: r.csrf_hash, user: { id: r.id, email: r.email, role: r.role, status: r.status } };
}
__name(getSession, "getSession");
async function logout(db, sessionId, nowMs) {
  await db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(nowMs), sessionId).run();
}
__name(logout, "logout");
async function revokeAllSessions(db, userId, nowMs) {
  await db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(nowMs), userId).run();
}
__name(revokeAllSessions, "revokeAllSessions");
async function verifyCsrf(session, headerToken) {
  if (!headerToken) return false;
  return constantTimeEqual(await sha256Hex(headerToken), session.csrfHash);
}
__name(verifyCsrf, "verifyCsrf");
function originAllowed(method, originHeader, allowedOrigin) {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  return originHeader === allowedOrigin;
}
__name(originAllowed, "originAllowed");
function sessionCookie(token, maxAgeSec = SESSION_TTL_SEC) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
__name(sessionCookie, "sessionCookie");
var clearSessionCookie = /* @__PURE__ */ __name(() => sessionCookie("", 0), "clearSessionCookie");
function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}
__name(parseCookie, "parseCookie");
var ForbiddenError = class extends Error {
  static {
    __name(this, "ForbiddenError");
  }
  constructor() {
    super("forbidden");
  }
};
async function audit(db, e, nowMs) {
  await db.prepare("INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail_json,ts) VALUES(?,?,?,?,?,?)").bind(e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, e.detail === void 0 ? null : JSON.stringify(e.detail), nowIso(nowMs)).run();
}
__name(audit, "audit");

// src/lib/states.ts
var SUBSCRIPTION_TRANSITIONS = {
  incomplete: ["active", "canceled"],
  active: ["past_due", "suspended", "canceling", "canceled", "refunded"],
  past_due: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  canceling: ["active", "canceled"],
  canceled: [],
  refunded: []
};
var JOB_TRANSITIONS = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "retrying", "dead"],
  // 실패 판정과 재시도/폐기 결정은 한 번에 기록
  failed: ["retrying", "dead"],
  retrying: ["running", "dead", "cancelled"],
  succeeded: [],
  dead: ["queued"],
  // 운영자 수동 재처리만 허용
  cancelled: []
};
function assertTransition(table, from, to) {
  if (!table[from]?.includes(to)) throw new Error(`illegal state transition: ${from} -> ${to}`);
}
__name(assertTransition, "assertTransition");

// src/lib/paypal.client.ts
var PayPalError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
  static {
    __name(this, "PayPalError");
  }
  /** 네트워크 오류(status 0)·429·5xx 는 재시도 가능. 그 외 4xx 는 요청 자체의 문제라 재시도해도 같다. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
};
function centsToValue(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("invalid_cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
__name(centsToValue, "centsToValue");
function valueToCents(v) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v));
  if (!m) throw new Error(`invalid_amount:${v}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}
__name(valueToCents, "valueToCents");
var PAYPAL_BASE = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" };
var PayPalHttp = class {
  constructor(o) {
    this.o = o;
    if (!o.clientId || !o.clientSecret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET \uB204\uB77D");
  }
  o;
  static {
    __name(this, "PayPalHttp");
  }
  token = null;
  get base() {
    return PAYPAL_BASE[this.o.env];
  }
  f = /* @__PURE__ */ __name((u, i) => (this.o.fetch ?? ((url, init) => fetch(url, init)))(u, i), "f");
  nowMs() {
    return (this.o.now ?? Date.now)();
  }
  async accessToken() {
    if (this.token && this.token.exp > this.nowMs() + 6e4) return this.token.value;
    let res;
    try {
      res = await this.f(`${this.base}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${this.o.clientId}:${this.o.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials"
      });
    } catch {
      throw new PayPalError(0, "network_error", "PayPal \uC778\uC99D \uC5F0\uACB0 \uC2E4\uD328");
    }
    const j = await res.json().catch(() => null);
    if (res.status >= 400 || !j?.access_token) throw new PayPalError(res.status, j?.error, j?.error_description ?? `PayPal \uC778\uC99D \uC2E4\uD328 HTTP ${res.status}`);
    this.token = { value: j.access_token, exp: this.nowMs() + Number(j.expires_in ?? 300) * 1e3 };
    return this.token.value;
  }
  async call(method, path, body, idem) {
    const headers = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (idem) headers["PayPal-Request-Id"] = idem.slice(0, 108);
    let res;
    try {
      res = await this.f(`${this.base}${path}`, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
    } catch {
      throw new PayPalError(0, "network_error", "PayPal \uC5F0\uACB0 \uC2E4\uD328");
    }
    const j = res.status === 204 ? {} : await res.json().catch(() => null);
    if (res.status >= 400 || j === null) throw new PayPalError(res.status, j?.name, j?.message ?? `HTTP ${res.status}`);
    return j;
  }
  async createMonthlyPlan(p, idem) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal \uC740 USD \uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    const product = await this.call("POST", "/v1/catalogs/products", { name: p.name.slice(0, 127), type: "SERVICE", category: "SOFTWARE" }, `product:${idem}`);
    const plan = await this.call("POST", "/v1/billing/plans", {
      product_id: product.id,
      name: p.name.slice(0, 127),
      status: "ACTIVE",
      description: p.name.slice(0, 127),
      billing_cycles: [{
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: centsToValue(p.amountMinor), currency_code: "USD" } }
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3, setup_fee_failure_action: "CANCEL" }
    }, `plan:${idem}`);
    return { planId: plan.id };
  }
  async createSubscription(p, idem) {
    const s = await this.call("POST", "/v1/billing/subscriptions", {
      plan_id: p.planId,
      custom_id: p.customId.slice(0, 127),
      subscriber: { email_address: p.email },
      application_context: {
        brand_name: "CloudPress",
        locale: "ko-KR",
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
        return_url: p.returnUrl,
        cancel_url: p.cancelUrl
      }
    }, idem);
    const approve = s.links?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new PayPalError(502, "no_approve_link", "PayPal \uC2B9\uC778 URL \uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return { id: s.id, approveUrl: approve };
  }
  async getSubscription(id) {
    const s = await this.call("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`, void 0);
    return { id: s.id, status: s.status, nextBillingTime: s.billing_info?.next_billing_time ?? null, lastPaymentTime: s.billing_info?.last_payment?.time ?? null };
  }
  async cancelSubscription(id, reason) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 128) });
  }
  async suspendSubscription(id, reason) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/suspend`, { reason: reason.slice(0, 128) });
  }
  async activateSubscription(id, reason) {
    await this.call("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/activate`, { reason: reason.slice(0, 128) });
  }
  async createOrder(p, idem) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal \uC740 USD \uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    const o = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ custom_id: p.customId.slice(0, 127), description: p.description.slice(0, 127), amount: { currency_code: "USD", value: centsToValue(p.amountMinor) } }],
      payment_source: { paypal: { experience_context: { brand_name: "CloudPress", locale: "ko-KR", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: p.returnUrl, cancel_url: p.cancelUrl } } }
    }, idem);
    const approve = o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (!approve) throw new PayPalError(502, "no_approve_link", "PayPal \uC2B9\uC778 URL \uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return { id: o.id, approveUrl: approve };
  }
  async captureOrder(orderId, idem) {
    const o = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, idem);
    const pu = o.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];
    if (!cap) throw new PayPalError(502, "no_capture", "\uCEA1\uCC98 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
    return { orderId: o.id, captureId: cap.id, status: cap.status, customId: cap.custom_id ?? pu?.custom_id ?? null, currency: cap.amount?.currency_code, amountMinor: valueToCents(cap.amount?.value) };
  }
  async refundCapture(p, idem) {
    const body = {};
    if (p.amountMinor) body.amount = { value: centsToValue(p.amountMinor), currency_code: p.currency ?? "USD" };
    if (p.note) body.note_to_payer = p.note.slice(0, 255);
    const r = await this.call("POST", `/v2/payments/captures/${encodeURIComponent(p.captureId)}/refund`, body, idem);
    return { id: r.id, status: r.status };
  }
  async verifyWebhook(p) {
    const h = p.headers;
    if (!h.authAlgo || !h.certUrl || !h.transmissionId || !h.transmissionSig || !h.transmissionTime) return false;
    try {
      if (!/(^|\.)paypal\.com$/.test(new URL(h.certUrl).hostname)) return false;
    } catch {
      return false;
    }
    let event;
    try {
      event = JSON.parse(p.rawBody);
    } catch {
      return false;
    }
    const r = await this.call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h.authAlgo,
      cert_url: h.certUrl,
      transmission_id: h.transmissionId,
      transmission_sig: h.transmissionSig,
      transmission_time: h.transmissionTime,
      webhook_id: p.webhookId,
      webhook_event: event
    });
    return r.verification_status === "SUCCESS";
  }
};
var MockPayPal = class _MockPayPal {
  static {
    __name(this, "MockPayPal");
  }
  calls = [];
  memo = /* @__PURE__ */ new Map();
  failNext = null;
  /** verifyWebhook 은 `paypal-transmission-sig` 가 이 값일 때만 통과한다(테스트 전용). */
  static VALID_SIG = "mock-valid-signature";
  n = 0;
  /** 재시작해도 로컬 DB 의 기존 ID 와 겹치지 않게 호출 시점에 난수 접미사를 붙인다(전역 스코프에서는 난수 생성 금지). */
  uid() {
    return `${++this.n}${crypto.randomUUID().slice(0, 6)}`;
  }
  run(op, args, idem, make) {
    this.calls.push({ op, args, idem });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (idem && this.memo.has(`${op}:${idem}`)) return this.memo.get(`${op}:${idem}`);
    const v = make();
    if (idem) this.memo.set(`${op}:${idem}`, v);
    return v;
  }
  async createMonthlyPlan(p, idem) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal \uC740 USD \uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    return this.run("plan", p, idem, () => ({ planId: `P-MOCK${this.uid()}` }));
  }
  async createSubscription(p, idem) {
    return this.run("subscription", p, idem, () => {
      const id = `I-MOCK${this.uid()}`;
      return { id, approveUrl: `https://www.sandbox.paypal.test/webapps/billing/subscriptions?ba_token=${id}` };
    });
  }
  async getSubscription(id) {
    return this.run("get_subscription", { id }, void 0, () => ({ id, status: "ACTIVE", nextBillingTime: null, lastPaymentTime: null }));
  }
  async cancelSubscription(id, reason) {
    this.run("cancel_subscription", { id, reason }, void 0, () => void 0);
  }
  async suspendSubscription(id, reason) {
    this.run("suspend_subscription", { id, reason }, void 0, () => void 0);
  }
  async activateSubscription(id, reason) {
    this.run("activate_subscription", { id, reason }, void 0, () => void 0);
  }
  async createOrder(p, idem) {
    if (p.currency !== "USD") throw new PayPalError(400, "currency_unsupported", "PayPal \uC740 USD \uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    return this.run("order", p, idem, () => {
      const id = `ORD-MOCK${this.uid()}`;
      return { id, approveUrl: `https://www.sandbox.paypal.test/checkoutnow?token=${id}` };
    });
  }
  async captureOrder(orderId, idem) {
    return this.run("capture", { orderId }, idem, () => ({ orderId, captureId: `CAP-MOCK${this.uid()}`, status: "COMPLETED", customId: null, currency: "USD", amountMinor: 0 }));
  }
  async refundCapture(p, idem) {
    return this.run("refund", p, idem, () => ({ id: `REF-MOCK${this.uid()}`, status: "COMPLETED" }));
  }
  async verifyWebhook(p) {
    this.calls.push({ op: "verify_webhook", args: { webhookId: p.webhookId } });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return p.headers.transmissionSig === _MockPayPal.VALID_SIG;
  }
};

// src/lib/domainNames.ts
var LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
var MULTI_LABEL_SUFFIXES = /* @__PURE__ */ new Set(["co.kr", "or.kr", "ne.kr", "go.kr", "re.kr", "pe.kr", "ac.kr", "mil.kr", "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.jp", "or.jp", "ne.jp", "com.br", "co.nz", "co.in", "com.cn", "com.tw", "com.sg", "com.hk"]);
function normalizeHostname(raw) {
  const s = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!s || s.length > 253 || /[\s/@:?#\\]/.test(s)) return null;
  let host;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}
__name(normalizeHostname, "normalizeHostname");
function isApexDomain(host) {
  const labels = host.split(".");
  const suffixLabels = labels.length >= 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.length === suffixLabels + 1;
}
__name(isApexDomain, "isApexDomain");

// src/lib/money.ts
var MICRO_PER_USD = 1e6;
function usd(decimal) {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(decimal.trim());
  if (!m) throw new Error(`invalid USD amount: ${decimal}`);
  const [, sign, whole, frac = ""] = m;
  const v = Number(whole) * MICRO_PER_USD + Number(frac.padEnd(6, "0"));
  if (!Number.isSafeInteger(v)) throw new Error("amount out of range");
  return sign === "-" ? -v : v;
}
__name(usd, "usd");

// src/lib/domainPricing.ts
var SEED_DOMAIN_PRICING = { markupBp: 1500, minFeeMicro: usd("2.00"), feeRateBp: 440, feeFixedMicro: usd("0.30"), driftToleranceMicro: usd("0.25"), quoteTtlMinutes: 15 };
var ceilCents = /* @__PURE__ */ __name((m) => Math.ceil(m / 1e4) * 1e4, "ceilCents");
function priceFor(costMicro2, c = SEED_DOMAIN_PRICING) {
  const fee = Math.max(c.minFeeMicro, Math.round(costMicro2 * c.markupBp / 1e4));
  const base = costMicro2 + fee;
  return ceilCents(Math.ceil((base + c.feeFixedMicro) * 1e4 / (1e4 - c.feeRateBp)));
}
__name(priceFor, "priceFor");
var driftAcceptable = /* @__PURE__ */ __name((quotedCost, currentCost, c = SEED_DOMAIN_PRICING) => currentCost - quotedCost <= c.driftToleranceMicro, "driftAcceptable");

// src/lib/zoneSettings.ts
var oneOf = /* @__PURE__ */ __name((...vals) => (v) => typeof v === "string" && vals.includes(v), "oneOf");
var onOff = oneOf("on", "off");
var BROWSER_TTLS = /* @__PURE__ */ new Set([0, 30, 60, 120, 300, 1200, 1800, 3600, 7200, 10800, 14400, 18e3, 28800, 43200, 57600, 72e3, 86400, 172800, 259200, 345600, 432e3, 691200, 1382400, 2073600, 2678400, 5356800, 16070400, 31536e3]);
var SETTINGS = Object.fromEntries([
  ["ssl", "SSL/TLS \uBAA8\uB4DC", "high", oneOf("full", "strict")],
  // off/flexible 은 플랫폼 정책상 금지
  ["always_use_https", "\uD56D\uC0C1 HTTPS \uC0AC\uC6A9", "low", onOff],
  ["min_tls_version", "\uCD5C\uC18C TLS \uBC84\uC804", "medium", oneOf("1.2", "1.3")],
  // 1.0/1.1 금지
  ["tls_1_3", "TLS 1.3", "low", oneOf("on", "off", "zrt")],
  ["automatic_https_rewrites", "\uC790\uB3D9 HTTPS \uC7AC\uC791\uC131", "low", onOff],
  ["http3", "HTTP/3(QUIC)", "low", onOff],
  ["brotli", "Brotli \uC555\uCD95", "low", onOff],
  ["early_hints", "Early Hints", "low", onOff],
  ["0rtt", "0-RTT", "medium", onOff],
  ["ipv6", "IPv6", "low", onOff],
  ["websockets", "WebSockets", "low", onOff],
  ["opportunistic_encryption", "\uAE30\uD68C\uC801 \uC554\uD638\uD654", "low", onOff],
  ["browser_cache_ttl", "\uBE0C\uB77C\uC6B0\uC800 \uCE90\uC2DC TTL(\uCD08)", "low", (v) => typeof v === "number" && BROWSER_TTLS.has(v)],
  ["cache_level", "\uCE90\uC2DC \uC218\uC900", "medium", oneOf("basic", "simplified", "aggressive")],
  ["security_level", "\uBCF4\uC548 \uC218\uC900", "medium", oneOf("low", "medium", "high", "under_attack")],
  ["challenge_ttl", "\uCC4C\uB9B0\uC9C0 \uD1B5\uACFC \uC720\uC9C0 \uC2DC\uAC04(\uCD08)", "low", (v) => typeof v === "number" && [300, 900, 1800, 2700, 3600, 7200, 10800, 14400, 28800, 57600, 86400].includes(v)],
  ["browser_check", "\uBE0C\uB77C\uC6B0\uC800 \uBB34\uACB0\uC131 \uAC80\uC0AC", "low", onOff],
  ["email_obfuscation", "\uC774\uBA54\uC77C \uC8FC\uC18C \uB09C\uB3C5\uD654", "low", onOff],
  ["hotlink_protection", "\uD56B\uB9C1\uD06C \uBCF4\uD638", "low", onOff],
  ["rocket_loader", "Rocket Loader", "medium", onOff],
  // WordPress 에서 깨질 수 있어 중간 위험
  ["development_mode", "\uAC1C\uBC1C \uBAA8\uB4DC(3\uC2DC\uAC04 \uCE90\uC2DC \uC6B0\uD68C)", "low", onOff]
].map(([key, label, risk, validate]) => [key, { key, label, risk, validate, kind: "zone_setting" }]));
SETTINGS["dnssec"] = { key: "dnssec", label: "DNSSEC", risk: "medium", validate: oneOf("active", "disabled"), kind: "dnssec" };

// src/lib/zoneService.ts
var ServiceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
  static {
    __name(this, "ServiceError");
  }
};
var NS_INSTRUCTIONS = "\uB3C4\uBA54\uC778\uC744 \uAD6C\uC785\uD55C \uB4F1\uB85D\uAE30\uAD00\uC758 \uB124\uC784\uC11C\uBC84\uB97C \uC544\uB798 \uAC12\uC73C\uB85C \uBCC0\uACBD\uD558\uC138\uC694. \uC804\uD30C\uC5D0\uB294 \uCD5C\uB300 24~48\uC2DC\uAC04\uC774 \uAC78\uB9B4 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uBCC0\uACBD\uC774 \uD655\uC778\uB418\uBA74 \uC790\uB3D9\uC73C\uB85C \uD65C\uC131\uD654\uB429\uB2C8\uB2E4.";
async function connectDomain(db, zones, customerId, rawHostname, nowMs) {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname) throw new ServiceError("invalid_hostname", "\uC62C\uBC14\uB978 \uB3C4\uBA54\uC778 \uC774\uB984\uC774 \uC544\uB2D8");
  if (!isApexDomain(hostname)) throw new ServiceError("not_apex", "\uB8E8\uD2B8 \uB3C4\uBA54\uC778(example.com)\uB9CC \uC5F0\uACB0\uD560 \uC218 \uC788\uC74C. \uC11C\uBE0C\uB3C4\uBA54\uC778\uC740 \uBCC4\uB3C4 \uBC29\uC2DD\uC73C\uB85C \uC5F0\uACB0\uD569\uB2C8\uB2E4.");
  const dup = await db.prepare("SELECT 1 AS x FROM dns_zones WHERE hostname = ? AND status <> 'deleted'").bind(hostname).first();
  if (dup) throw new ServiceError("already_connected", "\uC774\uBBF8 \uC5F0\uACB0\uB41C \uB3C4\uBA54\uC778");
  if (await zones.findZone(hostname)) throw new ServiceError("domain_in_platform_account", "\uC774 \uB3C4\uBA54\uC778\uC740 \uD50C\uB7AB\uD3FC \uACC4\uC815\uC5D0 \uC774\uBBF8 \uC874\uC7AC\uD558\uC5EC \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC74C. \uC9C0\uC6D0\uD300\uC5D0 \uBB38\uC758\uD558\uC138\uC694.");
  const z = await zones.createZone(hostname);
  const id = newId("zon");
  try {
    await db.prepare("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin,status,name_servers_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, customerId, hostname, z.id, "connected", "pending_nameservers", JSON.stringify(z.nameServers), nowIso(nowMs)).run();
  } catch (e) {
    await zones.deleteZone(z.id).catch(() => {
    });
    throw e;
  }
  await audit(db, { actorId: customerId, action: "domain.connect", targetType: "dns_zone", targetId: id, detail: { hostname } }, nowMs);
  return { zoneId: id, hostname, nameServers: z.nameServers, instructions: NS_INSTRUCTIONS };
}
__name(connectDomain, "connectDomain");
var ACTIVATION_DELAYS_MIN = [5, 15, 60, 180, 360, 720, 1440];
var nextActivationDelayMin = /* @__PURE__ */ __name((checks) => ACTIVATION_DELAYS_MIN[Math.min(checks, ACTIVATION_DELAYS_MIN.length - 1)], "nextActivationDelayMin");
var PENDING_ZONE_TTL_DAYS = 7;
async function checkActivation(db, zones, z, nowMs) {
  if (z.status === "active") return "active";
  const info = await zones.getZone(z.cf_zone_id);
  if (info.status === "active") {
    await db.prepare("UPDATE dns_zones SET status='active', activated_at=?, last_checked_at=?, activation_checks=activation_checks+1 WHERE id=?").bind(nowIso(nowMs), nowIso(nowMs), z.id).run();
    return "active";
  }
  if (nowMs - Date.parse(z.created_at) > PENDING_ZONE_TTL_DAYS * 864e5) {
    await zones.deleteZone(z.cf_zone_id);
    await db.prepare("UPDATE dns_zones SET status='deleted', last_checked_at=? WHERE id=?").bind(nowIso(nowMs), z.id).run();
    return "expired";
  }
  await zones.recheckActivation(z.cf_zone_id);
  await db.prepare("UPDATE dns_zones SET last_checked_at=?, activation_checks=activation_checks+1 WHERE id=?").bind(nowIso(nowMs), z.id).run();
  return "pending";
}
__name(checkActivation, "checkActivation");

// src/lib/domainOrders.ts
var SEL = "id,customer_id,hostname,status,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,registrar_state,stripe_payment_intent_id,registrar_provider,fx_rate_micro";
var getOrder = /* @__PURE__ */ __name((db, id) => db.prepare(`SELECT ${SEL} FROM domain_orders WHERE id = ?`).bind(id).first(), "getOrder");
var portOf = /* @__PURE__ */ __name((src, provider) => typeof src === "function" ? src(provider) : src, "portOf");
function validContact(c) {
  const a = c?.postal_info?.address;
  return !!c && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email) && /^\+\d{1,3}\.\d{4,14}$/.test(c.phone) && !!c.postal_info.name?.trim() && !!a && [a.street, a.city, a.postal_code].every((x) => !!x?.trim()) && /^[A-Z]{2}$/.test(a.country_code);
}
__name(validContact, "validContact");
async function createQuote(db, registrar, crypto2, p) {
  const cfg = p.cfg ?? SEED_DOMAIN_PRICING;
  const hostname = normalizeHostname(p.hostname);
  if (!hostname || !isApexDomain(hostname)) throw new ServiceError("invalid_hostname", "\uB4F1\uB85D\uD560 \uC218 \uC788\uB294 \uB8E8\uD2B8 \uB3C4\uBA54\uC778(example.com)\uB9CC \uAC00\uB2A5");
  if (!validContact(p.contact)) throw new ServiceError("invalid_contact", "\uB4F1\uB85D\uC790 \uC815\uBCF4(\uC774\uBA54\uC77C\xB7\uC804\uD654 +\uAD6D\uAC00.\uBC88\uD638\xB7\uC774\uB984\xB7\uC8FC\uC18C\xB7\uAD6D\uAC00\uCF54\uB4DC)\uB97C \uC815\uD655\uD788 \uC785\uB825\uD574\uC57C \uD568. \uB3C4\uBA54\uC778\uC758 \uBC95\uC801 \uC18C\uC720\uC790\uB294 \uC785\uB825\uD55C \uB4F1\uB85D\uC790\uC785\uB2C8\uB2E4.");
  const taken = await db.prepare("SELECT 1 AS x FROM domain_orders WHERE hostname = ? AND status IN ('paid','registering','registered','needs_review')").bind(hostname).first();
  if (taken) throw new ServiceError("unavailable", "\uC774\uBBF8 \uC8FC\uBB38\uC774 \uC9C4\uD589 \uC911\uC774\uAC70\uB098 \uB4F1\uB85D\uB41C \uB3C4\uBA54\uC778");
  const [chk] = await registrar.check([hostname]);
  if (!chk || !chk.registrable || !chk.registrationCostMicro || !chk.renewalCostMicro) throw new ServiceError("unavailable", `\uB4F1\uB85D\uD560 \uC218 \uC5C6\uC74C${chk?.reason ? ` (${chk.reason})` : ""}`);
  const id = newId("dor");
  const price = priceFor(chk.registrationCostMicro, cfg);
  const renewalPrice = priceFor(chk.renewalCostMicro, cfg);
  const expires = nowIso(p.nowMs + cfg.quoteTtlMinutes * 6e4);
  await db.prepare("INSERT INTO domain_orders(id,customer_id,hostname,registrar_cost_micro,renewal_cost_micro,price_micro,renewal_price_micro,quote_expires_at,registrant_enc,created_at,updated_at,registrar_provider,charge_currency,charge_amount,renewal_charge_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,'cloudflare','USD',?,?)").bind(id, p.customerId, hostname, chk.registrationCostMicro, chk.renewalCostMicro, price, renewalPrice, expires, await crypto2.encrypt(JSON.stringify(p.contact), `domain_order:${id}`), nowIso(p.nowMs), nowIso(p.nowMs), Math.round(price / 1e4), Math.round(renewalPrice / 1e4)).run();
  await audit(db, { actorId: p.customerId, action: "domain.quote", targetType: "domain_order", targetId: id, detail: { hostname, price } }, p.nowMs);
  return { orderId: id, hostname, currency: "USD", chargeAmount: Math.round(price / 1e4), renewalChargeAmount: Math.round(renewalPrice / 1e4), priceMicro: price, renewalPriceMicro: renewalPrice, quoteExpiresAt: expires, nonRefundableNotice: "\uB3C4\uBA54\uC778 \uB4F1\uB85D\uC774 \uC644\uB8CC\uB418\uBA74 \uD658\uBD88\uB418\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." };
}
__name(createQuote, "createQuote");
async function expireQuotes(db, nowMs) {
  const r = await db.prepare("UPDATE domain_orders SET status='quote_expired', updated_at=? WHERE status='awaiting_payment' AND quote_expires_at < ?").bind(nowIso(nowMs), nowIso(nowMs)).run();
  return r.meta.changes;
}
__name(expireQuotes, "expireQuotes");
var refundJob = /* @__PURE__ */ __name((db, orderId, nowMs) => db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "refund_domain_order", `refund:${orderId}`, JSON.stringify({ orderId }), nowIso(nowMs), nowIso(nowMs)), "refundJob");
var toRefund = /* @__PURE__ */ __name((db, orderId, from, reason, nowMs) => [
  db.prepare(`UPDATE domain_orders SET status='refund_due', failure_reason=?, updated_at=? WHERE id=? AND status IN (${from.map(() => "?").join(",")})`).bind(reason, nowIso(nowMs), orderId, ...from),
  refundJob(db, orderId, nowMs)
], "toRefund");
async function markPaid(db, orderId, paymentIntentId, nowMs) {
  try {
    const r = await db.prepare("UPDATE domain_orders SET status='paid', stripe_payment_intent_id=?, updated_at=? WHERE id=? AND status IN ('awaiting_payment','quote_expired')").bind(paymentIntentId, nowIso(nowMs), orderId).run();
    if (r.meta.changes === 1) return "paid";
  } catch {
    await db.batch([db.prepare("UPDATE domain_orders SET stripe_payment_intent_id=? WHERE id=?").bind(paymentIntentId, orderId), ...toRefund(db, orderId, ["awaiting_payment", "quote_expired"], "domain_taken_by_other_order", nowMs)]);
    return "refund_due";
  }
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "\uC8FC\uBB38 \uC5C6\uC74C");
  return o.stripe_payment_intent_id === paymentIntentId ? "duplicate" : (() => {
    throw new ServiceError("payment_mismatch", "\uB2E4\uB978 \uACB0\uC81C\uB85C \uC774\uBBF8 \uCC98\uB9AC\uB41C \uC8FC\uBB38");
  })();
}
__name(markPaid, "markPaid");
function applyOutcome(db, o, out, nowMs) {
  switch (out.outcome) {
    case "succeeded":
      return [db.prepare("UPDATE domain_orders SET status='registered', registrar_state='succeeded', registered_at=?, expires_at=?, updated_at=? WHERE id=? AND status IN ('registering','needs_review')").bind(nowIso(nowMs), out.expiresAt || null, nowIso(nowMs), o.id)];
    case "in_progress":
      return [db.prepare("UPDATE domain_orders SET registrar_state='in_progress', updated_at=? WHERE id=? AND status='registering'").bind(nowIso(nowMs), o.id)];
    case "action_required":
    case "blocked":
      return [db.prepare("UPDATE domain_orders SET status='needs_review', registrar_state=?, failure_reason=?, updated_at=? WHERE id=? AND status='registering'").bind(out.outcome, `${out.code ?? out.outcome}`, nowIso(nowMs), o.id)];
    case "failed":
      return toRefund(db, o.id, ["registering"], `registrar_failed:${out.code ?? "unknown"}`, nowMs);
  }
}
__name(applyOutcome, "applyOutcome");
async function runRegistration(db, ports, crypto2, orderId, nowMs, cfg = SEED_DOMAIN_PRICING) {
  const claim = await db.prepare("UPDATE domain_orders SET status='registering', updated_at=? WHERE id=? AND status='paid'").bind(nowIso(nowMs), orderId).run();
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "\uC8FC\uBB38 \uC5C6\uC74C");
  if (claim.meta.changes === 0) return o.status;
  const registrar = portOf(ports, o.registrar_provider);
  const [chk] = await registrar.check([o.hostname]);
  const currentCost = chk?.registrationCostMicro;
  if (!chk?.registrable || currentCost === void 0) {
    await db.batch(toRefund(db, o.id, ["registering"], `not_registrable:${chk?.reason ?? "unknown"}`, nowMs));
    return "refund_due";
  }
  if (!driftAcceptable(o.registrar_cost_micro, currentCost, cfg)) {
    await db.batch(toRefund(db, o.id, ["registering"], "price_changed", nowMs));
    return "refund_due";
  }
  if (!o.registrant_enc) {
    await db.prepare("UPDATE domain_orders SET status='needs_review', failure_reason='missing_registrant', updated_at=? WHERE id=? AND status='registering'").bind(nowIso(nowMs), o.id).run();
    return "needs_review";
  }
  const contact = JSON.parse(await crypto2.decrypt(o.registrant_enc, `domain_order:${o.id}`));
  let out;
  try {
    out = await registrar.register(o.hostname, contact);
  } catch {
    try {
      out = await registrar.status(o.hostname);
    } catch {
      out = { outcome: "blocked", code: "ambiguous_error" };
    }
    if (out.outcome === "failed") out = { outcome: "blocked", code: "ambiguous_error" };
  }
  await db.batch(applyOutcome(db, o, out, nowMs));
  await audit(db, { actorId: null, action: "domain.register", targetType: "domain_order", targetId: o.id, detail: { outcome: out.outcome } }, nowMs);
  return (await getOrder(db, o.id)).status;
}
__name(runRegistration, "runRegistration");
async function pollRegistration(db, ports, orderId, nowMs) {
  const o = await getOrder(db, orderId);
  if (!o) throw new ServiceError("not_found", "\uC8FC\uBB38 \uC5C6\uC74C");
  if (o.status !== "registering" || o.registrar_state !== "in_progress") return o.status;
  const out = await portOf(ports, o.registrar_provider).status(o.hostname);
  await db.batch(applyOutcome(db, o, out, nowMs));
  return (await getOrder(db, orderId)).status;
}
__name(pollRegistration, "pollRegistration");
async function markRefunded(db, orderId, nowMs) {
  const r = await db.prepare("UPDATE domain_orders SET status='refunded', updated_at=? WHERE id=? AND status='refund_due'").bind(nowIso(nowMs), orderId).run();
  return r.meta.changes === 1;
}
__name(markRefunded, "markRefunded");
async function adoptRegisteredZone(db, zones, orderId, nowMs) {
  const o = await getOrder(db, orderId);
  if (!o || o.status !== "registered") throw new ServiceError("not_registered", "\uB4F1\uB85D\uC774 \uC644\uB8CC\uB41C \uC8FC\uBB38\uB9CC \uC601\uC5ED\uC744 \uB9CC\uB4E4 \uC218 \uC788\uC74C");
  const existing = await db.prepare("SELECT id, customer_id, cf_zone_id FROM dns_zones WHERE hostname = ? AND status <> 'deleted'").bind(o.hostname).first();
  if (existing && existing.customer_id === o.customer_id) return { zoneId: existing.id, created: false };
  if (existing) {
    await zones.deleteZone(existing.cf_zone_id);
    await db.prepare("UPDATE dns_zones SET status='deleted' WHERE id=?").bind(existing.id).run();
    await audit(db, { actorId: null, action: "domain.squatter_zone_removed", targetType: "dns_zone", targetId: existing.id, detail: { hostname: o.hostname, order: o.id } }, nowMs);
  }
  const found = await zones.findZone(o.hostname);
  if (found && o.registrar_provider !== "cloudflare") throw new ServiceError("zone_conflict", "\uCD94\uC801\uB418\uC9C0 \uC54A\uB294 \uAE30\uC874 \uC601\uC5ED\uC774 \uC788\uC5B4 \uC6B4\uC601\uC790 \uD655\uC778\uC774 \uD544\uC694\uD568");
  const z = found ?? await zones.createZone(o.hostname);
  const id = newId("zon");
  await db.prepare("INSERT INTO dns_zones(id,customer_id,hostname,cf_zone_id,origin,status,name_servers_json,order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, o.customer_id, o.hostname, z.id, "registered", "pending_nameservers", JSON.stringify(z.nameServers), o.id, nowIso(nowMs)).run();
  return { zoneId: id, created: true };
}
__name(adoptRegisteredZone, "adoptRegisteredZone");
async function delegateNameservers(db, nsPort, orderId, nowMs) {
  const o = await getOrder(db, orderId);
  if (!o || o.status !== "registered") throw new ServiceError("not_registered", "\uB4F1\uB85D\uC774 \uC644\uB8CC\uB41C \uC8FC\uBB38\uB9CC \uC704\uC784\uD560 \uC218 \uC788\uC74C");
  const z = await db.prepare("SELECT name_servers_json AS ns FROM dns_zones WHERE order_id = ? AND status <> 'deleted'").bind(orderId).first();
  if (!z) throw new ServiceError("no_zone", "\uC601\uC5ED\uC774 \uBA3C\uC800 \uB9CC\uB4E4\uC5B4\uC838\uC57C \uD568");
  const ns = JSON.parse(z.ns);
  if (o.registrar_provider === "cloudflare") return { delegated: true, nameServers: ns };
  await nsPort.setNameservers(o.hostname, ns);
  await db.prepare("UPDATE domain_orders SET ns_delegated_at=?, updated_at=? WHERE id=?").bind(nowIso(nowMs), nowIso(nowMs), orderId).run();
  return { delegated: true, nameServers: ns };
}
__name(delegateNameservers, "delegateNameservers");

// src/lib/catalog.ts
var OFFICIAL_INSTANCE_TYPES = {
  lite: { vcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  basic: { vcpu: 1 / 4, memoryMiB: 1024, diskGB: 4 },
  "standard-1": { vcpu: 1 / 2, memoryMiB: 4096, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryMiB: 6144, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryMiB: 8192, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryMiB: 12288, diskGB: 20 }
};
var P = /* @__PURE__ */ __name((p) => p, "P");
var SEED_PRODUCTS = [
  P({ id: "ccs-lite", kind: "ccs", nameKo: "CCS Lite", monthlyMicro: usd("4.99"), instanceType: "lite", targetVcpu: 1 / 16 }),
  P({ id: "ccs-basic", kind: "ccs", nameKo: "CCS Basic", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4 }),
  P({ id: "ccs-standard", kind: "ccs", nameKo: "CCS Standard", monthlyMicro: usd("34.99"), instanceType: "standard-1", targetVcpu: 1 / 2, includedActiveHours: 360 }),
  P({ id: "ccs-performance", kind: "ccs", nameKo: "CCS Performance", monthlyMicro: usd("59.99"), instanceType: "standard-3", targetVcpu: 2, includedActiveHours: 360 }),
  P({ id: "cloudb-mariadb", kind: "cloudb", nameKo: "ClouDB MariaDB", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 2, engine: "mariadb" }),
  P({ id: "cloudb-mysql", kind: "cloudb", nameKo: "ClouDB MySQL", monthlyMicro: usd("12.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 2, engine: "mysql" }),
  P({ id: "cloudb-sqlite", kind: "cloudb_sqlite", nameKo: "ClouDB SQLite", monthlyMicro: usd("4.99"), includedStorageGB: 2, engine: "sqlite" }),
  P({ id: "cloudage-bucket", kind: "cloudage", nameKo: "Cloudage \uBC84\uD0B7", monthlyMicro: usd("7.99"), includedStorageGB: 10 }),
  P({ id: "csw-service", kind: "csw", nameKo: "CSW \uC11C\uBE44\uC2A4", monthlyMicro: usd("4.99") }),
  P({ id: "wp-starter", kind: "wordpress", nameKo: "WordPress Starter", monthlyMicro: usd("19.99"), instanceType: "basic", targetVcpu: 1 / 4, includedStorageGB: 5, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-pro", kind: "wordpress", nameKo: "WordPress Pro", monthlyMicro: usd("34.99"), instanceType: "standard-1", targetVcpu: 1 / 2, includedStorageGB: 20, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-business", kind: "wordpress", nameKo: "WordPress Business", monthlyMicro: usd("59.99"), instanceType: "standard-2", targetVcpu: 1, includedStorageGB: 50, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "wp-scale", kind: "wordpress", nameKo: "WordPress Scale", monthlyMicro: usd("99.99"), instanceType: "standard-3", targetVcpu: 2, includedStorageGB: 100, includes: ["ccs", "cloudb", "cloudage", "csw"] }),
  P({ id: "cas-general", kind: "cas", nameKo: "CAS \uC77C\uBC18 \uBAA8\uB378", monthlyMicro: usd("0.99") }),
  P({ id: "cas-performance", kind: "cas", nameKo: "CAS \uACE0\uC131\uB2A5 \uBAA8\uB378", monthlyMicro: usd("2.99") }),
  P({ id: "cas-premium", kind: "cas", nameKo: "CAS \uD504\uB9AC\uBBF8\uC5C4 \uBAA8\uB378", monthlyMicro: usd("4.99") }),
  P({ id: "pg-micro", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Micro", monthlyMicro: usd("19.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "micro" }),
  P({ id: "pg-small", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Small", monthlyMicro: usd("26.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "small" }),
  P({ id: "pg-medium", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Medium", monthlyMicro: usd("99.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "medium" }),
  P({ id: "pg-large", kind: "cloudb_pg", nameKo: "ClouDB PostgreSQL Large", monthlyMicro: usd("179.99"), includedStorageGB: 8, engine: "postgres", pgSizeClass: "large" })
];
var WP_MULTISITE_MONTHLY = usd("4.00");

// src/lib/cpuAddons.ts
var SEED_CPU_POLICY = {
  prices: { "1": 699e4, "2": 1299e4, "4": 2399e4, "8": 4399e4 },
  maxTotalAddVcpu: 8,
  allowedKinds: ["ccs", "wordpress", "cloudb", "cloudb_pg"],
  allowedInstances: ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"],
  prorate: false
};
async function loadCpuPolicy(db) {
  const r = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cpu_addon_policy'").first();
  if (!r) return SEED_CPU_POLICY;
  try {
    return { ...SEED_CPU_POLICY, ...JSON.parse(r.value_json) };
  } catch {
    return SEED_CPU_POLICY;
  }
}
__name(loadCpuPolicy, "loadCpuPolicy");
async function saveCpuPolicy(db, actorId, input, nowMs) {
  const cur = await loadCpuPolicy(db);
  const next = { ...cur, ...input, prices: { ...cur.prices, ...input.prices ?? {} } };
  for (const [k, v] of Object.entries(next.prices)) {
    if (!/^[1-9]\d*$/.test(k) || !Number.isInteger(v) || v <= 0 || v % 1e4 !== 0) throw new ServiceError("bad_policy", `\uAC00\uACA9 \uD56D\uBAA9\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC74C: ${k}`);
  }
  if (!Number.isInteger(next.maxTotalAddVcpu) || next.maxTotalAddVcpu < 0 || next.maxTotalAddVcpu > 64) throw new ServiceError("bad_policy", "\uCD5C\uB300 \uCD94\uAC00\uB7C9\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC74C");
  if (next.allowedInstances.some((i) => !(i in OFFICIAL_INSTANCE_TYPES))) throw new ServiceError("bad_policy", "\uACF5\uC2DD \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uC778\uC2A4\uD134\uC2A4 \uC0AC\uC591\uC774 \uD3EC\uD568\uB428");
  if (next.prorate) throw new ServiceError("bad_policy", "PayPal \uC815\uAE30\uACB0\uC81C\uB294 \uC911\uAC04 \uC99D\uC124 \uC77C\uD560 \uCCAD\uAD6C\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cpu_addon_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(JSON.stringify(next), actorId, nowIso(nowMs)).run();
  await audit(db, { actorId, action: "admin.cpu_policy_update", detail: next }, nowMs);
  return next;
}
__name(saveCpuPolicy, "saveCpuPolicy");
function resolveInstance(base, totalAddVcpu, allowed = Object.keys(OFFICIAL_INSTANCE_TYPES)) {
  const need2 = OFFICIAL_INSTANCE_TYPES[base].vcpu + totalAddVcpu;
  const c = Object.entries(OFFICIAL_INSTANCE_TYPES).filter(([t, v]) => allowed.includes(t) && v.vcpu >= need2 - 1e-9).sort((a, b) => a[1].vcpu - b[1].vcpu || OFFICIAL_INSTANCE_TYPES[a[0]].memoryMiB - OFFICIAL_INSTANCE_TYPES[b[0]].memoryMiB);
  return c[0]?.[0] ?? null;
}
__name(resolveInstance, "resolveInstance");
async function loadTarget(db, userId, subId) {
  const r = await db.prepare(`SELECT s.id AS sid, s.status, p.kind, p.instance_type AS base, c.id AS cid, c.instance_type AS cur
    FROM subscriptions s JOIN products p ON p.id = s.product_id LEFT JOIN containers c ON c.subscription_id = s.id AND c.deleted_at IS NULL
    WHERE s.id = ? AND s.customer_id = ?`).bind(subId, userId).first();
  if (!r) throw new ServiceError("not_found", "\uC11C\uBE44\uC2A4\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  if (r.status !== "active") throw new ServiceError("bad_state", "\uC774\uC6A9 \uC911\uC778 \uC11C\uBE44\uC2A4\uC5D0\uB9CC \uCD94\uAC00 CPU \uB97C \uAD6C\uB9E4\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  if (!r.base || !(r.base in OFFICIAL_INSTANCE_TYPES)) throw new ServiceError("unsupported_product", "\uC774 \uC0C1\uD488\uC740 \uCD94\uAC00 CPU \uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (!r.cid || !r.cur) throw new ServiceError("no_container", "\uCEE8\uD14C\uC774\uB108\uAC00 \uC544\uC9C1 \uC0DD\uC131\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC0DD\uC131\uC774 \uB05D\uB09C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.");
  return { containerId: r.cid, subId: r.sid, base: r.base, current: r.cur, kind: r.kind };
}
__name(loadTarget, "loadTarget");
async function quoteCpuAddon(db, userId, subId, addVcpu) {
  const policy = await loadCpuPolicy(db);
  const price = policy.prices[String(addVcpu)];
  if (!Number.isInteger(addVcpu) || price === void 0) throw new ServiceError("bad_tier", `\uD310\uB9E4\uD558\uC9C0 \uC54A\uB294 \uCD94\uAC00 CPU \uC218\uB7C9\uC785\uB2C8\uB2E4. \uAC00\uB2A5: ${Object.keys(policy.prices).join(", ")}`);
  const t = await loadTarget(db, userId, subId);
  if (!policy.allowedKinds.includes(t.kind)) throw new ServiceError("unsupported_product", "\uC774 \uC0C1\uD488\uC740 \uCD94\uAC00 CPU \uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const existing = await db.prepare("SELECT COALESCE(SUM(add_vcpu),0) AS s FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'paid' AND cancel_at_period_end = 0").bind(subId).first();
  const total = (existing?.s ?? 0) + addVcpu;
  if (total > policy.maxTotalAddVcpu) throw new ServiceError("limit_exceeded", `\uCD94\uAC00 vCPU \uD569\uACC4\uB294 \uCD5C\uB300 ${policy.maxTotalAddVcpu} \uC785\uB2C8\uB2E4.`);
  const to = resolveInstance(t.base, total, policy.allowedInstances);
  if (!to) throw new ServiceError("unsupported_spec", "\uC694\uCCAD\uD55C CPU \uB97C \uC81C\uACF5\uD558\uB294 \uACF5\uC2DD \uC9C0\uC6D0 \uC778\uC2A4\uD134\uC2A4 \uC0AC\uC591\uC774 \uC5C6\uC2B5\uB2C8\uB2E4(Cloudflare Containers \uCD5C\uB300 4 vCPU).");
  const spec = OFFICIAL_INSTANCE_TYPES[to];
  return {
    containerId: t.containerId,
    addVcpu,
    monthlyMicro: price,
    fromInstance: t.current,
    toInstance: to,
    totalAddVcpu: total,
    resulting: { vcpu: spec.vcpu, memoryMiB: spec.memoryMiB, diskGB: spec.diskGB },
    note: "Cloudflare \uC778\uC2A4\uD134\uC2A4 \uC0AC\uC591\uC740 CPU\xB7\uBA54\uBAA8\uB9AC\xB7\uB514\uC2A4\uD06C\uAC00 \uD568\uAED8 \uC815\uD574\uC9D1\uB2C8\uB2E4. CPU \uB97C \uC62C\uB9AC\uBA74 \uBA54\uBAA8\uB9AC\xB7\uB514\uC2A4\uD06C\uB3C4 \uD574\uB2F9 \uC0AC\uC591 \uAC12\uC73C\uB85C \uBC14\uB01D\uB2C8\uB2E4."
  };
}
__name(quoteCpuAddon, "quoteCpuAddon");
async function ensureCpuPlan(db, paypal, addVcpu, monthlyMicro, nowMs) {
  const ex = await db.prepare("SELECT paypal_plan_id AS p FROM cpu_addon_plans WHERE add_vcpu = ? AND monthly_micro = ?").bind(addVcpu, monthlyMicro).first();
  if (ex) return ex.p;
  const { planId } = await paypal.createMonthlyPlan({ name: `CloudPress \uCD94\uAC00 CPU +${addVcpu} vCPU`, currency: "USD", amountMinor: monthlyMicro / 1e4, customId: `cpu:${addVcpu}` }, `cpuplan:${addVcpu}:${monthlyMicro}`);
  await db.prepare("INSERT OR IGNORE INTO cpu_addon_plans(add_vcpu,monthly_micro,paypal_plan_id,created_at) VALUES(?,?,?,?)").bind(addVcpu, monthlyMicro, planId, nowIso(nowMs)).run();
  return (await db.prepare("SELECT paypal_plan_id AS p FROM cpu_addon_plans WHERE add_vcpu = ? AND monthly_micro = ?").bind(addVcpu, monthlyMicro).first()).p;
}
__name(ensureCpuPlan, "ensureCpuPlan");
async function purchaseCpuAddon(db, paypal, userId, subId, addVcpu, ctx) {
  const q = await quoteCpuAddon(db, userId, subId, addVcpu);
  const pending = await db.prepare("SELECT id FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'pending' AND created_at > ?").bind(subId, nowIso(ctx.nowMs - 24 * 36e5)).first();
  if (pending) throw new ServiceError("pending_exists", "\uACB0\uC81C \uB300\uAE30 \uC911\uC778 \uCD94\uAC00 CPU \uAC00 \uC788\uC2B5\uB2C8\uB2E4. \uC644\uB8CC\uD558\uAC70\uB098 24\uC2DC\uAC04 \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.");
  const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first();
  const planId = await ensureCpuPlan(db, paypal, addVcpu, q.monthlyMicro, ctx.nowMs);
  const id = newId("cpu");
  const s = await paypal.createSubscription({
    planId,
    customId: `cpu:${id}`,
    email: user.email,
    returnUrl: `${ctx.appOrigin}/services/${encodeURIComponent(subId)}?cpu=success`,
    cancelUrl: `${ctx.appOrigin}/services/${encodeURIComponent(subId)}?cpu=cancel`
  }, `cpu:${id}`);
  await db.prepare("INSERT INTO cpu_addons(id,subscription_id,container_id,from_instance_type,to_instance_type,add_vcpu,monthly_micro,paypal_plan_id,paypal_subscription_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id, subId, q.containerId, q.fromInstance, q.toInstance, addVcpu, q.monthlyMicro, planId, s.id, nowIso(ctx.nowMs)).run();
  await audit(db, { actorId: userId, action: "cpu_addon.purchase_start", targetType: "cpu_addon", targetId: id, detail: { subId, addVcpu } }, ctx.nowMs);
  return { id, url: s.approveUrl, quote: q };
}
__name(purchaseCpuAddon, "purchaseCpuAddon");
function enqueueResize(db, subId, containerId, reason, nowMs) {
  return db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(newId("job"), "cpu_resize", subId, `cpu_resize:${containerId}:${reason}`, JSON.stringify({ containerId }), nowIso(nowMs), nowIso(nowMs));
}
__name(enqueueResize, "enqueueResize");
async function desiredInstance(db, containerId) {
  const r = await db.prepare(`SELECT c.subscription_id AS sid, c.instance_type AS cur, p.instance_type AS base FROM containers c JOIN subscriptions s ON s.id = c.subscription_id JOIN products p ON p.id = s.product_id WHERE c.id = ? AND c.deleted_at IS NULL`).bind(containerId).first();
  if (!r) return null;
  const sum = await db.prepare("SELECT COALESCE(SUM(add_vcpu),0) AS s FROM cpu_addons WHERE subscription_id = ? AND purchase_status = 'paid'").bind(r.sid).first();
  const inst = resolveInstance(r.base, sum?.s ?? 0);
  if (!inst) throw new Error("no_supported_instance_for_total_cpu");
  return { subId: r.sid, instance: inst, current: r.cur };
}
__name(desiredInstance, "desiredInstance");
async function finalizeCpuAddons(db, nowMs) {
  const ex = await db.prepare("UPDATE cpu_addons SET purchase_status='cancelled' WHERE purchase_status='pending' AND created_at < ?").bind(nowIso(nowMs - 24 * 36e5)).run();
  const { results } = await db.prepare("SELECT id, subscription_id AS sid, container_id AS cid FROM cpu_addons WHERE purchase_status='paid' AND cancel_at_period_end=1 AND current_period_end IS NOT NULL AND current_period_end <= ?").bind(nowIso(nowMs)).all();
  for (const a of results) {
    await db.batch([
      db.prepare("UPDATE cpu_addons SET purchase_status='cancelled', apply_status='not_started' WHERE id=? AND purchase_status='paid'").bind(a.id),
      enqueueResize(db, a.sid, a.cid, `downsize:${a.id}`, nowMs)
    ]);
  }
  return { expired: ex.meta.changes, cancelled: results.length };
}
__name(finalizeCpuAddons, "finalizeCpuAddons");

// src/lib/cas.ts
var COST_MICRO_PER_NEURON = 11;
var SEED_TIER_PRICES = {
  general: { monthlyMicro: 99e4, sellPer1kMicro: 2e4 },
  performance: { monthlyMicro: 299e4, sellPer1kMicro: 3e4 },
  premium: { monthlyMicro: 499e4, sellPer1kMicro: 4e4 }
};
var ceilDiv = /* @__PURE__ */ __name((a, b) => Math.floor((a + b - 1) / b), "ceilDiv");
function estimateNeurons(m, u) {
  let n = 0;
  if (m.unit_neurons && u.units) n += m.unit_neurons * u.units;
  if (m.input_neurons_per_m && u.inputTokens) n += ceilDiv(m.input_neurons_per_m * u.inputTokens, 1e6);
  if (m.output_neurons_per_m && u.outputTokens) n += ceilDiv(m.output_neurons_per_m * u.outputTokens, 1e6);
  return n;
}
__name(estimateNeurons, "estimateNeurons");
var sellMicro = /* @__PURE__ */ __name((neurons, sellPer1kMicro) => ceilDiv(neurons * sellPer1kMicro, 1e3), "sellMicro");
var costMicro = /* @__PURE__ */ __name((neurons) => neurons * COST_MICRO_PER_NEURON, "costMicro");
function neuronsFromProperties(props) {
  const out = { inputM: null, outputM: null, unit: null };
  const price = props?.find((p) => p.property_id === "price")?.value;
  if (!Array.isArray(price)) return out;
  for (const e of price) {
    if (typeof e?.price !== "number" || e.currency && e.currency !== "USD") continue;
    const neurons = Math.round(e.price / 11e-6);
    const unit = String(e.unit ?? "").toLowerCase();
    if (unit.includes("input") && unit.includes("token")) out.inputM = neurons;
    else if (unit.includes("output") && unit.includes("token")) out.outputM = neurons;
    else if (unit.length) out.unit = neurons;
  }
  return out;
}
__name(neuronsFromProperties, "neuronsFromProperties");
async function syncModels(db, models, nowMs) {
  const r = { seen: 0, added: 0, updated: 0, removed: 0 };
  const seen = /* @__PURE__ */ new Set();
  for (const m of models) {
    const modelId = m.name ?? m.id;
    if (typeof modelId !== "string" || !modelId.startsWith("@")) continue;
    seen.add(modelId);
    r.seen++;
    const rates = neuronsFromProperties(m.properties);
    const task = m.task?.name ?? "unknown";
    const deprecated = m.properties?.some((p) => p.property_id === "planned_deprecation_date") ?? false;
    const ex = await db.prepare("SELECT id, pricing_source FROM ai_models WHERE model_id = ?").bind(modelId).first();
    if (!ex) {
      await db.prepare("INSERT INTO ai_models(id,model_id,name,task_type,tier,official_status,uses_neurons,enabled,last_synced_at,input_neurons_per_m,output_neurons_per_m,unit_neurons,pricing_source) VALUES(?,?,?,?,'general',?,1,0,?,?,?,?,?)").bind(newId("aim"), modelId, modelId.split("/").pop(), task, deprecated ? "deprecating" : "listed", nowIso(nowMs), rates.inputM, rates.outputM, rates.unit, rates.inputM || rates.outputM || rates.unit ? "cloudflare_api" : "none").run();
      r.added++;
    } else {
      const keep = ex.pricing_source === "admin";
      await db.prepare(`UPDATE ai_models SET task_type=?, official_status=?, last_synced_at=?${keep ? "" : ", input_neurons_per_m=?, output_neurons_per_m=?, unit_neurons=?, pricing_source=CASE WHEN ? THEN 'cloudflare_api' ELSE 'none' END"} WHERE id=?`).bind(...[task, deprecated ? "deprecating" : "listed", nowIso(nowMs), ...keep ? [] : [rates.inputM, rates.outputM, rates.unit, rates.inputM || rates.outputM || rates.unit ? 1 : 0], ex.id]).run();
      r.updated++;
    }
  }
  const { results } = await db.prepare("SELECT model_id FROM ai_models WHERE official_status != 'removed'").all();
  for (const row of results) if (!seen.has(row.model_id)) {
    await db.prepare("UPDATE ai_models SET official_status='removed', enabled=0, last_synced_at=? WHERE model_id=?").bind(nowIso(nowMs), row.model_id).run();
    r.removed++;
  }
  return r;
}
__name(syncModels, "syncModels");
async function adminSetModel(db, actorId, modelPk, p, nowMs) {
  const m = await db.prepare("SELECT id, tier, input_neurons_per_m i, output_neurons_per_m o, unit_neurons u FROM ai_models WHERE id = ?").bind(modelPk).first();
  if (!m) throw new ServiceError("not_found", "\uBAA8\uB378 \uC5C6\uC74C");
  if (p.tier && !(p.tier in SEED_TIER_PRICES)) throw new ServiceError("bad_tier", "\uBD84\uB958\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC74C");
  const ints = [p.inputNeuronsPerM, p.outputNeuronsPerM, p.unitNeurons, p.monthlyMicro, p.sellPer1kMicro];
  if (ints.some((v) => v !== void 0 && (!Number.isInteger(v) || v < 0))) throw new ServiceError("bad_value", "\uC22B\uC790\uB294 0 \uC774\uC0C1\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  const priced = (p.inputNeuronsPerM ?? m.i) || (p.outputNeuronsPerM ?? m.o) || (p.unitNeurons ?? m.u);
  if (p.enabled && !priced) throw new ServiceError("no_pricing", "Neurons \uB2E8\uAC00\uAC00 \uC5C6\uB294 \uBAA8\uB378\uC740 \uD65C\uC131\uD654\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E8\uAC00\uB97C \uC785\uB825\uD558\uC138\uC694.");
  const stmts = [];
  if (p.inputNeuronsPerM !== void 0 || p.outputNeuronsPerM !== void 0 || p.unitNeurons !== void 0)
    stmts.push(db.prepare("UPDATE ai_models SET input_neurons_per_m=COALESCE(?,input_neurons_per_m), output_neurons_per_m=COALESCE(?,output_neurons_per_m), unit_neurons=COALESCE(?,unit_neurons), pricing_source='admin' WHERE id=?").bind(p.inputNeuronsPerM ?? null, p.outputNeuronsPerM ?? null, p.unitNeurons ?? null, m.id));
  if (p.tier) stmts.push(db.prepare("UPDATE ai_models SET tier=? WHERE id=?").bind(p.tier, m.id));
  if (p.enabled !== void 0) stmts.push(db.prepare("UPDATE ai_models SET enabled=? WHERE id=?").bind(p.enabled ? 1 : 0, m.id));
  const tier = p.tier ?? m.tier;
  if (p.monthlyMicro !== void 0 || p.sellPer1kMicro !== void 0 || p.tier) {
    const cur = await currentPrice(db, m.id);
    const seed = SEED_TIER_PRICES[tier];
    stmts.push(db.prepare("INSERT INTO ai_model_prices(id,model_id,version,monthly_micro,sell_per_1k_micro,cost_per_1k_micro,active_from) VALUES(?,?,?,?,?,?,?)").bind(newId("aip"), m.id, (cur?.version ?? 0) + 1, p.monthlyMicro ?? (p.tier ? seed.monthlyMicro : cur?.monthly_micro ?? seed.monthlyMicro), p.sellPer1kMicro ?? (p.tier ? seed.sellPer1kMicro : cur?.sell_per_1k_micro ?? seed.sellPer1kMicro), COST_MICRO_PER_NEURON * 1e3, nowIso(nowMs)));
  }
  if (stmts.length) await db.batch(stmts);
  await audit(db, { actorId, action: "admin.cas_model_update", targetType: "ai_model", targetId: m.id, detail: p }, nowMs);
}
__name(adminSetModel, "adminSetModel");
async function currentPrice(db, modelPk) {
  return db.prepare("SELECT version, monthly_micro, sell_per_1k_micro, cost_per_1k_micro FROM ai_model_prices WHERE model_id = ? ORDER BY version DESC LIMIT 1").bind(modelPk).first();
}
__name(currentPrice, "currentPrice");
async function issueKey(db, customerId, name, nowMs, o = {}) {
  const n = name.trim();
  if (!n || n.length > 60) throw new ServiceError("bad_name", "\uD0A4 \uC774\uB984\uC740 1~60\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  const cnt = await db.prepare("SELECT COUNT(*) AS c FROM ai_api_keys WHERE customer_id = ? AND status = 'active'").bind(customerId).first();
  if ((cnt?.c ?? 0) >= 10) throw new ServiceError("limit_exceeded", "\uD65C\uC131 \uD0A4\uB294 \uCD5C\uB300 10\uAC1C\uC785\uB2C8\uB2E4.");
  const rate = o.rateLimitPerMin ?? 60;
  if (!Number.isInteger(rate) || rate < 1 || rate > 6e3) throw new ServiceError("bad_value", "\uBD84\uB2F9 \uC694\uCCAD \uC81C\uD55C\uC740 1~6000 \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
  if (o.monthlyCapMicro != null && (!Number.isInteger(o.monthlyCapMicro) || o.monthlyCapMicro < 0)) throw new ServiceError("bad_value", "\uC6D4 \uC0C1\uD55C\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const key = `cpai_${randomToken()}`;
  const id = newId("aik");
  await db.prepare("INSERT INTO ai_api_keys(id,customer_id,name,prefix,key_hash,rate_limit_per_min,monthly_cap_micro,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, customerId, n, key.slice(0, 11), await sha256Hex(key), rate, o.monthlyCapMicro ?? null, nowIso(nowMs)).run();
  await audit(db, { actorId: customerId, action: "cas.key_issue", targetType: "ai_key", targetId: id }, nowMs);
  return { id, key, prefix: key.slice(0, 11) };
}
__name(issueKey, "issueKey");
async function revokeKey(db, customerId, keyId, nowMs) {
  const r = await db.prepare("UPDATE ai_api_keys SET status='revoked', revoked_at=? WHERE id=? AND customer_id=? AND status!='revoked'").bind(nowIso(nowMs), keyId, customerId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "\uD0A4\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  await audit(db, { actorId: customerId, action: "cas.key_revoke", targetType: "ai_key", targetId: keyId }, nowMs);
}
__name(revokeKey, "revokeKey");
async function rotateKey(db, customerId, keyId, nowMs) {
  const k = await db.prepare("SELECT name, rate_limit_per_min r, monthly_cap_micro c FROM ai_api_keys WHERE id=? AND customer_id=? AND status='active'").bind(keyId, customerId).first();
  if (!k) throw new ServiceError("not_found", "\uD65C\uC131 \uD0A4\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  await revokeKey(db, customerId, keyId, nowMs);
  return issueKey(db, customerId, k.name, nowMs, { rateLimitPerMin: k.r, monthlyCapMicro: k.c });
}
__name(rotateKey, "rotateKey");
async function creditBalance(db, customerId) {
  const r = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) AS b FROM ai_credit_ledger WHERE customer_id = ?").bind(customerId).first();
  return r?.b ?? 0;
}
__name(creditBalance, "creditBalance");
async function creditTopup(db, customerId, amountMicro, ref, nowMs) {
  const r = await db.prepare("INSERT OR IGNORE INTO ai_credit_ledger(id,customer_id,kind,amount_micro,ref,created_at) VALUES(?,?,'topup',?,?,?)").bind(newId("led"), customerId, amountMicro, ref, nowIso(nowMs)).run();
  return r.meta.changes > 0;
}
__name(creditTopup, "creditTopup");
var MIN_TOPUP_MICRO = 5e6;
var MAX_TOPUP_MICRO = 5e8;
var MockAiRunner = class {
  static {
    __name(this, "MockAiRunner");
  }
  calls = [];
  async run(model, input) {
    this.calls.push({ model, input });
    const text = String(input.prompt ?? "");
    return { result: { response: `[mock] ${text.slice(0, 80)}`, mock: true }, usage: { inputTokens: Math.ceil(text.length / 4) + 1, outputTokens: 20 } };
  }
};
var fail = /* @__PURE__ */ __name((status, error, message) => ({ ok: false, status, error, message }), "fail");
async function runGateway(db, runner, bearer, body, o) {
  if (!bearer || !bearer.startsWith("cpai_")) return fail(401, "unauthorized", "API \uD0A4\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
  const key = await db.prepare("SELECT id, customer_id, status, rate_limit_per_min r, monthly_cap_micro cap FROM ai_api_keys WHERE key_hash = ?").bind(await sha256Hex(bearer)).first();
  if (!key || key.status !== "active") return fail(401, "unauthorized", "\uC720\uD6A8\uD558\uC9C0 \uC54A\uC740 API \uD0A4\uC785\uB2C8\uB2E4.");
  const kill = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cas_kill_switch'").first();
  if (kill?.value_json === "true") return fail(503, "service_paused", "\uC6B4\uC601\uC790\uAC00 AI \uC11C\uBE44\uC2A4\uB97C \uC77C\uC2DC \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
  if (typeof body.model !== "string" || typeof body.input !== "object" || body.input === null) return fail(400, "bad_request", "model(\uBB38\uC790\uC5F4)\uACFC input(\uAC1D\uCCB4)\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
  const user = await db.prepare("SELECT status FROM users WHERE id = ?").bind(key.customer_id).first();
  if (user?.status !== "active") return fail(403, "account_inactive", "\uACC4\uC815\uC774 \uD65C\uC131 \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  const model = await db.prepare("SELECT id, model_id, enabled, input_neurons_per_m, output_neurons_per_m, unit_neurons FROM ai_models WHERE model_id = ?").bind(body.model).first();
  if (!model || !model.enabled) return fail(404, "model_not_found", "\uC0AC\uC6A9\uD560 \uC218 \uC5C6\uB294 \uBAA8\uB378\uC785\uB2C8\uB2E4.");
  const access = await db.prepare("SELECT a.subscription_id AS sid FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND a.model_id = ? AND s.status IN ('active','canceling','past_due') LIMIT 1").bind(key.customer_id, model.id).first();
  if (!access) return fail(403, "no_subscription", "\uC774 \uBAA8\uB378\uC758 CAS \uAD6C\uB3C5\uC774 \uC5C6\uAC70\uB098 \uD65C\uC131 \uC0C1\uD0DC\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  const price = await currentPrice(db, model.id);
  if (!price) return fail(503, "not_priced", "\uAC00\uACA9\uC774 \uC124\uC815\uB418\uC9C0 \uC54A\uC740 \uBAA8\uB378\uC785\uB2C8\uB2E4.");
  const since = nowIso(o.nowMs - 6e4);
  const rate = await db.prepare("SELECT COUNT(*) AS c FROM ai_usage_records WHERE api_key_id = ? AND ts > ?").bind(key.id, since).first();
  if ((rate?.c ?? 0) >= key.r) return fail(429, "rate_limited", `\uBD84\uB2F9 \uC694\uCCAD \uC81C\uD55C(${key.r})\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4.`);
  const monthStart = new Date(o.nowMs);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  if (key.cap !== null) {
    const spent = await db.prepare("SELECT COALESCE(SUM(billed_micro),0) AS s FROM ai_usage_records WHERE api_key_id = ? AND ts >= ?").bind(key.id, nowIso(monthStart.getTime())).first();
    if ((spent?.s ?? 0) >= key.cap) return fail(429, "monthly_cap", "\uC774 \uD0A4\uC758 \uC6D4 \uBE44\uC6A9 \uC0C1\uD55C\uC5D0 \uB3C4\uB2EC\uD588\uC2B5\uB2C8\uB2E4.");
  }
  const maxOut = Math.min(Math.max(o.maxOutputTokens ?? 2048, 1), 32768);
  const worstNeurons = estimateNeurons(model, { inputTokens: JSON.stringify(body.input).length, outputTokens: maxOut, units: 1 });
  const balance = await creditBalance(db, key.customer_id);
  if (balance < sellMicro(worstNeurons, price.sell_per_1k_micro)) return fail(402, "insufficient_credit", "\uD06C\uB808\uB527\uC774 \uBD80\uC871\uD569\uB2C8\uB2E4. \uCDA9\uC804 \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.");
  let out;
  try {
    out = await runner.run(model.model_id, body.input);
  } catch (e) {
    return fail(502, "upstream_error", "AI \uC2E4\uD589\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4(\uACFC\uAE08\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4).");
  }
  const neurons = estimateNeurons(model, out.usage);
  const billed = sellMicro(neurons, price.sell_per_1k_micro);
  await db.batch([
    db.prepare("INSERT INTO ai_usage_records(id,subscription_id,api_key_id,model_id,request_id,neurons,input_tokens,output_tokens,cost_micro,billed_micro,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(newId("aiu"), access.sid, key.id, model.id, o.requestId, neurons, out.usage.inputTokens ?? null, out.usage.outputTokens ?? null, costMicro(neurons), billed, nowIso(o.nowMs)),
    db.prepare("INSERT OR IGNORE INTO ai_credit_ledger(id,customer_id,kind,amount_micro,ref,created_at) VALUES(?,?,'usage',?,?,?)").bind(newId("led"), key.customer_id, -billed, `use:${o.requestId}`, nowIso(o.nowMs)),
    db.prepare("UPDATE ai_api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(o.nowMs), key.id)
  ]);
  await detectAnomaly(db, key.id, key.customer_id, o.nowMs);
  return { ok: true, result: out.result, usage: out.usage, neurons, billedMicro: billed, balanceMicro: balance - billed };
}
__name(runGateway, "runGateway");
async function detectAnomaly(db, keyId, customerId, nowMs) {
  const th = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'cas_anomaly_micro_10m'").first();
  const limit = th ? Number(th.value_json) : 2e7;
  const s = await db.prepare("SELECT COALESCE(SUM(billed_micro),0) AS s FROM ai_usage_records WHERE api_key_id = ? AND ts > ?").bind(keyId, nowIso(nowMs - 6e5)).first();
  if ((s?.s ?? 0) <= limit) return false;
  const r = await db.prepare("UPDATE ai_api_keys SET status='blocked' WHERE id=? AND status='active'").bind(keyId).run();
  if (r.meta.changes === 0) return false;
  await db.batch([
    db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", "AI \uD0A4 \uC790\uB3D9 \uCC28\uB2E8", `\uD0A4 ${keyId} \uAC00 10\uBD84 \uC548\uC5D0 \uC784\uACC4 \uAE08\uC561\uC744 \uCD08\uACFC\uD574 \uCC28\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`, nowIso(nowMs)),
    db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), customerId, "warning", "AI API \uD0A4\uAC00 \uCC28\uB2E8\uB418\uC5C8\uC2B5\uB2C8\uB2E4", "\uBE44\uC815\uC0C1\uC801\uC73C\uB85C \uBE60\uB978 \uC0AC\uC6A9\uC774 \uAC10\uC9C0\uB418\uC5B4 \uD0A4\uB97C \uCC28\uB2E8\uD588\uC2B5\uB2C8\uB2E4. \uC9C0\uC6D0\uD300\uC5D0 \uBB38\uC758\uD558\uC138\uC694.", nowIso(nowMs))
  ]);
  return true;
}
__name(detectAnomaly, "detectAnomaly");

// src/lib/affiliate.ts
var MONTH_MS = 30.4375 * 24 * 3600 * 1e3;
function commissionFor(p, f, policy) {
  if (!f.referralValid || f.selfReferral || p.unpaid) return 0;
  if (f.maintainedMonths < policy.minMaintainedMonths) return 0;
  if (p.paidAtMs - f.firstQualifyingPaymentAtMs >= policy.maxCommissionMonths * MONTH_MS) return 0;
  const net = Math.max(0, p.paidMicro - p.refundedMicro - p.chargebackMicro);
  return Math.floor(net * policy.rateBp / 1e4);
}
__name(commissionFor, "commissionFor");
function isPayoutDay(date, policy) {
  return date.getUTCDate() === policy.payoutDayOfMonth;
}
__name(isPayoutDay, "isPayoutDay");
function planPayout(commissions, carryoverMicro, policy) {
  const total = commissions.reduce((a, c) => a + c, 0) + carryoverMicro;
  if (total < policy.minPayoutMicro) return { payMicro: 0, carryoverMicro: total };
  return { payMicro: total, carryoverMicro: 0 };
}
__name(planPayout, "planPayout");

// src/lib/affiliateProgram.ts
var SEED_AFFILIATE_POLICY = { rateBp: 1500, minMaintainedMonths: 2, minPayoutMicro: 25e6, maxCommissionMonths: 12, payoutDayOfMonth: 10, velocityLimitPerHour: 10 };
var MONTH_MS2 = 30.4375 * 24 * 3600 * 1e3;
async function loadAffiliatePolicy(db) {
  const r = await db.prepare("SELECT value_json FROM admin_settings WHERE key = 'affiliate_policy'").first();
  if (!r) return SEED_AFFILIATE_POLICY;
  try {
    return { ...SEED_AFFILIATE_POLICY, ...JSON.parse(r.value_json) };
  } catch {
    return SEED_AFFILIATE_POLICY;
  }
}
__name(loadAffiliatePolicy, "loadAffiliatePolicy");
async function saveAffiliatePolicy(db, actor, input, nowMs) {
  const n = { ...await loadAffiliatePolicy(db), ...input };
  const int = /* @__PURE__ */ __name((v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi, "int");
  if (!int(n.rateBp, 0, 5e3)) throw new ServiceError("bad_policy", "\uC218\uC218\uB8CC\uC728\uC740 0~50%(0~5000bp) \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  if (!int(n.minMaintainedMonths, 0, 24) || !int(n.maxCommissionMonths, 1, 60)) throw new ServiceError("bad_policy", "\uC720\uC9C0 \uAE30\uAC04\xB7\uC9C0\uAE09 \uAE30\uAC04\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  if (!int(n.minPayoutMicro, 0, 1e10) || n.minPayoutMicro % 1e4 !== 0) throw new ServiceError("bad_policy", "\uCD5C\uC18C \uC9C0\uAE09\uC561\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4(\uC13C\uD2B8 \uB2E8\uC704).");
  if (!int(n.payoutDayOfMonth, 1, 28)) throw new ServiceError("bad_policy", "\uC9C0\uAE09\uC77C\uC740 1~28 \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.");
  if (!int(n.velocityLimitPerHour, 1, 1e3)) throw new ServiceError("bad_policy", "\uC2DC\uAC04\uB2F9 \uCD94\uCC9C \uD55C\uB3C4\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('affiliate_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(JSON.stringify(n), actor, nowIso(nowMs)).run();
  await audit(db, { actorId: actor, action: "admin.affiliate_policy", detail: n }, nowMs);
  return n;
}
__name(saveAffiliatePolicy, "saveAffiliatePolicy");
function normalizeEmailForCompare(email) {
  const [l = "", d = ""] = email.trim().toLowerCase().split("@");
  const domain = d === "googlemail.com" ? "gmail.com" : d;
  const local = l.split("+")[0];
  return `${domain === "gmail.com" ? local.replace(/\./g, "") : local}@${domain}`;
}
__name(normalizeEmailForCompare, "normalizeEmailForCompare");
var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
}
__name(generateCode, "generateCode");
async function applyAffiliate(db, userId, payoutEmail, nowMs) {
  const email = payoutEmail.trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) throw new ServiceError("bad_email", "\uC9C0\uAE09\uBC1B\uC744 PayPal \uC774\uBA54\uC77C\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
  const ex = await db.prepare("SELECT id, code, status FROM affiliate_users WHERE user_id = ?").bind(userId).first();
  if (ex) return ex;
  for (let i = 0; i < 5; i++) {
    const id = newId("aff"), code = generateCode();
    const r = await db.prepare("INSERT OR IGNORE INTO affiliate_users(id,user_id,code,status,payout_method,payout_email,created_at) VALUES(?,?,?,'pending','paypal',?,?)").bind(id, userId, code, email, nowIso(nowMs)).run();
    if (r.meta.changes) {
      await audit(db, { actorId: userId, action: "affiliate.apply", targetType: "affiliate", targetId: id }, nowMs);
      return { id, code, status: "pending" };
    }
    const again = await db.prepare("SELECT id, code, status FROM affiliate_users WHERE user_id = ?").bind(userId).first();
    if (again) return again;
  }
  throw new ServiceError("code_collision", "\uCD94\uCC9C \uCF54\uB4DC\uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.");
}
__name(applyAffiliate, "applyAffiliate");
async function setAffiliateStatus(db, actor, affId, status, nowMs) {
  const r = await db.prepare("UPDATE affiliate_users SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE id = ?").bind(status, status, nowIso(nowMs), affId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "\uC81C\uD734\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  await audit(db, { actorId: actor, action: "admin.affiliate_status", targetType: "affiliate", targetId: affId, detail: { status } }, nowMs);
}
__name(setAffiliateStatus, "setAffiliateStatus");
async function bindReferral(db, user, rawCode, nowMs) {
  const code = String(rawCode ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(code)) return { bound: false, reason: "invalid_code" };
  const aff = await db.prepare("SELECT a.id, a.user_id, a.status, u.email FROM affiliate_users a JOIN users u ON u.id = a.user_id WHERE a.code = ?").bind(code).first();
  if (!aff || aff.status !== "approved") return { bound: false, reason: "affiliate_unavailable" };
  const policy = await loadAffiliatePolicy(db);
  let reason = null;
  if (aff.user_id === user.id || normalizeEmailForCompare(aff.email) === normalizeEmailForCompare(user.email)) reason = "self_referral";
  else {
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM affiliate_referrals WHERE affiliate_id = ? AND created_at > ?").bind(aff.id, nowIso(nowMs - 36e5)).first();
    if ((recent?.n ?? 0) >= policy.velocityLimitPerHour) reason = "velocity";
  }
  const r = await db.prepare("INSERT OR IGNORE INTO affiliate_referrals(id,affiliate_id,referred_user_id,flagged_fraud,flag_reason,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ref"), aff.id, user.id, reason ? 1 : 0, reason, nowIso(nowMs)).run();
  if (r.meta.changes === 0) return { bound: false, reason: "already_referred" };
  return { bound: true, flagged: !!reason, reason: reason ?? void 0 };
}
__name(bindReferral, "bindReferral");
async function accrueCommission(db, paymentId, nowMs) {
  const p = await db.prepare("SELECT p.id, p.customer_id, p.amount_micro, p.status, p.paid_at, i.subscription_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?").bind(paymentId).first();
  if (!p || p.status !== "succeeded" || !p.subscription_id || !p.paid_at) return "skipped";
  const ref = await db.prepare("SELECT r.id, r.affiliate_id, r.flagged_fraud, r.first_qualifying_payment_at AS fq, a.status, a.user_id FROM affiliate_referrals r JOIN affiliate_users a ON a.id = r.affiliate_id WHERE r.referred_user_id = ?").bind(p.customer_id).first();
  if (!ref || ref.flagged_fraud || ref.status !== "approved" || ref.user_id === p.customer_id) return "skipped";
  const policy = await loadAffiliatePolicy(db);
  const paidAt = Date.parse(p.paid_at);
  const first = ref.fq ? Date.parse(ref.fq) : paidAt;
  if (!ref.fq) await db.prepare("UPDATE affiliate_referrals SET first_qualifying_payment_at = ? WHERE id = ? AND first_qualifying_payment_at IS NULL").bind(p.paid_at, ref.id).run();
  const amount = commissionFor(
    { paymentId: p.id, subscriptionId: p.subscription_id, paidMicro: p.amount_micro, refundedMicro: 0, chargebackMicro: 0, unpaid: false, paidAtMs: paidAt },
    { firstQualifyingPaymentAtMs: first, maintainedMonths: policy.minMaintainedMonths, referralValid: true, selfReferral: false },
    policy
  );
  if (amount <= 0) return "skipped";
  const r = await db.prepare("INSERT OR IGNORE INTO affiliate_commissions(id,affiliate_id,referral_id,subscription_id,payment_id,amount_micro,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").bind(newId("com"), ref.affiliate_id, ref.id, p.subscription_id, p.id, amount, nowIso(nowMs)).run();
  return r.meta.changes ? "accrued" : "skipped";
}
__name(accrueCommission, "accrueCommission");
async function settleAffiliates(db, nowMs, o = {}) {
  const rep = { voided: 0, adjusted: 0, promoted: 0, payoutsCreated: 0 };
  const policy = await loadAffiliatePolicy(db);
  const ts = nowIso(nowMs);
  const rev = (await db.prepare(`SELECT c.id, c.affiliate_id, c.amount_micro, c.status, p.amount_micro AS pay, p.status AS pstatus,
      COALESCE((SELECT SUM(amount_micro) FROM refunds WHERE payment_id = p.id AND kind = 'refund'),0) AS refunded
    FROM affiliate_commissions c JOIN payments p ON p.id = c.payment_id WHERE c.status IN ('pending','eligible','payable','paid') AND p.status IN ('refunded','partially_refunded','disputed')`).all()).results;
  for (const c of rev) {
    const full = c.pstatus === "refunded" || c.pstatus === "disputed" || c.refunded >= c.pay;
    const keep = full ? 0 : Math.floor(c.amount_micro * Math.max(0, c.pay - c.refunded) / c.pay);
    const lose = c.amount_micro - keep;
    if (lose <= 0) continue;
    if (c.status === "pending" || c.status === "eligible") {
      if (keep === 0) {
        await db.prepare("UPDATE affiliate_commissions SET status='void' WHERE id=?").bind(c.id).run();
        rep.voided++;
      } else {
        await db.prepare("UPDATE affiliate_commissions SET amount_micro=? WHERE id=?").bind(keep, c.id).run();
        rep.voided++;
      }
    } else {
      const r = await db.prepare("INSERT OR IGNORE INTO affiliate_adjustments(id,affiliate_id,commission_id,amount_micro,reason,created_at) VALUES(?,?,?,?,?,?)").bind(newId("adj"), c.affiliate_id, c.id, -lose, c.pstatus === "disputed" ? "\uCC28\uC9C0\uBC31/\uBD84\uC7C1" : "\uD658\uBD88", ts).run();
      if (r.meta.changes) {
        await db.prepare("UPDATE affiliate_commissions SET status = CASE WHEN status='paid' THEN 'clawed_back' ELSE status END WHERE id=?").bind(c.id).run();
        rep.adjusted++;
      }
    }
  }
  const pend = (await db.prepare(`SELECT c.id, s.status AS sstatus,
      (SELECT MIN(p2.paid_at) FROM payments p2 JOIN invoices i2 ON i2.id = p2.invoice_id WHERE i2.subscription_id = c.subscription_id AND p2.status IN ('succeeded','partially_refunded')) AS first_paid
    FROM affiliate_commissions c JOIN subscriptions s ON s.id = c.subscription_id WHERE c.status = 'pending'`).all()).results;
  for (const c of pend) {
    const maintained = c.first_paid !== null && nowMs - Date.parse(c.first_paid) >= policy.minMaintainedMonths * MONTH_MS2;
    if (["canceled", "refunded", "incomplete"].includes(c.sstatus) && !maintained) {
      await db.prepare("UPDATE affiliate_commissions SET status='void' WHERE id=?").bind(c.id).run();
      rep.voided++;
    } else if (maintained && ["active", "canceling", "canceled"].includes(c.sstatus)) {
      await db.prepare("UPDATE affiliate_commissions SET status='eligible' WHERE id=?").bind(c.id).run();
      rep.promoted++;
    }
  }
  if (isPayoutDay(new Date(nowMs), policy) || o.forcePayout) {
    const period = ts.slice(0, 7);
    const affs = (await db.prepare("SELECT id FROM affiliate_users WHERE status = 'approved'").all()).results;
    for (const a of affs) {
      if (await db.prepare("SELECT 1 AS x FROM affiliate_payouts WHERE affiliate_id = ? AND period = ?").bind(a.id, period).first()) continue;
      const elig = (await db.prepare("SELECT id, amount_micro FROM affiliate_commissions WHERE affiliate_id = ? AND status = 'eligible' ORDER BY created_at").bind(a.id).all()).results;
      const adj = (await db.prepare("SELECT id, amount_micro FROM affiliate_adjustments WHERE affiliate_id = ? AND applied_payout_id IS NULL").bind(a.id).all()).results;
      const plan = planPayout([...elig.map((e) => e.amount_micro), ...adj.map((x) => x.amount_micro)], 0, policy);
      if (plan.payMicro <= 0) continue;
      const pid = newId("pay");
      const ins = await db.prepare("INSERT OR IGNORE INTO affiliate_payouts(id,affiliate_id,period,amount_micro,carryover_micro,status,created_at) VALUES(?,?,?,?,0,'pending',?)").bind(pid, a.id, period, plan.payMicro, ts).run();
      if (!ins.meta.changes) continue;
      await db.batch([
        ...elig.map((e) => db.prepare("UPDATE affiliate_commissions SET status='payable', payout_id=? WHERE id=? AND status='eligible'").bind(pid, e.id)),
        ...adj.map((x) => db.prepare("UPDATE affiliate_adjustments SET applied_payout_id=? WHERE id=? AND applied_payout_id IS NULL").bind(pid, x.id))
      ]);
      rep.payoutsCreated++;
    }
  }
  return rep;
}
__name(settleAffiliates, "settleAffiliates");
async function payoutRow(db, id) {
  const p = await db.prepare("SELECT id, affiliate_id, status FROM affiliate_payouts WHERE id = ?").bind(id).first();
  if (!p) throw new ServiceError("not_found", "\uC9C0\uAE09 \uC694\uCCAD\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  return p;
}
__name(payoutRow, "payoutRow");
async function approvePayout(db, actor, id, nowMs) {
  const p = await payoutRow(db, id);
  if (p.status !== "pending") throw new ServiceError("bad_state", "\uC2B9\uC778\uD560 \uC218 \uC5C6\uB294 \uC0C1\uD0DC\uC785\uB2C8\uB2E4.");
  await db.prepare("UPDATE affiliate_payouts SET status='approved', approved_by=? WHERE id=?").bind(actor, id).run();
  await audit(db, { actorId: actor, action: "admin.payout_approve", targetType: "affiliate_payout", targetId: id }, nowMs);
}
__name(approvePayout, "approvePayout");
async function markPayoutPaid(db, actor, id, reference, nowMs) {
  const ref = reference.trim();
  if (!ref || ref.length > 120) throw new ServiceError("bad_reference", "\uC1A1\uAE08 \uCC38\uC870\uBC88\uD638(1~120\uC790)\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
  const p = await payoutRow(db, id);
  if (p.status !== "approved") throw new ServiceError("bad_state", "\uC2B9\uC778\uB41C \uC9C0\uAE09\uB9CC \uC644\uB8CC \uCC98\uB9AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  await db.batch([
    db.prepare("UPDATE affiliate_payouts SET status='paid', external_ref=?, paid_at=? WHERE id=?").bind(ref, nowIso(nowMs), id),
    db.prepare("UPDATE affiliate_commissions SET status='paid' WHERE payout_id=? AND status='payable'").bind(id)
  ]);
  await audit(db, { actorId: actor, action: "admin.payout_paid", targetType: "affiliate_payout", targetId: id, detail: { reference: ref } }, nowMs);
}
__name(markPayoutPaid, "markPayoutPaid");
async function releasePayout(db, actor, id, outcome, reason, nowMs) {
  const p = await payoutRow(db, id);
  if (!["pending", "approved"].includes(p.status)) throw new ServiceError("bad_state", "\uCC98\uB9AC\uD560 \uC218 \uC5C6\uB294 \uC0C1\uD0DC\uC785\uB2C8\uB2E4.");
  await db.batch([
    db.prepare("UPDATE affiliate_payouts SET status=?, failure_reason=? WHERE id=?").bind(outcome, reason.slice(0, 300), id),
    db.prepare("UPDATE affiliate_commissions SET status='eligible', payout_id=NULL WHERE payout_id=? AND status='payable'").bind(id),
    db.prepare("UPDATE affiliate_adjustments SET applied_payout_id=NULL WHERE applied_payout_id=?").bind(id)
  ]);
  await audit(db, { actorId: actor, action: `admin.payout_${outcome}`, targetType: "affiliate_payout", targetId: id, detail: { reason } }, nowMs);
}
__name(releasePayout, "releasePayout");
async function clearReferralFlag(db, actor, referralId, nowMs) {
  const r = await db.prepare("UPDATE affiliate_referrals SET flagged_fraud = 0 WHERE id = ? AND flagged_fraud = 1").bind(referralId).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "\uAC80\uD1A0\uD560 \uCD94\uCC9C\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  await audit(db, { actorId: actor, action: "admin.referral_clear_flag", targetType: "affiliate_referral", targetId: referralId }, nowMs);
}
__name(clearReferralFlag, "clearReferralFlag");
async function affiliateSummary(db, userId, origin) {
  const a = await db.prepare("SELECT id, code, status, payout_email FROM affiliate_users WHERE user_id = ?").bind(userId).first();
  const policy = await loadAffiliatePolicy(db);
  if (!a) return { applied: false, policy: pub(policy) };
  const sums = (await db.prepare("SELECT status, COALESCE(SUM(amount_micro),0) s, COUNT(*) n FROM affiliate_commissions WHERE affiliate_id = ? GROUP BY status").bind(a.id).all()).results;
  const refs = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(first_qualifying_payment_at IS NOT NULL),0) paying FROM affiliate_referrals WHERE affiliate_id = ? AND flagged_fraud = 0").bind(a.id).first();
  const adj = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) s FROM affiliate_adjustments WHERE affiliate_id = ? AND applied_payout_id IS NULL").bind(a.id).first();
  return {
    applied: true,
    status: a.status,
    code: a.code,
    link: a.status === "approved" ? `${origin}/register?ref=${a.code}` : null,
    payoutEmail: a.payout_email,
    referrals: { total: refs?.n ?? 0, paying: refs?.paying ?? 0 },
    amounts: Object.fromEntries(sums.map((x) => [x.status, x.s])),
    pendingAdjustmentMicro: adj?.s ?? 0,
    commissions: (await db.prepare("SELECT c.id, c.amount_micro, c.status, c.created_at, p.name_ko product FROM affiliate_commissions c JOIN subscriptions s ON s.id = c.subscription_id JOIN products p ON p.id = s.product_id WHERE c.affiliate_id = ? ORDER BY c.created_at DESC LIMIT 20").bind(a.id).all()).results,
    payouts: (await db.prepare("SELECT id, period, amount_micro, status, paid_at, failure_reason FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 12").bind(a.id).all()).results,
    policy: pub(policy)
  };
}
__name(affiliateSummary, "affiliateSummary");
var pub = /* @__PURE__ */ __name((p) => ({ ratePct: p.rateBp / 100, minMaintainedMonths: p.minMaintainedMonths, minPayoutMicro: p.minPayoutMicro, maxCommissionMonths: p.maxCommissionMonths, payoutDayOfMonth: p.payoutDayOfMonth }), "pub");
async function adminAffiliateOverview(db) {
  const q = /* @__PURE__ */ __name(async (sql) => (await db.prepare(sql).all()).results, "q");
  return {
    policy: await loadAffiliatePolicy(db),
    affiliates: await q(`SELECT a.id, a.code, a.status, a.payout_email, u.email, a.created_at,
        (SELECT COUNT(*) FROM affiliate_referrals WHERE affiliate_id = a.id) AS referrals,
        (SELECT COALESCE(SUM(amount_micro),0) FROM affiliate_commissions WHERE affiliate_id = a.id AND status IN ('pending','eligible')) AS outstanding,
        (SELECT COALESCE(SUM(amount_micro),0) FROM affiliate_commissions WHERE affiliate_id = a.id AND status = 'paid') AS paid
      FROM affiliate_users a JOIN users u ON u.id = a.user_id ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC`),
    flagged: await q("SELECT r.id, r.flag_reason, r.created_at, a.code, u.email AS referred_email FROM affiliate_referrals r JOIN affiliate_users a ON a.id = r.affiliate_id JOIN users u ON u.id = r.referred_user_id WHERE r.flagged_fraud = 1 ORDER BY r.created_at DESC LIMIT 50"),
    payouts: await q("SELECT p.id, p.period, p.amount_micro, p.status, p.external_ref, p.paid_at, p.failure_reason, a.code, a.payout_email, u.email FROM affiliate_payouts p JOIN affiliate_users a ON a.id = p.affiliate_id JOIN users u ON u.id = a.user_id ORDER BY p.created_at DESC LIMIT 50")
  };
}
__name(adminAffiliateOverview, "adminAffiliateOverview");

// src/lib/webhooks.ts
function paypalWebhookHeaders(h) {
  return {
    authAlgo: h.get("paypal-auth-algo"),
    certUrl: h.get("paypal-cert-url"),
    transmissionId: h.get("paypal-transmission-id"),
    transmissionSig: h.get("paypal-transmission-sig"),
    transmissionTime: h.get("paypal-transmission-time")
  };
}
__name(paypalWebhookHeaders, "paypalWebhookHeaders");
var MICRO_PER_CENT = 1e4;
var addMonthUtc = /* @__PURE__ */ __name((ms) => {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}, "addMonthUtc");
async function handlePayPalWebhook(db, paypal, rawBody, headers, webhookId, nowMs) {
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "bad_json" };
  }
  if (typeof event?.id !== "string" || typeof event?.event_type !== "string" || typeof event.resource !== "object" || event.resource === null) return { status: 400, body: "bad_event" };
  let ok = false;
  try {
    ok = await paypal.verifyWebhook({ headers, webhookId, rawBody });
  } catch (e) {
    return { status: 500, body: "verification_unavailable" };
  }
  if (!ok) return { status: 400, body: "invalid signature" };
  const ins = await db.prepare("INSERT OR IGNORE INTO webhook_events(id,type,payload_json,received_at,provider) VALUES(?,?,?,?,'paypal')").bind(event.id, event.event_type, rawBody, nowIso(nowMs)).run();
  if (ins.meta.changes === 0) {
    const prev = await db.prepare("SELECT status FROM webhook_events WHERE id = ?").bind(event.id).first();
    if (prev?.status === "processed" || prev?.status === "ignored") return { status: 200, body: "duplicate" };
  }
  try {
    const handled = await dispatch(db, event, nowMs);
    await db.prepare("UPDATE webhook_events SET status = ?, processed_at = ?, last_error = NULL WHERE id = ?").bind(handled ? "processed" : "ignored", nowIso(nowMs), event.id).run();
    return { status: 200, body: handled ? "ok" : "ignored" };
  } catch (e) {
    await db.prepare("UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?").bind(String(e instanceof Error ? e.message : e).slice(0, 500), event.id).run();
    return { status: 500, body: "processing failed" };
  }
}
__name(handlePayPalWebhook, "handlePayPalWebhook");
async function dispatch(db, ev, nowMs) {
  switch (ev.event_type) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      return onSubscriptionActivated(db, ev, nowMs);
    case "PAYMENT.SALE.COMPLETED":
      return onSaleCompleted(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      return onPaymentFailed(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.SUSPENDED":
      return onSubscriptionSuspended(db, ev, nowMs);
    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return onSubscriptionEnded(db, ev, nowMs);
    case "PAYMENT.SALE.REFUNDED":
    case "PAYMENT.CAPTURE.REFUNDED":
      return onRefunded(db, ev, nowMs);
    case "PAYMENT.SALE.REVERSED":
    case "PAYMENT.CAPTURE.REVERSED":
      return onReversed(db, ev, nowMs);
    case "CUSTOMER.DISPUTE.CREATED":
      return onDisputeCreated(db, ev, nowMs);
    case "PAYMENT.CAPTURE.COMPLETED":
      return onCaptureCompleted(db, ev, nowMs);
    default:
      return false;
  }
}
__name(dispatch, "dispatch");
var SUB_COLS = "id,customer_id,status,paypal_subscription_id,current_period_end";
var findSubByPayPal = /* @__PURE__ */ __name((db, id) => id ? db.prepare(`SELECT ${SUB_COLS} FROM subscriptions WHERE paypal_subscription_id = ?`).bind(id).first() : Promise.resolve(null), "findSubByPayPal");
var findSubById = /* @__PURE__ */ __name((db, id) => id ? db.prepare(`SELECT ${SUB_COLS} FROM subscriptions WHERE id = ?`).bind(id).first() : Promise.resolve(null), "findSubById");
function jobStmt(db, kind, subId, idemKey, nowMs) {
  return db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), kind, subId, idemKey, nowIso(nowMs), nowIso(nowMs));
}
__name(jobStmt, "jobStmt");
async function resolveSub(db, paypalSubId, customId) {
  return await findSubByPayPal(db, paypalSubId) ?? await findSubById(db, customId);
}
__name(resolveSub, "resolveSub");
async function onSubscriptionActivated(db, ev, nowMs) {
  const r = ev.resource;
  const ourId = r.custom_id;
  if (!ourId || typeof r.id !== "string") return false;
  if (ourId.startsWith("cpu:")) return await findAddon(db, r.id, ourId) !== null;
  const res = await db.prepare("UPDATE subscriptions SET paypal_subscription_id = ?, updated_at = ? WHERE id = ? AND (paypal_subscription_id IS NULL OR paypal_subscription_id = ?)").bind(r.id, nowIso(nowMs), ourId, r.id).run();
  if (res.meta.changes === 0) throw new Error(`cannot link paypal subscription to ${ourId}`);
  return true;
}
__name(onSubscriptionActivated, "onSubscriptionActivated");
async function accrueSafe(db, paymentId, nowMs) {
  try {
    await accrueCommission(db, paymentId, nowMs);
  } catch (e) {
    console.error("[affiliate accrue]", e instanceof Error ? e.message : e);
  }
}
__name(accrueSafe, "accrueSafe");
async function findAddon(db, paypalSubId, custom) {
  const cols = "id,subscription_id,container_id,purchase_status,monthly_micro";
  if (paypalSubId) {
    const a = await db.prepare(`SELECT ${cols} FROM cpu_addons WHERE paypal_subscription_id = ?`).bind(paypalSubId).first();
    if (a) return a;
  }
  if (typeof custom === "string" && custom.startsWith("cpu:")) return db.prepare(`SELECT ${cols} FROM cpu_addons WHERE id = ?`).bind(custom.slice(4)).first();
  return null;
}
__name(findAddon, "findAddon");
async function onAddonSale(db, addon, sale, nowMs) {
  const cents = valueToCents(sale.amount?.total);
  const micro = cents * MICRO_PER_CENT;
  const parent = await db.prepare("SELECT customer_id FROM subscriptions WHERE id = ?").bind(addon.subscription_id).first();
  if (!parent) throw new Error(`parent subscription missing for addon ${addon.id}`);
  const invoiceId = `inv_${sale.id}`;
  const periodEnd = addMonthUtc(nowMs);
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO invoices(id,subscription_id,customer_id,paypal_sale_id,status,subtotal_micro,total_micro,currency,total_minor,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,'USD',?,?,?,?)").bind(invoiceId, addon.subscription_id, parent.customer_id, sale.id, "paid", micro, micro, cents, nowIso(nowMs), nowIso(periodEnd), nowIso(nowMs)),
    db.prepare("INSERT OR IGNORE INTO payments(id,invoice_id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,?,'paypal',?,?,?,?,'USD',?)").bind(`pay_${sale.id}`, invoiceId, parent.customer_id, sale.id, micro, "succeeded", nowIso(nowMs), nowIso(nowMs), cents),
    db.prepare("UPDATE cpu_addons SET current_period_end=? WHERE id=?").bind(nowIso(periodEnd), addon.id)
  ];
  if (addon.purchase_status === "pending") {
    if (micro !== addon.monthly_micro) throw new Error(`addon price mismatch: ${micro} != ${addon.monthly_micro}`);
    stmts.push(db.prepare("UPDATE cpu_addons SET purchase_status='paid', apply_status='queued' WHERE id=? AND purchase_status='pending'").bind(addon.id));
    stmts.push(enqueueResize(db, addon.subscription_id, addon.container_id, `buy:${addon.id}`, nowMs));
  }
  await db.batch(stmts);
  await accrueSafe(db, `pay_${sale.id}`, nowMs);
  return true;
}
__name(onAddonSale, "onAddonSale");
async function onSaleCompleted(db, ev, nowMs) {
  const sale = ev.resource;
  if (String(sale.state).toLowerCase() !== "completed") return false;
  const addon = await findAddon(db, sale.billing_agreement_id, sale.custom ?? sale.custom_id);
  if (addon) return onAddonSale(db, addon, sale, nowMs);
  const sub = await resolveSub(db, sale.billing_agreement_id, sale.custom ?? sale.custom_id);
  if (!sub) throw new Error(`subscription not linked yet: ${sale.billing_agreement_id}`);
  if (String(sale.amount?.currency).toUpperCase() !== "USD") throw new Error(`unsupported currency: ${sale.amount?.currency}`);
  const cents = valueToCents(sale.amount?.total);
  const micro = cents * MICRO_PER_CENT;
  const periodStart = nowMs;
  const periodEnd = addMonthUtc(nowMs);
  const invoiceId = `inv_${sale.id}`;
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO invoices(id,subscription_id,customer_id,paypal_sale_id,status,subtotal_micro,total_micro,currency,total_minor,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,'USD',?,?,?,?)").bind(invoiceId, sub.id, sub.customer_id, sale.id, "paid", micro, micro, cents, nowIso(periodStart), nowIso(periodEnd), nowIso(nowMs)),
    db.prepare("INSERT OR IGNORE INTO payments(id,invoice_id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,?,'paypal',?,?,?,?,'USD',?)").bind(`pay_${sale.id}`, invoiceId, sub.customer_id, sale.id, micro, "succeeded", nowIso(nowMs), nowIso(nowMs), cents)
  ];
  if (sub.status !== "active" && sub.status !== "canceling") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "active");
    stmts.push(db.prepare("UPDATE subscriptions SET status='active', current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?").bind(nowIso(periodStart), nowIso(periodEnd), invoiceId, nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, sub.status === "incomplete" ? "provision" : "resume", sub.id, sub.status === "incomplete" ? `provision:${sub.id}` : `resume:${sub.id}:${sale.id}`, nowMs));
  } else {
    stmts.push(db.prepare("UPDATE subscriptions SET current_period_start=?, current_period_end=?, last_invoice_id=?, updated_at=? WHERE id=?").bind(nowIso(periodStart), nowIso(periodEnd), invoiceId, nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  await accrueSafe(db, `pay_${sale.id}`, nowMs);
  return true;
}
__name(onSaleCompleted, "onSaleCompleted");
async function onPaymentFailed(db, ev, nowMs) {
  const addon = await findAddon(db, ev.resource.id, ev.resource.custom_id);
  if (addon) {
    const owner = await db.prepare("SELECT customer_id FROM subscriptions WHERE id = ?").bind(addon.subscription_id).first();
    if (owner) await db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), owner.customer_id, "warning", "\uCD94\uAC00 CPU \uACB0\uC81C \uC2E4\uD328", "\uCD94\uAC00 CPU \uACB0\uC81C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. PayPal \uACB0\uC81C \uC218\uB2E8\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.", nowIso(nowMs)).run();
    return true;
  }
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  const stmts = [db.prepare("INSERT INTO notifications(id,user_id,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), sub.customer_id, "warning", "\uACB0\uC81C \uC2E4\uD328", "\uACB0\uC81C\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. PayPal \uACB0\uC81C \uC218\uB2E8\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.", nowIso(nowMs))];
  if (sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "past_due");
    stmts.push(db.prepare("UPDATE subscriptions SET status='past_due', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
  }
  await db.batch(stmts);
  return true;
}
__name(onPaymentFailed, "onPaymentFailed");
async function onSubscriptionSuspended(db, ev, nowMs) {
  if (await findAddon(db, ev.resource.id, ev.resource.custom_id)) return true;
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  if (sub.status !== "active" && sub.status !== "past_due") return true;
  assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "suspended");
  await db.batch([db.prepare("UPDATE subscriptions SET status='suspended', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id), jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:paypal_suspended:${ev.id}`, nowMs)]);
  return true;
}
__name(onSubscriptionSuspended, "onSubscriptionSuspended");
async function onSubscriptionEnded(db, ev, nowMs) {
  const addon = await findAddon(db, ev.resource.id, ev.resource.custom_id);
  if (addon) {
    if (addon.purchase_status === "pending") await db.prepare("UPDATE cpu_addons SET purchase_status='cancelled' WHERE id=?").bind(addon.id).run();
    else if (addon.purchase_status === "paid") await db.prepare("UPDATE cpu_addons SET cancel_at_period_end=1 WHERE id=?").bind(addon.id).run();
    return true;
  }
  const sub = await resolveSub(db, ev.resource.id, ev.resource.custom_id);
  if (!sub) throw new Error("subscription not linked yet");
  if (sub.status === "canceled" || sub.status === "refunded" || sub.status === "canceling") return true;
  const hasTimeLeft = sub.current_period_end !== null && Date.parse(sub.current_period_end) > nowMs;
  if (sub.status === "incomplete") {
    await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id).run();
    return true;
  }
  if (hasTimeLeft && sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "canceling");
    await db.prepare("UPDATE subscriptions SET status='canceling', cancel_at_period_end=1, updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id).run();
    return true;
  }
  assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "canceled");
  await db.batch([db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id), jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:canceled`, nowMs)]);
  return true;
}
__name(onSubscriptionEnded, "onSubscriptionEnded");
async function applyDomainCapture(db, orderId, captureId, currency, amountMinor, nowMs) {
  const o = await db.prepare("SELECT id,customer_id,charge_currency,charge_amount,price_micro FROM domain_orders WHERE id = ?").bind(orderId).first();
  if (!o) throw new Error(`domain order not found: ${orderId}`);
  if (currency.toUpperCase() !== "USD" || o.charge_currency !== "USD" || o.charge_amount !== null && amountMinor !== o.charge_amount) throw new Error(`domain payment mismatch for ${orderId}: ${currency} ${amountMinor} != ${o.charge_currency} ${o.charge_amount}`);
  const result = await markPaid(db, orderId, captureId, nowMs);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO payments(id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,'paypal',?,?,?,?,'USD',?)").bind(`pay_${captureId}`, o.customer_id, captureId, o.price_micro, "succeeded", nowIso(nowMs), nowIso(nowMs), amountMinor),
    ...result === "paid" ? [db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,idempotency_key,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "register_domain", `register:${orderId}`, JSON.stringify({ orderId }), nowIso(nowMs), nowIso(nowMs))] : []
  ]);
}
__name(applyDomainCapture, "applyDomainCapture");
async function applyAiTopup(db, topupId, captureId, currency, amountMinor, nowMs) {
  const t = await db.prepare("SELECT id, customer_id, amount_micro, status FROM ai_credit_topups WHERE id = ?").bind(topupId).first();
  if (!t) throw new Error(`ai topup not found: ${topupId}`);
  if (currency.toUpperCase() !== "USD" || amountMinor * MICRO_PER_CENT !== t.amount_micro) throw new Error(`ai topup mismatch for ${topupId}`);
  await db.batch([
    db.prepare("UPDATE ai_credit_topups SET status='paid' WHERE id=? AND status='pending'").bind(t.id),
    db.prepare("INSERT OR IGNORE INTO payments(id,customer_id,paypal_capture_id,provider,amount_micro,status,paid_at,created_at,currency,amount_minor) VALUES(?,?,?,'paypal',?,?,?,?,'USD',?)").bind(`pay_${captureId}`, t.customer_id, captureId, t.amount_micro, "succeeded", nowIso(nowMs), nowIso(nowMs), amountMinor)
  ]);
  await creditTopup(db, t.customer_id, t.amount_micro, `topup:${captureId}`, nowMs);
}
__name(applyAiTopup, "applyAiTopup");
async function onCaptureCompleted(db, ev, nowMs) {
  const c = ev.resource;
  if (String(c.status).toUpperCase() !== "COMPLETED") return false;
  const orderId = c.custom_id;
  if (!orderId) return false;
  if (orderId.startsWith("ai:")) {
    await applyAiTopup(db, orderId.slice(3), c.id, c.amount?.currency_code ?? "", valueToCents(c.amount?.value), nowMs);
    return true;
  }
  const exists = await db.prepare("SELECT 1 AS x FROM domain_orders WHERE id = ?").bind(orderId).first();
  if (!exists) return false;
  await applyDomainCapture(db, orderId, c.id, c.amount?.currency_code ?? "", valueToCents(c.amount?.value), nowMs);
  return true;
}
__name(onCaptureCompleted, "onCaptureCompleted");
var findPaymentByRef = /* @__PURE__ */ __name((db, ref) => ref ? db.prepare("SELECT id,customer_id,amount_micro,invoice_id FROM payments WHERE paypal_capture_id = ?").bind(ref).first() : Promise.resolve(null), "findPaymentByRef");
async function subOfPayment(db, p) {
  return p.invoice_id ? db.prepare(`SELECT s.id,s.customer_id,s.status,s.paypal_subscription_id,s.current_period_end FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id WHERE i.id = ?`).bind(p.invoice_id).first() : null;
}
__name(subOfPayment, "subOfPayment");
function refundedParentId(ev) {
  const r = ev.resource;
  if (typeof r.sale_id === "string") return r.sale_id;
  const up = r.links?.find((l) => l.rel === "up")?.href;
  return up ? up.split("/").pop() : void 0;
}
__name(refundedParentId, "refundedParentId");
async function onRefunded(db, ev, nowMs) {
  const r = ev.resource;
  const parent = refundedParentId(ev);
  const pay = await findPaymentByRef(db, parent);
  if (!pay) throw new Error(`payment not found for refund ${r.id} (parent ${parent})`);
  const cents = valueToCents(r.amount?.total ?? r.amount?.value);
  const micro = cents * MICRO_PER_CENT;
  await db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,paypal_refund_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,?,'refund',?)").bind(`ref_${r.id}`, pay.id, r.id, micro, r.note_to_payer ?? r.reason_code ?? null, nowIso(nowMs)).run();
  const sum = await db.prepare("SELECT COALESCE(SUM(amount_micro),0) AS s FROM refunds WHERE payment_id = ? AND kind = 'refund'").bind(pay.id).first();
  const full = (sum?.s ?? 0) >= pay.amount_micro;
  const stmts = [db.prepare("UPDATE payments SET status=? WHERE id=?").bind(full ? "refunded" : "partially_refunded", pay.id)];
  const sub = await subOfPayment(db, pay);
  if (full && sub && sub.status === "active") {
    assertTransition(SUBSCRIPTION_TRANSITIONS, "active", "refunded");
    stmts.push(db.prepare("UPDATE subscriptions SET status='refunded', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:refunded`, nowMs));
  }
  await db.batch(stmts);
  return true;
}
__name(onRefunded, "onRefunded");
async function markChargeback(db, pay, refKey, reason, nowMs) {
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO refunds(id,payment_id,amount_micro,reason,kind,created_at) VALUES(?,?,?,?,'chargeback',?)").bind(`cb_${refKey}`, pay.id, pay.amount_micro, reason, nowIso(nowMs)),
    db.prepare("UPDATE payments SET status='disputed' WHERE id=?").bind(pay.id),
    db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", "\uACB0\uC81C \uBD84\uC7C1/\uCDE8\uC18C \uBC1C\uC0DD", `PayPal ${refKey}`, nowIso(nowMs))
  ];
  const sub = await subOfPayment(db, pay);
  if (sub && (sub.status === "active" || sub.status === "past_due")) {
    assertTransition(SUBSCRIPTION_TRANSITIONS, sub.status, "suspended");
    stmts.push(db.prepare("UPDATE subscriptions SET status='suspended', updated_at=? WHERE id=?").bind(nowIso(nowMs), sub.id));
    stmts.push(jobStmt(db, "suspend", sub.id, `suspend:${sub.id}:dispute:${refKey}`, nowMs));
  }
  await db.batch(stmts);
}
__name(markChargeback, "markChargeback");
async function onReversed(db, ev, nowMs) {
  const pay = await findPaymentByRef(db, ev.resource.id);
  if (!pay) throw new Error(`payment not found for reversal ${ev.resource.id}`);
  await markChargeback(db, pay, String(ev.resource.id), "reversed", nowMs);
  return true;
}
__name(onReversed, "onReversed");
async function onDisputeCreated(db, ev, nowMs) {
  const d = ev.resource;
  const tx = d.disputed_transactions?.[0]?.seller_transaction_id;
  const pay = await findPaymentByRef(db, tx);
  if (!pay) throw new Error(`payment not found for dispute ${d.dispute_id ?? d.id}`);
  await markChargeback(db, pay, String(d.dispute_id ?? d.id), d.reason ?? null, nowMs);
  return true;
}
__name(onDisputeCreated, "onDisputeCreated");

// src/lib/ratelimit.ts
var MemoryRateLimiter = class {
  static {
    __name(this, "MemoryRateLimiter");
  }
  buckets = /* @__PURE__ */ new Map();
  async hit(key, limit, windowSec, nowMs) {
    const bucket = this.buckets.get(key);
    if (!bucket || nowMs > bucket.expiresAt) {
      this.buckets.set(key, { count: 1, expiresAt: nowMs + windowSec * 1e3 });
      return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
    }
    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((bucket.expiresAt - nowMs) / 1e3) };
    }
    bucket.count++;
    return { allowed: true, remaining: limit - bucket.count, retryAfterSec: 0 };
  }
};

// src/lib/outbox.ts
async function dispatchOutbox(db, queue, nowMs, limit = 50) {
  const { results } = await db.prepare(
    `SELECT j.id FROM deployment_jobs j
      WHERE j.state IN ('queued','retrying') AND (j.next_run_at IS NULL OR j.next_run_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM queue_jobs q WHERE q.deployment_job_id = j.id)
      ORDER BY j.created_at LIMIT ?`
  ).bind(nowIso(nowMs), limit).all();
  let sent = 0;
  for (const { id } of results) {
    try {
      await queue.send({ jobId: id });
    } catch {
      continue;
    }
    await db.prepare("INSERT OR IGNORE INTO queue_jobs(id,queue_name,deployment_job_id,state,enqueued_at) VALUES(?,?,?,?,?)").bind(`q_${id}`, "cloudpress-jobs", id, "enqueued", nowIso(nowMs)).run();
    sent++;
  }
  return sent;
}
__name(dispatchOutbox, "dispatchOutbox");

// src/lib/workforce.ts
var RANK_LEVEL = { executive: 4, director: 3, senior: 2, junior: 1 };
var DEPTS = [
  { id: "strategy", name: "\uACBD\uC601\uC804\uB7B5\uC2E4", mission: "\uD68C\uC0AC \uBAA9\uD45C(OKR) \uC218\uB9BD\uACFC \uBD80\uC11C \uAC04 \uC6B0\uC120\uC21C\uC704 \uC870\uC728, \uC77C\uC77C \uACBD\uC601 \uBE0C\uB9AC\uD551" },
  { id: "engineering", name: "\uC81C\uD488\xB7\uAC1C\uBC1C\uD300", mission: "\uAE30\uB2A5 \uAC1C\uC120\uC548, \uAE30\uC220\uBD80\uCC44\xB7\uD14C\uC2A4\uD2B8 \uD488\uC9C8 \uAD00\uB9AC, \uBC84\uADF8 \uBD84\uC11D" },
  { id: "infra", name: "\uC778\uD504\uB77C\xB7SRE\uD300", mission: "\uC11C\uBE44\uC2A4 \uC548\uC815\uC131, \uC791\uC5C5 \uD050\xB7\uC6F9\uD6C5\xB7\uCEE8\uD14C\uC774\uB108 \uC0C1\uD0DC \uC810\uAC80\uACFC \uC7A5\uC560 \uB300\uC751\uC548" },
  { id: "security", name: "\uBCF4\uC548\uD300", mission: "\uC774\uC0C1 \uC0AC\uC6A9\xB7\uAD8C\uD55C\xB7\uBE44\uBC00\uC815\uBCF4 \uAD00\uB9AC \uC810\uAC80, \uBCF4\uC548 \uC704\uD5D8 \uD3C9\uAC00" },
  { id: "support", name: "\uACE0\uAC1D\uC9C0\uC6D0\uD300", mission: "\uACB0\uC81C \uC2E4\uD328\xB7\uBB38\uC758 \uB300\uC751\uC548 \uC791\uC131, \uACE0\uAC1D \uACBD\uD5D8 \uAC1C\uC120" },
  { id: "growth", name: "\uB9C8\uCF00\uD305\xB7\uC131\uC7A5\uD300", mission: "\uBE44\uC6A9\uC774 \uB4E4\uC9C0 \uC54A\uB294 \uCC44\uB110 \uC911\uC2EC\uC758 \uACE0\uAC1D \uD655\uBCF4 \uC2E4\uD5D8 \uC124\uACC4" },
  { id: "finance", name: "\uC7AC\uBB34\xB7\uC218\uC775\uC131\uD300", mission: "\uB9E4\uCD9C\xB7\uC6D0\uAC00\xB7\uC218\uC218\uB8CC\xB7\uAE30\uC5EC\uC774\uC775 \uBD84\uC11D, \uAC00\uACA9 \uC815\uCC45 \uC704\uD5D8 \uACBD\uACE0" },
  { id: "legal", name: "\uBC95\uBB34\xB7\uCEF4\uD50C\uB77C\uC774\uC5B8\uC2A4\uD300", mission: "\uC57D\uAD00\xB7\uAC1C\uC778\uC815\uBCF4\xB7\uACB0\uC81C/\uD074\uB77C\uC6B0\uB4DC \uC0AC\uC5C5\uC790 \uC815\uCC45 \uC900\uC218 \uC810\uAC80" },
  { id: "data", name: "\uB370\uC774\uD130\xB7\uBD84\uC11D\uD300", mission: "\uD575\uC2EC \uC9C0\uD45C \uCD94\uC138 \uBD84\uC11D\uACFC \uC774\uC0C1 \uC9D5\uD6C4 \uBCF4\uACE0" }
];
var NAMES = {
  strategy: ["\uD558\uB298", "\uBC14\uB2E4", "\uB098\uB798"],
  engineering: ["\uB3C4\uC724", "\uC11C\uC900", "\uC9C0\uD638"],
  infra: ["\uD558\uB78C", "\uC774\uB4E0", "\uC2DC\uC6B0"],
  security: ["\uC5EC\uC6B8", "\uB77C\uC628", "\uB2E4\uC628"],
  support: ["\uC0C8\uBD04", "\uC544\uB77C", "\uBCF4\uB78C"],
  growth: ["\uAC00\uC628", "\uB204\uB9AC", "\uC2AC\uAE30"],
  finance: ["\uB2E4\uC19C", "\uD55C\uACB0", "\uBBF8\uB974"],
  legal: ["\uC628\uC720", "\uD574\uB4E0", "\uC740\uC194"],
  data: ["\uBCC4\uC774", "\uC774\uB808", "\uC18C\uB2F4"]
};
var COMMON_RULES = `\uC5C5\uBB34 \uC6D0\uCE59:
1) \uB3C8\uC744 \uC4F0\uAC70\uB098, \uBC30\uD3EC\uD558\uAC70\uB098, \uAC00\uACA9\uC744 \uBC14\uAFB8\uAC70\uB098, \uACE0\uAC1D\uC5D0\uAC8C \uC5F0\uB77D\uD558\uAC70\uB098, \uACC4\uC57D\xB7\uBC95\uC801 \uC870\uCE58\uB97C \uD558\uB294 \uB4F1 "\uC2E4\uC81C \uD589\uB3D9"\uC740 \uC808\uB300 \uC9C1\uC811 \uC2E4\uD589\uD558\uC9C0 \uC54A\uB294\uB2E4. \uD544\uC694\uD558\uBA74 proposed_actions \uB85C \uC81C\uC548\uB9CC \uD55C\uB2E4(\uC6B4\uC601\uC790\uAC00 \uC2B9\uC778\uD55C\uB2E4).
2) \uC0AC\uC2E4\uC740 \uC81C\uACF5\uB41C "\uD68C\uC0AC \uC9C0\uD45C"\uC640 "\uC5C5\uBB34 \uB0B4\uC6A9"\uB9CC \uADFC\uAC70\uB85C \uD55C\uB2E4. \uADFC\uAC70\uAC00 \uC5C6\uC73C\uBA74 \uBAA8\uB978\uB2E4\uACE0 \uC4F0\uACE0 \uCD94\uCE21\uC744 \uC0AC\uC2E4\uCC98\uB7FC \uC4F0\uC9C0 \uC54A\uB294\uB2E4.
3) \uACE0\uAC1D\uC758 \uAC1C\uC778\uC815\uBCF4\xB7\uBE44\uBC00\uD0A4\xB7\uBE44\uBC00\uBC88\uD638\uB97C \uC694\uCCAD\uD558\uAC70\uB098 \uCD9C\uB825\uD558\uC9C0 \uC54A\uB294\uB2E4.
4) \uB2E4\uB978 \uBD80\uC11C\uC758 \uD611\uC758\uAC00 \uC815\uB9D0 \uD544\uC694\uD560 \uB54C\uB9CC needs_collab \uC5D0 \uBD80\uC11C ID \uB97C \uC801\uB294\uB2E4. \uD63C\uC790 \uCC98\uB9AC\uD560 \uC218 \uC788\uC73C\uBA74 \uD611\uC758\uB97C \uC694\uCCAD\uD558\uC9C0 \uC54A\uB294\uB2E4.
5) \uCD9C\uB825\uC740 \uC9C0\uC815\uD55C JSON \uD55C \uAC1C\uB9CC \uB0B8\uB2E4(\uC124\uBA85 \uBB38\uC7A5\xB7\uCF54\uB4DC\uBE14\uB85D \uAE08\uC9C0).`;
function seedAgents() {
  const out = [];
  out.push({ id: "agent-coo", dept: "strategy", name: "\uB9C8\uB8E8", title: "COO(\uCD5C\uACE0\uC6B4\uC601 AI)", rank: "executive", persona: "\uD68C\uC0AC \uC804\uCCB4 \uC6B4\uC601\uC744 \uCD1D\uAD04\uD55C\uB2E4. \uBD80\uC11C \uAC04 \uCDA9\uB3CC\uC744 \uC870\uC728\uD558\uACE0 \uCD5C\uC885 \uC6B0\uC120\uC21C\uC704\uB97C \uC815\uD55C\uB2E4. \uC6B4\uC601\uC790(\uB300\uD45C)\uC5D0\uAC8C \uACB0\uC815\uC774 \uD544\uC694\uD55C \uC0AC\uC548\uB9CC \uC62C\uB9B0\uB2E4." });
  for (const d of DEPTS) {
    const [dir, sen, jun] = NAMES[d.id];
    out.push({ id: `agent-${d.id}-dir`, dept: d.id, name: dir, title: `${d.name} \uD300\uC7A5`, rank: "director", persona: `${d.name}\uC758 \uCC45\uC784\uC790. \uD300 \uC0B0\uCD9C\uBB3C\uC744 \uAC80\uD1A0\xB7\uC2B9\uC778\uD558\uACE0 \uC704\uD5D8\uD55C \uC81C\uC548\uC744 \uAC78\uB7EC\uB0B8\uB2E4. \uB2F4\uB2F9 \uC5C5\uBB34: ${d.mission}` });
    out.push({ id: `agent-${d.id}-sen`, dept: d.id, name: sen, title: `${d.name} \uC120\uC784`, rank: "senior", persona: `${d.name} \uC120\uC784 \uB2F4\uB2F9\uC790. \uBCF5\uC7A1\uD558\uAC70\uB098 \uC6B0\uC120\uC21C\uC704\uAC00 \uB192\uC740 \uC5C5\uBB34\uB97C \uB9E1\uB294\uB2E4. \uB2F4\uB2F9 \uC5C5\uBB34: ${d.mission}` });
    out.push({ id: `agent-${d.id}-jun`, dept: d.id, name: jun, title: `${d.name} \uC0AC\uC6D0`, rank: "junior", persona: `${d.name} \uC0AC\uC6D0. \uC815\uD615 \uC5C5\uBB34\uC640 \uCD08\uC548\uC744 \uBE60\uB974\uAC8C \uB9CC\uB4E0\uB2E4. \uB2F4\uB2F9 \uC5C5\uBB34: ${d.mission}` });
  }
  return out;
}
__name(seedAgents, "seedAgents");
var PROVIDERS = [
  { name: "workers-ai-strong", kind: "workers_ai", base_url: null, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", secret: null, strong: 1, priority: 10, limit: 120, external: 0, note: "Cloudflare Workers AI(\uC0C1\uC704). \uBAA8\uB378 ID \uB294 CAS \uBAA8\uB378 \uB3D9\uAE30\uD654 \uBAA9\uB85D\uC5D0\uC11C \uD655\uC778." },
  { name: "workers-ai-fast", kind: "workers_ai", base_url: null, model: "@cf/meta/llama-3.1-8b-instruct", secret: null, strong: 0, priority: 20, limit: 400, external: 0, note: "Cloudflare Workers AI(\uACBD\uB7C9). \uBB34\uB8CC \uD558\uB8E8 10,000 Neurons \uCD08\uACFC\uBD84\uC740 \uACFC\uAE08." },
  { name: "gemini-free", kind: "openai_compat", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", secret: "GEMINI_API_KEY", strong: 1, priority: 30, limit: 150, external: 1, note: "\uC608\uC2DC(\uBB34\uB8CC \uD55C\uB3C4\xB7\uC57D\uAD00\xB7\uBAA8\uB378\uBA85 \uD655\uC778 \uD544\uC694). \uC785\uB825\uC740 \uAC1C\uC778\uC815\uBCF4 \uB9C8\uC2A4\uD0B9 \uD6C4 \uC804\uC1A1." },
  { name: "groq-free", kind: "openai_compat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", secret: "GROQ_API_KEY", strong: 1, priority: 40, limit: 150, external: 1, note: "\uC608\uC2DC(\uBB34\uB8CC \uD55C\uB3C4\xB7\uC57D\uAD00\xB7\uBAA8\uB378\uBA85 \uD655\uC778 \uD544\uC694)." },
  { name: "openrouter-free", kind: "openai_compat", base_url: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", secret: "OPENROUTER_API_KEY", strong: 0, priority: 50, limit: 100, external: 1, note: "\uC608\uC2DC(':free' \uBAA8\uB378\uC740 \uC790\uC8FC \uBC14\uB01C)." }
];
var ROUTINES = [
  { id: "r-strategy-brief", dept: "strategy", title: "\uC77C\uC77C \uACBD\uC601 \uBE0C\uB9AC\uD551", detail: "\uD68C\uC0AC \uC9C0\uD45C\uC640 \uBAA9\uD45C\uB97C \uBE44\uAD50\uD574 \uC624\uB298\uC758 \uC6B0\uC120\uC21C\uC704 3\uAC00\uC9C0\uC640 \uBD80\uC11C\uBCC4 \uC9C0\uC2DC \uC0AC\uD56D\uC744 \uC815\uB9AC\uD55C\uB2E4.", hours: 24, priority: 7 },
  { id: "r-finance-margin", dept: "finance", title: "\uC218\uC775\uC131\xB7\uC6D0\uAC00 \uC810\uAC80", detail: "\uD65C\uC131 \uAD6C\uB3C5\xB7\uC6D4 \uBC18\uBCF5 \uB9E4\uCD9C\xB7AI \uC0AC\uC6A9 \uC6D0\uAC00/\uB9E4\uCD9C\uC744 \uBC14\uD0D5\uC73C\uB85C \uB9C8\uC9C4 \uC704\uD5D8\uACFC \uAC00\uACA9 \uC815\uCC45 \uAC1C\uC120\uC548\uC744 \uC694\uC57D\uD55C\uB2E4.", hours: 24, priority: 7 },
  { id: "r-infra-health", dept: "infra", title: "\uC2DC\uC2A4\uD15C \uAC74\uAC15 \uC810\uAC80", detail: "\uC2E4\uD328\uD55C \uC791\uC5C5(dead)\xB7\uC6F9\uD6C5 \uC2E4\uD328\xB7\uB300\uAE30 \uC791\uC5C5 \uC218\uB97C \uBCF4\uACE0 \uC6D0\uC778 \uAC00\uC124\uACFC \uC870\uCE58 \uC81C\uC548\uC744 \uC791\uC131\uD55C\uB2E4.", hours: 6, priority: 6 },
  { id: "r-security-review", dept: "security", title: "\uBCF4\uC548 \uC810\uAC80", detail: "\uCC28\uB2E8\uB41C API \uD0A4\xB7\uC774\uC0C1 \uC0AC\uC6A9\xB7\uACC4\uC815 \uC815\uC9C0 \uC9C0\uD45C\uB97C \uBCF4\uACE0 \uC704\uD5D8 \uC9D5\uD6C4\uC640 \uAD8C\uACE0\uB97C \uC791\uC131\uD55C\uB2E4.", hours: 24, priority: 6, conf: 1 },
  { id: "r-support-queue", dept: "support", title: "\uACE0\uAC1D \uB300\uC751 \uB300\uAE30\uC5F4 \uC810\uAC80", detail: "\uACB0\uC81C \uC2E4\uD328\xB7\uBBF8\uD574\uACB0 \uC54C\uB9BC \uC9C0\uD45C\uB97C \uBCF4\uACE0 \uACE0\uAC1D \uC548\uB0B4 \uBB38\uC548 \uCD08\uC548(\uBC1C\uC1A1\uC740 \uC2B9\uC778 \uD544\uC694)\uC744 \uC791\uC131\uD55C\uB2E4.", hours: 12, priority: 5, conf: 1 },
  { id: "r-growth-ideas", dept: "growth", title: "\uBB34\uB8CC \uCC44\uB110 \uC131\uC7A5 \uC2E4\uD5D8 \uC81C\uC548", detail: "\uBE44\uC6A9 0\uC6D0\uC73C\uB85C \uAC00\uB2A5\uD55C \uACE0\uAC1D \uD655\uBCF4 \uC2E4\uD5D8 3\uAC00\uC9C0\uB97C \uAC00\uC124\xB7\uCE21\uC815\uC9C0\uD45C\uC640 \uD568\uAED8 \uC81C\uC548\uD55C\uB2E4.", hours: 48, priority: 4 },
  { id: "r-legal-check", dept: "legal", title: "\uC815\uCC45 \uC900\uC218 \uC810\uAC80 \uBAA9\uB85D", detail: "\uAC1C\uC778\uC815\uBCF4\xB7\uACB0\uC81C(PayPal)\xB7\uD074\uB77C\uC6B0\uB4DC(Cloudflare) \uC815\uCC45 \uAD00\uC810\uC5D0\uC11C \uC774\uBC88 \uC8FC \uD655\uC778\uD574\uC57C \uD560 \uD56D\uBAA9\uC744 \uC815\uB9AC\uD55C\uB2E4(\uBC95\uB960 \uC790\uBB38\uC774 \uC544\uB2D8\uC744 \uBA85\uC2DC).", hours: 168, priority: 4 },
  { id: "r-data-trends", dept: "data", title: "\uD575\uC2EC \uC9C0\uD45C \uCD94\uC138 \uBCF4\uACE0", detail: "\uAC00\uC785\xB7\uAD6C\uB3C5\xB7\uB9E4\uCD9C\xB7AI \uC0AC\uC6A9 \uC9C0\uD45C\uC758 \uBCC0\uD654\uC640 \uC774\uC0C1 \uC9D5\uD6C4\uB97C \uC694\uC57D\uD55C\uB2E4.", hours: 24, priority: 5 },
  { id: "r-eng-backlog", dept: "engineering", title: "\uAC1C\uBC1C \uBC31\uB85C\uADF8 \uC815\uB9AC \uC81C\uC548", detail: "\uC54C\uB824\uC9C4 \uD55C\uACC4(\uCEE8\uD14C\uC774\uB108 \uB9E4\uB2C8\uC800 \uBBF8\uC5F0\uACB0, \uC81C\uD734 \uC815\uC0B0 \uBBF8\uAD6C\uD604 \uB4F1)\uB97C \uAE30\uC900\uC73C\uB85C \uB2E4\uC74C \uAC1C\uBC1C \uC6B0\uC120\uC21C\uC704\uB97C \uC81C\uC548\uD55C\uB2E4.", hours: 72, priority: 4 }
];
async function seedWorkforce(db, nowMs) {
  const st = [];
  for (const d of DEPTS) st.push(db.prepare("INSERT OR IGNORE INTO ai_departments(id,name_ko,mission,sort) VALUES(?,?,?,?)").bind(d.id, d.name, d.mission, DEPTS.indexOf(d)));
  for (const a of seedAgents()) st.push(db.prepare("INSERT OR IGNORE INTO ai_agents(id,department_id,name,title,rank,persona) VALUES(?,?,?,?,?,?)").bind(a.id, a.dept, a.name, a.title, a.rank, a.persona));
  for (const p of PROVIDERS) st.push(db.prepare("INSERT OR IGNORE INTO ai_providers(name,kind,base_url,model,secret_name,strong,priority,daily_limit,external,enabled,note) VALUES(?,?,?,?,?,?,?,?,?,0,?)").bind(p.name, p.kind, p.base_url, p.model, p.secret, p.strong, p.priority, p.limit, p.external, p.note));
  for (const r of ROUTINES) st.push(db.prepare("INSERT OR IGNORE INTO ai_routines(id,department_id,title,detail,interval_hours,priority,confidential) VALUES(?,?,?,?,?,?,?)").bind(r.id, r.dept, r.title, r.detail, r.hours, r.priority, r.conf ?? 0));
  st.push(db.prepare("INSERT OR IGNORE INTO company_goals(id,title,metric,target,status,created_at) VALUES('g-subs','\uD65C\uC131 \uAD6C\uB3C5 10\uAC1C \uB2EC\uC131','active_subscriptions',10,'active',?)").bind(nowIso(nowMs)));
  st.push(db.prepare("INSERT OR IGNORE INTO company_goals(id,title,metric,target,status,created_at) VALUES('g-mrr','\uC6D4 \uBC18\uBCF5 \uB9E4\uCD9C $200 \uB2EC\uC131','mrr_usd',200,'active',?)").bind(nowIso(nowMs)));
  await db.batch(st);
}
__name(seedWorkforce, "seedWorkforce");
function scrub(text) {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[\uC774\uBA54\uC77C]").replace(/\bcpai_[A-Za-z0-9_-]+/g, "[API\uD0A4]").replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [\uD1A0\uD070]").replace(/(?<![\d-])\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?![\d-])|\b\d{13,19}\b/g, "[\uBC88\uD638]").replace(/\+?\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{4}\b/g, "[\uC804\uD654]").replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[\uBE44\uBC00\uAC12]");
}
__name(scrub, "scrub");
var hostOk = /* @__PURE__ */ __name((u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(x.hostname) && x.hostname.includes(".");
  } catch {
    return false;
  }
}, "hostOk");
function openAiCompat(baseUrl, model, apiKey, f = fetch) {
  if (!hostOk(baseUrl)) throw new Error("base_url \uC740 \uACF5\uAC1C https \uC8FC\uC18C\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  return {
    async complete(system, user, o) {
      const res = await f(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: o?.maxTokens ?? 1200, temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: user }] })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("empty_response");
      return { text, inputTokens: j?.usage?.prompt_tokens ?? Math.ceil((system.length + user.length) / 4), outputTokens: j?.usage?.completion_tokens ?? Math.ceil(text.length / 4) };
    }
  };
}
__name(openAiCompat, "openAiCompat");
function workersAi(ai, model) {
  return {
    async complete(system, user, o) {
      const r = await ai.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: o?.maxTokens ?? 1200 });
      const text = typeof r?.response === "string" ? r.response : typeof r?.result?.response === "string" ? r.result.response : null;
      if (text === null) throw new Error("empty_response");
      return { text, inputTokens: r?.usage?.prompt_tokens ?? Math.ceil((system.length + user.length) / 4), outputTokens: r?.usage?.completion_tokens ?? Math.ceil(text.length / 4) };
    }
  };
}
__name(workersAi, "workersAi");
async function setting(db, key) {
  return (await db.prepare("SELECT value_json v FROM admin_settings WHERE key = ?").bind(key).first())?.v ?? null;
}
__name(setting, "setting");
async function setSetting(db, actor, key, value, nowMs) {
  await db.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(key, value, actor, nowIso(nowMs)).run();
}
__name(setSetting, "setSetting");
async function loadSettings(db) {
  const n = /* @__PURE__ */ __name(async (k, d, lo, hi) => {
    const v = Number(await setting(db, k));
    return Number.isFinite(v) && v >= lo && v <= hi && await setting(db, k) !== null ? Math.floor(v) : d;
  }, "n");
  return {
    enabled: await setting(db, "workforce_enabled") === "true",
    paused: await setting(db, "workforce_paused") === "true",
    maxTasksPerTick: await n("workforce_max_tasks_per_tick", 3, 1, 20),
    tickMinutes: await n("workforce_tick_minutes", 30, 5, 1440),
    dailyRunCap: await n("workforce_daily_run_cap", 300, 10, 5e3)
  };
}
__name(loadSettings, "loadSettings");
async function gatherMetrics(db, nowMs) {
  const c = /* @__PURE__ */ __name(async (sql, ...b) => (await db.prepare(sql).bind(...b).first())?.n ?? 0, "c");
  const since = nowIso(nowMs - 30 * 864e5);
  const byKind = await db.prepare("SELECT p.kind k, COUNT(*) n FROM subscriptions s JOIN products p ON p.id = s.product_id WHERE s.status = 'active' GROUP BY p.kind").all();
  const mrr = (await db.prepare("SELECT COALESCE(SUM(pr.monthly_micro * s.quantity),0) AS n FROM subscriptions s JOIN prices pr ON pr.id = s.price_version_id WHERE s.status = 'active'").first())?.n ?? 0;
  const rev = await db.prepare("SELECT COALESCE(SUM(billed_micro),0) r, COALESCE(SUM(cost_micro),0) c FROM ai_usage_records WHERE ts >= ?").bind(since).first() ?? { r: 0, c: 0 };
  return {
    users: await c("SELECT COUNT(*) n FROM users WHERE status != 'deleted'"),
    activeSubscriptions: await c("SELECT COUNT(*) n FROM subscriptions WHERE status = 'active'"),
    subscriptionsByKind: Object.fromEntries(byKind.results.map((r) => [r.k, r.n])),
    mrrUsd: Math.round(mrr / 1e4) / 100,
    pastDueSubscriptions: await c("SELECT COUNT(*) n FROM subscriptions WHERE status = 'past_due'"),
    deadJobs: await c("SELECT COUNT(*) n FROM deployment_jobs WHERE state = 'dead'"),
    failedWebhooks: await c("SELECT COUNT(*) n FROM webhook_events WHERE status = 'failed'"),
    unreadOperatorAlerts: await c("SELECT COUNT(*) n FROM notifications WHERE audience = 'operator' AND read_at IS NULL"),
    aiRevenueUsd30d: Math.round(rev.r / 1e4) / 100,
    aiCostUsd30d: Math.round(rev.c / 1e4) / 100,
    aiMarginPct: rev.r > 0 ? Math.round((rev.r - rev.c) / rev.r * 1e3) / 10 : null,
    pendingApprovals: await c("SELECT COUNT(*) n FROM ai_approvals WHERE status = 'pending'")
  };
}
__name(gatherMetrics, "gatherMetrics");
var log = /* @__PURE__ */ __name((db, nowMs, kind, message, agentId, taskId) => db.prepare("INSERT INTO ai_activity(id,ts,kind,agent_id,task_id,message) VALUES(?,?,?,?,?,?)").bind(newId("act"), nowIso(nowMs), kind, agentId ?? null, taskId ?? null, message.slice(0, 500)).run(), "log");
function parseLoose(text) {
  const s = text.indexOf("{");
  if (s >= 0) {
    for (let e = text.lastIndexOf("}"); e > s; e = text.lastIndexOf("}", e - 1)) {
      try {
        const v = JSON.parse(text.slice(s, e + 1));
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
      } catch {
      }
    }
  }
  return { summary: text.trim().slice(0, 300), deliverable: text.trim(), _unstructured: true };
}
__name(parseLoose, "parseLoose");
async function runsToday(db, nowMs, provider) {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  const r = provider ? await db.prepare("SELECT COUNT(*) n FROM ai_runs WHERE ts >= ? AND provider = ?").bind(nowIso(d.getTime()), provider).first() : await db.prepare("SELECT COUNT(*) n FROM ai_runs WHERE ts >= ?").bind(nowIso(d.getTime())).first();
  return r?.n ?? 0;
}
__name(runsToday, "runsToday");
async function callLlm(x, agent, phase, task, system, user, meetingId) {
  if (await runsToday(x.db, x.nowMs) >= x.settings.dailyRunCap) throw new Error("daily_run_cap");
  const { results } = await x.db.prepare("SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY priority").all();
  const strongWanted = RANK_LEVEL[agent.rank] >= RANK_LEVEL.director;
  const cands = results.filter((p) => !(task.confidential && p.external)).sort((a, b) => (a.name === agent.provider_pref ? -1 : 0) - (b.name === agent.provider_pref ? -1 : 0) || (strongWanted ? b.strong - a.strong : a.strong - b.strong) || a.priority - b.priority);
  const errs = [];
  for (const p of cands) {
    if (await runsToday(x.db, x.nowMs, p.name) >= p.daily_limit) {
      errs.push(`${p.name}: \uC77C\uC77C \uD55C\uB3C4`);
      continue;
    }
    let llm = null;
    try {
      llm = x.factory(p);
    } catch (e) {
      errs.push(`${p.name}: \uC124\uC815 \uC624\uB958`);
      continue;
    }
    if (!llm) {
      errs.push(`${p.name}: \uBBF8\uC124\uC815`);
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await llm.complete(p.external ? scrub(system) : system, p.external ? scrub(user) : user);
      await x.db.prepare("INSERT INTO ai_runs(id,task_id,meeting_id,agent_id,phase,provider,ok,input_tokens,output_tokens,latency_ms,ts) VALUES(?,?,?,?,?,?,1,?,?,?,?)").bind(newId("run"), task.id ?? null, meetingId ?? null, agent.id, phase, p.name, r.inputTokens, r.outputTokens, Date.now() - t0, nowIso(x.nowMs)).run();
      return r.text;
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      errs.push(`${p.name}: ${m}`);
      await x.db.prepare("INSERT INTO ai_runs(id,task_id,meeting_id,agent_id,phase,provider,ok,latency_ms,error,ts) VALUES(?,?,?,?,?,?,0,?,?,?)").bind(newId("run"), task.id ?? null, meetingId ?? null, agent.id, phase, p.name, Date.now() - t0, m, nowIso(x.nowMs)).run();
    }
  }
  throw new Error(`\uC0AC\uC6A9 \uAC00\uB2A5\uD55C AI \uACF5\uAE09\uC790\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4(${errs.join("; ") || "\uD65C\uC131 \uACF5\uAE09\uC790 \uC5C6\uC74C"})`);
}
__name(callLlm, "callLlm");
var sysFor = /* @__PURE__ */ __name((a, deptName) => `\uB2F9\uC2E0\uC740 CloudPress(\uD074\uB77C\uC6B0\uB4DC \uD638\uC2A4\uD305 SaaS)\uC758 ${deptName} \uC18C\uC18D ${a.title} "${a.name}"(AI)\uC785\uB2C8\uB2E4.
${a.persona}

${COMMON_RULES}`, "sysFor");
async function pickAgent(db, deptId, priority) {
  const want = priority >= 8 ? ["senior", "director"] : ["junior", "senior", "director"];
  for (const r of want) {
    const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = ? AND status != 'paused' ORDER BY (status='idle') DESC, tasks_done ASC LIMIT 1").bind(deptId, r).first();
    if (a) return a;
  }
  return null;
}
__name(pickAgent, "pickAgent");
async function pickReviewer(db, author) {
  const higher = Object.keys(RANK_LEVEL).filter((r) => RANK_LEVEL[r] > RANK_LEVEL[author.rank]).sort((a, b) => RANK_LEVEL[a] - RANK_LEVEL[b]);
  for (const r of higher) {
    const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = ? AND status != 'paused' LIMIT 1").bind(r === "executive" ? "strategy" : author.department_id, r).first();
    if (a) return a;
  }
  return null;
}
__name(pickReviewer, "pickReviewer");
var setStatus = /* @__PURE__ */ __name((db, id, status, nowMs) => db.prepare("UPDATE ai_agents SET status = ?, last_active_at = ? WHERE id = ?").bind(status, nowIso(nowMs), id).run(), "setStatus");
var KINDS = /* @__PURE__ */ new Set(["spend", "deploy", "pricing", "customer_contact", "legal", "escalation", "other"]);
var RISKS = /* @__PURE__ */ new Set(["low", "medium", "high"]);
var trunc = /* @__PURE__ */ __name((v, n) => String(v ?? "").slice(0, n), "trunc");
async function runTick(db, factory, nowMs, o = {}) {
  const rep = { tasksProcessed: 0, meetings: 0, approvalsCreated: 0, errors: [], routinesCreated: 0 };
  const settings = await loadSettings(db);
  if (settings.paused) return { ...rep, skipped: "paused" };
  if (!settings.enabled && !o.force) return { ...rep, skipped: "disabled" };
  if (!o.force) {
    const last = Number(await setting(db, "workforce_last_tick")) || 0;
    if (nowMs - last < settings.tickMinutes * 6e4) return { ...rep, skipped: "not_due" };
  }
  await setSetting(db, "system", "workforce_last_tick", String(nowMs), nowMs);
  rep.routinesCreated = await createRoutineTasks(db, nowMs);
  const { results } = await db.prepare("SELECT * FROM ai_tasks WHERE status = 'queued' AND assignee_human = 0 ORDER BY priority DESC, created_at LIMIT ?").bind(settings.maxTasksPerTick).all();
  const x = { db, factory, nowMs, settings };
  for (const t of results) {
    try {
      const r = await processTask(x, t);
      rep.tasksProcessed++;
      rep.meetings += r.meeting ? 1 : 0;
      rep.approvalsCreated += r.approvals;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      rep.errors.push(`${t.title}: ${m}`);
      const transient = /AI 공급자|daily_run_cap/.test(m);
      await db.prepare("UPDATE ai_tasks SET status = ?, updated_at = ? WHERE id = ?").bind(transient ? "queued" : "blocked", nowIso(nowMs), t.id).run();
      if (t.assignee_agent_id) await setStatus(db, t.assignee_agent_id, "idle", nowMs);
      await log(db, nowMs, "error", `\uC5C5\uBB34 "${t.title}" \uCC98\uB9AC \uC2E4\uD328: ${m}`, t.assignee_agent_id, t.id);
      if (transient) break;
    }
  }
  return rep;
}
__name(runTick, "runTick");
async function createRoutineTasks(db, nowMs) {
  const { results } = await db.prepare("SELECT * FROM ai_routines WHERE enabled = 1").all();
  let n = 0;
  for (const r of results) {
    if (r.last_run_at && nowMs - Date.parse(r.last_run_at) < r.interval_hours * 36e5) continue;
    const ins = await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'routine',?,'routine',?,?)").bind(newId("task"), r.department_id, r.title, r.detail, r.priority, r.confidential, `routine:${r.id}:${Math.floor(nowMs / (r.interval_hours * 36e5))}`, nowIso(nowMs), nowIso(nowMs)).run();
    await db.prepare("UPDATE ai_routines SET last_run_at = ? WHERE id = ?").bind(nowIso(nowMs), r.id).run();
    n += ins.meta.changes;
  }
  return n;
}
__name(createRoutineTasks, "createRoutineTasks");
async function processTask(x, t) {
  const { db, nowMs } = x;
  const dept = await db.prepare("SELECT name_ko FROM ai_departments WHERE id = ?").bind(t.department_id).first();
  const agent = t.assignee_agent_id ? await db.prepare("SELECT * FROM ai_agents WHERE id = ?").bind(t.assignee_agent_id).first() : await pickAgent(db, t.department_id, t.priority);
  if (!agent || !dept) throw new Error("\uB2F4\uB2F9\uC790\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
  await db.prepare("UPDATE ai_tasks SET status='in_progress', assignee_agent_id=?, updated_at=? WHERE id=?").bind(agent.id, nowIso(nowMs), t.id).run();
  await setStatus(db, agent.id, "working", nowMs);
  await log(db, nowMs, "task_start", `${agent.title} ${agent.name}: "${t.title}" \uC2DC\uC791`, agent.id, t.id);
  const metrics = await gatherMetrics(db, nowMs);
  const goals = (await db.prepare("SELECT title, metric, target FROM company_goals WHERE status = 'active'").all()).results;
  const ctxText = `[\uD68C\uC0AC \uC9C0\uD45C]
${JSON.stringify(metrics)}
[\uD65C\uC131 \uBAA9\uD45C]
${JSON.stringify(goals)}`;
  const schema = `{"summary":"\uD55C \uC904 \uC694\uC57D","deliverable":"\uACB0\uACFC\uBB3C \uBCF8\uBB38","needs_collab":["\uBD80\uC11CID"...](\uC120\uD0DD),"proposed_actions":[{"kind":"spend|deploy|pricing|customer_contact|legal|other","title":"","detail":"","risk":"low|medium|high"}](\uC120\uD0DD),"follow_up_tasks":[{"department":"\uBD80\uC11CID","title":"","detail":"","priority":1-9}](\uC120\uD0DD),"needs_human":true|false(\uC120\uD0DD)}`;
  let feedback = "";
  let out = {};
  for (let attempt = 0; attempt <= 2; attempt++) {
    const text = await callLlm(
      x,
      agent,
      "work",
      { id: t.id, confidential: !!t.confidential },
      sysFor(agent, dept.name_ko),
      `${ctxText}

[\uC5C5\uBB34]
\uC81C\uBAA9: ${t.title}
\uB0B4\uC6A9: ${t.detail ?? ""}${feedback ? `

[\uAC80\uD1A0\uC790 \uD53C\uB4DC\uBC31 \u2014 \uBC18\uC601\uD574\uC11C \uB2E4\uC2DC \uC791\uC131]
${feedback}` : ""}

\uB2E4\uC74C JSON \uD615\uC2DD\uC73C\uB85C\uB9CC \uB2F5\uD558\uC138\uC694:
${schema}`
    );
    out = parseLoose(text);
    const collab = Array.isArray(out.needs_collab) ? out.needs_collab.filter((d) => typeof d === "string" && d !== t.department_id).slice(0, 3) : [];
    if (collab.length && attempt === 0 && t.depth < 2) {
      const ok = await holdMeeting(x, t, agent, dept.name_ko, collab, ctxText);
      if (ok) {
        await setStatus(db, agent.id, "idle", nowMs);
        return { meeting: true, approvals: 0 };
      }
    }
    const reviewer = await pickReviewer(db, agent);
    if (!reviewer) break;
    await db.prepare("UPDATE ai_tasks SET status='in_review', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
    await setStatus(db, reviewer.id, "reviewing", nowMs);
    let verdict;
    try {
      const rtxt = await callLlm(
        x,
        reviewer,
        "review",
        { id: t.id, confidential: !!t.confidential },
        sysFor(reviewer, dept.name_ko),
        `[\uC5C5\uBB34]
${t.title}
${t.detail ?? ""}

[\uB2F4\uB2F9\uC790(${agent.title} ${agent.name}) \uC0B0\uCD9C\uBB3C]
${trunc(out.deliverable ?? out.summary, 3500)}

\uC0AC\uC2E4 \uADFC\uAC70(\uD68C\uC0AC \uC9C0\uD45C)\uC5D0 \uC5B4\uAE0B\uB098\uAC70\uB098 \uC704\uD5D8\uD55C \uC2E4\uC81C \uD589\uB3D9\uC774 \uC9C1\uC811 \uC2E4\uD589\uB418\uB3C4\uB85D \uC4F0\uC600\uB294\uC9C0 \uAC80\uD1A0\uD558\uC138\uC694. \uC774 JSON \uC73C\uB85C\uB9CC \uB2F5\uD558\uC138\uC694: {"verdict":"approve|revise","feedback":"\uC218\uC815 \uC694\uCCAD \uC0AC\uD56D"}
${ctxText}`
      );
      verdict = parseLoose(rtxt);
    } finally {
      await setStatus(db, reviewer.id, "idle", nowMs);
    }
    const approve = String(verdict.verdict ?? "approve").toLowerCase() !== "revise";
    await log(db, nowMs, "review", `${reviewer.title} ${reviewer.name}: "${t.title}" ${approve ? "\uC2B9\uC778" : "\uC218\uC815 \uC694\uCCAD"}`, reviewer.id, t.id);
    if (approve) break;
    feedback = trunc(verdict.feedback, 800);
    await db.prepare("UPDATE ai_tasks SET revisions = revisions + 1, status='in_progress', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
    await log(db, nowMs, "revise", `"${t.title}" \uC218\uC815 ${attempt + 1}\uD68C\uCC28`, agent.id, t.id);
    if (attempt === 2) {
      await db.prepare("UPDATE ai_tasks SET status='needs_human', result_summary=?, result_json=?, updated_at=? WHERE id=?").bind(trunc(out.summary, 300), JSON.stringify(out).slice(0, 2e4), nowIso(nowMs), t.id).run();
      await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,'escalation',?,?,'medium',?)").bind(newId("apr"), t.id, agent.id, `\uAC80\uD1A0 \uBC18\uBCF5 \uC2E4\uD328: ${t.title}`, `\uC218\uC815 \uC694\uCCAD\uC774 2\uD68C \uBC18\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uB9C8\uC9C0\uB9C9 \uD53C\uB4DC\uBC31: ${feedback}`, nowIso(nowMs)).run();
      await log(db, nowMs, "escalate", `"${t.title}" \uC6B4\uC601\uC790 \uD655\uC778 \uD544\uC694(\uAC80\uD1A0 2\uD68C \uBD88\uD1B5\uACFC)`, agent.id, t.id);
      await setStatus(db, agent.id, "idle", nowMs);
      return { meeting: false, approvals: 1 };
    }
  }
  let approvals = 0;
  const actions = Array.isArray(out.proposed_actions) ? out.proposed_actions.slice(0, 5) : [];
  for (const a of actions) {
    if (!a || typeof a.title !== "string") continue;
    await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(newId("apr"), t.id, agent.id, KINDS.has(a.kind) ? a.kind : "other", trunc(a.title, 200), trunc(a.detail, 1500), RISKS.has(a.risk) ? a.risk : "high", nowIso(nowMs)).run();
    approvals++;
  }
  const follow = Array.isArray(out.follow_up_tasks) ? out.follow_up_tasks.slice(0, 3) : [];
  for (const f of follow) {
    if (!f || typeof f.title !== "string" || t.depth >= 2) continue;
    const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(f.department).first();
    if (!dep) continue;
    await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,parent_id,depth,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'follow_up',?,?,?,?)").bind(newId("task"), f.department, trunc(f.title, 200), trunc(f.detail, 1500), Math.min(Math.max(Number(f.priority) || 5, 1), 9), t.confidential, t.id, t.depth + 1, `follow:${t.id}:${trunc(f.title, 60)}`, agent.id, nowIso(nowMs), nowIso(nowMs)).run();
  }
  const human = out.needs_human === true;
  await db.prepare("UPDATE ai_tasks SET status=?, result_summary=?, result_json=?, completed_at=?, updated_at=? WHERE id=?").bind(human ? "needs_human" : "done", trunc(out.summary, 300), JSON.stringify(out).slice(0, 2e4), nowIso(nowMs), nowIso(nowMs), t.id).run();
  await db.prepare("UPDATE ai_agents SET tasks_done = tasks_done + 1 WHERE id = ?").bind(agent.id).run();
  await setStatus(db, agent.id, "idle", nowMs);
  await log(db, nowMs, "task_done", `${agent.name}: "${t.title}" \uC644\uB8CC \u2014 ${trunc(out.summary, 120)}`, agent.id, t.id);
  if (approvals) await log(db, nowMs, "approval", `"${t.title}" \uC5D0\uC11C \uC2B9\uC778 \uC694\uCCAD ${approvals}\uAC74 \uC0DD\uC131`, agent.id, t.id);
  return { meeting: false, approvals };
}
__name(processTask, "processTask");
async function holdMeeting(x, t, requester, deptName, depts, ctxText) {
  const { db, nowMs } = x;
  const people = [];
  for (const d of depts) {
    const a = await db.prepare("SELECT * FROM ai_agents WHERE department_id = ? AND rank = 'director' AND status != 'paused' LIMIT 1").bind(d).first();
    if (a) people.push(a);
  }
  if (!people.length) return false;
  const chair = [requester, ...people].sort((a, b) => RANK_LEVEL[b.rank] - RANK_LEVEL[a.rank])[0];
  const mid = newId("mtg");
  await db.prepare("INSERT INTO ai_meetings(id,task_id,topic,chair_agent_id,created_at) VALUES(?,?,?,?,?)").bind(mid, t.id, t.title, chair.id, nowIso(nowMs)).run();
  await db.prepare("UPDATE ai_tasks SET status='in_progress', updated_at=? WHERE id=?").bind(nowIso(nowMs), t.id).run();
  await log(db, nowMs, "meeting", `\uD68C\uC758 \uC18C\uC9D1: "${t.title}" (${[requester, ...people].map((p) => p.name).join(", ")})`, chair.id, t.id);
  const said = [];
  try {
    for (const p of [requester, ...people]) {
      await setStatus(db, p.id, "meeting", nowMs);
      const dn = (await db.prepare("SELECT name_ko FROM ai_departments WHERE id = ?").bind(p.department_id).first())?.name_ko ?? deptName;
      const body = await callLlm(
        x,
        p,
        "meeting",
        { id: t.id, confidential: !!t.confidential },
        sysFor(p, dn),
        `[\uD68C\uC758 \uC548\uAC74]
${t.title}
${t.detail ?? ""}
[\uC9C0\uAE08\uAE4C\uC9C0 \uBC1C\uC5B8]
${said.join("\n") || "(\uC5C6\uC74C)"}

\uB2F9\uC2E0 \uBD80\uC11C \uAD00\uC810\uC758 \uC758\uACAC\xB7\uC704\uD5D8\xB7\uD544\uC694\uD55C \uC870\uAC74\uC744 5\uBB38\uC7A5 \uC774\uB0B4 \uC77C\uBC18 \uD14D\uC2A4\uD2B8\uB85C \uB9D0\uD558\uC138\uC694.
${ctxText}`,
        mid
      );
      const line = `${p.name}(${dn}): ${trunc(body, 800)}`;
      said.push(line);
      await db.prepare("INSERT INTO ai_meeting_messages(id,meeting_id,agent_id,body,ts) VALUES(?,?,?,?,?)").bind(newId("msg"), mid, p.id, trunc(body, 2e3), nowIso(nowMs)).run();
    }
    const sum = await callLlm(
      x,
      chair,
      "summary",
      { id: t.id, confidential: !!t.confidential },
      sysFor(chair, deptName),
      `[\uD68C\uC758 \uC548\uAC74]
${t.title}
[\uBC1C\uC5B8 \uAE30\uB85D]
${said.join("\n")}

\uACB0\uB860\uC744 \uC774 JSON \uC73C\uB85C\uB9CC \uC815\uB9AC\uD558\uC138\uC694: {"decision":"\uACB0\uC815 \uB0B4\uC6A9","follow_up_tasks":[{"department":"\uBD80\uC11CID","title":"","detail":"","priority":1-9}],"proposed_actions":[{"kind":"","title":"","detail":"","risk":"low|medium|high"}]}`,
      mid
    );
    const dec = parseLoose(sum);
    await db.prepare("UPDATE ai_meetings SET status='done', decision=?, closed_at=? WHERE id=?").bind(trunc(dec.decision ?? dec.summary, 2e3), nowIso(nowMs), mid).run();
    let appr = 0;
    for (const a of Array.isArray(dec.proposed_actions) ? dec.proposed_actions.slice(0, 5) : []) {
      if (!a || typeof a.title !== "string") continue;
      await db.prepare("INSERT INTO ai_approvals(id,task_id,agent_id,kind,title,detail,risk,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(newId("apr"), t.id, chair.id, KINDS.has(a.kind) ? a.kind : "other", trunc(a.title, 200), trunc(a.detail, 1500), RISKS.has(a.risk) ? a.risk : "high", nowIso(nowMs)).run();
      appr++;
    }
    for (const f of Array.isArray(dec.follow_up_tasks) ? dec.follow_up_tasks.slice(0, 4) : []) {
      if (!f || typeof f.title !== "string") continue;
      const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(f.department).first();
      if (!dep) continue;
      await db.prepare("INSERT OR IGNORE INTO ai_tasks(id,department_id,title,detail,priority,confidential,parent_id,depth,source,idempotency_key,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'meeting',?,?,?,?)").bind(newId("task"), f.department, trunc(f.title, 200), trunc(f.detail, 1500), Math.min(Math.max(Number(f.priority) || 5, 1), 9), t.confidential, t.id, t.depth + 1, `meet:${mid}:${trunc(f.title, 60)}`, chair.id, nowIso(nowMs), nowIso(nowMs)).run();
    }
    await db.prepare("UPDATE ai_tasks SET status='done', result_summary=?, result_json=?, completed_at=?, updated_at=? WHERE id=?").bind(`\uD68C\uC758 \uACB0\uB860: ${trunc(dec.decision ?? dec.summary, 250)}`, JSON.stringify({ meetingId: mid, decision: dec.decision }), nowIso(nowMs), nowIso(nowMs), t.id).run();
    await log(db, nowMs, "meeting", `\uD68C\uC758 \uC885\uB8CC: "${t.title}" \u2014 ${trunc(dec.decision ?? dec.summary, 120)}`, chair.id, t.id);
    return true;
  } catch (e) {
    await db.prepare("UPDATE ai_meetings SET status='failed', closed_at=? WHERE id=?").bind(nowIso(nowMs), mid).run();
    throw e;
  } finally {
    for (const p of [requester, ...people]) await setStatus(db, p.id, "idle", nowMs);
  }
}
__name(holdMeeting, "holdMeeting");
async function createTask(db, actor, p, nowMs) {
  const title = (p.title ?? "").trim();
  if (!title || title.length > 200) throw new ServiceError("bad_title", "\uC81C\uBAA9\uC740 1~200\uC790\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
  const dep = await db.prepare("SELECT id FROM ai_departments WHERE id = ?").bind(p.department).first();
  if (!dep) throw new ServiceError("bad_department", "\uC5C6\uB294 \uBD80\uC11C\uC785\uB2C8\uB2E4.");
  const id = newId("task");
  await db.prepare("INSERT INTO ai_tasks(id,department_id,title,detail,priority,confidential,assignee_human,status,source,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'operator',?,?,?)").bind(id, p.department, title, (p.detail ?? "").slice(0, 3e3), Math.min(Math.max(Math.floor(p.priority ?? 5), 1), 9), p.confidential ? 1 : 0, p.human ? 1 : 0, p.human ? "needs_human" : "queued", actor, nowIso(nowMs), nowIso(nowMs)).run();
  await audit(db, { actorId: actor, action: "company.task_create", targetType: "ai_task", targetId: id }, nowMs);
  return id;
}
__name(createTask, "createTask");
async function decideApproval(db, actor, id, approve, note, nowMs) {
  const a = await db.prepare("SELECT id, task_id, kind, title, detail, status FROM ai_approvals WHERE id = ?").bind(id).first();
  if (!a) throw new ServiceError("not_found", "\uC2B9\uC778 \uC694\uCCAD\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
  if (a.status !== "pending") throw new ServiceError("bad_state", "\uC774\uBBF8 \uCC98\uB9AC\uB41C \uC694\uCCAD\uC785\uB2C8\uB2E4.");
  await db.prepare("UPDATE ai_approvals SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?").bind(approve ? "approved" : "rejected", actor, nowIso(nowMs), note.slice(0, 500), id).run();
  if (approve && a.kind !== "escalation") {
    await db.prepare("INSERT INTO ai_tasks(id,department_id,title,detail,priority,assignee_human,status,parent_id,source,created_by,created_at,updated_at) VALUES(?,?,?,?,7,1,'needs_human',?,'follow_up',?,?,?)").bind(newId("task"), (a.task_id ? (await db.prepare("SELECT department_id d FROM ai_tasks WHERE id = ?").bind(a.task_id).first())?.d : null) ?? "strategy", `\uC2B9\uC778\uB41C \uC870\uCE58 \uC2E4\uD589: ${a.title}`.slice(0, 200), a.detail ?? "", a.task_id, actor, nowIso(nowMs), nowIso(nowMs)).run();
  }
  await log(db, nowMs, "approval", `\uC6B4\uC601\uC790\uAC00 "${a.title}" ${approve ? "\uC2B9\uC778" : "\uBC18\uB824"}${note ? ` \u2014 ${note.slice(0, 80)}` : ""}`);
  await audit(db, { actorId: actor, action: approve ? "company.approve" : "company.reject", targetType: "ai_approval", targetId: id, detail: { title: a.title } }, nowMs);
}
__name(decideApproval, "decideApproval");
async function completeHumanTask(db, actor, id, nowMs) {
  const r = await db.prepare("UPDATE ai_tasks SET status='done', completed_at=?, updated_at=? WHERE id=? AND status='needs_human'").bind(nowIso(nowMs), nowIso(nowMs), id).run();
  if (r.meta.changes === 0) throw new ServiceError("not_found", "\uC644\uB8CC\uD560 \uC218 \uC788\uB294 \uC5C5\uBB34\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  await log(db, nowMs, "task_done", `\uC6B4\uC601\uC790\uAC00 \uC5C5\uBB34 \uC644\uB8CC \uCC98\uB9AC: ${id}`);
}
__name(completeHumanTask, "completeHumanTask");
async function companyOverview(db, nowMs) {
  const q = /* @__PURE__ */ __name(async (sql, ...b) => (await db.prepare(sql).bind(...b).all()).results, "q");
  const settings = await loadSettings(db);
  const departments = await q("SELECT * FROM ai_departments ORDER BY sort");
  const agents = await q("SELECT id, department_id, name, title, rank, status, tasks_done, last_active_at FROM ai_agents ORDER BY department_id, CASE rank WHEN 'executive' THEN 0 WHEN 'director' THEN 1 WHEN 'senior' THEN 2 ELSE 3 END");
  const counts = await q("SELECT department_id d, status s, COUNT(*) n FROM ai_tasks GROUP BY department_id, status");
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  const metrics = await gatherMetrics(db, nowMs);
  const goals = (await q("SELECT id, title, metric, target, status FROM company_goals ORDER BY created_at")).map((g) => {
    const cur = g.metric === "active_subscriptions" ? metrics.activeSubscriptions : g.metric === "mrr_usd" ? metrics.mrrUsd : g.metric === "ai_margin_pct" ? metrics.aiMarginPct : null;
    return { ...g, current: cur, progressPct: cur === null ? null : Math.min(100, Math.round(cur / g.target * 100)) };
  });
  return {
    settings,
    metrics,
    goals,
    totals: { agents: agents.length, working: agents.filter((a) => a.status !== "idle" && a.status !== "paused").length, runsToday: await runsToday(db, nowMs) },
    departments: departments.map((dp) => ({
      id: dp.id,
      name: dp.name_ko,
      mission: dp.mission,
      agents: agents.filter((a) => a.department_id === dp.id),
      tasks: Object.fromEntries(counts.filter((c) => c.d === dp.id).map((c) => [c.s, c.n]))
    })),
    activity: await q("SELECT a.id, a.ts, a.kind, a.message, g.name agent_name FROM ai_activity a LEFT JOIN ai_agents g ON g.id = a.agent_id ORDER BY a.ts DESC, a.rowid DESC LIMIT 40"),
    approvals: await q("SELECT p.id, p.kind, p.title, p.detail, p.risk, p.created_at, g.name agent_name, g.title agent_title FROM ai_approvals p LEFT JOIN ai_agents g ON g.id = p.agent_id WHERE p.status = 'pending' ORDER BY p.created_at"),
    humanTasks: await q("SELECT id, title, detail, department_id, priority FROM ai_tasks WHERE status = 'needs_human' AND assignee_human = 1 ORDER BY priority DESC, created_at LIMIT 20"),
    recentTasks: await q("SELECT t.id, t.title, t.status, t.priority, t.department_id, t.result_summary, t.source, g.name agent_name FROM ai_tasks t LEFT JOIN ai_agents g ON g.id = t.assignee_agent_id ORDER BY t.updated_at DESC LIMIT 30"),
    meetings: await q("SELECT m.id, m.topic, m.status, m.decision, m.created_at, g.name chair FROM ai_meetings m LEFT JOIN ai_agents g ON g.id = m.chair_agent_id ORDER BY m.created_at DESC LIMIT 8"),
    providers: await Promise.all((await q("SELECT * FROM ai_providers ORDER BY priority")).map(async (p) => ({ name: p.name, kind: p.kind, model: p.model, external: !!p.external, strong: !!p.strong, enabled: !!p.enabled, dailyLimit: p.daily_limit, usedToday: await runsToday(db, nowMs, p.name), configured: p.kind === "workers_ai" ? null : !!p.secret_name, note: p.note })))
  };
}
__name(companyOverview, "companyOverview");
var MockLlm = class {
  static {
    __name(this, "MockLlm");
  }
  calls = [];
  /** 테스트에서 응답을 바꾸는 훅. null 을 돌려주면 기본 응답을 쓴다. */
  script = null;
  async complete(system, user) {
    this.calls.push({ system, user });
    const custom = this.script?.(system, user);
    const text = custom ?? (user.includes('"verdict"') ? '{"verdict":"approve","feedback":""}' : user.includes("\uACB0\uB860\uC744 \uC774 JSON") ? '{"decision":"[mock] \uD611\uC758 \uACB0\uACFC \uC9C4\uD589","follow_up_tasks":[],"proposed_actions":[]}' : user.includes("[\uD68C\uC758 \uC548\uAC74]") ? "[mock] \uC6B0\uB9AC \uBD80\uC11C \uAD00\uC810\uC758 \uC758\uACAC\uC785\uB2C8\uB2E4." : '{"summary":"[mock] \uC5C5\uBB34 \uCC98\uB9AC \uC694\uC57D","deliverable":"[mock] \uACB0\uACFC\uBB3C"}');
    return { text, inputTokens: Math.ceil((system.length + user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
  }
};

// src/lib/cfApi.ts
var CfApiError = class extends Error {
  constructor(status, codes, message) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
  status;
  codes;
  static {
    __name(this, "CfApiError");
  }
  /** 429·5xx 는 재시도 가능, 4xx 는 요청 자체의 문제. */
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
};
var CfClient = class {
  constructor(o) {
    this.o = o;
    if (!o.token) throw new Error("CLOUDFLARE_API_TOKEN \uC774 \uC124\uC815\uB418\uC9C0 \uC54A\uC74C");
    if (!/^[0-9a-f]{32}$/i.test(o.accountId)) throw new Error("accountId \uD615\uC2DD \uC624\uB958");
  }
  o;
  static {
    __name(this, "CfClient");
  }
  get accountId() {
    return this.o.accountId;
  }
  async request(method, path, body, extraHeaders = {}) {
    const f = this.o.fetch ?? ((u, i) => fetch(u, i));
    const res = await f(`${this.o.baseUrl ?? "https://api.cloudflare.com/client/v4"}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json", ...extraHeaders },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    let env = null;
    try {
      env = await res.json();
    } catch {
    }
    if (res.status >= 400 || !env || env.success === false) {
      const errs = env?.errors ?? [];
      throw new CfApiError(res.status, errs.map((e) => e.code), errs.map((e) => e.message).join("; ") || `HTTP ${res.status}`);
    }
    return { status: res.status, result: env.result };
  }
};

// src/lib/registrar.ts
function mapDomain(d) {
  return {
    name: d.name,
    registrable: d.registrable === true,
    reason: d.reason,
    tier: d.tier,
    registrationCostMicro: d.pricing?.registration_cost ? usd(String(d.pricing.registration_cost)) : void 0,
    renewalCostMicro: d.pricing?.renewal_cost ? usd(String(d.pricing.renewal_cost)) : void 0
  };
}
__name(mapDomain, "mapDomain");
function mapState(r) {
  switch (r?.state) {
    case "succeeded":
      return { outcome: "succeeded", expiresAt: r.context?.registration?.expires_at ?? "" };
    case "in_progress":
      return { outcome: "in_progress" };
    case "action_required":
    case "blocked":
    case "failed":
      return { outcome: r.state, code: r.error?.code, message: r.error?.message };
    default:
      return { outcome: "failed", code: "unknown_state", message: String(r?.state) };
  }
}
__name(mapState, "mapState");
var CloudflareRegistrar = class {
  constructor(c) {
    this.c = c;
  }
  c;
  static {
    __name(this, "CloudflareRegistrar");
  }
  base = /* @__PURE__ */ __name(() => `/accounts/${this.c.accountId}/registrar`, "base");
  async search(q, limit) {
    const r = await this.c.request("GET", `${this.base()}/domain-search?q=${encodeURIComponent(q)}&limit=${Math.min(Math.max(limit, 1), 20)}`);
    return r.result.domains.map(mapDomain);
  }
  async check(domains) {
    if (domains.length < 1 || domains.length > 20) throw new Error("check \uB294 1~20\uAC1C \uB3C4\uBA54\uC778\uB9CC \uD5C8\uC6A9");
    const r = await this.c.request("POST", `${this.base()}/domain-check`, { domains });
    return r.result.domains.map(mapDomain);
  }
  /** 항상 비동기 응답(Prefer: respond-async)으로 요청해 Worker 가 오래 대기하지 않게 하고, 201/202 모두 정상으로 취급. 같은 요청을 즉시 재시도하지 않는다. */
  async register(domainName, contact) {
    const body = { domain_name: domainName };
    if (contact) body.contacts = { registrant: contact };
    const r = await this.c.request("POST", `${this.base()}/registrations`, body, { Prefer: "respond-async" });
    return mapState(r.result);
  }
  async status(domainName) {
    const r = await this.c.request("GET", `${this.base()}/registrations/${encodeURIComponent(domainName)}/registration-status`);
    return mapState(r.result);
  }
};
var MockRegistrar = class {
  constructor(cfg = {}) {
    this.cfg = cfg;
  }
  cfg;
  static {
    __name(this, "MockRegistrar");
  }
  registered = /* @__PURE__ */ new Map();
  calls = [];
  price(name) {
    return this.cfg.costs?.[name.split(".").slice(-1)[0]] ?? ["10.44", "10.44"];
  }
  async search(q, limit) {
    return this.check([`${q}.com`, `${q}.dev`].slice(0, limit));
  }
  async check(domains) {
    this.calls.push(`check:${domains.join(",")}`);
    return domains.map((name) => {
      if (this.registered.has(name) || this.cfg.unavailable?.includes(name)) return { name, registrable: false, reason: "domain_unavailable" };
      const [reg, ren] = this.price(name);
      const bump = this.cfg.priceBump ? usd(this.cfg.priceBump) : 0;
      return { name, registrable: true, tier: "standard", registrationCostMicro: usd(reg) + bump, renewalCostMicro: usd(ren) };
    });
  }
  async register(domainName) {
    this.calls.push(`register:${domainName}`);
    const b = this.cfg.registerBehavior ?? "succeed";
    if (b === "throw") throw new CfApiError(504, [], "timeout");
    if (b === "fail") return { outcome: "failed", code: "registry_rejected", message: "rejected" };
    if (b === "action_required") return { outcome: "action_required", code: "contact_verification" };
    if (b === "in_progress") {
      this.registered.set(domainName, "pending");
      return { outcome: "in_progress" };
    }
    this.registered.set(domainName, "2027-10-18T00:00:00Z");
    return { outcome: "succeeded", expiresAt: "2027-10-18T00:00:00Z" };
  }
  async status(domainName) {
    this.calls.push(`status:${domainName}`);
    const v = this.registered.get(domainName);
    if (!v) return { outcome: "failed", code: "not_found" };
    return v === "pending" ? { outcome: "in_progress" } : { outcome: "succeeded", expiresAt: v };
  }
};

// src/lib/zones.ts
var toInfo = /* @__PURE__ */ __name((z) => ({ id: z.id, name: z.name, status: z.status, nameServers: z.name_servers ?? [] }), "toInfo");
var recBody = /* @__PURE__ */ __name((r) => ({ type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, ...r.priority !== void 0 ? { priority: r.priority } : {} }), "recBody");
var CloudflareZones = class {
  constructor(c) {
    this.c = c;
  }
  c;
  static {
    __name(this, "CloudflareZones");
  }
  async findZone(name) {
    const r = await this.c.request("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${this.c.accountId}`);
    return r.result.length > 0 ? toInfo(r.result[0]) : null;
  }
  async createZone(name) {
    const r = await this.c.request("POST", "/zones", { account: { id: this.c.accountId }, name, type: "full" });
    return toInfo(r.result);
  }
  async getZone(id) {
    return toInfo((await this.c.request("GET", `/zones/${id}`)).result);
  }
  async recheckActivation(id) {
    await this.c.request("PUT", `/zones/${id}/activation_check`);
  }
  async deleteZone(id) {
    await this.c.request("DELETE", `/zones/${id}`);
  }
  async createRecord(zoneId, r) {
    return (await this.c.request("POST", `/zones/${zoneId}/dns_records`, recBody(r))).result.id;
  }
  async updateRecord(zoneId, id, r) {
    await this.c.request("PATCH", `/zones/${zoneId}/dns_records/${id}`, recBody(r));
  }
  async deleteRecord(zoneId, id) {
    await this.c.request("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }
  async setSetting(zoneId, key, value) {
    await this.c.request("PATCH", `/zones/${zoneId}/settings/${key}`, { value });
  }
  async putRules(zoneId, phase, rules) {
    await this.c.request("PUT", `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, { rules });
  }
  async setDnssec(zoneId, status) {
    const r = await this.c.request("PATCH", `/zones/${zoneId}/dnssec`, { status });
    return { ds: r.result?.ds };
  }
  async attachWorkerRoute(zoneId, pattern, script) {
    await this.c.request("POST", `/zones/${zoneId}/workers/routes`, { pattern, script });
  }
};
var MockZones = class {
  static {
    __name(this, "MockZones");
  }
  zones = /* @__PURE__ */ new Map();
  records = /* @__PURE__ */ new Map();
  settings = /* @__PURE__ */ new Map();
  rules = /* @__PURE__ */ new Map();
  routes = [];
  n = 0;
  /** 운영 계정에 이미 있는 영역(예: 운영자 본인 도메인)을 흉내 낼 때 사용. */
  preexisting(name) {
    const z = { id: `z${++this.n}`, name, status: "active", nameServers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"] };
    this.zones.set(z.id, z);
    return z;
  }
  async findZone(name) {
    return [...this.zones.values()].find((z) => z.name === name) ?? null;
  }
  async createZone(name) {
    if (await this.findZone(name)) throw new Error("zone exists");
    const z = { id: `z${++this.n}`, name, status: "pending", nameServers: [`ns${this.n}a.mock.ns.cloudflare.com`, `ns${this.n}b.mock.ns.cloudflare.com`] };
    this.zones.set(z.id, z);
    return z;
  }
  async getZone(id) {
    const z = this.zones.get(id);
    if (!z) throw new Error("not found");
    return z;
  }
  async recheckActivation() {
  }
  async deleteZone(id) {
    this.zones.delete(id);
  }
  async createRecord(zoneId, r) {
    const id = `r${++this.n}`;
    (this.records.get(zoneId) ?? this.records.set(zoneId, /* @__PURE__ */ new Map()).get(zoneId)).set(id, r);
    return id;
  }
  async updateRecord(zoneId, id, r) {
    this.records.get(zoneId).set(id, r);
  }
  async deleteRecord(zoneId, id) {
    this.records.get(zoneId)?.delete(id);
  }
  async setSetting(zoneId, key, value) {
    this.settings.set(zoneId, { ...this.settings.get(zoneId) ?? {}, [key]: value });
  }
  async putRules(zoneId, phase, rules) {
    this.rules.set(`${zoneId}:${phase}`, rules);
  }
  async setDnssec() {
    return { ds: "mock-ds" };
  }
  async attachWorkerRoute(_z, pattern) {
    this.routes.push(pattern);
  }
};

// src/runtime.ts
var ConfigError = class extends Error {
  static {
    __name(this, "ConfigError");
  }
};
var mockLlm = new MockLlm();
var noNameserverDelegation = /* @__PURE__ */ __name(() => ({ setNameservers: /* @__PURE__ */ __name(async () => {
  throw new Error("nameserver_delegation_not_supported");
}, "setNameservers") }), "noNameserverDelegation");
var DEV_ONLY_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
var mock = null;
function buildRuntime(env) {
  if (env.CLOUDPRESS_MODE !== "live") {
    if (!mock) {
      const cf2 = new MockRegistrar();
      const crypto2 = { encrypt: /* @__PURE__ */ __name((p, a) => encryptSecret(p, DEV_ONLY_KEY, a), "encrypt"), decrypt: /* @__PURE__ */ __name((t, a) => decryptSecret(t, DEV_ONLY_KEY, a), "decrypt") };
      mock = { mode: "mock", llm: /* @__PURE__ */ __name(() => mockLlm, "llm"), ai: new MockAiRunner(), paypal: new MockPayPal(), paypalEnv: "sandbox", registrar: cf2, portFor: /* @__PURE__ */ __name(() => cf2, "portFor"), nsPortFor: noNameserverDelegation, zones: new MockZones(), crypto: crypto2, provisioner: { provision: /* @__PURE__ */ __name(async () => {
      }, "provision"), suspend: /* @__PURE__ */ __name(async () => {
      }, "suspend"), resume: /* @__PURE__ */ __name(async () => {
      }, "resume"), resize: /* @__PURE__ */ __name(async () => {
      }, "resize") } };
    }
    return mock;
  }
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "SECRETS_ENCRYPTION_KEY"].filter((k) => !env[k]);
  if (missing.length) throw new ConfigError(`live \uBAA8\uB4DC\uC5D0 \uD544\uC694\uD55C \uBE44\uBC00 \uAC12\uC774 \uC5C6\uC74C: ${missing.join(", ")}`);
  const cf = new CfClient({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID });
  const registrar = new CloudflareRegistrar(cf);
  const key = env.SECRETS_ENCRYPTION_KEY;
  return {
    mode: "live",
    ai: workersAiRunner(env),
    llm: /* @__PURE__ */ __name((row) => {
      if (row.kind === "workers_ai") return env.AI ? workersAi(env.AI, row.model) : null;
      const key2 = row.secret_name ? env[row.secret_name] : void 0;
      return key2 && row.base_url ? openAiCompat(row.base_url, row.model, key2) : null;
    }, "llm"),
    paypal: new PayPalHttp({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, env: env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live" }),
    paypalEnv: env.PAYPAL_ENV === "sandbox" ? "sandbox" : "live",
    registrar,
    // 가비아는 설정 후에만 라우팅 대상에 포함
    portFor: /* @__PURE__ */ __name(() => registrar, "portFor"),
    nsPortFor: noNameserverDelegation,
    zones: new CloudflareZones(cf),
    crypto: { encrypt: /* @__PURE__ */ __name((p, a) => encryptSecret(p, key, a), "encrypt"), decrypt: /* @__PURE__ */ __name((t, a) => decryptSecret(t, key, a), "decrypt") },
    provisioner: null
    // 컨테이너 매니저 구현 전: 프로비저닝 작업은 폐기·운영자 알림으로 드러난다
  };
}
__name(buildRuntime, "buildRuntime");
function workersAiRunner(env) {
  if (!env.AI) throw new ConfigError("live \uBAA8\uB4DC\uC5D0\uB294 Workers AI \uBC14\uC778\uB529(AI)\uC774 \uD544\uC694\uD569\uB2C8\uB2E4. wrangler.jsonc \uC758 ai \uC124\uC815\uC744 \uD655\uC778\uD558\uC138\uC694.");
  const ai = env.AI;
  return {
    async run(model, input) {
      const r = await ai.run(model, input);
      const u = r?.usage;
      if (u && (typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number")) return { result: r, usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 } };
      const out = typeof r?.response === "string" ? r.response.length : 0;
      return { result: r, usage: { inputTokens: Math.ceil(JSON.stringify(input).length / 4), outputTokens: Math.ceil(out / 4), units: 1 } };
    }
  };
}
__name(workersAiRunner, "workersAiRunner");

// src/lib/jobs.ts
var RetryableError = class extends Error {
  static {
    __name(this, "RetryableError");
  }
};
var PermanentError = class extends Error {
  static {
    __name(this, "PermanentError");
  }
};
function backoffSeconds(attempt, jitter = 0.5) {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + 0.4 * jitter));
}
__name(backoffSeconds, "backoffSeconds");
function classify(e) {
  if (e instanceof PermanentError) return "permanent";
  if (e instanceof RetryableError) return "retry";
  if (e instanceof CfApiError || e instanceof PayPalError) return e.retryable ? "retry" : "permanent";
  return "retry";
}
__name(classify, "classify");
var notifyOperator = /* @__PURE__ */ __name((db, title, body, nowMs) => db.prepare("INSERT INTO notifications(id,audience,severity,title,body,created_at) VALUES(?,?,?,?,?,?)").bind(newId("ntf"), "operator", "critical", title, body.slice(0, 500), nowIso(nowMs)), "notifyOperator");
var HANDLERS = {
  async register_domain(job, ctx) {
    const { orderId } = JSON.parse(job.payload_json);
    let status = await runRegistration(ctx.db, ctx.portFor, ctx.crypto, orderId, ctx.nowMs);
    if (status === "registering") {
      status = await pollRegistration(ctx.db, ctx.portFor, orderId, ctx.nowMs);
      if (status === "registering") throw new RetryableError("\uB4F1\uB85D \uC9C4\uD589 \uC911");
    }
    if (status === "registered") {
      await adoptRegisteredZone(ctx.db, ctx.zones, orderId, ctx.nowMs);
      const o = await ctx.db.prepare("SELECT registrar_provider AS p FROM domain_orders WHERE id = ?").bind(orderId).first();
      await delegateNameservers(ctx.db, ctx.nsPortFor(o.p), orderId, ctx.nowMs);
    } else if (status === "needs_review") {
      await notifyOperator(ctx.db, "\uB3C4\uBA54\uC778 \uB4F1\uB85D \uAC80\uD1A0 \uD544\uC694", `\uC8FC\uBB38 ${orderId}: \uC790\uB3D9 \uCC98\uB9AC\uD560 \uC218 \uC5C6\uB294 \uC0C1\uD0DC\uC785\uB2C8\uB2E4(\uB4F1\uB85D\uC740 \uD658\uBD88 \uBD88\uAC00\uC774\uBBC0\uB85C \uC218\uB3D9 \uD655\uC778).`, ctx.nowMs).run();
    }
  },
  async refund_domain_order(job, ctx) {
    const { orderId } = JSON.parse(job.payload_json);
    const o = await ctx.db.prepare("SELECT status, stripe_payment_intent_id AS pi FROM domain_orders /* \uC678\uBD80 \uACB0\uC81C \uCC38\uC870 = PayPal capture id */ WHERE id = ?").bind(orderId).first();
    if (!o) throw new PermanentError("\uC8FC\uBB38 \uC5C6\uC74C");
    if (o.status === "refunded") return;
    if (o.status !== "refund_due") throw new PermanentError(`\uD658\uBD88 \uB300\uC0C1\uC774 \uC544\uB2CC \uC0C1\uD0DC: ${o.status}`);
    if (!o.pi) throw new PermanentError("\uACB0\uC81C \uC815\uBCF4 \uC5C6\uC74C");
    await ctx.paypal.refundCapture({ captureId: o.pi, note: "\uB3C4\uBA54\uC778 \uB4F1\uB85D \uC2E4\uD328\uB85C \uC778\uD55C \uC804\uC561 \uD658\uBD88" }, `refund:${orderId}`);
    await markRefunded(ctx.db, orderId, ctx.nowMs);
  },
  async provision(job, ctx) {
    await need(ctx).provision(job.subscription_id);
  },
  async suspend(job, ctx) {
    await need(ctx).suspend(job.subscription_id);
  },
  async resume(job, ctx) {
    await need(ctx).resume(job.subscription_id);
  },
  // 추가 CPU 적용: 결제(구매 상태)와 별개로 실제 적용 상태를 기록한다. 실패하면 재시도하고, 끝내 실패하면 운영자에게 알린다(dead).
  async cpu_resize(job, ctx) {
    const { containerId } = JSON.parse(job.payload_json);
    const want = await desiredInstance(ctx.db, containerId);
    if (!want) throw new PermanentError("container_not_found");
    await ctx.db.prepare("UPDATE cpu_addons SET apply_status='applying', attempts=attempts+1 WHERE container_id=? AND purchase_status='paid' AND apply_status IN ('not_started','queued','failed','applying')").bind(containerId).run();
    try {
      if (want.instance !== want.current) await need(ctx).resize(containerId, want.instance);
      const spec = OFFICIAL_INSTANCE_TYPES[want.instance];
      await ctx.db.batch([
        ctx.db.prepare("UPDATE containers SET instance_type=?, actual_vcpu=? WHERE id=?").bind(want.instance, spec.vcpu, containerId),
        ctx.db.prepare("UPDATE cpu_addons SET apply_status='applied', applied_at=?, last_error=NULL WHERE container_id=? AND purchase_status='paid' AND apply_status='applying'").bind(nowIso(ctx.nowMs), containerId)
      ]);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await ctx.db.prepare("UPDATE cpu_addons SET apply_status='failed', last_error=? WHERE container_id=? AND purchase_status='paid' AND apply_status='applying'").bind(msg, containerId).run();
      throw e;
    }
  }
};
function need(ctx) {
  if (!ctx.provisioner) throw new PermanentError("provisioner_not_connected: \uCEE8\uD14C\uC774\uB108 \uB9E4\uB2C8\uC800\uAC00 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC74C");
  return ctx.provisioner;
}
__name(need, "need");
async function processJob(ctx, jobId, handlers = HANDLERS, jitter = 0.5) {
  const { db, nowMs } = ctx;
  const claim = await db.prepare("UPDATE deployment_jobs SET state='running', attempts=attempts+1, updated_at=? WHERE id=? AND state IN ('queued','retrying') AND (next_run_at IS NULL OR next_run_at <= ?)").bind(nowIso(nowMs), jobId, nowIso(nowMs)).run();
  if (claim.meta.changes === 0) return "skipped";
  const job = await db.prepare("SELECT id,kind,subscription_id,payload_json,attempts,max_attempts FROM deployment_jobs WHERE id = ?").bind(jobId).first();
  const h = handlers[job.kind];
  const finish = /* @__PURE__ */ __name(async (state, err, nextRun, extra = []) => {
    assertTransition(JOB_TRANSITIONS, "running", state);
    await db.batch([
      db.prepare("UPDATE deployment_jobs SET state=?, last_error=?, next_run_at=?, updated_at=? WHERE id=?").bind(state, err, nextRun, nowIso(nowMs), jobId),
      ...state === "retrying" ? [db.prepare("DELETE FROM queue_jobs WHERE deployment_job_id = ?").bind(jobId)] : [],
      ...extra
    ]);
  }, "finish");
  if (!h) {
    await finish("dead", `unknown_job_kind:${job.kind}`, null, [notifyOperator(db, "\uC54C \uC218 \uC5C6\uB294 \uC791\uC5C5 \uC885\uB958", job.kind, nowMs)]);
    return "dead";
  }
  try {
    await h(job, ctx);
    await finish("succeeded", null, null);
    return "succeeded";
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    if (classify(e) === "retry" && job.attempts < job.max_attempts) {
      await finish("retrying", msg, nowIso(nowMs + backoffSeconds(job.attempts, jitter) * 1e3));
      return "retrying";
    }
    await finish("dead", msg, null, [notifyOperator(db, `\uC791\uC5C5 \uD3D0\uAE30: ${job.kind}`, `${job.id} (${job.attempts}\uD68C \uC2DC\uB3C4): ${msg}`, nowMs)]);
    return "dead";
  }
}
__name(processJob, "processJob");
async function recoverStuckJobs(db, nowMs, timeoutMin = 15) {
  const cutoff = nowIso(nowMs - timeoutMin * 6e4);
  const { results } = await db.prepare("SELECT id FROM deployment_jobs WHERE state='running' AND updated_at < ?").bind(cutoff).all();
  for (const { id } of results) {
    await db.batch([
      db.prepare("UPDATE deployment_jobs SET state='retrying', next_run_at=?, last_error='stuck_recovered', updated_at=? WHERE id=? AND state='running'").bind(nowIso(nowMs), nowIso(nowMs), id),
      db.prepare("DELETE FROM queue_jobs WHERE deployment_job_id = ?").bind(id)
    ]);
  }
  return results.length;
}
__name(recoverStuckJobs, "recoverStuckJobs");
async function consumeBatch(ctx, messages) {
  const tally = { succeeded: 0, retrying: 0, dead: 0, skipped: 0 };
  for (const m of messages) {
    try {
      tally[await processJob(ctx, m.body.jobId)]++;
    } catch {
      continue;
    }
    m.ack();
  }
  return tally;
}
__name(consumeBatch, "consumeBatch");

// src/lib/checkout.ts
function assertPayPalCurrency(currency) {
  if (currency !== "USD") throw new ServiceError("currency_unsupported", "PayPal \uACB0\uC81C\uB294 USD \uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
}
__name(assertPayPalCurrency, "assertPayPalCurrency");
async function ensurePayPalPlan(db, paypal, priceId, currency, nowMs) {
  assertPayPalCurrency(currency);
  const existing = await db.prepare("SELECT amount_minor AS a, paypal_plan_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first();
  if (existing?.s) return { paypalPlanId: existing.s, amountMinor: existing.a };
  const p = await db.prepare("SELECT p.monthly_micro AS m, p.product_id AS pid, pr.name_ko AS name FROM prices p JOIN products pr ON pr.id = p.product_id WHERE p.id = ?").bind(priceId).first();
  if (!p) throw new ServiceError("not_found", "\uAC00\uACA9 \uC5C6\uC74C");
  if (p.m % 1e4 !== 0) throw new ServiceError("bad_price", "USD \uAC00\uACA9\uC740 \uC13C\uD2B8 \uB2E8\uC704\uC5EC\uC57C \uD568");
  const amountMinor = p.m / 1e4;
  const created = await paypal.createMonthlyPlan({ name: `CloudPress ${p.name}`, currency, amountMinor, customId: priceId }, `${priceId}:${currency}`);
  await db.prepare("INSERT INTO price_amounts(price_id,currency,amount_minor,paypal_plan_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT(price_id,currency) DO UPDATE SET paypal_plan_id = COALESCE(price_amounts.paypal_plan_id, excluded.paypal_plan_id)").bind(priceId, currency, amountMinor, created.planId, nowIso(nowMs)).run();
  const row = await db.prepare("SELECT amount_minor AS a, paypal_plan_id AS s FROM price_amounts WHERE price_id = ? AND currency = ?").bind(priceId, currency).first();
  return { paypalPlanId: row.s, amountMinor: row.a };
}
__name(ensurePayPalPlan, "ensurePayPalPlan");
async function createSubscriptionCheckout(db, paypal, userId, productId, currency, ctx) {
  assertPayPalCurrency(currency);
  const prod = await db.prepare("SELECT id, on_sale FROM products WHERE id = ?").bind(productId).first();
  if (!prod || prod.on_sale !== 1) throw new ServiceError("not_for_sale", "\uD310\uB9E4 \uC911\uC778 \uC0C1\uD488\uC774 \uC544\uB2D8");
  const price = await db.prepare("SELECT id FROM prices WHERE product_id = ? AND retired_at IS NULL ORDER BY version DESC LIMIT 1").bind(productId).first();
  if (!price) throw new ServiceError("not_for_sale", "\uD310\uB9E4 \uAC00\uB2A5\uD55C \uAC00\uACA9\uC774 \uC5C6\uC74C");
  const user = await db.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first();
  if (!user) throw new ServiceError("not_found", "\uC0AC\uC6A9\uC790 \uC5C6\uC74C");
  const { paypalPlanId } = await ensurePayPalPlan(db, paypal, price.id, currency, ctx.nowMs);
  const subId = newId("sub");
  const s = await paypal.createSubscription({
    planId: paypalPlanId,
    customId: subId,
    email: user.email,
    returnUrl: `${ctx.appOrigin}/dashboard?checkout=success`,
    cancelUrl: `${ctx.appOrigin}/services/create?checkout=cancel`
  }, `sub:${subId}`);
  await db.prepare("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id,paypal_plan_id,paypal_subscription_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'incomplete',?,?)").bind(subId, userId, productId, price.id, paypalPlanId, s.id, nowIso(ctx.nowMs), nowIso(ctx.nowMs)).run();
  await audit(db, { actorId: userId, action: "checkout.subscription", targetType: "subscription", targetId: subId, detail: { productId, currency, provider: "paypal" } }, ctx.nowMs);
  return { subscriptionId: subId, url: s.approveUrl };
}
__name(createSubscriptionCheckout, "createSubscriptionCheckout");
async function createDomainCheckout(db, paypal, userId, orderId, ctx) {
  const o = await db.prepare("SELECT id,hostname,status,charge_currency AS cur,charge_amount AS amt,quote_expires_at AS exp FROM domain_orders WHERE id = ? AND customer_id = ?").bind(orderId, userId).first();
  if (!o) throw new ServiceError("not_found", "\uC8FC\uBB38\uC774 \uC5C6\uAC70\uB098 \uAD8C\uD55C \uC5C6\uC74C");
  if (o.status !== "awaiting_payment") throw new ServiceError("bad_state", "\uACB0\uC81C\uD560 \uC218 \uC5C6\uB294 \uC8FC\uBB38 \uC0C1\uD0DC");
  if (Date.parse(o.exp) <= ctx.nowMs) throw new ServiceError("quote_expired", "\uACAC\uC801\uC774 \uB9CC\uB8CC\uB428. \uB2E4\uC2DC \uACAC\uC801\uC744 \uBC1B\uC73C\uC138\uC694.");
  if (!o.amt) throw new ServiceError("bad_price", "\uC8FC\uBB38 \uAE08\uC561\uC774 \uC5C6\uC74C");
  assertPayPalCurrency(o.cur);
  const ord = await paypal.createOrder({
    customId: o.id,
    currency: o.cur,
    amountMinor: o.amt,
    description: `\uB3C4\uBA54\uC778 \uB4F1\uB85D 1\uB144: ${o.hostname}`,
    returnUrl: `${ctx.appOrigin}/api/paypal/return?kind=domain&order=${encodeURIComponent(o.id)}`,
    cancelUrl: `${ctx.appOrigin}/domains?checkout=cancel`
  }, `domain:${o.id}`);
  await db.prepare("UPDATE domain_orders SET paypal_order_id = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").bind(ord.id, nowIso(ctx.nowMs), o.id).run();
  await audit(db, { actorId: userId, action: "checkout.domain", targetType: "domain_order", targetId: o.id }, ctx.nowMs);
  return { url: ord.approveUrl };
}
__name(createDomainCheckout, "createDomainCheckout");
async function createPortal(_db, _paypal, _userId, _appOrigin, env = "live") {
  return { url: env === "sandbox" ? "https://www.sandbox.paypal.com/myaccount/autopay/" : "https://www.paypal.com/myaccount/autopay/" };
}
__name(createPortal, "createPortal");
async function expireIncompleteSubscriptions(db, nowMs, ttlHours = 24) {
  const r = await db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE status='incomplete' AND created_at < ?").bind(nowIso(nowMs), nowIso(nowMs - ttlHours * 36e5)).run();
  return r.meta.changes;
}
__name(expireIncompleteSubscriptions, "expireIncompleteSubscriptions");
async function finalizeCanceledSubscriptions(db, nowMs) {
  const { results } = await db.prepare("SELECT id FROM subscriptions WHERE status = 'canceling' AND current_period_end IS NOT NULL AND current_period_end <= ?").bind(nowIso(nowMs)).all();
  for (const s of results) {
    await db.batch([
      db.prepare("UPDATE subscriptions SET status='canceled', updated_at=? WHERE id=? AND status='canceling'").bind(nowIso(nowMs), s.id),
      db.prepare("INSERT OR IGNORE INTO deployment_jobs(id,kind,subscription_id,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(newId("job"), "suspend", s.id, `suspend:${s.id}:period_end`, nowIso(nowMs), nowIso(nowMs))
    ]);
  }
  return results.length;
}
__name(finalizeCanceledSubscriptions, "finalizeCanceledSubscriptions");

// src/lib/scheduler.ts
async function runScheduled(db, deps, nowMs) {
  const r = { quotesExpired: 0, incompleteExpired: 0, stuckRecovered: 0, dispatched: 0, zonesChecked: 0, errors: [] };
  const step = /* @__PURE__ */ __name(async (name, f) => {
    try {
      await f();
    } catch (e) {
      r.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }, "step");
  await step("expireQuotes", async () => {
    r.quotesExpired = await expireQuotes(db, nowMs);
  });
  await step("expireIncomplete", async () => {
    r.incompleteExpired = await expireIncompleteSubscriptions(db, nowMs);
  });
  await step("finalizeCanceled", async () => {
    await finalizeCanceledSubscriptions(db, nowMs);
  });
  await step("affiliates", async () => {
    await settleAffiliates(db, nowMs);
  });
  await step("cpuAddons", async () => {
    await finalizeCpuAddons(db, nowMs);
  });
  await step("recoverStuck", async () => {
    r.stuckRecovered = await recoverStuckJobs(db, nowMs);
  });
  await step("dispatchOutbox", async () => {
    if (deps.queue) r.dispatched = await dispatchOutbox(db, deps.queue, nowMs);
  });
  await step("zones", async () => {
    const { results } = await db.prepare("SELECT id,customer_id,hostname,cf_zone_id,status,origin,name_servers_json,created_at,activation_checks,last_checked_at FROM dns_zones WHERE status='pending_nameservers' ORDER BY COALESCE(last_checked_at, created_at) LIMIT 50").all();
    for (const z of results) {
      const last = z.last_checked_at ? Date.parse(z.last_checked_at) : 0;
      if (nowMs - last < nextActivationDelayMin(z.activation_checks) * 6e4) continue;
      try {
        await checkActivation(db, deps.zones, z, nowMs);
        r.zonesChecked++;
      } catch (e) {
        r.errors.push(`zone ${z.id}: ${e instanceof Error ? e.message : "\uC624\uB958"}`.slice(0, 200));
      }
    }
  });
  return r;
}
__name(runScheduled, "runScheduled");

// src/lib/fx.ts
var SEED_FX_CONFIG = { maxAgeMs: 6 * 36e5, maxJumpBp: 300, window: 12, confirmToleranceBp: 50, bufferBp: 150 };
var median = /* @__PURE__ */ __name((xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}, "median");
var smoothedRate = /* @__PURE__ */ __name((s) => s.accepted.length ? median(s.accepted.map((x) => x.rateMicro)) : null, "smoothedRate");
function ingestSample(state, s, nowMs, cfg = SEED_FX_CONFIG) {
  if (!Number.isInteger(s.rateMicro) || s.rateMicro <= 0) return { state, status: "rejected", reason: "\uC798\uBABB\uB41C \uD658\uC728 \uAC12" };
  if (nowMs - s.fetchedAtMs > cfg.maxAgeMs) return { state, status: "rejected", reason: "\uC624\uB798\uB41C \uD45C\uBCF8" };
  const base = smoothedRate(state);
  const accept = /* @__PURE__ */ __name((st, reason) => ({ state: { accepted: [...st.accepted, s].slice(-cfg.window), pending: void 0 }, status: "accepted", reason }), "accept");
  if (base === null) return accept(state, "\uCD5C\uCD08 \uD45C\uBCF8");
  const jumpBp = Math.abs(s.rateMicro - base) * 1e4 / base;
  if (jumpBp <= cfg.maxJumpBp) return accept(state, "\uC815\uC0C1 \uBC94\uC704");
  const p = state.pending;
  if (p && (p.source !== s.source || p.fetchedAtMs !== s.fetchedAtMs) && Math.abs(p.rateMicro - s.rateMicro) * 1e4 / p.rateMicro <= cfg.confirmToleranceBp) return accept(state, "\uAE09\uBCC0\uC744 \uB3C5\uB9BD \uD45C\uBCF8\uC774 \uD655\uC778");
  return { state: { ...state, pending: s }, status: "quarantined", reason: `\uD3C9\uD65C\uAC12 \uB300\uBE44 ${Math.round(jumpBp)}bp \uAE09\uBCC0: \uD655\uC778 \uC804\uAE4C\uC9C0 \uBCF4\uB958` };
}
__name(ingestSample, "ingestSample");

// src/lib/currency.ts
function parseCurrency(c) {
  const s = String(c ?? "usd").toLowerCase();
  if (s === "usd") return "USD";
  if (s === "krw") return "KRW";
  throw new Error(`unsupported_currency:${s}`);
}
__name(parseCurrency, "parseCurrency");

// src/lib/fxStore.ts
async function loadFxState(db, cfg = SEED_FX_CONFIG) {
  const acc = await db.prepare("SELECT rate_micro AS r, source AS s, fetched_at AS t FROM fx_rates WHERE pair='USD/KRW' AND status='accepted' ORDER BY fetched_at DESC, id DESC LIMIT ?").bind(cfg.window).all();
  const lastAccepted = acc.results[0]?.t ?? "";
  const pend = await db.prepare("SELECT rate_micro AS r, source AS s, fetched_at AS t FROM fx_rates WHERE pair='USD/KRW' AND status='quarantined' AND fetched_at > ? ORDER BY fetched_at DESC, id DESC LIMIT 1").bind(lastAccepted).first();
  const toS = /* @__PURE__ */ __name((x) => ({ rateMicro: x.r, source: x.s, fetchedAtMs: Date.parse(x.t) }), "toS");
  return { accepted: acc.results.map(toS).reverse(), pending: pend ? toS(pend) : void 0 };
}
__name(loadFxState, "loadFxState");
async function recordFxSample(db, sample, nowMs, cfg = SEED_FX_CONFIG) {
  const res = ingestSample(await loadFxState(db, cfg), sample, nowMs, cfg);
  await db.prepare("INSERT INTO fx_rates(pair,rate_micro,source,fetched_at,status,reason) VALUES('USD/KRW',?,?,?,?,?)").bind(Math.max(1, Math.trunc(sample.rateMicro) || 1), sample.source, nowIso(sample.fetchedAtMs), res.status, res.reason).run();
  return res;
}
__name(recordFxSample, "recordFxSample");

// src/api.ts
var routes = [];
var add = /* @__PURE__ */ __name((method, path, h, admin = false) => routes.push({ method, re: new RegExp("^" + path.replace(/:[a-z]+/gi, "([^/]+)") + "/?$"), admin, h }), "add");
var all = /* @__PURE__ */ __name(async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results, "all");
var one = /* @__PURE__ */ __name(async (db, sql, ...b) => db.prepare(sql).bind(...b).first(), "one");
var parseJson = /* @__PURE__ */ __name((s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
}, "parseJson");
async function routeApi(c) {
  const path = c.url.pathname;
  for (const r of routes) {
    if (r.method !== c.req.method) continue;
    const m = path.match(r.re);
    if (!m) continue;
    if (r.admin && c.session.user.role !== "admin") return c.json({ error: "forbidden" }, 403);
    return r.h(c, m);
  }
  return null;
}
__name(routeApi, "routeApi");
async function listPlans(db) {
  const rows = await all(db, `SELECT p.id, p.kind, p.name_ko, p.instance_type, p.target_vcpu, p.included_storage_gb, p.included_active_hours, pr.monthly_micro
    FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.retired_at IS NULL
    WHERE p.on_sale = 1 AND pr.version = (SELECT MAX(version) FROM prices WHERE product_id = p.id AND retired_at IS NULL)
    ORDER BY p.kind, pr.monthly_micro`);
  return rows.map((r) => ({ id: r.id, kind: r.kind, nameKo: r.name_ko, monthlyMicro: r.monthly_micro, instanceType: r.instance_type, targetVcpu: r.target_vcpu, includedStorageGb: r.included_storage_gb, includedActiveHours: r.included_active_hours }));
}
__name(listPlans, "listPlans");
var subSelect = `SELECT s.id, s.product_id, s.status, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.created_at, s.billing_interval, s.quantity,
    p.kind, p.name_ko, pr.monthly_micro
  FROM subscriptions s JOIN products p ON p.id = s.product_id JOIN prices pr ON pr.id = s.price_version_id`;
var subOut = /* @__PURE__ */ __name((r) => ({
  id: r.id,
  productId: r.product_id,
  status: r.status,
  currentPeriodStart: r.current_period_start,
  currentPeriodEnd: r.current_period_end,
  cancelAtPeriodEnd: !!r.cancel_at_period_end,
  createdAt: r.created_at,
  billingInterval: r.billing_interval,
  quantity: r.quantity,
  product: { id: r.product_id, nameKo: r.name_ko, kind: r.kind, monthlyMicro: r.monthly_micro }
}), "subOut");
add("GET", "/api/subscriptions", async (c) => {
  const rows = await all(c.env.DB, `${subSelect} WHERE s.customer_id = ? AND s.status NOT IN ('incomplete') ORDER BY s.created_at DESC`, c.session.user.id);
  return c.json(rows.map(subOut));
});
add("POST", "/api/subscriptions", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.productId !== "string") return c.json({ error: "bad_request" }, 400);
  let cur;
  try {
    cur = parseCurrency(b.currency ?? "USD");
  } catch {
    return c.json({ error: "bad_currency" }, 400);
  }
  const rt = buildRuntime(c.env);
  const r = await createSubscriptionCheckout(c.env.DB, rt.paypal, c.session.user.id, b.productId, cur, { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  return c.json({ ok: true, subscriptionId: r.subscriptionId, url: r.url }, 201);
});
add("GET", "/api/subscriptions/:id", async (c, m) => {
  const r = await one(c.env.DB, `${subSelect} WHERE s.id = ? AND s.customer_id = ?`, m[1], c.session.user.id);
  return r ? c.json(subOut(r)) : c.json({ error: "not_found" }, 404);
});
add("POST", "/api/services/:id/cancel", async (c, m) => {
  const s = await one(c.env.DB, "SELECT id, status, paypal_subscription_id AS pp FROM subscriptions WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!["active", "past_due", "suspended"].includes(s.status)) return c.json({ error: "bad_state", message: "\uCDE8\uC18C\uD560 \uC218 \uC5C6\uB294 \uC0C1\uD0DC\uC785\uB2C8\uB2E4." }, 409);
  if (s.pp) {
    try {
      await buildRuntime(c.env).paypal.cancelSubscription(s.pp, "\uACE0\uAC1D \uC694\uCCAD\uC5D0 \uC758\uD55C \uCDE8\uC18C");
    } catch (e) {
      return c.json({ error: "paypal_error", message: "PayPal \uAD6C\uB3C5 \uD574\uC9C0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." }, e?.retryable ? 503 : 502);
    }
  }
  await c.env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, status = 'canceling', updated_at = ? WHERE id = ?").bind(nowIso(c.now), s.id).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "subscription.cancel", targetType: "subscription", targetId: s.id }, c.now);
  return c.json({ ok: true, cancelAtPeriodEnd: true });
});
for (const [action, from, to] of [["suspend", "active", "suspended"], ["resume", "suspended", "active"]]) {
  add("POST", `/api/services/:id/${action}`, async (c, m) => {
    const s = await one(c.env.DB, "SELECT id, paypal_subscription_id AS pp FROM subscriptions WHERE id = ? AND customer_id = ? AND status = ?", m[1], c.session.user.id, from);
    if (!s) return c.json({ error: "bad_state", message: "\uD604\uC7AC \uC0C1\uD0DC\uC5D0\uC11C\uB294 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 409);
    if (s.pp) {
      try {
        const pp = buildRuntime(c.env).paypal;
        await (action === "suspend" ? pp.suspendSubscription(s.pp, "\uACE0\uAC1D \uC694\uCCAD \uC815\uC9C0") : pp.activateSubscription(s.pp, "\uACE0\uAC1D \uC694\uCCAD \uC7AC\uAC1C"));
      } catch (e) {
        return c.json({ error: "paypal_error", message: "PayPal \uCC98\uB9AC\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." }, e?.retryable ? 503 : 502);
      }
    }
    await c.env.DB.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ? AND status = ?").bind(to, nowIso(c.now), s.id, from).run();
    await audit(c.env.DB, { actorId: c.session.user.id, action: `subscription.${action}`, targetType: "subscription", targetId: s.id }, c.now);
    return c.json({ ok: true });
  });
}
add("GET", "/api/paypal/return", async (c) => {
  const kind = c.url.searchParams.get("kind");
  const orderId = c.url.searchParams.get("order");
  const token = c.url.searchParams.get("token");
  const redirect = /* @__PURE__ */ __name((to) => new Response(null, { status: 302, headers: { Location: `${c.env.APP_ORIGIN}${to}` } }), "redirect");
  if (kind === "ai" && orderId && token) {
    const t = await one(c.env.DB, "SELECT id, paypal_order_id, status FROM ai_credit_topups WHERE id = ? AND customer_id = ?", orderId, c.session.user.id);
    if (!t || t.paypal_order_id !== token) return redirect("/ai?topup=invalid");
    if (t.status === "paid") return redirect("/ai?topup=done");
    try {
      const cap = await buildRuntime(c.env).paypal.captureOrder(token, `capture:${t.id}`);
      if (cap.status !== "COMPLETED") return redirect("/ai?topup=pending");
      await applyAiTopup(c.env.DB, t.id, cap.captureId, cap.currency, cap.amountMinor, c.now);
      return redirect("/ai?topup=success");
    } catch {
      return redirect("/ai?topup=error");
    }
  }
  if (kind !== "domain" || !orderId || !token) return redirect("/dashboard");
  const o = await one(c.env.DB, "SELECT id, paypal_order_id, status FROM domain_orders WHERE id = ? AND customer_id = ?", orderId, c.session.user.id);
  if (!o || o.paypal_order_id !== token) return redirect("/domains?checkout=invalid");
  if (o.status !== "awaiting_payment") return redirect("/domains?checkout=done");
  try {
    const cap = await buildRuntime(c.env).paypal.captureOrder(token, `capture:${o.id}`);
    if (cap.status !== "COMPLETED") return redirect("/domains?checkout=pending");
    await applyDomainCapture(c.env.DB, o.id, cap.captureId, cap.currency, cap.amountMinor, c.now);
    return redirect("/domains?checkout=success");
  } catch {
    return redirect("/domains?checkout=error");
  }
});
add("GET", "/api/services/:id/cpu-addons", async (c, m) => {
  const own = await one(c.env.DB, "SELECT id FROM subscriptions WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
  if (!own) return c.json({ error: "not_found" }, 404);
  const policy = await loadCpuPolicy(c.env.DB);
  const rows = await all(c.env.DB, "SELECT id, add_vcpu, monthly_micro, from_instance_type, to_instance_type, purchase_status, apply_status, last_error, current_period_end, cancel_at_period_end, created_at FROM cpu_addons WHERE subscription_id = ? AND purchase_status != 'cancelled' ORDER BY created_at DESC", m[1]);
  const container = await one(c.env.DB, "SELECT instance_type, target_vcpu, actual_vcpu FROM containers WHERE subscription_id = ? AND deleted_at IS NULL", m[1]);
  return c.json({
    tiers: Object.entries(policy.prices).map(([v, p]) => ({ addVcpu: Number(v), monthlyMicro: p })),
    maxTotalAddVcpu: policy.maxTotalAddVcpu,
    container: container ? { instanceType: container.instance_type, targetVcpu: container.target_vcpu, actualVcpu: container.actual_vcpu } : null,
    addons: rows.map((r) => ({ id: r.id, addVcpu: r.add_vcpu, monthlyMicro: r.monthly_micro, fromInstance: r.from_instance_type, toInstance: r.to_instance_type, purchaseStatus: r.purchase_status, applyStatus: r.apply_status, lastError: r.last_error, currentPeriodEnd: r.current_period_end, cancelAtPeriodEnd: !!r.cancel_at_period_end }))
  });
});
add("POST", "/api/services/:id/cpu-addons/quote", async (c, m) => {
  const b = await c.body(512);
  const q = await quoteCpuAddon(c.env.DB, c.session.user.id, m[1], Number(b?.addVcpu));
  return c.json(q);
});
add("POST", "/api/services/:id/cpu-addons", async (c, m) => {
  const b = await c.body(512);
  const r = await purchaseCpuAddon(c.env.DB, buildRuntime(c.env).paypal, c.session.user.id, m[1], Number(b?.addVcpu), { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  return c.json({ ok: true, id: r.id, url: r.url, quote: r.quote }, 201);
});
add("POST", "/api/cpu-addons/:id/cancel", async (c, m) => {
  const a = await one(c.env.DB, `SELECT a.id, a.paypal_subscription_id AS pp, a.purchase_status AS status FROM cpu_addons a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.id = ? AND s.customer_id = ?`, m[1], c.session.user.id);
  if (!a) return c.json({ error: "not_found" }, 404);
  if (a.status !== "paid") return c.json({ error: "bad_state", message: "\uCDE8\uC18C\uD560 \uC218 \uC5C6\uB294 \uC0C1\uD0DC\uC785\uB2C8\uB2E4." }, 409);
  if (a.pp) {
    try {
      await buildRuntime(c.env).paypal.cancelSubscription(a.pp, "\uACE0\uAC1D \uC694\uCCAD \uCD94\uAC00 CPU \uCDE8\uC18C");
    } catch (e) {
      return c.json({ error: "paypal_error", message: "PayPal \uD574\uC9C0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694." }, e?.retryable ? 503 : 502);
    }
  }
  await c.env.DB.prepare("UPDATE cpu_addons SET cancel_at_period_end = 1 WHERE id = ?").bind(a.id).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "cpu_addon.cancel", targetType: "cpu_addon", targetId: a.id }, c.now);
  return c.json({ ok: true, cancelAtPeriodEnd: true });
});
add("GET", "/api/admin/cpu-policy", async (c) => c.json(await loadCpuPolicy(c.env.DB)), true);
add("PUT", "/api/admin/cpu-policy", async (c) => {
  const b = await c.body(4096);
  if (!b) return c.json({ error: "bad_request" }, 400);
  return c.json(await saveCpuPolicy(c.env.DB, c.session.user.id, b, c.now));
}, true);
var TIER_PRODUCT = { general: "cas-general", performance: "cas-performance", premium: "cas-premium" };
add("GET", "/api/cas/models", async (c) => {
  const rows = await all(c.env.DB, `SELECT m.id, m.model_id, m.name, m.task_type, m.tier, m.input_neurons_per_m i, m.output_neurons_per_m o, m.unit_neurons u, m.official_status,
      (SELECT sell_per_1k_micro FROM ai_model_prices WHERE model_id = m.id ORDER BY version DESC LIMIT 1) AS sell
    FROM ai_models m WHERE m.enabled = 1 AND m.official_status != 'removed' ORDER BY m.tier, m.name`);
  const prods = Object.fromEntries((await all(c.env.DB, "SELECT p.id, pr.monthly_micro AS m FROM products p JOIN prices pr ON pr.product_id = p.id AND pr.retired_at IS NULL WHERE p.kind = 'cas'")).map((r) => [r.id, r.m]));
  const mine = new Set((await all(c.env.DB, "SELECT a.model_id AS m FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND s.status IN ('active','canceling','past_due')", c.session.user.id)).map((r) => r.m));
  return c.json({ models: rows.map((r) => ({ id: r.id, modelId: r.model_id, name: r.name, task: r.task_type, tier: r.tier, monthlyMicro: prods[TIER_PRODUCT[r.tier] ?? ""] ?? null, sellPer1kNeuronsMicro: r.sell, deprecating: r.official_status === "deprecating", subscribed: mine.has(r.id) })) });
});
add("POST", "/api/cas/subscribe", async (c) => {
  const b = await c.body(512);
  if (!b || typeof b.modelId !== "string") return c.json({ error: "bad_request" }, 400);
  const m = await one(c.env.DB, "SELECT id, tier, input_neurons_per_m i, output_neurons_per_m o, unit_neurons u FROM ai_models WHERE id = ? AND enabled = 1 AND official_status != 'removed'", b.modelId);
  if (!m || !(m.i || m.o || m.u) || !await currentPrice(c.env.DB, m.id)) return c.json({ error: "model_not_found", message: "\uD310\uB9E4 \uC911\uC778 \uBAA8\uB378\uC774 \uC544\uB2D9\uB2C8\uB2E4." }, 404);
  const dup = await one(c.env.DB, "SELECT a.subscription_id FROM cas_model_access a JOIN subscriptions s ON s.id = a.subscription_id WHERE a.customer_id = ? AND a.model_id = ? AND s.status IN ('incomplete','active','canceling','past_due','suspended')", c.session.user.id, m.id);
  if (dup) return c.json({ error: "already_subscribed", message: "\uC774\uBBF8 \uC774 \uBAA8\uB378\uC744 \uAD6C\uB3C5 \uC911\uC774\uAC70\uB098 \uACB0\uC81C \uB300\uAE30 \uC911\uC785\uB2C8\uB2E4." }, 409);
  const r = await createSubscriptionCheckout(c.env.DB, buildRuntime(c.env).paypal, c.session.user.id, TIER_PRODUCT[m.tier], "USD", { appOrigin: c.env.APP_ORIGIN, nowMs: c.now });
  await c.env.DB.prepare("INSERT INTO cas_model_access(subscription_id,customer_id,model_id,created_at) VALUES(?,?,?,?)").bind(r.subscriptionId, c.session.user.id, m.id, nowIso(c.now)).run();
  return c.json({ ok: true, subscriptionId: r.subscriptionId, url: r.url }, 201);
});
add("GET", "/api/cas/keys", async (c) => c.json({ keys: (await all(c.env.DB, "SELECT id, name, prefix, status, rate_limit_per_min, monthly_cap_micro, created_at, last_used_at FROM ai_api_keys WHERE customer_id = ? AND status != 'revoked' ORDER BY created_at DESC", c.session.user.id)).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status, rateLimitPerMin: k.rate_limit_per_min, monthlyCapMicro: k.monthly_cap_micro, createdAt: k.created_at, lastUsedAt: k.last_used_at })) }));
add("POST", "/api/cas/keys", async (c) => {
  const b = await c.body(1024);
  const k = await issueKey(c.env.DB, c.session.user.id, String(b?.name ?? ""), c.now, { rateLimitPerMin: b?.rateLimitPerMin, monthlyCapMicro: b?.monthlyCapMicro });
  return c.json({ ...k, notice: "\uC774 \uD0A4\uB294 \uC9C0\uAE08\uB9CC \uBCFC \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uC548\uC804\uD55C \uACF3\uC5D0 \uBCF4\uAD00\uD558\uC138\uC694." }, 201);
});
add("POST", "/api/cas/keys/:id/revoke", async (c, m) => {
  await revokeKey(c.env.DB, c.session.user.id, m[1], c.now);
  return c.json({ ok: true });
});
add("POST", "/api/cas/keys/:id/rotate", async (c, m) => c.json({ ...await rotateKey(c.env.DB, c.session.user.id, m[1], c.now), notice: "\uC774\uC804 \uD0A4\uB294 \uD3D0\uAE30\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC0C8 \uD0A4\uB294 \uC9C0\uAE08\uB9CC \uBCFC \uC218 \uC788\uC2B5\uB2C8\uB2E4." }, 201));
add("GET", "/api/cas/usage", async (c) => {
  const ms = new Date(c.now);
  ms.setUTCDate(1);
  ms.setUTCHours(0, 0, 0, 0);
  const rows = await all(c.env.DB, `SELECT m.model_id, m.name, COUNT(*) AS requests, SUM(u.neurons) AS neurons, SUM(u.billed_micro) AS billed
    FROM ai_usage_records u JOIN ai_models m ON m.id = u.model_id JOIN cas_model_access a ON a.subscription_id = u.subscription_id
    WHERE a.customer_id = ? AND u.ts >= ? GROUP BY m.id ORDER BY billed DESC`, c.session.user.id, nowIso(ms.getTime()));
  return c.json({ balanceMicro: await creditBalance(c.env.DB, c.session.user.id), month: nowIso(ms.getTime()).slice(0, 7), models: rows, note: "Neurons \uB294 \uACF5\uC2DD \uB2E8\uAC00\uB85C \uD658\uC0B0\uD55C \uCD94\uC815\uCE58\uC774\uBA70 Cloudflare \uC758 \uC2E4\uC81C \uC9D1\uACC4\uC640 \uC18C\uD3ED \uB2E4\uB97C \uC218 \uC788\uC2B5\uB2C8\uB2E4." });
});
add("POST", "/api/cas/credits/topup", async (c) => {
  const b = await c.body(256);
  const usd2 = Number(b?.amountUsd);
  const micro = Math.round(usd2 * 1e6);
  if (!Number.isFinite(usd2) || micro % 1e4 !== 0 || micro < MIN_TOPUP_MICRO || micro > MAX_TOPUP_MICRO) return c.json({ error: "bad_amount", message: `\uCDA9\uC804 \uAE08\uC561\uC740 $${MIN_TOPUP_MICRO / 1e6} ~ $${MAX_TOPUP_MICRO / 1e6} \uC0AC\uC774(\uC13C\uD2B8 \uB2E8\uC704)\uC5EC\uC57C \uD569\uB2C8\uB2E4.` }, 400);
  const id = newId("top");
  const ord = await buildRuntime(c.env).paypal.createOrder({
    customId: `ai:${id}`,
    currency: "USD",
    amountMinor: micro / 1e4,
    description: "CloudPress AI \uD06C\uB808\uB527 \uCDA9\uC804",
    returnUrl: `${c.env.APP_ORIGIN}/api/paypal/return?kind=ai&order=${encodeURIComponent(id)}`,
    cancelUrl: `${c.env.APP_ORIGIN}/ai?topup=cancel`
  }, `aitopup:${id}`);
  await c.env.DB.prepare("INSERT INTO ai_credit_topups(id,customer_id,amount_micro,paypal_order_id,created_at) VALUES(?,?,?,?,?)").bind(id, c.session.user.id, micro, ord.id, nowIso(c.now)).run();
  return c.json({ ok: true, url: ord.approveUrl }, 201);
});
add("GET", "/api/admin/cas/overview", async (c) => {
  const ms = new Date(c.now);
  ms.setUTCDate(1);
  ms.setUTCHours(0, 0, 0, 0);
  const models = await all(c.env.DB, `SELECT m.id, m.model_id, m.name, m.task_type, m.tier, m.enabled, m.official_status, m.pricing_source, m.input_neurons_per_m i, m.output_neurons_per_m o, m.unit_neurons u, m.last_synced_at,
      (SELECT sell_per_1k_micro FROM ai_model_prices WHERE model_id = m.id ORDER BY version DESC LIMIT 1) AS sell,
      (SELECT COUNT(*) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS requests,
      (SELECT COALESCE(SUM(neurons),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS neurons,
      (SELECT COALESCE(SUM(billed_micro),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS billed,
      (SELECT COALESCE(SUM(cost_micro),0) FROM ai_usage_records WHERE model_id = m.id AND ts >= ?) AS cost
    FROM ai_models m ORDER BY m.enabled DESC, m.name`, nowIso(ms.getTime()), nowIso(ms.getTime()), nowIso(ms.getTime()), nowIso(ms.getTime()));
  const kill = await one(c.env.DB, "SELECT value_json FROM admin_settings WHERE key = 'cas_kill_switch'");
  return c.json({ models, killSwitch: kill?.value_json === "true", costPerNeuronMicro: COST_MICRO_PER_NEURON });
}, true);
add("POST", "/api/admin/cas/sync", async (c) => {
  const env = c.env;
  if (env.CLOUDPRESS_MODE !== "live") {
    const mock2 = [{ name: "@cf/meta/llama-3.1-8b-instruct", task: { name: "Text Generation" }, properties: [{ property_id: "price", value: [{ unit: "per M input tokens", price: 0.282, currency: "USD" }, { unit: "per M output tokens", price: 0.827, currency: "USD" }] }] }];
    return c.json({ mode: "mock", ...await syncModels(env.DB, mock2, c.now) });
  }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return c.json({ error: "not_configured", message: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4." }, 503);
  const models = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
    if (!res.ok) return c.json({ error: "upstream_error", message: `Cloudflare \uBAA8\uB378 \uBAA9\uB85D \uC870\uD68C \uC2E4\uD328(HTTP ${res.status})` }, 502);
    const j = await res.json();
    models.push(...j.result ?? []);
    if (!j.result || j.result.length < 100) break;
  }
  return c.json({ mode: "live", ...await syncModels(env.DB, models, c.now) });
}, true);
add("PATCH", "/api/admin/cas/models/:id", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  await adminSetModel(c.env.DB, c.session.user.id, m[1], { enabled: b.enabled, tier: b.tier, inputNeuronsPerM: b.inputNeuronsPerM, outputNeuronsPerM: b.outputNeuronsPerM, unitNeurons: b.unitNeurons, sellPer1kMicro: b.sellPer1kMicro }, c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/cas/kill", async (c) => {
  const b = await c.body(128);
  const on = b?.on === true;
  await c.env.DB.prepare("INSERT INTO admin_settings(key,value_json,updated_by,updated_at) VALUES('cas_kill_switch',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(on ? "true" : "false", c.session.user.id, nowIso(c.now)).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.cas_kill_switch", detail: { on } }, c.now);
  return c.json({ ok: true, killSwitch: on });
}, true);
add("GET", "/api/admin/company/overview", async (c) => {
  const has = await one(c.env.DB, "SELECT 1 AS x FROM ai_departments LIMIT 1");
  if (!has) await seedWorkforce(c.env.DB, c.now);
  return c.json(await companyOverview(c.env.DB, c.now));
}, true);
add("POST", "/api/admin/company/tick", async (c) => {
  const rt = buildRuntime(c.env);
  await seedWorkforce(c.env.DB, c.now);
  const r = await runTick(c.env.DB, rt.llm, c.now, { force: true });
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.manual_tick", detail: r }, c.now);
  return c.json(r);
}, true);
add("POST", "/api/admin/company/settings", async (c) => {
  const b = await c.body(512);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const map = { enabled: "workforce_enabled", paused: "workforce_paused", maxTasksPerTick: "workforce_max_tasks_per_tick", tickMinutes: "workforce_tick_minutes", dailyRunCap: "workforce_daily_run_cap" };
  for (const [k, key] of Object.entries(map)) if (b[k] !== void 0) {
    const v = typeof b[k] === "boolean" ? String(b[k]) : Number.isFinite(Number(b[k])) ? String(Math.floor(Number(b[k]))) : null;
    if (v === null) return c.json({ error: "bad_value", message: `${k} \uAC12\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.` }, 400);
    await setSetting(c.env.DB, c.session.user.id, key, v, c.now);
  }
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.settings", detail: b }, c.now);
  return c.json(await loadSettings(c.env.DB));
}, true);
add("POST", "/api/admin/company/tasks", async (c) => {
  const b = await c.body(8192);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const id = await createTask(c.env.DB, c.session.user.id, { department: String(b.department ?? ""), title: String(b.title ?? ""), detail: b.detail, priority: Number(b.priority) || 5, confidential: b.confidential === true, human: b.human === true }, c.now);
  return c.json({ ok: true, id }, 201);
}, true);
add("POST", "/api/admin/company/tasks/:id/complete", async (c, m) => {
  await completeHumanTask(c.env.DB, c.session.user.id, m[1], c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/company/approvals/:id/decide", async (c, m) => {
  const b = await c.body(1024);
  if (!b || typeof b.approve !== "boolean") return c.json({ error: "bad_request" }, 400);
  await decideApproval(c.env.DB, c.session.user.id, m[1], b.approve, String(b.note ?? ""), c.now);
  return c.json({ ok: true });
}, true);
add("PATCH", "/api/admin/company/providers/:name", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  const p = await one(c.env.DB, "SELECT external FROM ai_providers WHERE name = ?", m[1]);
  if (!p) return c.json({ error: "not_found" }, 404);
  if (b.enabled === true && p.external && b.acknowledgeExternal !== true) return c.json({ error: "ack_required", message: "\uC678\uBD80 AI \uB294 \uC5C5\uBB34 \uD14D\uC2A4\uD2B8(\uAC1C\uC778\uC815\uBCF4 \uB9C8\uC2A4\uD0B9 \uD6C4)\uAC00 \uD574\uB2F9 \uC0AC\uC5C5\uC790\uB85C \uC804\uC1A1\uB418\uBA70 \uBB34\uB8CC \uD55C\uB3C4\xB7\uC57D\uAD00 \uD655\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4. \uD655\uC778\uD588\uB2E4\uBA74 acknowledgeExternal \uC744 true \uB85C \uBCF4\uB0B4\uC138\uC694." }, 400);
  if (b.dailyLimit !== void 0 && (!Number.isInteger(b.dailyLimit) || b.dailyLimit < 0 || b.dailyLimit > 1e5)) return c.json({ error: "bad_value" }, 400);
  if (b.enabled !== void 0) await c.env.DB.prepare("UPDATE ai_providers SET enabled = ? WHERE name = ?").bind(b.enabled ? 1 : 0, m[1]).run();
  if (b.dailyLimit !== void 0) await c.env.DB.prepare("UPDATE ai_providers SET daily_limit = ? WHERE name = ?").bind(b.dailyLimit, m[1]).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "company.provider_update", targetType: "ai_provider", targetId: m[1], detail: { enabled: b.enabled, dailyLimit: b.dailyLimit } }, c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/company/goals", async (c) => {
  const b = await c.body(512);
  const target = Number(b?.target);
  if (!b || typeof b.title !== "string" || !b.title.trim() || !["active_subscriptions", "mrr_usd", "ai_margin_pct"].includes(b.metric) || !Number.isFinite(target) || target <= 0) return c.json({ error: "bad_request", message: "title, metric(active_subscriptions|mrr_usd|ai_margin_pct), target(>0)\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." }, 400);
  await c.env.DB.prepare("INSERT INTO company_goals(id,title,metric,target,created_at) VALUES(?,?,?,?,?)").bind(newId("goal"), b.title.trim().slice(0, 120), b.metric, target, nowIso(c.now)).run();
  return c.json({ ok: true }, 201);
}, true);
add("POST", "/api/admin/company/agents/:id/pause", async (c, m) => {
  const b = await c.body(128);
  const r = await c.env.DB.prepare("UPDATE ai_agents SET status = ? WHERE id = ?").bind(b?.paused === true ? "paused" : "idle", m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);
add("GET", "/api/affiliate", async (c) => c.json(await affiliateSummary(c.env.DB, c.session.user.id, c.env.APP_ORIGIN)));
add("POST", "/api/affiliate/apply", async (c) => {
  const b = await c.body(512);
  const r = await applyAffiliate(c.env.DB, c.session.user.id, String(b?.payoutEmail ?? ""), c.now);
  return c.json({ ok: true, ...r }, 201);
});
add("GET", "/api/admin/affiliate/overview", async (c) => c.json(await adminAffiliateOverview(c.env.DB)), true);
add("POST", "/api/admin/affiliate/:id/status", async (c, m) => {
  const b = await c.body(256);
  if (!b || !["approved", "suspended", "rejected"].includes(b.status)) return c.json({ error: "bad_request" }, 400);
  await setAffiliateStatus(c.env.DB, c.session.user.id, m[1], b.status, c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/referrals/:id/clear-flag", async (c, m) => {
  await clearReferralFlag(c.env.DB, c.session.user.id, m[1], c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/payouts/:id/approve", async (c, m) => {
  await approvePayout(c.env.DB, c.session.user.id, m[1], c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/payouts/:id/paid", async (c, m) => {
  const b = await c.body(512);
  await markPayoutPaid(c.env.DB, c.session.user.id, m[1], String(b?.reference ?? ""), c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/payouts/:id/fail", async (c, m) => {
  const b = await c.body(512);
  await releasePayout(c.env.DB, c.session.user.id, m[1], "failed", String(b?.reason ?? ""), c.now);
  return c.json({ ok: true });
}, true);
add("POST", "/api/admin/affiliate/payouts/:id/reject", async (c, m) => {
  const b = await c.body(512);
  await releasePayout(c.env.DB, c.session.user.id, m[1], "rejected", String(b?.reason ?? ""), c.now);
  return c.json({ ok: true });
}, true);
add("PUT", "/api/admin/affiliate/policy", async (c) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  return c.json(await saveAffiliatePolicy(c.env.DB, c.session.user.id, b, c.now));
}, true);
add("POST", "/api/admin/affiliate/settle", async (c) => {
  const b = await c.body(128);
  return c.json(await settleAffiliates(c.env.DB, c.now, { forcePayout: b?.forcePayout === true }));
}, true);
add("POST", "/api/billing/portal", async (c) => {
  const rt = buildRuntime(c.env);
  return c.json(await createPortal(c.env.DB, rt.paypal, c.session.user.id, c.env.APP_ORIGIN, rt.paypalEnv));
});
var invOut = /* @__PURE__ */ __name((r) => ({ id: r.id, subscriptionId: r.subscription_id, status: r.status, totalMicro: r.total_micro, subtotalMicro: r.subtotal_micro, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at }), "invOut");
add("GET", "/api/billing/invoices", async (c) => {
  const sub = c.url.searchParams.get("subscription");
  const rows = sub ? await all(c.env.DB, "SELECT * FROM invoices WHERE customer_id = ? AND subscription_id = ? ORDER BY created_at DESC LIMIT 100", c.session.user.id, sub) : await all(c.env.DB, "SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100", c.session.user.id);
  return c.json(rows.map(invOut));
});
add("GET", "/api/billing/upcoming", async (c) => {
  const rows = await all(c.env.DB, `SELECT s.current_period_start AS ps, s.current_period_end AS pe, pr.monthly_micro AS m, s.quantity AS q
    FROM subscriptions s JOIN prices pr ON pr.id = s.price_version_id
    WHERE s.customer_id = ? AND s.status = 'active' AND s.cancel_at_period_end = 0 AND s.current_period_end IS NOT NULL ORDER BY s.current_period_end`, c.session.user.id);
  if (!rows.length) return c.json(null);
  const total = rows.reduce((a, r) => a + r.m * (r.q || 1), 0);
  return c.json({ totalMicro: total, periodStart: rows[0].ps, periodEnd: rows[0].pe, note: "\uCD08\uACFC \uC0AC\uC6A9\uB8CC \uC81C\uC678 \uAE30\uBCF8 \uC694\uAE08 \uD569\uACC4(USD)" });
});
add("GET", "/api/user/profile", async (c) => {
  const u = await one(c.env.DB, "SELECT id,email,role,status,locale,created_at FROM users WHERE id = ?", c.session.user.id);
  return c.json({ user: { id: u.id, email: u.email, role: u.role, status: u.status, locale: u.locale, createdAt: u.created_at } });
});
add("POST", "/api/user/password", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.currentPassword !== "string" || typeof b.newPassword !== "string") return c.json({ error: "bad_request" }, 400);
  const row = await one(c.env.DB, "SELECT password_hash FROM users WHERE id = ?", c.session.user.id);
  if (!row || !await verifyPassword(b.currentPassword, row.password_hash)) return c.json({ error: "invalid_credentials", message: "\uD604\uC7AC \uBE44\uBC00\uBC88\uD638\uAC00 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }, 403);
  const hash = await hashPasswordForUser(b.newPassword);
  if (!hash.ok) return c.json({ error: "weak_password", message: hash.message }, 400);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(hash.hash, nowIso(c.now), c.session.user.id).run();
  await c.env.DB.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL").bind(nowIso(c.now), c.session.user.id, c.session.sessionId).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "user.password_change", targetType: "user", targetId: c.session.user.id }, c.now);
  return c.json({ ok: true });
});
add("DELETE", "/api/user/account", async (c) => {
  const open = await one(c.env.DB, "SELECT COUNT(*) AS n FROM subscriptions WHERE customer_id = ? AND status IN ('active','past_due','suspended','canceling')", c.session.user.id);
  if (open && open.n > 0) return c.json({ error: "active_subscriptions", message: "\uD65C\uC131 \uAD6C\uB3C5\uC774 \uC788\uC5B4 \uC0AD\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 \uBAA8\uB4E0 \uC11C\uBE44\uC2A4\uB97C \uCDE8\uC18C\uD558\uC138\uC694." }, 409);
  await c.env.DB.prepare("UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?").bind(nowIso(c.now), c.session.user.id).run();
  await revokeAllSessions(c.env.DB, c.session.user.id, c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "user.delete", targetType: "user", targetId: c.session.user.id }, c.now);
  return c.json({ ok: true });
});
add("GET", "/api/domains", async (c) => {
  const zones = await all(c.env.DB, "SELECT id, hostname, status, name_servers_json, created_at, activated_at FROM dns_zones WHERE customer_id = ? ORDER BY created_at DESC", c.session.user.id);
  const orders = await all(c.env.DB, "SELECT id, hostname, status, created_at FROM domain_orders WHERE customer_id = ? AND status NOT IN ('expired','cancelled') ORDER BY created_at DESC", c.session.user.id);
  const seen = new Set(zones.map((z) => z.hostname));
  return c.json([
    ...zones.map((z) => ({ id: z.id, hostname: z.hostname, ownershipStatus: z.status === "active" ? "verified" : "pending", sslStatus: z.status === "active" ? "active" : "pending", nameServers: parseJson(z.name_servers_json, []), createdAt: z.created_at, kind: "zone" })),
    ...orders.filter((o) => !seen.has(o.hostname)).map((o) => ({ id: o.id, hostname: o.hostname, ownershipStatus: "pending", sslStatus: "pending", orderStatus: o.status, createdAt: o.created_at, kind: "order" }))
  ]);
});
add("POST", "/api/domains", async (c) => {
  const b = await c.body(8192);
  if (!b || typeof b.hostname !== "string") return c.json({ error: "bad_request" }, 400);
  const rt = buildRuntime(c.env);
  const r = await connectDomain(c.env.DB, rt.zones, c.session.user.id, b.hostname, c.now);
  return c.json({ ok: true, ...r }, 201);
});
add("GET", "/api/domains/check", async (c) => {
  const q = (c.url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(q) || q.length > 253) return c.json({ error: "bad_hostname" }, 400);
  const taken = await one(c.env.DB, "SELECT 1 AS x FROM dns_zones WHERE hostname = ? AND status != 'deleted'", q);
  return c.json({ hostname: q, connectedInCloudPress: !!taken, note: "\uB4F1\uB85D \uAC00\uB2A5 \uC5EC\uBD80\uC640 \uAC00\uACA9\uC740 \uACAC\uC801 \uC694\uCCAD \uC2DC \uB4F1\uB85D\uAE30\uAD00\uC5D0\uC11C \uD655\uC778\uD569\uB2C8\uB2E4." });
});
add("POST", "/api/domains/quote", async (c) => {
  const b = await c.body(8192);
  if (!b || typeof b.hostname !== "string" || typeof b.contact !== "object") return c.json({ error: "bad_request" }, 400);
  const rt = buildRuntime(c.env);
  const r = await createQuote(c.env.DB, rt.registrar, rt.crypto, { customerId: c.session.user.id, hostname: b.hostname, contact: b.contact, nowMs: c.now });
  return c.json(r, 201);
});
add("POST", "/api/domains/orders/:id/checkout", async (c, m) => {
  const rt = buildRuntime(c.env);
  return c.json(await createDomainCheckout(c.env.DB, rt.paypal, c.session.user.id, m[1], { appOrigin: c.env.APP_ORIGIN, nowMs: c.now }));
});
add("GET", "/api/containers", async (c) => {
  const rows = await all(c.env.DB, `SELECT c.id, c.subscription_id, c.instance_type, c.target_vcpu, c.actual_vcpu, c.state, c.created_at,
      (SELECT ip FROM container_instances i WHERE i.container_id = c.id ORDER BY i.created_at DESC LIMIT 1) AS ip
    FROM containers c WHERE c.customer_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at DESC`, c.session.user.id);
  return c.json(rows);
});
for (const act of ["start", "stop", "restart", "delete"]) {
  add("POST", `/api/containers/:id/${act}`, async (c, m) => {
    const owned = await one(c.env.DB, "SELECT id FROM containers WHERE id = ? AND customer_id = ? AND deleted_at IS NULL", m[1], c.session.user.id);
    if (!owned) return c.json({ error: "not_found" }, 404);
    if (c.env.CLOUDPRESS_MODE === "live") return c.json({ error: "not_configured", message: "\uCEE8\uD14C\uC774\uB108 \uB9E4\uB2C8\uC800\uAC00 \uC544\uC9C1 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC544 \uC774 \uC791\uC5C5\uC744 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uC6B4\uC601\uC790\uC5D0\uAC8C \uBB38\uC758\uD558\uC138\uC694." }, 503);
    const to = act === "start" || act === "restart" ? "running" : act === "stop" ? "stopped" : "deleted";
    await c.env.DB.prepare("UPDATE containers SET state = ?, deleted_at = CASE WHEN ? = 'deleted' THEN ? ELSE deleted_at END WHERE id = ?").bind(to, to, nowIso(c.now), m[1]).run();
    await audit(c.env.DB, { actorId: c.session.user.id, action: `container.${act}`, targetType: "container", targetId: m[1] }, c.now);
    return c.json({ ok: true, state: to, mode: "mock" });
  });
}
add("GET", "/api/databases", async (c) => {
  const dbs = await all(c.env.DB, "SELECT id, subscription_id, engine, provider, state, storage_limit_gb, last_backup_at, created_at FROM databases WHERE customer_id = ? ORDER BY created_at DESC", c.session.user.id);
  const out = [];
  for (const d of dbs) {
    out.push({
      ...d,
      replicas: await all(c.env.DB, "SELECT id, replica_type, status, replication_lag_ms FROM database_replicas WHERE database_id = ?", d.id),
      pitrSnapshots: await all(c.env.DB, "SELECT id, created_at, expires_at FROM database_pitr_snapshots WHERE database_id = ?", d.id)
    });
  }
  return c.json({ databases: out });
});
add("POST", "/api/databases", async (c) => c.json({ error: "purchase_required", message: "ClouDB \uC0C1\uD488\uC744 \uAD6C\uB3C5\uD558\uBA74 \uACB0\uC81C \uD655\uC778 \uD6C4 \uC790\uB3D9\uC73C\uB85C \uC0DD\uC131\uB429\uB2C8\uB2E4.", next: "/services/create" }, 402));
for (const [act, label] of [["backup", "\uBC31\uC5C5"], ["replicas", "\uB808\uD50C\uB9AC\uCE74"]]) {
  add("POST", `/api/databases/:id/${act}`, async (c, m) => {
    const d = await one(c.env.DB, "SELECT id FROM databases WHERE id = ? AND customer_id = ?", m[1], c.session.user.id);
    if (!d) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "not_configured", message: `${label} \uC2E4\uD589\uAE30(\uCEE8\uD14C\uC774\uB108\xB7R2 \uC5F0\uB3D9)\uAC00 \uC544\uC9C1 \uC5F0\uACB0\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.` }, 503);
  });
}
add("GET", "/api/admin/summary", async (c) => {
  const db = c.env.DB;
  const users = await one(db, "SELECT COUNT(*) AS n FROM users WHERE status != 'deleted'");
  const subs = await one(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'");
  const rev = await one(db, "SELECT COALESCE(SUM(amount_micro),0) AS s FROM payments WHERE status = 'succeeded' AND paid_at >= ?", nowIso(c.now - 30 * 864e5));
  const dead = await one(db, "SELECT COUNT(*) AS n FROM deployment_jobs WHERE state = 'dead'");
  const waste = await all(db, "SELECT resource_id, kind, payload_json FROM resource_recommendations WHERE status = 'open' ORDER BY est_saving_micro DESC LIMIT 20").catch(() => []);
  const pend = await one(db, "SELECT COUNT(*) AS n FROM affiliate_payouts WHERE status = 'pending'");
  return c.json({
    totalUsers: users?.n ?? 0,
    activeSubscriptions: subs?.n ?? 0,
    totalRevenueMicro: rev?.s ?? 0,
    systemHealth: (dead?.n ?? 0) > 0 ? "degraded" : "healthy",
    wasteResources: waste.map((w) => {
      const p = parseJson(w.payload_json, {});
      return { resourceId: w.resource_id, kind: w.kind, detail: p.detail ?? "", action: p.action ?? "" };
    }),
    pendingApprovals: pend?.n ?? 0
  });
}, true);
add("GET", "/api/admin/users", async (c) => c.json({ users: await all(c.env.DB, "SELECT id, email, role, status, created_at FROM users ORDER BY created_at DESC LIMIT 500") }), true);
add("PATCH", "/api/admin/users/:id", async (c, m) => {
  const b = await c.body(1024);
  if (!b) return c.json({ error: "bad_request" }, 400);
  if (m[1] === c.session.user.id) return c.json({ error: "self_change", message: "\uC790\uAE30 \uC790\uC2E0\uC758 \uAD8C\uD55C\xB7\uC0C1\uD0DC\uB294 \uBCC0\uACBD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 400);
  const sets = [];
  const vals = [];
  if (b.status !== void 0) {
    if (!["active", "suspended"].includes(b.status)) return c.json({ error: "bad_status" }, 400);
    sets.push("status = ?");
    vals.push(b.status);
  }
  if (b.role !== void 0) {
    if (!["customer", "admin", "affiliate_only"].includes(b.role)) return c.json({ error: "bad_role" }, 400);
    sets.push("role = ?");
    vals.push(b.role);
  }
  if (!sets.length) return c.json({ error: "nothing_to_update" }, 400);
  const r = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND status != 'deleted'`).bind(...vals, nowIso(c.now), m[1]).run();
  if (r.meta.changes === 0) return c.json({ error: "not_found" }, 404);
  if (b.status === "suspended") await revokeAllSessions(c.env.DB, m[1], c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.user_update", targetType: "user", targetId: m[1], detail: { status: b.status, role: b.role } }, c.now);
  return c.json({ ok: true });
}, true);
add("GET", "/api/admin/subscriptions", async (c) => c.json({ subscriptions: await all(c.env.DB, `SELECT s.id, u.email AS customer_email, p.kind AS product_kind, s.status, s.billing_interval, s.current_period_end
  FROM subscriptions s JOIN users u ON u.id = s.customer_id JOIN products p ON p.id = s.product_id ORDER BY s.created_at DESC LIMIT 500`) }), true);
add("GET", "/api/admin/billing", async (c) => {
  const db = c.env.DB;
  const rev = await one(db, "SELECT COALESCE(SUM(amount_micro),0) AS s FROM payments WHERE status = 'succeeded' AND paid_at >= ?", nowIso(c.now - 30 * 864e5));
  const out = await one(db, "SELECT COALESCE(SUM(total_micro),0) AS s FROM invoices WHERE status = 'open'");
  const ref = await one(db, "SELECT COUNT(*) AS n FROM refunds");
  const act = await one(db, "SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'");
  const invoices = await all(db, `SELECT i.id, u.email AS customer_email, i.total_micro, i.status, i.created_at,
      (SELECT paid_at FROM payments WHERE invoice_id = i.id AND status = 'succeeded' ORDER BY paid_at DESC LIMIT 1) AS paid_at
    FROM invoices i JOIN users u ON u.id = i.customer_id ORDER BY i.created_at DESC LIMIT 200`);
  return c.json({ monthlyRevenue: rev?.s ?? 0, outstanding: out?.s ?? 0, refundsCount: ref?.n ?? 0, activeSubscriptions: act?.n ?? 0, invoices });
}, true);
add("GET", "/api/admin/system", async (c) => {
  const db = c.env.DB;
  let d1Healthy = true;
  try {
    await one(db, "SELECT 1 AS ok");
  } catch {
    d1Healthy = false;
  }
  const q = await all(db, "SELECT state, COUNT(*) AS n FROM deployment_jobs GROUP BY state");
  const n = /* @__PURE__ */ __name((s) => q.find((r) => r.state === s)?.n ?? 0, "n");
  const cont = await one(db, "SELECT COUNT(*) AS n FROM containers WHERE state = 'running' AND deleted_at IS NULL");
  const errs = await all(db, "SELECT action, target_type, ts, detail_json FROM audit_logs WHERE action LIKE '%failed%' OR action LIKE '%error%' ORDER BY ts DESC LIMIT 20");
  return c.json({
    apiP99: null,
    // Workers 요청 지연 분포는 이 API 에서 측정하지 않는다(관측 대시보드 사용).
    queuePending: n("queued") + n("retrying"),
    d1Healthy,
    activeContainers: cont?.n ?? 0,
    recentErrors: errs.map((e) => ({ message: e.action, timestamp: e.ts, endpoint: e.target_type ?? "-" })),
    queues: [{ name: "cloudpress-jobs", status: n("dead") > 0 ? "degraded" : "healthy", pending: n("queued"), processing: n("running"), completed: n("succeeded"), failed: n("failed") + n("dead") }],
    workers: []
  });
}, true);
add("POST", "/api/admin/fx", async (c) => {
  const b = await c.body(512);
  const won = Number(b?.wonPerUsd);
  if (!Number.isFinite(won) || won < 100 || won > 1e5) return c.json({ error: "bad_rate", message: "100~100,000 \uC0AC\uC774 \uAC12\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4." }, 400);
  const res = await recordFxSample(c.env.DB, { rateMicro: Math.round(won * 1e6), fetchedAtMs: c.now, source: "admin" }, c.now);
  await audit(c.env.DB, { actorId: c.session.user.id, action: "admin.fx_update", detail: { won, status: res.status } }, c.now);
  return c.json({ ok: true, status: res.status, reason: res.reason });
}, true);
var routeOut = /* @__PURE__ */ __name((r) => ({ ...r, methods: parseJson(r.methods_json, []) }), "routeOut");
add("GET", "/api/gateway/routes", async (c) => c.json({ routes: (await all(c.env.DB, "SELECT * FROM api_gateway_routes ORDER BY created_at DESC")).map(routeOut) }), true);
add("POST", "/api/gateway/routes", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.name !== "string" || typeof b.pathPattern !== "string" || !b.targetService && !b.targetUrl) return c.json({ error: "bad_request" }, 400);
  if (b.targetUrl && !/^https:\/\//.test(String(b.targetUrl))) return c.json({ error: "bad_target", message: "targetUrl \uC740 https \uB9CC \uD5C8\uC6A9\uB429\uB2C8\uB2E4." }, 400);
  const id = newId("rt");
  const t = nowIso(c.now);
  try {
    await c.env.DB.prepare(`INSERT INTO api_gateway_routes(id,name,path_pattern,methods_json,target_service,target_url,strip_path_prefix,timeout_ms,retries,retry_backoff_ms,circuit_breaker_threshold,circuit_breaker_timeout_sec,auth_required,roles_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id,
      b.name,
      b.pathPattern,
      JSON.stringify(b.methods ?? ["GET"]),
      b.targetService ?? null,
      b.targetUrl ?? null,
      b.stripPathPrefix ? 1 : 0,
      Math.min(Number(b.timeoutMs) || 3e4, 12e4),
      Math.min(Number(b.retries) || 0, 5),
      Number(b.retryBackoffMs) || 100,
      Number(b.circuitBreakerThreshold) || 5,
      Number(b.circuitBreakerTimeoutSec) || 30,
      b.authRequired === false ? 0 : 1,
      JSON.stringify(b.roles ?? []),
      t,
      t
    ).run();
  } catch (e) {
    return c.json({ error: "conflict", message: "\uC774\uB984 \uB610\uB294 \uACBD\uB85C\uAC00 \uC774\uBBF8 \uC874\uC7AC\uD558\uAC70\uB098 \uAC12\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }, 409);
  }
  await audit(c.env.DB, { actorId: c.session.user.id, action: "gateway.route_create", targetType: "route", targetId: id }, c.now);
  return c.json({ ok: true, id }, 201);
}, true);
add("DELETE", "/api/gateway/routes/:id", async (c, m) => {
  const r = await c.env.DB.prepare("DELETE FROM api_gateway_routes WHERE id = ?").bind(m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);
add("GET", "/api/mesh/services", async (c) => {
  const ns = c.url.searchParams.get("namespace") ?? "default";
  const rows = await all(c.env.DB, "SELECT service_name, namespace, COUNT(*) AS n FROM service_endpoints WHERE namespace = ? AND deregistered_at IS NULL AND healthy = 1 GROUP BY service_name, namespace", ns);
  return c.json({ services: rows.map((r) => ({ serviceName: r.service_name, namespace: r.namespace, endpointCount: r.n })) });
}, true);
add("GET", "/api/mesh/policies", async (c) => c.json({ policies: (await all(c.env.DB, "SELECT * FROM traffic_policies ORDER BY priority, created_at")).map((p) => ({ id: p.id, sourceService: p.source_service, targetService: p.target_service, namespace: p.namespace, policy: p.policy, priority: p.priority, config: parseJson(p.config_json, {}) })) }), true);
add("POST", "/api/mesh/policies", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.sourceService !== "string" || typeof b.targetService !== "string" || typeof b.policy !== "string") return c.json({ error: "bad_request" }, 400);
  const id = newId("tp");
  const t = nowIso(c.now);
  try {
    await c.env.DB.prepare("INSERT INTO traffic_policies(id,source_service,target_service,namespace,policy,config_json,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, b.sourceService, b.targetService, b.namespace ?? "default", b.policy, JSON.stringify(b.config ?? {}), Number(b.priority) || 100, t, t).run();
  } catch {
    return c.json({ error: "bad_policy", message: "\uC815\uCC45 \uAC12\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }, 400);
  }
  return c.json({ ok: true, id }, 201);
}, true);
add("GET", "/api/mesh/certificates", async (c) => c.json({ certificates: await all(c.env.DB, "SELECT id, service_name, namespace, issued_at, expires_at FROM service_certificates WHERE revoked = 0 ORDER BY expires_at") }), true);
add("GET", "/api/observability/alerts", async (c) => c.json({ alerts: (await all(c.env.DB, `SELECT e.id, e.alert_id, a.name AS alert_name, a.metric_name, a.severity, e.status, e.value
  FROM observability_alert_events e JOIN observability_alerts a ON a.id = e.alert_id ORDER BY e.started_at DESC LIMIT 200`)).map((r) => ({ id: r.id, alertId: r.alert_id, alertName: r.alert_name, metricName: r.metric_name, severity: r.severity, status: r.status, value: r.value })) }), true);
add("POST", "/api/observability/alerts", async (c) => {
  const b = await c.body(4096);
  if (!b || typeof b.name !== "string" || typeof b.metricName !== "string" || typeof b.condition !== "object") return c.json({ error: "bad_request" }, 400);
  const id = newId("al");
  const t = nowIso(c.now);
  try {
    await c.env.DB.prepare("INSERT INTO observability_alerts(id,name,description,metric_name,condition_json,severity,enabled,notification_channels_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(id, b.name, b.description ?? null, b.metricName, JSON.stringify(b.condition), b.severity ?? "warning", b.enabled === false ? 0 : 1, JSON.stringify(b.notificationChannels ?? []), t, t).run();
  } catch {
    return c.json({ error: "conflict", message: "\uC774\uBBF8 \uAC19\uC740 \uC774\uB984\uC758 \uC54C\uB9BC\uC774 \uC788\uAC70\uB098 \uAC12\uC774 \uC62C\uBC14\uB974\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." }, 409);
  }
  return c.json({ ok: true, id }, 201);
}, true);
add("POST", "/api/observability/alerts/:id/ack", async (c, m) => {
  const r = await c.env.DB.prepare("UPDATE observability_alert_events SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND status = 'firing'").bind(nowIso(c.now), c.session.user.id, m[1]).run();
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
}, true);
add("GET", "/api/observability/slos", async (c) => c.json({ slos: (await all(c.env.DB, "SELECT * FROM observability_slos ORDER BY created_at DESC")).map((s) => ({ id: s.id, name: s.name, service: s.service, target: s.target, window: s.window, current: null, met: false, errorBudgetRemaining: 0 })) }), true);
add("POST", "/api/observability/metrics/query", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.name !== "string") return c.json({ error: "bad_request" }, 400);
  const from = new Date(Number(b.fromMs) || c.now - 36e5).toISOString();
  const to = new Date(Number(b.toMs) || c.now).toISOString();
  const agg = ["avg", "sum", "min", "max", "count"].includes(b.aggregation) ? b.aggregation.toUpperCase() : "AVG";
  const r = await one(c.env.DB, `SELECT ${agg}(value) AS value, COUNT(*) AS points FROM observability_metrics WHERE metric_name = ? AND timestamp BETWEEN ? AND ?`, b.name, from, to);
  return c.json({ name: b.name, aggregation: agg.toLowerCase(), value: r?.value ?? null, points: r?.points ?? 0, from, to });
}, true);
var depOut = /* @__PURE__ */ __name((d) => ({ id: d.id, name: d.name, status: d.status, strategy: parseJson(d.strategy_json, {}).type ?? "rolling", currentStep: d.current_step, totalSteps: d.total_steps, targetVersion: d.target_version, startedAt: d.started_at }), "depOut");
add("GET", "/api/fleet/deployments", async (c) => c.json({ deployments: (await all(c.env.DB, "SELECT * FROM fleet_deployments ORDER BY started_at DESC LIMIT 200")).map(depOut) }), true);
add("POST", "/api/fleet/deployments", async (c) => {
  const b = await c.body(2048);
  if (!b || typeof b.name !== "string" || typeof b.targetVersion !== "string") return c.json({ error: "bad_request" }, 400);
  const type = b.strategy?.type ?? "rolling";
  if (!["rolling", "canary", "blue_green", "recreate"].includes(type)) return c.json({ error: "bad_strategy" }, 400);
  const id = newId("deploy");
  await c.env.DB.prepare("INSERT INTO fleet_deployments(id,name,subscription_id,strategy_json,status,current_step,total_steps,target_version,started_at) VALUES(?,?,NULL,?,'pending',0,?,?,?)").bind(id, b.name, JSON.stringify({ ...b.strategy, type }), type === "recreate" ? 1 : 5, b.targetVersion, nowIso(c.now)).run();
  await audit(c.env.DB, { actorId: c.session.user.id, action: "fleet.deployment_create", targetType: "deployment", targetId: id }, c.now);
  return c.json({ ok: true, id, note: "\uBC30\uD3EC \uAE30\uB85D\uC774 \uC0DD\uC131\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC2E4\uC81C \uB864\uC544\uC6C3\uC740 \uCEE8\uD14C\uC774\uB108 \uB9E4\uB2C8\uC800 \uC5F0\uACB0 \uD6C4 \uC2E4\uD589\uB429\uB2C8\uB2E4." }, 201);
}, true);
for (const [act, from, to] of [["pause", "running", "paused"], ["resume", "paused", "running"], ["rollback", "", "rolled_back"]]) {
  add("POST", `/api/fleet/deployments/:id/${act}`, async (c, m) => {
    const r = act === "rollback" ? await c.env.DB.prepare("UPDATE fleet_deployments SET status = 'rolled_back' WHERE id = ? AND status != 'rolled_back'").bind(m[1]).run() : await c.env.DB.prepare("UPDATE fleet_deployments SET status = ? WHERE id = ? AND status = ?").bind(to, m[1], from).run();
    if (!r.meta.changes) return c.json({ error: "bad_state", message: "\uD604\uC7AC \uC0C1\uD0DC\uC5D0\uC11C\uB294 \uC2E4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." }, 409);
    await audit(c.env.DB, { actorId: c.session.user.id, action: `fleet.${act}`, targetType: "deployment", targetId: m[1] }, c.now);
    return c.json({ ok: true });
  }, true);
}

// src/worker.ts
var limiter = new MemoryRateLimiter();
var SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cache-Control": "no-store"
};
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra }
  });
}
__name(json, "json");
async function readJson(req, maxBytes) {
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
__name(readJson, "readJson");
var clientIp = /* @__PURE__ */ __name((req) => req.headers.get("CF-Connecting-IP") ?? "unknown", "clientIp");
var schemaOk = false;
var REQUIRED_TABLES = ["users", "user_sessions", "products", "prices", "subscriptions", "audit_logs"];
async function schemaReady(db) {
  if (schemaOk) return null;
  for (const t of REQUIRED_TABLES) {
    try {
      await db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).first();
    } catch {
      return t;
    }
  }
  schemaOk = true;
  return null;
}
__name(schemaReady, "schemaReady");
async function handleAiGateway(req, env) {
  const h = { "Content-Type": "application/json", ...SECURITY_HEADERS };
  const out = /* @__PURE__ */ __name((d, st = 200) => new Response(JSON.stringify(d), { status: st, headers: h }), "out");
  if (req.method !== "POST") return out({ error: "method_not_allowed" }, 405);
  const raw = await req.text();
  if (raw.length > 262144) return out({ error: "too_large", message: "\uC694\uCCAD \uBCF8\uBB38\uC740 256KB \uC774\uD558\uC5EC\uC57C \uD569\uB2C8\uB2E4." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return out({ error: "bad_json" }, 400);
  }
  try {
    const rt = buildRuntime(env);
    const auth = req.headers.get("Authorization");
    const r = await runGateway(
      env.DB,
      rt.ai,
      auth?.startsWith("Bearer ") ? auth.slice(7) : null,
      body,
      { nowMs: Date.now(), requestId: (req.headers.get("X-Request-Id") ?? crypto.randomUUID()).slice(0, 80), maxOutputTokens: typeof body.max_tokens === "number" ? body.max_tokens : void 0 }
    );
    if (!r.ok) return out({ error: r.error, message: r.message }, r.status);
    return out({ result: r.result, usage: r.usage, estimated_neurons: r.neurons, billed_micro_usd: r.billedMicro, balance_micro_usd: r.balanceMicro, note: "Neurons \uB294 \uACF5\uC2DD \uB2E8\uAC00\uB85C \uD658\uC0B0\uD55C \uCD94\uC815\uCE58\uC785\uB2C8\uB2E4." });
  } catch (e) {
    console.error("[AI Gateway Error]", e instanceof Error ? e.message : e);
    return out({ error: "internal_error" }, 500);
  }
}
__name(handleAiGateway, "handleAiGateway");
async function handleApi(req, env) {
  const url = new URL(req.url);
  const now = Date.now();
  try {
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        mode: env.CLOUDPRESS_MODE,
        paypalWebhookConfigured: Boolean(env.PAYPAL_WEBHOOK_ID),
        encryptionKeyConfigured: Boolean(env.SECRETS_ENCRYPTION_KEY),
        liveIntegrations: [],
        schemaMissingTable: await schemaReady(env.DB)
      });
    }
    {
      const missing = await schemaReady(env.DB);
      if (missing) return json({ error: "schema_not_ready", message: `\uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uB9C8\uC774\uADF8\uB808\uC774\uC158\uC774 \uC801\uC6A9\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4(\uC5C6\uB294 \uD14C\uC774\uBE14: ${missing}). \uC6B4\uC601\uC790\uAC00 'wrangler d1 migrations apply'\uB97C \uC2E4\uD589\uD574\uC57C \uD569\uB2C8\uB2E4.` }, 503);
    }
    if (url.pathname === "/api/webhooks/paypal" && req.method === "POST") {
      const webhookId = env.PAYPAL_WEBHOOK_ID ?? (env.CLOUDPRESS_MODE === "live" ? void 0 : "WH-MOCK");
      if (!webhookId) return json({ error: "webhook_not_configured" }, 503);
      const raw = await req.text();
      if (raw.length > 1e6) return json({ error: "too_large" }, 413);
      const rt = buildRuntime(env);
      const r = await handlePayPalWebhook(env.DB, rt.paypal, raw, paypalWebhookHeaders(req.headers), webhookId, now);
      if (r.status === 200 && env.JOBS) await dispatchOutbox(env.DB, env.JOBS, now).catch(() => 0);
      return new Response(r.body, { status: r.status, headers: SECURITY_HEADERS });
    }
    if (!originAllowed(req.method, req.headers.get("Origin"), env.APP_ORIGIN)) {
      return json({ error: "bad_origin" }, 403);
    }
    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      const rl = await limiter.hit("reg:" + clientIp(req), 5, 3600, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      const b = await readJson(req, 4096);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") {
        return json({ error: "bad_request" }, 400);
      }
      try {
        const r = await registerUser(env.DB, b.email, b.password, now);
        if (r.ok && typeof b.ref === "string") {
          try {
            await bindReferral(env.DB, { id: r.userId, email: b.email.trim().toLowerCase() }, b.ref, now);
          } catch (e) {
            console.error("[referral]", e instanceof Error ? e.message : e);
          }
        }
        return r.ok ? json({ ok: true }, 201) : json({ error: r.code, message: r.message }, r.code === "email_taken" ? 409 : 400);
      } catch (regErr) {
        console.error("[Register Error Detail]", regErr?.message, regErr?.stack);
        return json({ error: "internal_error" }, 500);
      }
    }
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const b = await readJson(req, 4096);
      if (!b || typeof b.email !== "string" || typeof b.password !== "string") return json({ error: "bad_request" }, 400);
      const rl = await limiter.hit("login:" + clientIp(req) + ":" + b.email.toLowerCase(), 10, 900, now);
      if (!rl.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });
      try {
        const r = await login(env.DB, b.email, b.password, now);
        if (!r.ok) return json({ error: r.code === "suspended" ? "account_suspended" : "invalid_credentials" }, r.code === "suspended" ? 403 : 401);
        return json({ ok: true, csrfToken: r.csrfToken, user: { id: r.user.id, email: r.user.email, role: r.user.role } }, 200, { "Set-Cookie": sessionCookie(r.token) });
      } catch (loginErr) {
        console.error("[Login Error Detail]", loginErr?.message, loginErr?.stack);
        return json({ error: "internal_error", details: loginErr?.message }, 500);
      }
    }
    const session = await getSession(env.DB, parseCookie(req.headers.get("Cookie"), SESSION_COOKIE), now);
    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      return session ? json({ user: session.user }) : json({ error: "unauthenticated" }, 401);
    }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      if (!session) return json({ error: "unauthenticated" }, 401);
      if (!await verifyCsrf(session, req.headers.get("X-CSRF-Token"))) return json({ error: "bad_csrf" }, 403);
      await logout(env.DB, session.sessionId, now);
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
    }
    if (url.pathname === "/api/auth/csrf" && req.method === "GET") {
      return session ? json({ authenticated: true, csrfToken: await rotateCsrf(env.DB, session.sessionId), user: session.user }) : json({ authenticated: false });
    }
    if (url.pathname === "/api/plans" && req.method === "GET") {
      return json(await listPlans(env.DB));
    }
    if (!session) return json({ error: "unauthenticated" }, 401);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !await verifyCsrf(session, req.headers.get("X-CSRF-Token"))) {
      return json({ error: "bad_csrf", message: "\uBCF4\uC548 \uD1A0\uD070\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uD398\uC774\uC9C0\uB97C \uC0C8\uB85C\uACE0\uCE68\uD558\uC138\uC694." }, 403);
    }
    const routed = await routeApi({
      req,
      env,
      url,
      now,
      session,
      json: /* @__PURE__ */ __name((d, st, ex) => json(d, st, ex), "json"),
      body: /* @__PURE__ */ __name((max = 8192) => readJson(req, max), "body")
    });
    if (routed) return routed;
    return json({ error: "not_found" }, 404);
  } catch (e) {
    console.error("[API Fatal Error]", e?.message, e?.stack);
    if (/no such table/i.test(String(e?.message))) return json({ error: "schema_not_ready", message: "\uB370\uC774\uD130\uBCA0\uC774\uC2A4 \uB9C8\uC774\uADF8\uB808\uC774\uC158\uC774 \uCD5C\uC2E0\uC774 \uC544\uB2D9\uB2C8\uB2E4. \uC6B4\uC601\uC790\uAC00 'wrangler d1 migrations apply'\uB97C \uC2E4\uD589\uD574\uC57C \uD569\uB2C8\uB2E4." }, 503);
    if (e instanceof ServiceError) return json({ error: e.code, message: e.message }, e.code === "not_found" ? 404 : ["bad_state", "pending_exists", "limit_exceeded", "no_container"].includes(e.code) ? 409 : 400);
    if (e instanceof ForbiddenError) return json({ error: "forbidden" }, 403);
    if (e instanceof ConfigError) return json({ error: "not_configured", message: e.message }, 503);
    return json({ error: "internal_error", details: e?.message }, 500);
  }
}
__name(handleApi, "handleApi");
var worker_default = {
  async fetch(req, env, _ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/ai/run") return handleAiGateway(req, env);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env);
    }
    if (!env.ASSETS) return new Response("not found", { status: 404 });
    const assetResponse = await env.ASSETS.fetch(req);
    if (assetResponse.status === 404 && /^\/services\/[^/]+\/?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/services/_/", url), req));
    }
    return assetResponse;
  },
  async queue(batch, env) {
    const rt = buildRuntime(env);
    await consumeBatch({
      db: env.DB,
      nowMs: Date.now(),
      paypal: rt.paypal,
      portFor: rt.portFor,
      nsPortFor: rt.nsPortFor,
      zones: rt.zones,
      crypto: rt.crypto,
      provisioner: rt.provisioner
    }, batch.messages);
  },
  async scheduled(_event, env) {
    const rt = buildRuntime(env);
    await runScheduled(env.DB, { queue: env.JOBS ?? null, zones: rt.zones }, Date.now());
    try {
      await runTick(env.DB, rt.llm, Date.now());
    } catch (e) {
      console.error("[workforce tick]", e instanceof Error ? e.message : e);
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
