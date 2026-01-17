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
