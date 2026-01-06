export type MarketStatus = 'allowed' | 'quarantined' | 'blocked';

export interface MarketStatusEntry {
  status: MarketStatus;
  until?: number;
  reason?: string;
}

export interface MarketAllowlistConfig {
  autoResume: boolean;
}

export class MarketAllowlist {
  private entries = new Map<string, MarketStatusEntry>();

  constructor(private config: MarketAllowlistConfig) {}

  allow(key: string): void {
    this.entries.set(key, { status: 'allowed' });
  }

  seed(keys: string[]): void {
    for (const key of keys) {
      this.allow(key);
    }
  }

  block(key: string, reason?: string): void {
    this.entries.set(key, { status: 'blocked', reason });
  }

  quarantine(key: string, durationMs: number, reason?: string): void {
    this.entries.set(key, {
      status: 'quarantined',
      until: Date.now() + durationMs,
      reason
    });
  }

  isAllowed(key: string, now = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.status === 'allowed') return true;
    if (entry.status === 'blocked') return false;
    if (entry.status === 'quarantined') {
      if (this.config.autoResume && entry.until && now >= entry.until) {
        this.allow(key);
        return true;
      }
      return false;
    }
    return false;
  }

  getStatus(key: string, now = Date.now()): MarketStatusEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (
      this.config.autoResume &&
      entry.status === 'quarantined' &&
      entry.until &&
      now >= entry.until
    ) {
      this.allow(key);
      return this.entries.get(key) ?? null;
    }
    return entry;
  }

  list(): Array<{ key: string; entry: MarketStatusEntry }> {
    return Array.from(this.entries.entries()).map(([key, entry]) => ({ key, entry }));
  }
}
