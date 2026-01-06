export class RateLimiter {
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(private readonly maxRequestsPerWindow: number, windowMs: number) {
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    while (this.timestamps.length > 0 && now - this.timestamps[0] >= this.windowMs) {
      this.timestamps.shift();
    }

    if (this.timestamps.length < this.maxRequestsPerWindow) {
      this.timestamps.push(now);
      return;
    }

    const oldest = this.timestamps[0];
    const waitMs = this.windowMs - (now - oldest);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return this.acquire();
  }
}
