# Operations Runbook

## Purpose
Operate the OpenPolyTrader runtime safely with near-risk-free gating and tight incident controls.

## Start/Stop

### Backend
```bash
npm install
npm run dev
```

### Dashboard
```bash
cd dashboard
npm install
npm run dev
```

If ops auth is enabled, set:
- `VITE_OPS_API_TOKEN=...` (matches `OPS_API_TOKEN`)

## Environment Configuration

Required for live trading:
- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`

Safety defaults:
- `TRADING_ENABLED=false` (default)
- `TOTAL_CAPITAL=1000`

Ops API:
- `OPS_API_ENABLED=true`
- `OPS_API_HOST=0.0.0.0`
- `PORT=3000`
- `OPS_API_TOKEN=...` (optional but recommended)

Market catalog:
- `MARKET_CATALOG_PATH=/path/to/markets.json` (optional)

## Health Monitoring

Ops endpoints:
- `GET /health` — agent + system health
- `GET /metrics` — event counts and last event time
- `GET /allowlist` — allowlist/quarantine state
- `GET /incidents` — recent incidents
- `GET /stream` — SSE updates

When `OPS_API_TOKEN` is set, include it in requests:
```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

## Incident Response

### Automatic quarantine
Markets are quarantined after delayed or rejected order responses.

### Manual triage
1. Inspect `/incidents` for the latest event.
2. Verify orderbook depth and spread for the market.
3. Keep the market quarantined until stability is confirmed.

## Deployment

Use the CI pipeline for test and build validation.
When deploying, verify:
- Ops API reachable
- WebSocket connection stable
- Allowlist seeded
- `TRADING_ENABLED` set intentionally

## Rollback

1. Stop the running process.
2. Roll back to the last known good build.
3. Verify `/health` returns `healthy`.

## Security

- Store API keys outside the repo (environment variables or secrets manager).
- Restrict ops API access (set `OPS_API_TOKEN` or implement mTLS).
- Rotate keys regularly.
