import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';

import { EventStore, type StoredEvent } from '../../src/core/EventStore.js';
import type { IdempotencyRecord } from '../../src/domain/idempotency.js';

describe('EventStore integration', () => {
  const paths: string[] = [];
  const cleanupSqliteArtifacts = (path: string) => {
    for (const suffix of ['', '-wal', '-shm', '.bak', '.bak-wal', '.bak-shm']) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  };

  afterEach(() => {
    for (const path of paths.splice(0, paths.length)) {
      cleanupSqliteArtifacts(path);
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

  it('persists and lists decision records', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    const base = Date.now();

    store.persistDecision({
      id: 'dec-1',
      subjectId: 'system:test',
      timestampMs: base,
      agent: 'LearningAgent',
      decisionJson: { schema_version: 1, agent: 'LearningAgent', mode: 'active' },
      reasoningJson: { status: 'success' }
    });

    store.persistDecision({
      id: 'dec-2',
      subjectId: 'system:test',
      timestampMs: base + 10,
      agent: 'RiskAgent',
      decisionJson: { schema_version: 1, agent: 'RiskAgent', mode: 'shadow' },
      reasoningJson: { status: 'success' }
    });

    const learningOnly = store.listDecisions({ agent: 'LearningAgent', sinceMs: base - 1, untilMs: base + 1 });
    expect(learningOnly.map((row) => row.id)).toEqual(['dec-1']);

    const all = store.listDecisions({ sinceMs: base - 1, untilMs: base + 100 });
    expect(all.map((row) => row.id)).toEqual(['dec-1', 'dec-2']);

    const unfiltered = store.listDecisions();
    expect(unfiltered.map((row) => row.id)).toEqual(['dec-1', 'dec-2']);

    const subjectOnly = store.listDecisions({ subjectId: 'system:test', sinceMs: base - 1, untilMs: base + 100 });
    expect(subjectOnly.map((row) => row.id)).toEqual(['dec-1', 'dec-2']);

    const limited = store.listDecisions({ sinceMs: base - 1, untilMs: base + 100, limit: 1 });
    expect(limited).toHaveLength(1);

    const negativeLimit = store.listDecisions({ sinceMs: base - 1, untilMs: base + 100, limit: -1 });
    expect(negativeLimit.map((row) => row.id)).toEqual(['dec-1', 'dec-2']);

    store.close();
  });

  it('reads latest event by type', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    const base = Date.now();

    expect(store.getLatestEventByType('unit:missing')).toBeUndefined();

    store.append({
      id: 'evt-a',
      timestamp: base,
      type: 'unit:type',
      payload: { n: 1 },
      metadata: { agent: 'test' }
    });

    store.append({
      id: 'evt-b',
      timestamp: base + 1,
      type: 'unit:type',
      payload: { n: 2 },
      metadata: { agent: 'test' }
    });

    const latest = store.getLatestEventByType('unit:type');
    expect(latest?.id).toBe('evt-b');
    expect(latest?.payload).toEqual({ n: 2 });

    store.close();
  });

  it('lists events by types with time windows and limits', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    const base = Date.now();

    store.append({
      id: 'evt-1',
      timestamp: base,
      type: 'unit:a',
      payload: { n: 1 },
      metadata: undefined
    } as StoredEvent);

    store.append({
      id: 'evt-2',
      timestamp: base + 1,
      type: 'unit:b',
      payload: { n: 2 },
      metadata: {}
    });

    store.append({
      id: 'evt-3',
      timestamp: base + 2,
      type: 'unit:a',
      payload: { n: 3 },
      metadata: {}
    });

    expect(store.listEventsByTypes({ types: [] })).toEqual([]);

    const all = store.listEventsByTypes({ types: ['unit:a', 'unit:b', 'unit:a', '   '] });
    expect(all.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);

    const sinceExclusive = store.listEventsByTypes({ types: ['unit:a', 'unit:b'], sinceExclusiveMs: base });
    expect(sinceExclusive.map((e) => e.id)).toEqual(['evt-2', 'evt-3']);

    const until = store.listEventsByTypes({ types: ['unit:a', 'unit:b'], untilMs: base + 1 });
    expect(until.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);

    const limited = store.listEventsByTypes({ types: ['unit:a', 'unit:b'], limit: 1 });
    expect(limited).toHaveLength(1);

    const negativeLimit = store.listEventsByTypes({ types: ['unit:a', 'unit:b'], limit: -1 });
    expect(negativeLimit.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);

    store.close();
  });

  it('creates indexes for decisions queries', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });
    store.close();

    const db = new Database(path);
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
        .all() as Array<{ name: string }>;

      const names = rows.map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining(['idx_decisions_ts', 'idx_decisions_agent_ts', 'idx_decisions_opportunity_ts'])
      );

      const eventIndexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
        .all() as Array<{ name: string }>;
      expect(eventIndexes.map((row) => row.name)).toEqual(expect.arrayContaining(['idx_events_type_ts']));
    } finally {
      db.close();
    }
  });

  it('recovers writes when the database file is moved and replaced', () => {
    const path = `data/test-${randomUUID()}.db`;
    paths.push(path);

    const store = new EventStore({ dbPath: path });

    store.persistMetric({
      type: 'info',
      timestamp: 1000,
      data: { message: 'before_move' }
    });

    renameSync(path, `${path}.bak`);
    const replacement = new Database(path);
    replacement.close();

    expect(() =>
      store.persistMetric({
        type: 'info',
        timestamp: 2000,
        data: { message: 'after_move' }
      })
    ).not.toThrow();

    const metrics = store.queryMetrics('info', 100000, 100000);
    const messages = metrics.map((event) => (event.data as { message?: string }).message);
    expect(messages).toContain('after_move');

    store.close();
  });
});
