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

## Dashboard

```bash
cd dashboard
npm install
npm run dev
```

## Environment variables

Start from `.env.example`.

Safety defaults:
- `TRADING_ENABLED=false`
- `OPS_API_ENABLED=true`

## Docker

Build and run locally:

```bash
docker compose up --build
```

Notes:
- Container exposes `3000`.
- SQLite database persists in `./data` (mounted into the container).
- For live trading, set the required Polymarket + RPC keys (see `docs/Operations/runbook.md`).
