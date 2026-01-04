import { EventEmitter } from 'node:events';

export type EventMap = Record<string, unknown>;

export class MessageBus<E extends EventMap = EventMap> {
  private emitter = new EventEmitter();

  constructor(maxListeners = 50) {
    this.emitter.setMaxListeners(maxListeners);
  }

  on<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): void {
    this.emitter.on(event, handler);
  }

  once<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): void {
    this.emitter.once(event, handler);
  }

  off<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): void {
    this.emitter.off(event, handler);
  }

  emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    this.emitter.emit(event, payload);
  }
}

export const messageBus = new MessageBus();
