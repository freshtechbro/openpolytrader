export class RateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private tokens: number;
  private lastRefill: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly maxRequestsPerWindow: number, windowMs: number) {
    const boundedWindowMs = Math.max(windowMs, 1);
    this.capacity = Math.max(maxRequestsPerWindow, 1);
    this.refillRatePerMs = this.capacity / boundedWindowMs;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  acquire(count = 1): Promise<void> {
    const requested = Math.max(1, Math.floor(count));
    const run = async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= requested) {
          this.tokens -= requested;
          return;
        }
        const deficit = requested - this.tokens;
        const waitMs = Math.max(1, Math.ceil(deficit / this.refillRatePerMs));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    };

    this.pending = this.pending.then(run, run);
    return this.pending;
  }

  private refill(now = Date.now()): void {
    const elapsedMs = Math.max(0, now - this.lastRefill);
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillRatePerMs);
    this.lastRefill = now;
  }
}
