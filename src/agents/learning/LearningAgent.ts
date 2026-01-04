import { randomUUID } from 'node:crypto';

import type { StoredEvent } from '../../core/EventStore.js';
import type { EventStore } from '../../core/EventStore.js';
import { messageBus } from '../../core/MessageBus.js';

export interface LearningAgentConfig {
  enabled: boolean;
}

/**
 * Phase 1: learning is write-only telemetry.
 * - No online policy updates.
 * - Records key decisions/events to the EventStore for offline analysis.
 */
export class LearningAgent {
  private started = false;

  constructor(
    private config: LearningAgentConfig,
    private store: EventStore
  ) {}

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;

    const record = (type: string, payload: unknown, metadata?: StoredEvent['metadata']) => {
      this.store.append({
        id: randomUUID(),
        timestamp: Date.now(),
        type,
        payload,
        metadata: metadata ?? {}
      });
    };

    messageBus.on('opportunity:detected', (event) => record('opportunity:detected', event, { agent: 'ScannerAgent' }));
    messageBus.on('risk:approved', (event) => record('risk:approved', event, { agent: 'RiskAgent' }));
    messageBus.on('ops:health', (event) => record('ops:health', event, { agent: 'OpsAgent' }));
    messageBus.on('ops:alert', (event) => record('ops:alert', event, { agent: 'OpsAgent' }));
  }
}
