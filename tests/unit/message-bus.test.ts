import { describe, it, expect, vi } from 'vitest';

import { MessageBus } from '../../src/core/MessageBus.js';

describe('MessageBus', () => {
  it('handles on/emit and off', () => {
    const bus = new MessageBus<{ ping: string }>();
    const handler = vi.fn();

    bus.on('ping', handler);
    bus.emit('ping', 'hello');
    expect(handler).toHaveBeenCalledWith('hello');

    bus.off('ping', handler);
    bus.emit('ping', 'bye');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('handles once listeners', () => {
    const bus = new MessageBus<{ ping: number }>();
    const handler = vi.fn();

    bus.once('ping', handler);
    bus.emit('ping', 1);
    bus.emit('ping', 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
