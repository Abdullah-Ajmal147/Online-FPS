/**
 * Token-bucket rate limiter keyed by a string (usually the client IP). In memory: fine for one
 * process; a shared store (Redis) is needed once there are several instances behind a balancer.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    /** Burst size. */
    private readonly capacity: number,
    /** Sustained rate. */
    private readonly perSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Takes one token for `key`; false means "too many requests". */
  take(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.updated) / 1000) * this.perSecond);
    b.updated = t;
    if (this.buckets.size > 50_000) this.prune(t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Forget full buckets (idle clients) so memory stays bounded. */
  private prune(t: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.updated) / 1000) * this.perSecond >= this.capacity)
        this.buckets.delete(k);
    }
  }
}
