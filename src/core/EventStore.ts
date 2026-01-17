import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { IdempotencyRecord } from '../domain/idempotency.js';
import type { MetricEvent, MetricEventType } from '../telemetry/metrics.js';

export interface StoredEvent {
  id: string;
  timestamp: number;
  type: string;
  payload: unknown;
  metadata: {
    agent?: string;
    correlationId?: string;
  };
}

export interface EventStoreOptions {
  dbPath: string;
}

export interface StoredDecision {
  id: string;
  subjectId: string;
  timestamp: number;
  agent: string;
  decision: unknown;
  reasoning: unknown;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics (ts);
CREATE INDEX IF NOT EXISTS idx_metrics_type_ts ON metrics (type, ts);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  status TEXT NOT NULL,
  error_msg TEXT,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  size REAL NOT NULL,
  price REAL NOT NULL,
  fee_rate_bps REAL,
  tx_hash TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  reasoning_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions (ts);
CREATE INDEX IF NOT EXISTS idx_decisions_agent_ts ON decisions (agent, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_opportunity_ts ON decisions (opportunity_id, ts);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_updated_at ON idempotency (updated_at);
`;

export class EventStore {
  private db: Database.Database;
  private insertMetric: Database.Statement;
  private insertDecision: Database.Statement;
  private selectLatestEventByType: Database.Statement;

  constructor(options: EventStoreOptions) {
    const resolved = resolve(options.dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.exec(SCHEMA_SQL);
    this.insertMetric = this.db.prepare('INSERT INTO metrics (ts, type, data) VALUES (?, ?, ?)');
    this.insertDecision = this.db.prepare(
      'INSERT INTO decisions (id, opportunity_id, ts, agent, decision_json, reasoning_json) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.selectLatestEventByType = this.db.prepare(
      'SELECT id, ts, type, payload, metadata FROM events WHERE type = ? ORDER BY ts DESC LIMIT 1'
    );
  }

  append(event: StoredEvent): void {
    const stmt = this.db.prepare(
      'INSERT INTO events (id, ts, type, payload, metadata) VALUES (?, ?, ?, ?, ?)'
    );

    stmt.run(
      event.id,
      event.timestamp,
      event.type,
      JSON.stringify(event.payload),
      JSON.stringify(event.metadata ?? {})
    );
  }

  listSince(timestamp: number): StoredEvent[] {
    const stmt = this.db.prepare(
      'SELECT id, ts, type, payload, metadata FROM events WHERE ts > ? ORDER BY ts ASC'
    );
    const rows = stmt.all(timestamp) as Array<{
      id: string;
      ts: number;
      type: string;
      payload: string;
      metadata: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: JSON.parse(row.metadata)
    }));
  }

  listEventsByTypes(filter: {
    types: string[];
    sinceExclusiveMs?: number;
    untilMs?: number;
    limit?: number;
  }): StoredEvent[] {
    const uniqueTypes = Array.from(new Set(filter.types)).filter((type) => type.trim().length > 0);
    if (uniqueTypes.length === 0) return [];

    const where: string[] = [];
    const params: Array<string | number> = [];

    where.push(`type IN (${uniqueTypes.map(() => '?').join(', ')})`);
    params.push(...uniqueTypes);

    if (typeof filter.sinceExclusiveMs === 'number') {
      where.push('ts > ?');
      params.push(filter.sinceExclusiveMs);
    }
    if (typeof filter.untilMs === 'number') {
      where.push('ts <= ?');
      params.push(filter.untilMs);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const limit = typeof filter.limit === 'number' ? Math.max(filter.limit, 0) : 0;
    const limitSql = limit > 0 ? `LIMIT ${limit}` : '';

    const stmt = this.db.prepare(
      `SELECT id, ts, type, payload, metadata
       FROM events
       ${whereSql}
       ORDER BY ts ASC
       ${limitSql}`
    );

    const rows = stmt.all(...params) as Array<{
      id: string;
      ts: number;
      type: string;
      payload: string;
      metadata: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: JSON.parse(row.metadata)
    }));
  }

  getLatestEventByType(type: string): StoredEvent | undefined {
    const row = this.selectLatestEventByType.get(type) as
      | { id: string; ts: number; type: string; payload: string; metadata: string }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      timestamp: row.ts,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: JSON.parse(row.metadata)
    };
  }

  getIdempotencyRecord(key: string): IdempotencyRecord | undefined {
    const stmt = this.db.prepare(
      'SELECT key, nonce, status, order_id, created_at, updated_at FROM idempotency WHERE key = ?'
    );
    const row = stmt.get(key) as
      | {
          key: string;
          nonce: string;
          status: IdempotencyRecord['status'];
          order_id: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;

    if (!row) return undefined;
    return {
      key: row.key,
      nonce: row.nonce,
      status: row.status,
      orderId: row.order_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  upsertIdempotencyRecord(record: IdempotencyRecord): void {
    const stmt = this.db.prepare(
      `INSERT INTO idempotency (key, nonce, status, order_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         nonce=excluded.nonce,
         status=excluded.status,
         order_id=excluded.order_id,
         updated_at=excluded.updated_at`
    );

    stmt.run(
      record.key,
      record.nonce,
      record.status,
      record.orderId ?? null,
      record.createdAt,
      record.updatedAt
    );
  }

  pruneIdempotencyRecords(beforeMs: number): number {
    const stmt = this.db.prepare('DELETE FROM idempotency WHERE updated_at < ?');
    const result = stmt.run(beforeMs);
    return result.changes;
  }

  persistMetric(event: MetricEvent): void {
    this.insertMetric.run(event.timestamp, event.type, JSON.stringify(event.data));
  }

  queryMetrics(type: MetricEventType, windowMs: number, nowMs = Date.now()): MetricEvent[] {
    const boundedWindow = Math.max(windowMs, 0);
    const cutoff = nowMs - boundedWindow;
    const stmt = this.db.prepare(
      'SELECT ts, type, data FROM metrics WHERE type = ? AND ts >= ? ORDER BY ts ASC'
    );
    const rows = stmt.all(type, cutoff) as Array<{ ts: number; type: string; data: string }>;
    return rows.map((row) => ({
      type: row.type as MetricEventType,
      timestamp: row.ts,
      data: JSON.parse(row.data)
    }));
  }

  queryMetricsByTypes(types: MetricEventType[], windowMs: number, nowMs = Date.now()): MetricEvent[] {
    const boundedWindow = Math.max(windowMs, 0);
    const cutoff = nowMs - boundedWindow;
    const uniqueTypes = Array.from(new Set(types));
    if (uniqueTypes.length === 0) return [];
    const placeholders = uniqueTypes.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT ts, type, data FROM metrics WHERE type IN (${placeholders}) AND ts >= ? ORDER BY ts ASC`
    );
    const rows = stmt.all(...uniqueTypes, cutoff) as Array<{ ts: number; type: string; data: string }>;
    return rows.map((row) => ({
      type: row.type as MetricEventType,
      timestamp: row.ts,
      data: JSON.parse(row.data)
    }));
  }

  pruneMetrics(beforeMs: number): number {
    const stmt = this.db.prepare('DELETE FROM metrics WHERE ts < ?');
    const result = stmt.run(beforeMs);
    return result.changes;
  }

  persistDecision(record: {
    id: string;
    subjectId: string;
    timestampMs: number;
    agent: string;
    decisionJson: unknown;
    reasoningJson: unknown;
  }): void {
    this.insertDecision.run(
      record.id,
      record.subjectId,
      record.timestampMs,
      record.agent,
      JSON.stringify(record.decisionJson),
      JSON.stringify(record.reasoningJson)
    );
  }

  listDecisions(filter: {
    agent?: string;
    subjectId?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  } = {}): StoredDecision[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    if (filter.subjectId) {
      where.push('opportunity_id = ?');
      params.push(filter.subjectId);
    }
    if (typeof filter.sinceMs === 'number') {
      where.push('ts >= ?');
      params.push(filter.sinceMs);
    }
    if (typeof filter.untilMs === 'number') {
      where.push('ts <= ?');
      params.push(filter.untilMs);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = typeof filter.limit === 'number' ? Math.max(filter.limit, 0) : 0;
    const limitSql = limit > 0 ? `LIMIT ${limit}` : '';

    const stmt = this.db.prepare(
      `SELECT id, opportunity_id, ts, agent, decision_json, reasoning_json
       FROM decisions
       ${whereSql}
       ORDER BY ts ASC
       ${limitSql}`
    );

    const rows = stmt.all(...params) as Array<{
      id: string;
      opportunity_id: string;
      ts: number;
      agent: string;
      decision_json: string;
      reasoning_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      subjectId: row.opportunity_id,
      timestamp: row.ts,
      agent: row.agent,
      decision: JSON.parse(row.decision_json),
      reasoning: JSON.parse(row.reasoning_json)
    }));
  }

  close(): void {
    this.db.close();
  }
}
