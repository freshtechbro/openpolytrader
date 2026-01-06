import type { MarketAllowlist } from '../domain/allowlist.js';
import {
  type IncidentRecord,
  getDefaultRecoveryAction,
  getDefaultSeverity
} from '../domain/incident.js';
import type { MetricsStore } from '../telemetry/metrics.js';

export interface IncidentTrackerConfig {
  cooldownMs: number;
  maxIncidents: number;
}

export class IncidentTracker {
  private incidents: IncidentRecord[] = [];

  constructor(
    private allowlist: MarketAllowlist,
    private metrics: MetricsStore,
    private config: IncidentTrackerConfig
  ) {}

  record(incident: IncidentRecord): void {
    const normalized: IncidentRecord = {
      ...incident,
      severity: incident.severity ?? getDefaultSeverity(incident.reason),
      recoveryAction: incident.recoveryAction ?? getDefaultRecoveryAction(incident.reason)
    };

    this.incidents.unshift(normalized);
    const maxIncidents = this.config.maxIncidents;
    if (this.incidents.length > maxIncidents) {
      this.incidents.pop();
    }

    if (normalized.recoveryAction !== 'alert_only') {
      this.allowlist.quarantine(
        normalized.marketId,
        this.config.cooldownMs,
        normalized.reason
      );
    }

    this.metrics.record({
      type: 'incident',
      timestamp: normalized.timestamp,
      data: normalized
    });
  }

  recent(limit: number): IncidentRecord[] {
    return this.incidents.slice(0, limit);
  }
}
