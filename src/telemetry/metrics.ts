import { EventEmitter } from 'node:events';

export type MetricEventType =
  | 'health'
  | 'incident'
  | 'opportunity'
  | 'order'
  | 'fill'
  | 'risk'
  | 'info'
  | 'error';

export interface MetricEvent {
  type: MetricEventType;
  timestamp: number;
  data: unknown;
}

export interface MetricsSnapshot {
  counts: Record<MetricEventType, number>;
  lastEventAt: number | null;
}

export class MetricsStore extends EventEmitter {
  private events: MetricEvent[] = [];

  constructor(private maxEvents = 1000) {
    super();
  }

  record(event: MetricEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    this.emit('event', event);
  }

  snapshot(): MetricsSnapshot {
    const counts: Record<MetricEventType, number> = {
      health: 0,
      incident: 0,
      opportunity: 0,
      order: 0,
      fill: 0,
      risk: 0,
      info: 0,
      error: 0
    };

    for (const event of this.events) {
      counts[event.type] += 1;
    }

    return {
      counts,
      lastEventAt: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null
    };
  }

  recent(type?: MetricEventType, limit = 50): MetricEvent[] {
    const filtered = type ? this.events.filter((event) => event.type === type) : this.events;
    return filtered.slice(-limit);
  }
}
