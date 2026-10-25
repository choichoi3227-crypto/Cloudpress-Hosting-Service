import { describe, it, expect } from "vitest";
import { verifyStripeSignature, signStripePayload } from "../src/lib/stripe";

const SECRET = "whsec_test_secret";
const NOW = Date.UTC(2026, 9, 17);
const body = JSON.stringify({ id: "evt_1", type: "invoice.paid", created: 1, data: { object: {} } });

describe("Stripe 서명 검증", () => {
  it("올바른 서명 통과", async () => {
    const h = await signStripePayload(body, SECRET, NOW);
    const r = await verifyStripeSignature(body, h, SECRET, NOW);
    expect(r.ok).toBe(true);
  });
  it("본문 변조·잘못된 시크릿 거부", async () => {
    const h = await signStripePayload(body, SECRET, NOW);
    expect((await verifyStripeSignature(body + " ", h, SECRET, NOW)).ok).toBe(false);
    expect((await verifyStripeSignature(body, h, "other", NOW)).ok).toBe(false);
  });
  it("오래된 타임스탬프(재전송 공격) 거부", async () => {
    const h = await signStripePayload(body, SECRET, NOW - 400_000);
    const r = await verifyStripeSignature(body, h, SECRET, NOW);
    expect(r).toEqual({ ok: false, reason: "stale" });
  });
  it("헤더 없음·형식 오류·여러 v1 중 하나만 맞아도 통과", async () => {
    expect(await verifyStripeSignature(body, null, SECRET, NOW)).toEqual({ ok: false, reason: "missing_header" });
    expect(await verifyStripeSignature(body, "garbage", SECRET, NOW)).toEqual({ ok: false, reason: "bad_header" });
    const good = await signStripePayload(body, SECRET, NOW);
    expect((await verifyStripeSignature(body, `${good},v1=deadbeef`, SECRET, NOW)).ok).toBe(true);
  });
});
