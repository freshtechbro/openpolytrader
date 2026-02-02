# Development Setup

## Prerequisites
- Node.js 20+
- npm

## Backend

```bash
npm install
npm run dev
```

Ops API defaults to `http://localhost:3000`.

## Backend + Dashboard (dev:ops)

```bash
npm install
npm run dev:ops
```

Notes:
- Requires `OPS_API_TOKEN` or `VITE_OPS_API_TOKEN` in `dashboard/.env`.
- Dashboard runs on `http://localhost:5174` by default (override with `DASHBOARD_PORT`).
- Stop with `npm run dev:ops:down`.
- Logs: `tmp/backend.log`, `tmp/dashboard.log`.

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

## Live (Docker backend + dashboard)

```bash
npm run dev:live
```

Requires Docker running. Stop the container with:

```bash
npm run dev:live:down
```

## Environment variables

Start from `.env.example`.
For the full env-key inventory and production guidance, see `docs/Operations/runbook.md` and `docs/Operations/config-knobs.md`.
Dashboard env keys live in `dashboard/.env.example`.

Safety defaults:
- `TRADING_ENABLED=true`
- `TRADING_MODE=shadow`
- `RISK_PROFILE=extra_high`
- `OPS_API_ENABLED=true`

For safe local testing, set `TRADING_ENABLED=false` or `TRADING_MODE=off`. The `dev:ops` script overrides to `TRADING_MODE=paper`.

Risk profiles:
- `RISK_PROFILE` selects `near_zero|moderate|high|extra_high` when explicitly set (non-empty).
- `RISK_PROFILE_PATH` optionally points to a JSON profile file (overrides the default path).
- Profile selections applied via the Ops API persist to `settings/risk-gates/active.json` and are loaded on boot unless overridden by env.

Optional overrides (see `.env.example`):
- Ops intervals/retention, allowlist auto-resume, event store path + telemetry retention, Polymarket CLOB/WS endpoints.
- Ops reconciliation cadence/tolerance (`OPS_RECONCILIATION_*`) and Polymarket Data API endpoints (`POLYMARKET_DATA_API_*`).
- RPC provider defaults, circuit breaker settings, rate limit window, and wait confirmations/timeouts.

Near-zero-risk live mode requires user channel connectivity, configured via `POLYMARKET_USER_WS_URL` (default in `.env.example`).
If credentials are missing or the user channel is disconnected, near-zero-risk live mode refuses to place orders (fail-closed).
Live mode also requires `POLYMARKET_POSITIONS_USER` for portfolio reconciliation against the Polymarket Data API.

Dashboard env (build-time):
- `VITE_OPS_BASE_URL=http://localhost:3000`
- `VITE_OPS_API_TOKEN=...`
- `VITE_PORTFOLIO_REFRESH_MS=5000`
- `VITE_SLO_REFRESH_MS=30000`
- `VITE_INCIDENTS_LIMIT=100`
- `VITE_INCIDENTS_PREVIEW_LIMIT=6`

RPC infra env (env-only; UI never edits these):
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

## Docker

Build and run locally:

```bash
docker compose up --build
```

Notes:
- Container exposes `3000`.
- SQLite database persists in `./data` (mounted into the container).
- Docker healthcheck uses `GET /health/live` (liveness). For orchestrator readiness probes, use `GET /health/ready` (returns `503` when degraded).
- For live trading, set the required Polymarket + RPC keys (see `docs/Operations/runbook.md`).
