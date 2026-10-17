const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const randomToken = (bytes = 32) => b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 길이와 무관하게 전체를 순회하는 상수 시간 비교. */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Workers WebCrypto 의 PBKDF2 반복 횟수 상한은 100,000 이다. 이 값을 넘기면 런타임 오류가 난다. */
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, k, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || algo !== "sha256" || !iterStr || !saltB64 || !hashB64) return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = b64urlEncode(await pbkdf2(password, b64urlDecode(saltB64), iterations));
  return constantTimeEqual(actual, hashB64);
}

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(keyB64);
  if (raw.length !== 32) throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (base64url)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM. 형식: v1.<iv>.<ciphertext>. aad 로 레코드에 묶어 다른 레코드로의 치환을 막는다. */
export async function encryptSecret(plaintext: string, keyB64: string, aad = ""): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(keyB64), enc.encode(plaintext));
  return `v1.${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}
export async function decryptSecret(token: string, keyB64: string, aad = ""): Promise<string> {
  const [v, iv, ct] = token.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad secret format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv), additionalData: enc.encode(aad) }, await aesKey(keyB64), b64urlDecode(ct));
  return new TextDecoder().decode(pt);
}
