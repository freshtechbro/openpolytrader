import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface PolymarketRealtimeConfig {
  url?: string;
  reconnectBackoffMs?: number[];
  authMessage?: Record<string, unknown>;
}

export type RealtimeEvent = Record<string, unknown>;

export class PolymarketRealtime extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private connecting = false;
  private connected = false;
  private shouldReconnect = true;
  private heartbeat: NodeJS.Timeout | null = null;
  private subscribedAssetIds = new Set<string>();
  private subscribedUser = false;

  constructor(private config: PolymarketRealtimeConfig = {}) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connecting || this.ws) {
      return;
    }

    this.shouldReconnect = true;
    this.connecting = true;
    const url =
      this.config.url ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on('open', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.connected = true;
        if (this.config.authMessage) {
          this.send(this.config.authMessage);
        }
        this.resubscribeAfterReconnect();
        this.startHeartbeat();
        this.emit('open');
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        const text = data.toString();
        try {
          const payload = JSON.parse(text) as RealtimeEvent;
          this.emit('message', payload);
        } catch (error) {
          if (text.trim().toUpperCase() === 'PONG') {
            return;
          }
          this.emit('error', error);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.ws = null;
        this.connected = false;
        this.stopHeartbeat();
        this.emit('close', code, reason.toString());
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (error: Error) => {
        this.connected = false;
        this.emit('error', error);
        reject(error);
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
      assets_ids: assetIds
    });
  }

  subscribeUser(): void {
    this.subscribedUser = true;
    this.send({ type: 'user' });
  }

  unsubscribeMarkets(assetIds: string[]): void {
    for (const id of assetIds) {
      this.subscribedAssetIds.delete(id);
    }
  }

  getSubscribedAssetIds(): string[] {
    return Array.from(this.subscribedAssetIds);
  }

  close(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
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

    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, 10000);
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
      const baseDelay = 250;
      const maxDelay = 30000;
      delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      delay = Math.max(0, Math.round(delay + jitter));
    }

    this.reconnectAttempts += 1;

    setTimeout(() => {
      if (!this.ws && this.shouldReconnect) {
        this.connect().catch((error) => this.emit('error', error));
      }
    }, delay);
  }

  private resubscribeAfterReconnect(): void {
    if (this.subscribedAssetIds.size > 0) {
      this.send({
        type: 'market',
        assets_ids: Array.from(this.subscribedAssetIds)
      });
    }
    if (this.subscribedUser) {
      this.send({ type: 'user' });
    }
  }
}
