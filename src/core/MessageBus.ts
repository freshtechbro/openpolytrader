import { EventEmitter } from 'node:events';

type EventMap = Record<string, unknown>;

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

export function createMessageBus<E extends EventMap = EventMap>(maxListeners = 50): MessageBus<E> {
  return new MessageBus<E>(maxListeners);
}

function isTestRuntime(): boolean {
  return typeof globalThis === 'object' && '__vitest_worker__' in globalThis;
}

export function resolveMessageBus<E extends EventMap = EventMap>(
  bus: MessageBus<E> | undefined,
  owner?: string
): MessageBus<E> {
  if (bus) {
    return bus;
  }
  if (owner && !isTestRuntime()) {
    throw new Error(`${owner} requires a shared messageBus`);
  }
  return createMessageBus<E>();
}
