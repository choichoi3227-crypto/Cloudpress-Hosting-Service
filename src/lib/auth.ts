import { type D1Like, newId, nowIso } from "./db";
import { hashPassword, verifyPassword, randomToken, sha256Hex, constantTimeEqual } from "./crypto";

export const SESSION_COOKIE = "__Host-cp_session";
export const SESSION_TTL_SEC = 7 * 24 * 3600;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export interface UserRow { id: string; email: string; role: "customer" | "admin" | "affiliate_only"; status: "active" | "suspended" | "deleted" }

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}
export function validatePassword(pw: string): string | null {
  if (pw.length < 12) return "비밀번호는 12자 이상이어야 합니다.";
  if (pw.length > 128) return "비밀번호는 128자 이하여야 합니다.";
  if (/^(.)\1+$/.test(pw)) return "너무 단순한 비밀번호입니다.";
  return null;
}

export type RegisterResult = { ok: true; userId: string } | { ok: false; code: "invalid_email" | "weak_password" | "email_taken"; message: string };

export async function registerUser(db: D1Like, emailRaw: string, password: string, nowMs: number): Promise<RegisterResult> {
  const email = normalizeEmail(emailRaw);
  if (!email) return { ok: false, code: "invalid_email", message: "이메일 형식이 올바르지 않습니다." };
  const weak = validatePassword(password);
  if (weak) return { ok: false, code: "weak_password", message: weak };
  const id = newId("usr");
  const hash = await hashPassword(password);
  // UNIQUE 제약으로 경쟁 상태에서도 중복 가입을 막는다(먼저 SELECT 하지 않음).
  const r = await db.prepare("INSERT OR IGNORE INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)").bind(id, email, hash, nowIso(nowMs), nowIso(nowMs)).run();
  if (r.meta.changes === 0) return { ok: false, code: "email_taken", message: "이미 가입된 이메일입니다." };
  await audit(db, { actorId: id, action: "user.register", targetType: "user", targetId: id }, nowMs);
  return { ok: true, userId: id };
}

// 사용자 없음/비밀번호 불일치를 시간·메시지로 구분할 수 없게 더미 해시를 검증한다.
let dummyHash: Promise<string> | undefined;

export type LoginResult = { ok: true; token: string; csrfToken: string; user: UserRow } | { ok: false; code: "invalid_credentials" | "suspended" };

export async function login(db: D1Like, emailRaw: string, password: string, nowMs: number): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw) ?? "";
  const row = await db.prepare("SELECT id,email,role,status,password_hash FROM users WHERE email = ?").bind(email).first<UserRow & { password_hash: string }>();
  dummyHash ??= hashPassword("dummy-password-for-timing");
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash));
  if (!row || !ok) {
    await audit(db, { actorId: row?.id ?? null, action: "user.login_failed", targetType: "user", targetId: row?.id ?? null }, nowMs);
    return { ok: false, code: "invalid_credentials" };
  }
  if (row.status !== "active") return { ok: false, code: "suspended" };
  const token = randomToken();
  const csrfToken = randomToken();
  await db.prepare("INSERT INTO user_sessions(id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)")
    .bind(newId("ses"), row.id, await sha256Hex(token), await sha256Hex(csrfToken), nowIso(nowMs + SESSION_TTL_SEC * 1000), nowIso(nowMs)).run();
  await audit(db, { actorId: row.id, action: "user.login", targetType: "user", targetId: row.id }, nowMs);
  return { ok: true, token, csrfToken, user: { id: row.id, email: row.email, role: row.role, status: row.status } };
}

export interface SessionInfo { sessionId: string; csrfHash: string; user: UserRow }

export async function getSession(db: D1Like, token: string | null | undefined, nowMs: number): Promise<SessionInfo | null> {
  if (!token) return null;
  const r = await db.prepare(
    `SELECT s.id AS sid, s.csrf_hash, s.expires_at, s.revoked_at, u.id, u.email, u.role, u.status
       FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<{ sid: string; csrf_hash: string; expires_at: string; revoked_at: string | null; id: string; email: string; role: UserRow["role"]; status: UserRow["status"] }>();
  if (!r || r.revoked_at || r.status !== "active" || Date.parse(r.expires_at) <= nowMs) return null;
  return { sessionId: r.sid, csrfHash: r.csrf_hash, user: { id: r.id, email: r.email, role: r.role, status: r.status } };
}

export async function logout(db: D1Like, sessionId: string, nowMs: number): Promise<void> {
  await db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(nowMs), sessionId).run();
}

/** 계정 정지 시 모든 세션을 즉시 폐기. */
export async function revokeAllSessions(db: D1Like, userId: string, nowMs: number): Promise<void> {
  await db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(nowMs), userId).run();
}

export async function verifyCsrf(session: SessionInfo, headerToken: string | null): Promise<boolean> {
  if (!headerToken) return false;
  return constantTimeEqual(await sha256Hex(headerToken), session.csrfHash);
}

/** 상태 변경 요청은 Origin 이 정확히 허용 출처와 같아야 한다. */
export function originAllowed(method: string, originHeader: string | null, allowedOrigin: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;
  return originHeader === allowedOrigin;
}

export function sessionCookie(token: string, maxAgeSec = SESSION_TTL_SEC): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export const clearSessionCookie = () => sessionCookie("", 0);

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

/** 서버 측 권한 검증. 클라이언트가 보낸 role 은 절대 신뢰하지 않는다. */
export function requireRole(user: UserRow, role: "admin"): void {
  if (user.role !== role) throw new ForbiddenError();
}
export class ForbiddenError extends Error { constructor() { super("forbidden"); } }

export async function audit(db: D1Like, e: { actorId: string | null; action: string; targetType?: string; targetId?: string | null; detail?: unknown }, nowMs: number): Promise<void> {
  await db.prepare("INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail_json,ts) VALUES(?,?,?,?,?,?)")
    .bind(e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, e.detail === undefined ? null : JSON.stringify(e.detail), nowIso(nowMs)).run();
}

/** 고객 간 격리: 자원 소유자가 요청자와 다르면 존재 여부도 숨기기 위해 null 처럼 취급. */
export async function ownedBy(db: D1Like, table: "containers" | "databases" | "storage_buckets" | "worker_services" | "domains" | "subscriptions", id: string, userId: string): Promise<boolean> {
  // table 은 타입으로 고정된 화이트리스트이므로 SQL 삽입 위험이 없다.
  const r = await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND customer_id = ?`).bind(id, userId).first();
  return r !== null;
}
