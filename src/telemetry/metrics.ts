import { EventEmitter } from 'node:events';
import type { LatencyEvent } from './events.js';

export type MetricEventType =
  | 'health'
  | 'incident'
  | 'opportunity'
  | 'order_attempt'
  | 'order'
  | 'fill'
  | 'delayed_ack'
  | 'risk'
  | 'info'
  | 'error'
  | 'latency'
  | 'execution_lifecycle'
  | 'book_staleness'
  | 'book_fallback'
  | 'slo_violation'
  | 'gate_rejection'
  | 'shadow_decision';

export interface MetricEvent {
  type: MetricEventType;
  timestamp: number;
  data: unknown;
}

export interface MetricsSnapshot {
  counts: Record<MetricEventType, number>;
  lastEventAt: number | null;
}

interface OrderWindowCounts {
  orders: number[];
  fills: number[];
  delayedAcks: number[];
}

export class MetricsStore extends EventEmitter {
  private events: MetricEvent[] = [];
  private orderAttempts: number[] = [];
  private orderCounts = new Map<string, OrderWindowCounts>();

  constructor(private maxEvents: number) {
    super();
  }

  record(event: MetricEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    this.emit('event', event);
  }

  recordLatency(event: LatencyEvent): void {
    this.record({ type: 'latency', timestamp: event.timestampMs, data: event });
  }

  recordOrderAttempt(marketId: string, nowMs = Date.now()): void {
    this.orderAttempts.push(nowMs);
    const counts = this.getOrderCounts(marketId);
    counts.orders.push(nowMs);
    this.record({ type: 'order_attempt', timestamp: nowMs, data: { marketId } });
  }

  recordFill(marketId: string, nowMs = Date.now()): void {
    const counts = this.getOrderCounts(marketId);
    counts.fills.push(nowMs);
    this.record({ type: 'fill', timestamp: nowMs, data: { marketId } });
  }

  recordDelayedAck(marketId: string, nowMs = Date.now()): void {
    const counts = this.getOrderCounts(marketId);
    counts.delayedAcks.push(nowMs);
    this.record({ type: 'delayed_ack', timestamp: nowMs, data: { marketId } });
  }

  getOrderVelocity(windowMs: number, nowMs = Date.now()): number {
    if (windowMs <= 0) return 0;
    const cutoff = nowMs - windowMs;
    pruneWindow(this.orderAttempts, cutoff);
    return this.orderAttempts.length;
  }

  getOrderStats(marketId: string, windowMs: number, nowMs = Date.now()): { orders: number; fills: number } {
    if (windowMs <= 0) return { orders: 0, fills: 0 };
    const cutoff = nowMs - windowMs;
    const counts = this.getOrderCounts(marketId);
    pruneWindow(counts.orders, cutoff);
    pruneWindow(counts.fills, cutoff);
    return { orders: counts.orders.length, fills: counts.fills.length };
  }

  getDelayedAckRate(marketId: string, windowMs: number, nowMs = Date.now()): number {
    if (windowMs <= 0) return 0;
    const cutoff = nowMs - windowMs;
    const counts = this.getOrderCounts(marketId);
    pruneWindow(counts.orders, cutoff);
    pruneWindow(counts.delayedAcks, cutoff);
    if (counts.orders.length === 0) return 0;
    return counts.delayedAcks.length / counts.orders.length;
  }

  getOTR(marketId: string, windowMs: number, nowMs = Date.now()): number {
    const { orders, fills } = this.getOrderStats(marketId, windowMs, nowMs);
    return orders / Math.max(fills, 1);
  }

  snapshot(): MetricsSnapshot {
    const counts: Record<MetricEventType, number> = {
      health: 0,
      incident: 0,
      opportunity: 0,
      order_attempt: 0,
      order: 0,
      fill: 0,
      delayed_ack: 0,
      risk: 0,
      info: 0,
      error: 0,
      latency: 0,
      execution_lifecycle: 0,
      book_staleness: 0,
      book_fallback: 0,
      slo_violation: 0,
      gate_rejection: 0,
      shadow_decision: 0
    };

    for (const event of this.events) {
      counts[event.type] += 1;
    }

    return {
      counts,
      lastEventAt: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null
    };
  }

  recent(type: MetricEventType | undefined, limit: number): MetricEvent[] {
    const filtered = type ? this.events.filter((event) => event.type === type) : this.events;
    return filtered.slice(-limit);
  }

  private getOrderCounts(marketId: string): OrderWindowCounts {
    const existing = this.orderCounts.get(marketId);
    if (existing) return existing;
    const created = { orders: [], fills: [], delayedAcks: [] };
    this.orderCounts.set(marketId, created);
    return created;
  }
}

function pruneWindow(values: number[], cutoff: number): void {
  while (values.length > 0 && values[0] < cutoff) {
    values.shift();
  }
}
