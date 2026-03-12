import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../src/core/EventStore.js';

const tempDirs: string[] = [];

function createDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, 'events.db');
}

function seedInvalidRow(dbPath: string, sql: string, params: unknown[]): void {
  const db = new Database(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('EventStore persisted JSON parsing', () => {
  it('throws a contextual error for malformed event payloads', () => {
    const dbPath = createDbPath('event-store-events-');
    const store = new EventStore({ dbPath });

    seedInvalidRow(
      dbPath,
      'INSERT INTO events (id, ts, type, payload, metadata) VALUES (?, ?, ?, ?, ?)',
      ['event-1', 1, 'learning:test', '{bad-json', '{}']
    );

    expect(() => store.listSince(0)).toThrow(/events\.payload for id=event-1/);
    store.close();
  });

  it('throws a contextual error for malformed metric payloads', () => {
    const dbPath = createDbPath('event-store-metrics-');
    const store = new EventStore({ dbPath });

    seedInvalidRow(
      dbPath,
      'INSERT INTO metrics (ts, type, data) VALUES (?, ?, ?)',
      [1, 'execution_latency', '{bad-json']
    );

    expect(() => store.queryMetrics('execution_latency', 10_000, 10_000)).toThrow(
      /metrics\.data for type=execution_latency ts=1/
    );
    store.close();
  });

  it('throws a contextual error for malformed decision payloads', () => {
    const dbPath = createDbPath('event-store-decisions-');
    const store = new EventStore({ dbPath });

    seedInvalidRow(
      dbPath,
      'INSERT INTO decisions (id, opportunity_id, ts, agent, decision_json, reasoning_json) VALUES (?, ?, ?, ?, ?, ?)',
      ['decision-1', 'opp-1', 1, 'RiskAgent', '{bad-json', '{}']
    );

    expect(() => store.listDecisions({ subjectId: 'opp-1' })).toThrow(
      /decisions\.decision_json for id=decision-1/
    );
    store.close();
  });
});
