import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  dbPath?: string;
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
`;

export class EventStore {
  private db: Database.Database;

  constructor(options: EventStoreOptions = {}) {
    const dbPath = options.dbPath ?? 'data/openpolytrader.db';
    const resolved = resolve(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.exec(SCHEMA_SQL);
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

  close(): void {
    this.db.close();
  }
}
