import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { EventStore } from '../../src/core/EventStore.js';

describe('EventStore integration', () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      rmSync(path, { force: true });
    }
  });

  it('appends and replays events by timestamp', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    const base = Date.now();

    store.append({
      id: 'evt-1',
      timestamp: base,
      type: 'unit:test',
      payload: { a: 1 },
      metadata: { agent: 'test' }
    });

    store.append({
      id: 'evt-2',
      timestamp: base + 1,
      type: 'unit:test',
      payload: { a: 2 },
      metadata: { agent: 'test' }
    });

    const events = store.listSince(base);
    expect(events.map((e) => e.id)).toEqual(['evt-2']);

    store.close();
  });
});
