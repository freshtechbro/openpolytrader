import type { MarketAllowlist } from '../domain/allowlist.js';
import type { IncidentRecord } from '../domain/incident.js';
import type { MetricsStore } from '../telemetry/metrics.js';

export interface IncidentTrackerConfig {
  cooldownMs: number;
}

export class IncidentTracker {
  private incidents: IncidentRecord[] = [];

  constructor(
    private allowlist: MarketAllowlist,
    private metrics: MetricsStore,
    private config: IncidentTrackerConfig
  ) {}

  record(incident: IncidentRecord): void {
    this.incidents.unshift(incident);
    if (this.incidents.length > 1000) {
      this.incidents.pop();
    }

    this.allowlist.quarantine(
      incident.marketId,
      this.config.cooldownMs,
      incident.reason
    );

    this.metrics.record({
      type: 'incident',
      timestamp: incident.timestamp,
      data: incident
    });
  }

  recent(limit = 50): IncidentRecord[] {
    return this.incidents.slice(0, limit);
  }
}
