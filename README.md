# OpenPolyTrader

Near-zero-risk Polymarket CLOB arbitrage automation with event-sourced state, agent orchestration, and an ops dashboard.

[![CI](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml/badge.svg)](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml)

## Highlights

- Agent pipeline: Scanner → Risk → Execution → Portfolio (event-driven).
- Event-sourced state with SQLite-backed EventStore.
- Ops API + SSE stream for real-time telemetry.
- React/Vite dashboard UI for monitoring and configuration.
- Risk profiles: `near_zero` (default), `moderate`, `high`, `extra_high` (JSON under `settings/risk-gates/`).
- Runtime risk profile apply + persistence to `settings/risk-gates/active.json`.
- LLM advisory support across scanner/risk/execution/portfolio/market-data/ops/learning (bounded, conservative).
- Deterministic unwind logic with idempotency + timeout controls.
- Market catalog + allowlist gating for controlled trading universe.

## Quickstart

### All-in-one (backend + dashboard)
Starts Docker backend and the dashboard dev server together.

```bash
npm install
npm run dev:live
```

- Backend: `http://localhost:3000`
- Dashboard: `http://localhost:5173`
- Requires Docker running.
- Stop with `npm run dev:live:down`.

### All-in-one build commands
```bash
# Build backend + dashboard + Docker images
npm run build:all

# Build everything and start Docker containers
npm run build:all:up

# Build everything and start backend + dashboard (dev server)
npm run build:all:live
```
- After changing `.env` or backend config, rebuild the container:
  ```bash
  docker compose up -d --build
  ```

### Backend only
```bash
npm install
npm run dev
```

### Dashboard only
```bash
cd dashboard
npm install
npm run dev
```

## Configuration

Start from `.env.example`.

Key settings:
- `TRADING_ENABLED=false` by default (fail-closed)
- `TRADING_MODE=off|shadow|paper|live`
- `RISK_PROFILE=near_zero|moderate|high|extra_high`
- `RISK_PROFILE_PATH=` optional override to a JSON profile
- `OPS_API_TOKEN=` (recommended)
- `VITE_OPS_API_TOKEN=` must match `OPS_API_TOKEN` for dashboard access

Risk profile behavior:
- If `RISK_PROFILE` is explicitly set, it takes precedence on boot.
- Applied profiles are persisted to `settings/risk-gates/active.json` and loaded on boot unless overridden by env.

Near-zero-risk live mode requires user channel connectivity (`POLYMARKET_USER_WS_URL`) and valid trading credentials.

## Ops API

Base: `http://localhost:3000`

- `GET /health`
- `GET /metrics`
- `GET /allowlist`
- `GET /incidents`
- `GET /config`
- `GET /config/schema`
- `GET /config/risk-profiles`
- `POST /config/risk-profile`
- `GET /stream` (SSE)

When `OPS_API_TOKEN` is set:
```
Authorization: Bearer $OPS_API_TOKEN
```

## Scripts

Backend:
- `npm run dev` — start backend
- `npm run build` — compile TypeScript
- `npm run build:all` — build backend, dashboard, and Docker images
- `npm run build:all:up` — build everything and start Docker containers
- `npm run start` — run compiled backend
- `npm run lint` — eslint
- `npm run typecheck` — tsc (no emit)
- `npm run test` — unit + integration tests
- `npm run test:coverage` — 95% coverage thresholds
- `npm run dev:live` — Docker backend + dashboard dev server
- `npm run dev:live:down` — stop Docker backend

Dashboard:
- `npm run dev` — Vite dev server
- `npm run build` — production build
- `npm run test:e2e` — Playwright E2E

## Docs

- `docs/ARCHITECTURE.md` — system architecture and agent flow
- `docs/Development/setup.md` — dev setup and environment notes
- `docs/Operations/runbook.md` — operational guidance
- `docs/Testing/strategy.md` — test strategy and coverage requirements
