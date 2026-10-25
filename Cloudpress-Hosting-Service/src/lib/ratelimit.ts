export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<RateLimitResult>;
}

/** 개발용 메모리 기반 제한기 */
export class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; expiresAt: number }>();

  async hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<RateLimitResult> {
    const bucket = this.buckets.get(key);
    if (!bucket || nowMs > bucket.expiresAt) {
      this.buckets.set(key, { count: 1, expiresAt: nowMs + windowSec * 1000 });
      return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
    }
    if (bucket.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((bucket.expiresAt - nowMs) / 1000) };
    }
    bucket.count++;
    return { allowed: true, remaining: limit - bucket.count, retryAfterSec: 0 };
  }
}

/** 운영용 Durable Object 기반 제한기 (Stub) */
export class DurableRateLimiter implements RateLimiter {
  constructor(private doStub: any) {}

  async hit(key: string, limit: number, windowSec: number, nowMs: number): Promise<RateLimitResult> {
    // Durable Object 스텁을 통해 원자적 연산 수행
    const res = await this.doStub.fetch(`https://limit/hit?key=${encodeURIComponent(key)}&limit=${limit}&window=${windowSec}`);
    return await res.json() as RateLimitResult;
  }
}
