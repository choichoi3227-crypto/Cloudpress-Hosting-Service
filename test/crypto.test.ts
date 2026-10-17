import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, encryptSecret, decryptSecret, constantTimeEqual, b64urlEncode, PBKDF2_ITERATIONS } from "../src/lib/crypto";

const KEY = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
describe("crypto", () => {
  it("비밀번호 해시 검증, 솔트로 매번 다른 해시", async () => {
    const h1 = await hashPassword("correct horse battery");
    const h2 = await hashPassword("correct horse battery");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("correct horse battery", h1)).toBe(true);
    expect(await verifyPassword("wrong password!!", h1)).toBe(false);
  });
  it("Workers 반복 횟수 상한 초과·손상된 해시 거부", async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
    expect(await verifyPassword("x", "pbkdf2$sha256$999999999$aa$bb")).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
  it("AES-GCM 암복호화와 AAD 바인딩", async () => {
    const ct = await encryptSecret("db-password", KEY, "database:d1");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(await decryptSecret(ct, KEY, "database:d1")).toBe("db-password");
    await expect(decryptSecret(ct, KEY, "database:d2")).rejects.toThrow(); // 다른 레코드로 치환 불가
  });
  it("잘못된 키 길이·변조 거부", async () => {
    await expect(encryptSecret("x", b64urlEncode(new Uint8Array(16)))).rejects.toThrow();
    const ct = await encryptSecret("x", KEY);
    await expect(decryptSecret(ct.slice(0, -2) + "AA", KEY)).rejects.toThrow();
  });
  it("상수 시간 비교", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
