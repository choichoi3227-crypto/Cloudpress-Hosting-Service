import { hmacSha256Hex, constantTimeEqual } from "./crypto";

export const WEBHOOK_TOLERANCE_SEC = 300;

export interface StripeEvent { id: string; type: string; created: number; data: { object: Record<string, any> } }

export type VerifyResult = { ok: true; event: StripeEvent } | { ok: false; reason: "missing_header" | "bad_header" | "stale" | "mismatch" | "bad_json" };

/** Stripe 웹훅 서명 검증: HMAC-SHA256("t.payload"), 5분 허용 오차, 상수 시간 비교. 원문(raw body) 그대로 검증해야 한다. */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs: number): Promise<VerifyResult> {
  if (!header) return { ok: false, reason: "missing_header" };
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || v1.length === 0) return { ok: false, reason: "bad_header" };
  if (Math.abs(nowMs / 1000 - Number(t)) > WEBHOOK_TOLERANCE_SEC) return { ok: false, reason: "stale" };
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  if (!v1.some((s) => constantTimeEqual(s, expected))) return { ok: false, reason: "mismatch" };
  try {
    const event = JSON.parse(rawBody) as StripeEvent;
    if (typeof event.id !== "string" || typeof event.type !== "string") return { ok: false, reason: "bad_json" };
    return { ok: true, event };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

/** 테스트·모의 모드용 서명 생성기. 운영 코드 경로에서는 사용하지 않는다. */
export async function signStripePayload(rawBody: string, secret: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}
