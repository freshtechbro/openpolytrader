# Operations Runbook

## Purpose
Operate the OpenPolyTrader runtime safely with near-risk-free gating and tight incident controls.

## Start/Stop

### Backend + Dashboard (one command)
```bash
npm install
npm run dev:ops
```

Stop:
```bash
npm run dev:ops:down
```

### Backend (manual)
```bash
npm install
npm run dev
```

### Dashboard (manual)
```bash
cd dashboard
npm install
npm run dev
```

If ops auth is enabled, set:
- `VITE_OPS_API_TOKEN=...` (matches `OPS_API_TOKEN`)

Dashboard env (build-time, env-only):
- `VITE_OPS_BASE_URL=http://localhost:3000`
- `VITE_OPS_API_TOKEN=...`
- `VITE_PORTFOLIO_REFRESH_MS=5000`
- `VITE_SLO_REFRESH_MS=30000`
- `VITE_INCIDENTS_LIMIT=100`
- `VITE_INCIDENTS_PREVIEW_LIMIT=6`

## Environment Configuration

Source of truth for env keys:
- Runtime: `.env.example` (enforced by tests against `src/config/env.ts`)
- Dashboard: `dashboard/.env.example` (enforced by tests against `dashboard/src/lib/dashboardConfig.ts`)
- Full knob inventory: `docs/Operations/config-knobs.md`

### Where to get values for blank keys

These keys are intentionally left blank in `.env.example` / `dashboard/.env.example` and must be filled from your environment/secrets manager:

- `OPS_API_TOKEN`: generate a random token and store it as a secret (example: `openssl rand -hex 32`). If set, also set dashboard `VITE_OPS_API_TOKEN` to the same value.
- `OPS_ALERT_WEBHOOK_URL`: create an incoming webhook in your alerting system (Slack/Discord/PagerDuty/etc) and paste the webhook URL (treat as a secret if it embeds tokens).
- `POLYMARKET_POSITIONS_USER`: the `0x...` wallet address whose positions are reconciled via the Polymarket Data API (must match the account used for live trading).
- `QUICKNODE_RPC_URL`: create a Polygon (mainnet) HTTP endpoint in QuickNode and paste the endpoint URL (optional; used as an RPC fallback in Phase 1).
- `MARKET_CATALOG_PATH`: local absolute/relative path to a market catalog JSON file (optional; see `docs/Development/market-catalog.md`).
- `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PEM` / `KALSHI_PRIVATE_KEY_PATH`: only required when Phase 2 cross-venue/Kalshi integration is enabled; obtain from Kalshi developer credentials and provide either PEM inline or a filesystem path to the PEM file.

Required for live trading (`TRADING_ENABLED=true` and `TRADING_MODE=live`):
- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER` (0x address for Data API position reconciliation)

Near-zero-risk live mode fails closed unless the Polymarket **user channel** is configured and connected (uses the same Polymarket credentials; endpoint defaults to `POLYMARKET_USER_WS_URL`).

Safety defaults:
- `TRADING_ENABLED=false` (default)
- `TRADING_MODE=off` (default)
- `TOTAL_CAPITAL=1000`

Ops API:
- `OPS_API_ENABLED=true`
- `OPS_API_HOST=0.0.0.0`
- `PORT=3000`
- `OPS_API_TOKEN=...` (optional but recommended)
- `OPS_ALERT_WEBHOOK_URL=...` (optional; incident alerts)
- `OPS_HEALTH_INTERVAL_MS=30000` (health check cadence)
- `OPS_SHUTDOWN_TIMEOUT_MS=30000` (graceful shutdown timeout)
- `OPS_STREAM_HEARTBEAT_MS=15000` (SSE heartbeat)
- `OPS_INCIDENTS_LIMIT=100` (incidents returned via `/incidents`)
- `OPS_RECONCILIATION_INTERVAL_MS=300000` (portfolio reconciliation cadence; 0 disables interval)
- `OPS_RECONCILIATION_AFTER_INCIDENT_DELAY_MS=0` (reconcile after any incident)
- `OPS_RECONCILIATION_POSITION_SIZE_TOLERANCE=0.000001` (tolerance when comparing venue vs internal sizes)
- `OPS_BOOK_REFRESH_INTERVAL_MS=5000` (stale book refresh cadence; 0 disables interval)
- `OPS_BOOK_REFRESH_STALE_MS=10000` (refresh snapshot once a book exceeds this age)
- `OPS_BOOK_STALE_QUARANTINE_THRESHOLD=3` (number of repeated stale incidents before quarantine)
- `OPS_BOOK_STALE_QUARANTINE_WINDOW_MS=300000` (rolling window for stale incident count)
- `OPS_BOOK_STALE_QUARANTINE_COOLDOWN_MS=0` (override cooldown; 0 uses risk cooldown)
- `METRICS_MAX_EVENTS=1000` (metrics retention)
- `INCIDENTS_MAX_EVENTS=1000` (incident retention)
- `ALLOWLIST_AUTO_RESUME=true` (auto-resume quarantines after cooldown)
- `EVENT_STORE_PATH=data/openpolytrader.db` (SQLite path)
- `EVENT_STORE_METRICS_RETENTION_DAYS=7` (telemetry retention window)
- `EVENT_STORE_METRICS_PRUNE_INTERVAL_MS=3600000` (telemetry pruning cadence; 0 disables interval)

Market catalog:
- `MARKET_CATALOG_PATH=/path/to/markets.json` (optional)
  - Recommended: `MARKET_CATALOG_PATH=data/market-catalog.json` and generate/refresh it via `docs/Development/market-catalog.md`.
- `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS=80` (optional; only used when the catalog file does not exist yet and `npm start` runs the prestart generator)
- `MARKET_CATALOG_MIN_VOLUME_24H=1000` (optional; minimum 24h volume for refresh inclusion)
- `MARKET_CATALOG_ORDER=volume24hr` (optional; accepts `volume24hr` or `newest` to bias discovery)
- `MARKET_CATALOG_PAGE_SIZE=100` (optional; Gamma page size)
- `MARKET_CATALOG_MAX_PAGES=5` (optional; cap on refresh pagination)
- Empty refreshes (no valid pairs) keep the last known allowlist and trigger a single `market_catalog_refresh_empty` error per backoff window.

Polymarket connectivity (optional overrides):
- `POLYMARKET_CLOB_BASE_URL=...`
- `POLYMARKET_CLOB_TIMEOUT_MS=8000`
- `POLYMARKET_CLOB_RATE_LIMIT_PER_SEC=300`
- `POLYMARKET_CLOB_RATE_LIMIT_WINDOW_MS=1000`
- `POLYMARKET_CLOB_ORDER_PATH=/orders`
- `POLYMARKET_CLOB_BATCH_ORDER_PATH=/orders`
- `POLYMARKET_CLOB_CANCEL_ORDER_PATH=/order`
- `POLYMARKET_CLOB_CANCEL_ORDERS_PATH=/orders`
- `POLYMARKET_CLOB_CANCEL_ALL_PATH=/cancel-all`
- `POLYMARKET_CLOB_CANCEL_MARKET_ORDERS_PATH=/cancel-market-orders`
- `POLYMARKET_CLOB_ACTIVE_ORDERS_PATH=/data/orders`
- `POLYMARKET_CLOB_RETRY_MAX_RETRIES=3`
- `POLYMARKET_CLOB_RETRY_BASE_DELAY_MS=250`
- `POLYMARKET_CLOB_RETRY_MAX_DELAY_MS=2000`
- `POLYMARKET_WS_URL=...`
- `POLYMARKET_USER_WS_URL=...` (user channel; required for near-zero-risk live execution)
- `POLYMARKET_WS_HEARTBEAT_MS=10000`
- `POLYMARKET_WS_RECONNECT_BASE_MS=250`
- `POLYMARKET_WS_RECONNECT_MAX_MS=30000`
- `POLYMARKET_WS_RECONNECT_JITTER_PCT=0.2`
- `POLYMARKET_L1_PRIVATE_KEY=...` (optional; derives fresh CLOB API creds at boot)
- `POLYMARKET_L1_NONCE=0` (nonce used when deriving CLOB API creds)

Polymarket Data API (used for reconciliation):
- `POLYMARKET_DATA_API_BASE_URL=https://data-api.polymarket.com`
- `POLYMARKET_DATA_API_POSITIONS_PATH=/positions`
- `POLYMARKET_DATA_API_TIMEOUT_MS=8000`
- `POLYMARKET_DATA_API_RATE_LIMIT_PER_SEC=300`
- `POLYMARKET_DATA_API_RATE_LIMIT_WINDOW_MS=1000`
- `POLYMARKET_DATA_API_RETRY_MAX_RETRIES=3`
- `POLYMARKET_DATA_API_RETRY_BASE_DELAY_MS=250`
- `POLYMARKET_DATA_API_RETRY_MAX_DELAY_MS=2000`
- `POLYMARKET_POSITIONS_USER=0x...`
- `POLYMARKET_POSITIONS_SIZE_THRESHOLD=0`
- `POLYMARKET_POSITIONS_LIMIT=200`
- `POLYMARKET_POSITIONS_OFFSET=0`

RPC infra (env-only; UI never edits these):
- `ALCHEMY_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2`
- `ALCHEMY_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2`
- `ALCHEMY_RPC_RPS=125`
- `QUICKNODE_RPC_URL=...`
- `QUICKNODE_RPC_RPS=10`
- `CHAINSTACK_RPC_URL=https://polygon-mainnet.chainstacklabs.com`
- `CHAINSTACK_WS_URL=wss://polygon-mainnet.chainstacklabs.com`
- `CHAINSTACK_RPC_RPS=600`
- `ANKR_RPC_URL=https://rpc.ankr.com/polygon`
- `ANKR_RPC_RPS_PHASE1=30`
- `ANKR_RPC_RPS_PHASE2=1500`
- `PRIVATE_RPC_URL=http://localhost:8545`
- `PRIVATE_WS_URL=ws://localhost:8545`
- `PRIVATE_RPC_RPS=10000`
- `RPC_RATE_LIMIT_WINDOW_MS=1000`
- `RPC_WAIT_CONFIRMATIONS=1`
- `RPC_WAIT_TIMEOUT_MS=60000`
- `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE1=5`
- `RPC_CIRCUIT_TIMEOUT_MS_PHASE1=60000`
- `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE1=3`
- `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE2=3`
- `RPC_CIRCUIT_TIMEOUT_MS_PHASE2=30000`
- `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE2=5`
- `RPC_CIRCUIT_FAILURE_THRESHOLD_PHASE3=2`
- `RPC_CIRCUIT_TIMEOUT_MS_PHASE3=15000`
- `RPC_CIRCUIT_HALF_OPEN_REQUESTS_PHASE3=10`

## Health Monitoring

Ops endpoints:
- `GET /health` — agent + system health
- `GET /health/live` — liveness (process uptime)
- `GET /health/ready` — readiness (runs checks; 200 healthy, 503 degraded)
- `GET /metrics` — event counts and last event time
- `GET /slo` — rolling 1h/24h SLO aggregates (SQLite-backed)
- `GET /allowlist` — allowlist/quarantine state
- `POST /allowlist/:marketId/resume` — manual resume after quarantine
- `GET /incidents` — recent incidents
- `GET /config` — current policy/risk config snapshot
- `GET /config/schema` — policy/risk schema for UI rendering
- `GET /config/infra` — env-only infra snapshot (read-only)
- `PATCH /config/policy` — update trade policy settings
- `PATCH /config/risk` — update risk settings
- `GET /stream` — SSE updates

Health probe semantics:
- Use `GET /health/live` for **liveness** (used by the Docker healthcheck); it only asserts the process is up.
- Use `GET /health/ready` for **readiness** in orchestrators; it runs OpsAgent checks and returns `503` when degraded to fail closed.

When `OPS_API_TOKEN` is set, include it in requests:
```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

## Incident Response

### Automatic quarantine
Markets are quarantined after delayed or rejected order responses and after repeated
`book_freshness` incidents within the configured rolling window.
If `ALLOWLIST_AUTO_RESUME=false`, quarantines persist until manually resumed.

### Manual triage
1. Inspect `/incidents` for the latest event.
2. Verify orderbook depth and spread for the market.
3. Keep the market quarantined until stability is confirmed.

### Manual resume
Resume a quarantined market after verification:
```bash
curl -X POST -H "Authorization: Bearer $OPS_API_TOKEN" \
  http://localhost:3000/allowlist/<marketId>/resume
```

## Deployment

Use the CI pipeline for test and build validation.
When deploying, verify:
- Ops API reachable
- WebSocket connection stable
- Allowlist seeded
- `TRADING_ENABLED` set intentionally
- `TRADING_MODE` set intentionally

## Rollback

1. Stop the running process.
2. Roll back to the last known good build.
3. Verify `/health` returns `healthy`.

## Security

- Store API keys outside the repo (environment variables or secrets manager).
- Restrict ops API access (set `OPS_API_TOKEN` or implement mTLS).
- Rotate keys regularly.
