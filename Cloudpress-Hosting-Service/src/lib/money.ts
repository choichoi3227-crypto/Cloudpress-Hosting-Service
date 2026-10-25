/** 모든 금액은 micro-USD(1 USD = 1_000_000) 정수로 다룬다. 부동소수점 금지. */
export type Micro = number;
export const MICRO_PER_USD = 1_000_000;

/** "12.99" 같은 십진 문자열을 micro-USD 정수로 변환한다. */
export function usd(decimal: string): Micro {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(decimal.trim());
  if (!m) throw new Error(`invalid USD amount: ${decimal}`);
  const [, sign, whole, frac = ""] = m;
  const v = Number(whole) * MICRO_PER_USD + Number(frac.padEnd(6, "0"));
  if (!Number.isSafeInteger(v)) throw new Error("amount out of range");
  return sign === "-" ? -v : v;
}

/** micro-USD를 센트로 반올림(half-up, 음수는 절댓값 기준). */
export function toCents(micro: Micro): number {
  const abs = Math.abs(micro);
  const cents = Math.floor((abs + 5_000) / 10_000);
  return micro < 0 ? -cents : cents;
}

export function formatUsd(micro: Micro): string {
  const cents = toCents(micro);
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}

/** rate(micro/단위) × quantity(정수 milli-단위) / 1000 을 정수로 계산. 반올림은 한 번만. */
export function mulMilli(rateMicroPerUnit: Micro, quantityMilli: number): Micro {
  if (!Number.isInteger(quantityMilli)) throw new Error("quantityMilli must be integer");
  return Math.round((rateMicroPerUnit * quantityMilli) / 1000);
}
