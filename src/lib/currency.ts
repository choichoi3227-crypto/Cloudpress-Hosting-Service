import type { D1Like } from "./db";
import { wonToUsdMicro } from "./fx";
import type { Micro } from "./money";

export type Cur = "USD" | "KRW";

/** Stripe 통화 코드(소문자) → 내부 통화. 지원하지 않는 통화는 오류(재시도로 숨기지 않고 운영자가 보게 한다). */
export function parseCurrency(c: unknown): Cur {
  const s = String(c ?? "usd").toLowerCase();
  if (s === "usd") return "USD";
  if (s === "krw") return "KRW";
  throw new Error(`unsupported_currency:${s}`);
}

/** 결제 통화의 최소 단위를 USD 환산 micro 로. USD: 센트×10,000 / KRW: 원을 환율로 환산(내림). */
export function minorToMicro(cur: Cur, minor: number, fxRateMicro: number | null): Micro {
  if (cur === "USD") return minor * 10_000;
  if (!fxRateMicro) throw new Error("fx_rate_unavailable");
  return wonToUsdMicro(minor, fxRateMicro);
}

export async function latestFxRate(db: D1Like): Promise<number | null> {
  const r = await db.prepare("SELECT rate_micro AS r FROM fx_rates WHERE pair='USD/KRW' AND status='accepted' ORDER BY fetched_at DESC, id DESC LIMIT 1").first<{ r: number }>();
  return r?.r ?? null;
}
