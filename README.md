# OpenPolyTrader

Near-risk-free Polymarket CLOB arbitrage automation with event-sourced state and an ops dashboard.

[![CI](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml/badge.svg)](https://github.com/freshtechbro/openpolytrader/actions/workflows/ci.yml)

## Quickstart

### Backend
```bash
npm install
npm run dev
```

### Ops Dashboard
```bash
cd dashboard
npm install
npm run dev
```

## Scripts

- `npm run dev` — start the backend
- `npm run build` — compile TypeScript
- `npm run typecheck` — TypeScript type checks
- `npm run test` — unit + integration tests

Dashboard:
- `npm run dev` — start Vite dev server
- `npm run build` — build dashboard
- `npm run test:e2e` — Playwright E2E tests

## Ops API

Default base: `http://localhost:3000`

- `GET /health`
- `GET /metrics`
- `GET /allowlist`
- `GET /incidents`
- `GET /stream` (SSE)

When `OPS_API_TOKEN` is set, include:
```bash
Authorization: Bearer $OPS_API_TOKEN
```

For the dashboard, set `VITE_OPS_API_TOKEN` to the same value.

## Configuration

Key env vars:
- `TOTAL_CAPITAL` (default 1000)
- `TRADING_ENABLED` (default false)
- `OPS_API_ENABLED` (default true)
- `OPS_API_HOST` (default 0.0.0.0)
- `OPS_API_TOKEN` (optional but recommended)
- `MARKET_CATALOG_PATH` (optional, JSON array of market pairs)
- `VITE_OPS_API_TOKEN` (dashboard only, matches `OPS_API_TOKEN`)

## Docs

- `docs/IMPLEMENTATION_PLAN.md`
- `docs/ARCHITECTURE.md`
- `docs/RESEARCH_REPORT.md`
- `docs/Development/market-catalog.md`
- `docs/Testing/strategy.md`
