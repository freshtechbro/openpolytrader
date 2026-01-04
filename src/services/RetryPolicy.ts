export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: (error: unknown) => boolean;
}

export class RetryPolicy {
  constructor(private options: RetryPolicyOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= this.options.maxRetries || !this.options.retryOn(error)) {
          throw error;
        }

        const delay = Math.min(
          this.options.baseDelayMs * Math.pow(2, attempt),
          this.options.maxDelayMs
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
      }
    }
  }
}
