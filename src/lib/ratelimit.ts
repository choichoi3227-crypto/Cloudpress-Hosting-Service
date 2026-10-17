export interface RateResult { allowed: boolean; remaining: number; retryAfterSec: number }
export interface RateLimiter { hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<RateResult> }

/** 단일 isolate 용 고정 윈도 제한기. 개발·테스트용이며 운영에서는 Durable Object 구현으로 교체해야 한다. */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  async hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<RateResult> {
    const b = this.buckets.get(key);
    if (!b || nowMs - b.start >= windowSec * 1000) {
      this.buckets.set(key, { start: nowMs, count: 1 });
      return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
    }
    b.count++;
    if (b.count > limit) return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.start + windowSec * 1000 - nowMs) / 1000) };
    return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 };
  }
}
