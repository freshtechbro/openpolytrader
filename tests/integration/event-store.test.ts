import { afterEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { EventStore, type StoredEvent } from '../../src/core/EventStore.js';
import type { IdempotencyRecord } from '../../src/domain/idempotency.js';

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

    store.append({
      id: 'evt-3',
      timestamp: base + 2,
      type: 'unit:test',
      payload: { a: 3 },
      metadata: undefined
    } as StoredEvent);

    const events = store.listSince(base);
    expect(events.map((e) => e.id)).toEqual(['evt-2', 'evt-3']);

    store.close();
  });

  it('uses configured db path when provided', () => {
    const path = 'data/openpolytrader.db';
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    store.append({
      id: 'evt-default',
      timestamp: Date.now(),
      type: 'unit:test',
      payload: {},
      metadata: {}
    });
    store.close();
  });

  it('persists and prunes idempotency records', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    const now = Date.now();

    const record: IdempotencyRecord = {
      key: 'idem-1',
      nonce: '1234',
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };

    store.upsertIdempotencyRecord(record);
    const fetched = store.getIdempotencyRecord('idem-1');

    expect(fetched).toEqual(record);

    const pruned = store.pruneIdempotencyRecords(now + 1);
    expect(pruned).toBe(1);
    expect(store.getIdempotencyRecord('idem-1')).toBeUndefined();

    store.close();
  });
});
