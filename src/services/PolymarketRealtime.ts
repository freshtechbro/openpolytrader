import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

interface PolymarketRealtimeConfig {
  url: string;
  reconnectBackoffMs?: number[];
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectJitterPct: number;
  heartbeatIntervalMs: number;
  authMessage?: Record<string, unknown>;
}

export type RealtimeEvent = Record<string, unknown>;

export interface UserOrderUpdate {
  eventType: 'order';
  orderId: string;
  marketId?: string;
  assetId?: string;
  side?: string;
  orderEventType?: string;
  status?: string;
  price?: number;
  originalSize?: number;
  sizeMatched?: number;
  timestampMs?: number;
  raw: RealtimeEvent;
}

export interface UserTradeUpdate {
  eventType: 'trade';
  tradeId: string;
  marketId?: string;
  assetId?: string;
  side?: string;
  status?: string;
  price?: number;
  size?: number;
  takerOrderId?: string;
  makerOrderIds: string[];
  makerMatches: Array<{ orderId: string; matchedAmount?: number }>;
  timestampMs?: number;
  raw: RealtimeEvent;
}

export class PolymarketRealtime extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private connecting = false;
  private connected = false;
  private shouldReconnect = true;
  private heartbeat: NodeJS.Timeout | null = null;
  private subscribedAssetIds = new Set<string>();
  private subscribedUser = false;
  private userSubscriptionMessage: Record<string, unknown> | null = null;
  private lastMessageAtMs = 0;
  private staleThresholdMs = 60000;

  constructor(private config: PolymarketRealtimeConfig) {
    super();
    this.on('error', () => {});
  }

  async connect(): Promise<void> {
    if (this.connecting || this.ws) {
      return;
    }

    this.shouldReconnect = true;
    this.connecting = true;
    const url = this.config.url;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.connecting = false;
        fn();
      };
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        opened = true;
        settle(() => {
        this.reconnectAttempts = 0;
        this.connected = true;
        if (this.config.authMessage) this.captureSubscription(this.config.authMessage);
        this.resubscribeAfterReconnect();
        this.startHeartbeat();
        this.emit('open');
        resolve();
        });
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.lastMessageAtMs = Date.now();
        const text = data.toString();
        try {
          const payload = JSON.parse(text) as RealtimeEvent;
          this.emit('message', payload);
          this.handleParsedMessage(payload);
        } catch (error) {
          if (text.trim().toUpperCase() === 'PONG') {
            this.lastMessageAtMs = Date.now();
            return;
          }
          this.emit('error', error);
        }
      });

      ws.on('pong', () => {
        this.lastMessageAtMs = Date.now();
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.stopHeartbeat();
        this.emit('close', code, reason.toString());
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
        if (!opened) {
          settle(() => reject(new Error(`WebSocket closed before open: ${code}`)));
        }
      });

      ws.on('error', (error: Error) => {
        this.connected = false;
        this.stopHeartbeat();
        this.emit('error', error);
        if (!opened) {
          settle(() => reject(error));
          this.ws = null;
          return;
        }
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      });
    });
  }

  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  subscribeMarkets(assetIds: string[]): void {
    for (const id of assetIds) {
      this.subscribedAssetIds.add(id);
    }
    this.send({
      type: 'market',
      assets_ids: assetIds,
      initial_dump: true
    });
  }

  subscribeUser(): void {
    this.subscribedUser = true;
    const payload = this.userSubscriptionMessage ?? { type: 'user' };
    this.captureSubscription(payload);
    this.send(payload);
  }

  unsubscribeMarkets(assetIds: string[]): void {
    if (assetIds.length === 0) return;
    for (const id of assetIds) {
      this.subscribedAssetIds.delete(id);
    }

    // Market channel does not reliably support incremental unsubscribe payloads.
    // Force a clean reconnect so resubscribeAfterReconnect applies the new set.
    this.restartForMarketSubscriptionUpdate();
  }

  getSubscribedAssetIds(): string[] {
    return Array.from(this.subscribedAssetIds);
  }

  close(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
      }
      this.ws = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    this.lastMessageAtMs = Date.now();
    const interval = this.config.heartbeatIntervalMs;
    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        const timeSinceLastMessage = Date.now() - this.lastMessageAtMs;
        if (timeSinceLastMessage > this.staleThresholdMs) {
          this.emit('error', new Error(`WebSocket stale: no messages for ${timeSinceLastMessage}ms`));
          this.ws.terminate();
        }
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    const backoff = this.config.reconnectBackoffMs;

    let delay: number;
    if (backoff && backoff.length > 0) {
      delay = backoff[Math.min(this.reconnectAttempts, backoff.length - 1)];
    } else {
      const baseDelay = this.config.reconnectBaseDelayMs;
      const maxDelay = this.config.reconnectMaxDelayMs;
      const jitterPct = this.config.reconnectJitterPct;
      delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
      const jitter = delay * jitterPct * (Math.random() * 2 - 1);
      delay = Math.max(0, Math.round(delay + jitter));
    }

    this.reconnectAttempts += 1;

    setTimeout(() => {
      if (!this.ws && this.shouldReconnect) {
        this.connect().catch((error) => this.emit('error', error));
      }
    }, delay);
  }

  private restartForMarketSubscriptionUpdate(): void {
    if (!this.ws) return;
    if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      return;
    }

    try {
      this.ws.close();
    } catch {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  private resubscribeAfterReconnect(): void {
    if (this.subscribedAssetIds.size > 0) {
      this.send({
        type: 'market',
        assets_ids: Array.from(this.subscribedAssetIds),
        initial_dump: true
      });
    }
    if (this.subscribedUser) {
      this.send(this.userSubscriptionMessage ?? { type: 'user' });
    }
  }

  private captureSubscription(message: Record<string, unknown>): void {
    if (message.type === 'user') {
      this.subscribedUser = true;
      this.userSubscriptionMessage = message;
      return;
    }

    if (message.type === 'market') {
      const assets = message.assets_ids;
      if (Array.isArray(assets)) {
        for (const id of assets) {
          if (typeof id === 'string' && id.length > 0) {
            this.subscribedAssetIds.add(id);
          }
        }
      }
    }
  }

  private handleParsedMessage(payload: unknown): void {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        this.handleParsedMessage(item);
      }
      return;
    }

    if (!payload || typeof payload !== 'object') return;
    const message = payload as RealtimeEvent;
    const eventTypeRaw = message.event_type;
    const eventType = typeof eventTypeRaw === 'string' ? eventTypeRaw.toLowerCase() : undefined;

    if (eventType === 'order') {
      const update = parseUserOrderUpdate(message);
      if (update) this.emit('user:order', update);
      return;
    }

    if (eventType === 'trade') {
      const update = parseUserTradeUpdate(message);
      if (update) this.emit('user:trade', update);
      return;
    }
  }
}

function parseUserOrderUpdate(message: RealtimeEvent): UserOrderUpdate | null {
  const orderId = coerceString(message.order_id) ?? coerceString(message.id);
  if (!orderId) return null;

  return {
    eventType: 'order',
    orderId,
    marketId: coerceString(message.market),
    assetId: coerceString(message.asset_id),
    side: coerceString(message.side),
    orderEventType: coerceString(message.type),
    status: coerceString(message.status),
    price: coerceNumber(message.price),
    originalSize: coerceNumber(message.original_size),
    sizeMatched: coerceNumber(message.size_matched),
    timestampMs: coerceTimestampMs(message.timestamp ?? message.last_update),
    raw: message
  };
}

function parseUserTradeUpdate(message: RealtimeEvent): UserTradeUpdate | null {
  const tradeId = coerceString(message.id);
  if (!tradeId) return null;

  const makerOrderIds: string[] = [];
  const makerMatches: Array<{ orderId: string; matchedAmount?: number }> = [];
  const makerOrders = message.maker_orders;
  if (Array.isArray(makerOrders)) {
    for (const order of makerOrders) {
      if (order && typeof order === 'object') {
        const record = order as Record<string, unknown>;
        const id = coerceString(record.order_id);
        if (id) {
          makerOrderIds.push(id);
          makerMatches.push({ orderId: id, matchedAmount: coerceNumber(record.matched_amount) });
        }
      }
    }
  }

  return {
    eventType: 'trade',
    tradeId,
    marketId: coerceString(message.market),
    assetId: coerceString(message.asset_id),
    side: coerceString(message.side),
    status: coerceString(message.status),
    price: coerceNumber(message.price),
    size: coerceNumber(message.size),
    takerOrderId: coerceString(message.taker_order_id),
    makerOrderIds,
    makerMatches,
    timestampMs: coerceTimestampMs(message.timestamp ?? message.matchtime),
    raw: message
  };
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function coerceTimestampMs(value: unknown): number | undefined {
  const secondsOrMs = coerceNumber(value);
  if (secondsOrMs === undefined) return undefined;
  // Heuristic: 13-digit timestamps are already in ms; 10-digit are seconds.
  return secondsOrMs >= 1e12 ? Math.round(secondsOrMs) : Math.round(secondsOrMs * 1000);
}
