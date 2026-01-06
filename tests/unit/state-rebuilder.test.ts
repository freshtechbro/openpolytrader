import { describe, it, expect } from 'vitest';

import { StateRebuilder } from '../../src/core/StateRebuilder.js';
import type { StoredEvent } from '../../src/core/EventStore.js';

describe('StateRebuilder', () => {
  it('rebuilds state without mutating base', () => {
    const initial = { count: 0, nested: { value: 1 } };
    const reducer = (state: typeof initial, event: StoredEvent) => {
      if (event.type === 'inc') {
        state.count += 1;
      }
      return state;
    };

    const rebuilder = new StateRebuilder(initial, reducer);
    const next = rebuilder.rebuild([
      { id: 1, type: 'inc', payload: {}, timestamp: 0 }
    ]);

    expect(next.count).toBe(1);
    expect(initial.count).toBe(0);
    expect(next.nested).not.toBe(initial.nested);
  });

  it('falls back to JSON clone when structuredClone is unavailable', () => {
    const original = globalThis.structuredClone;
    Object.defineProperty(globalThis, 'structuredClone', {
      value: undefined,
      configurable: true
    });

    const rebuilder = new StateRebuilder({ count: 0 }, (state) => ({
      count: state.count + 1
    }));

    const next = rebuilder.rebuild([{ id: 1, type: 'inc', payload: {}, timestamp: 0 }]);
    expect(next.count).toBe(1);

    Object.defineProperty(globalThis, 'structuredClone', {
      value: original,
      configurable: true
    });
  });
});
