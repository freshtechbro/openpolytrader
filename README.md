# OpenPolyTrader

Near-zero-risk Polymarket CLOB arbitrage automation with event-sourced state, agent orchestration, and an ops dashboard.

[![CI](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml/badge.svg)](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml)

## Highlights

- Agent pipeline: Scanner → Risk → Execution → Portfolio (event-driven).
- Event-sourced state with SQLite-backed EventStore.
- Ops API + SSE stream for real-time telemetry.
- React/Vite dashboard UI for monitoring and configuration.
- Risk profiles: `near_zero`, `moderate`, `high`, `extra_high` (default in `.env.example`: `extra_high`; JSON under `settings/risk-gates/`).
- Runtime risk profile apply + persistence to `settings/risk-gates/active.json`.
- LLM advisory support across scanner/risk/execution/portfolio/market-data/ops/learning (bounded, conservative).
- Deterministic unwind logic with idempotency + timeout controls.
- Market catalog + allowlist gating for controlled trading universe.

## Quickstart

### Ops dev (backend + dashboard, local processes)
Starts the backend + dashboard with a single command using `scripts/dev-up.sh`.

```bash
npm install
npm run dev:ops
```

- Requires `OPS_API_TOKEN` or `VITE_OPS_API_TOKEN` in `dashboard/.env`.
- Backend: `http://localhost:3000`
- Dashboard: `http://localhost:5174` (override with `DASHBOARD_PORT`)
- Stop with `npm run dev:ops:down`.

### All-in-one (backend + dashboard via Docker)
Starts the Docker backend and the dashboard dev server together.

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

Key settings (defaults in `.env.example`):
- `TRADING_ENABLED=true` (set to `false` to hard-disable trading)
- `TRADING_MODE=off|shadow|paper|live` (default: `shadow`)
- `RISK_PROFILE=near_zero|moderate|high|extra_high` (default: `extra_high`)
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
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `GET /slo`
- `GET /allowlist`
- `GET /incidents`
- `GET /config`
- `GET /config/schema`
- `GET /config/infra`
- `GET /config/risk-profiles`
- `PATCH /config/policy`
- `PATCH /config/risk`
- `POST /config/risk-profile`
- `GET /stream` (SSE)

When `OPS_API_TOKEN` is set:
```
Authorization: Bearer $OPS_API_TOKEN
```

## Scripts

Backend:
- `npm run dev` — start backend
- `npm run dev:ops` — start backend + dashboard with ops token
- `npm run dev:ops:down` — stop dev:ops processes
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
- `npm run catalog:refresh:dev` — refresh market catalog (dev, no build)
- `npm run catalog:refresh` — refresh market catalog (prod, uses dist)

Dashboard:
- `npm run dev` — Vite dev server
- `npm run build` — production build
- `npm run test:e2e` — Playwright E2E

## Docs

- `docs/ARCHITECTURE.md` — system architecture and agent flow
- `docs/Development/setup.md` — dev setup and environment notes
- `docs/Development/market-catalog.md` — market catalog generation and refresh
- `docs/Operations/runbook.md` — operational guidance
- `docs/Operations/config-knobs.md` — config + UI knob inventory
- `docs/Operations/security.md` — security procedures
- `docs/Testing/strategy.md` — test strategy and coverage requirements
