/** Fixed-window in-memory rate limiter keyed by client id. Adequate for a single web instance. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      this.gc(t);
      return { allowed: true, retryAfterSec: 0 };
    }
    if (entry.count >= this.limit) {
      return { allowed: false, retryAfterSec: Math.ceil((entry.windowStart + this.windowMs - t) / 1000) };
    }
    entry.count++;
    return { allowed: true, retryAfterSec: 0 };
  }

  private gc(t: number) {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (fwd || headers.get('x-real-ip') || 'local').slice(0, 64);
}
