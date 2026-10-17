import { describe, it, expect } from "vitest";
import { makeDb } from "./helpers/d1";
import { registerUser, login, getSession, logout, verifyCsrf, originAllowed, parseCookie, sessionCookie, requireRole, ForbiddenError, revokeAllSessions, ownedBy, SESSION_TTL_SEC } from "../src/lib/auth";
import { MemoryRateLimiter } from "../src/lib/ratelimit";

const NOW = Date.UTC(2026, 9, 17);
const PW = "a-long-enough-password";

describe("인증", () => {
  it("가입→로그인→세션 조회→로그아웃", async () => {
    const { db } = makeDb();
    expect((await registerUser(db, "User@Example.com ", PW, NOW)).ok).toBe(true);
    const l = await login(db, "user@example.com", PW, NOW);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const s = await getSession(db, l.token, NOW + 1000);
    expect(s?.user.email).toBe("user@example.com");
    expect(await verifyCsrf(s!, l.csrfToken)).toBe(true);
    expect(await verifyCsrf(s!, "wrong")).toBe(false);
    expect(await verifyCsrf(s!, null)).toBe(false);
    await logout(db, s!.sessionId, NOW + 2000);
    expect(await getSession(db, l.token, NOW + 3000)).toBeNull();
  });
  it("이메일 중복·약한 비밀번호·잘못된 이메일 거부(대소문자 무시)", async () => {
    const { db } = makeDb();
    await registerUser(db, "a@example.com", PW, NOW);
    const dup = await registerUser(db, "A@EXAMPLE.COM", PW, NOW);
    expect(dup.ok === false && dup.code).toBe("email_taken");
    const weak = await registerUser(db, "b@example.com", "short", NOW);
    expect(weak.ok === false && weak.code).toBe("weak_password");
    const bad = await registerUser(db, "not-an-email", PW, NOW);
    expect(bad.ok === false && bad.code).toBe("invalid_email");
  });
  it("비밀번호는 평문 저장되지 않음", async () => {
    const { db, raw } = makeDb();
    await registerUser(db, "a@example.com", PW, NOW);
    const row = raw.prepare("select password_hash from users").get() as { password_hash: string };
    expect(row.password_hash).not.toContain(PW);
    expect(row.password_hash.startsWith("pbkdf2$")).toBe(true);
  });
  it("틀린 비밀번호·없는 사용자는 같은 오류", async () => {
    const { db } = makeDb();
    await registerUser(db, "a@example.com", PW, NOW);
    const a = await login(db, "a@example.com", "wrong-password-123", NOW);
    const b = await login(db, "nobody@example.com", "wrong-password-123", NOW);
    expect(a).toEqual({ ok: false, code: "invalid_credentials" });
    expect(b).toEqual({ ok: false, code: "invalid_credentials" });
  });
  it("세션 만료·정지 계정 세션 폐기", async () => {
    const { db, raw } = makeDb();
    await registerUser(db, "a@example.com", PW, NOW);
    const l = await login(db, "a@example.com", PW, NOW);
    if (!l.ok) throw new Error("login");
    expect(await getSession(db, l.token, NOW + SESSION_TTL_SEC * 1000 + 1)).toBeNull();
    raw.exec("update users set status='suspended'");
    expect(await getSession(db, l.token, NOW + 1000)).toBeNull();
    expect((await login(db, "a@example.com", PW, NOW)).ok).toBe(false);
  });
  it("revokeAllSessions", async () => {
    const { db } = makeDb();
    await registerUser(db, "a@example.com", PW, NOW);
    const l = await login(db, "a@example.com", PW, NOW);
    if (!l.ok) throw new Error("login");
    await revokeAllSessions(db, l.user.id, NOW + 10);
    expect(await getSession(db, l.token, NOW + 20)).toBeNull();
  });
  it("Origin 검사·쿠키 속성", () => {
    expect(originAllowed("POST", "https://evil.test", "https://app.test")).toBe(false);
    expect(originAllowed("POST", null, "https://app.test")).toBe(false);
    expect(originAllowed("POST", "https://app.test", "https://app.test")).toBe(true);
    expect(originAllowed("GET", null, "https://app.test")).toBe(true);
    const c = sessionCookie("tok");
    for (const f of ["__Host-", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(c).toContain(f);
    expect(parseCookie("a=1; __Host-cp_session=tok; b=2", "__Host-cp_session")).toBe("tok");
  });
  it("관리자 권한은 서버에서 검증", () => {
    expect(() => requireRole({ id: "u", email: "e", role: "customer", status: "active" }, "admin")).toThrow(ForbiddenError);
    expect(() => requireRole({ id: "u", email: "e", role: "admin", status: "active" }, "admin")).not.toThrow();
  });
  it("고객 간 자원 격리(소유자만 접근)", async () => {
    const { db, raw } = makeDb();
    raw.exec("INSERT INTO users(id,email,password_hash) VALUES('u1','a@x.co','h'),('u2','b@x.co','h')");
    raw.exec("INSERT INTO products(id,kind,name_ko) VALUES('p','csw','x')");
    raw.exec("INSERT INTO prices(id,product_id,version,monthly_micro) VALUES('pr','p',1,1)");
    raw.exec("INSERT INTO subscriptions(id,customer_id,product_id,price_version_id) VALUES('s1','u1','p','pr')");
    raw.exec("INSERT INTO worker_services(id,subscription_id,customer_id,logical_name,route_key) VALUES('w1','s1','u1','api','rk1')");
    expect(await ownedBy(db, "worker_services", "w1", "u1")).toBe(true);
    expect(await ownedBy(db, "worker_services", "w1", "u2")).toBe(false);
  });
  it("속도 제한", async () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) expect((await rl.hit("k", 3, 60, NOW)).allowed).toBe(true);
    const r = await rl.hit("k", 3, 60, NOW + 1000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(59);
    expect((await rl.hit("k", 3, 60, NOW + 61_000)).allowed).toBe(true);
  });
});
