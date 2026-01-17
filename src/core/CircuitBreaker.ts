export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccesses: number;
}

export interface CircuitBreakerStateSnapshot {
  state: CircuitState;
  failures: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;

  constructor(private config: CircuitBreakerConfig, private name: string) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.config.cooldownMs) {
        throw new Error(`Circuit breaker open for ${this.name}`);
      }
      this.state = 'half-open';
      this.halfOpenSuccesses = 0;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  recordFailure(): void {
    this.onFailure();
  }

  recordSuccess(): void {
    this.onSuccess();
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.cooldownMs) {
        this.state = 'half-open';
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  getFailureCount(): number {
    return this.failures;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.lastFailureTime = 0;
    this.halfOpenSuccesses = 0;
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.config.halfOpenSuccesses) {
        this.state = 'closed';
      }
    }
  }

  private onFailure(): void {
    this.failures += 1;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  constructor(private config: CircuitBreakerConfig, private namePrefix = 'market') {}

  updateConfig(config: CircuitBreakerConfig): void {
    Object.assign(this.config, config);
  }

  get(marketId: string): CircuitBreaker {
    const existing = this.breakers.get(marketId);
    if (existing) return existing;
    const created = new CircuitBreaker(this.config, `${this.namePrefix}:${marketId}`);
    this.breakers.set(marketId, created);
    return created;
  }

  recordSuccess(marketId: string): void {
    this.get(marketId).recordSuccess();
  }

  recordFailure(marketId: string): void {
    this.get(marketId).recordFailure();
  }

  isOpen(marketId: string): boolean {
    const breaker = this.breakers.get(marketId);
    return breaker?.getState() === 'open';
  }

  getOpenMarkets(): string[] {
    const open: string[] = [];
    for (const [marketId, breaker] of this.breakers.entries()) {
      if (breaker.getState() === 'open') open.push(marketId);
    }
    return open;
  }

  getSummary(): Map<string, CircuitBreakerStateSnapshot> {
    const summary = new Map<string, CircuitBreakerStateSnapshot>();
    for (const [marketId, breaker] of this.breakers.entries()) {
      summary.set(marketId, { state: breaker.getState(), failures: breaker.getFailureCount() });
    }
    return summary;
  }
}
