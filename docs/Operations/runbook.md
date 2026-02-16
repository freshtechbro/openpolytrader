# Operations Runbook

## Purpose

Operate OpenPolyTrader safely across `off`, `shadow`, `paper`, and `live` modes.

## Minimum Requirements

### Local safe operations

- Node.js 20+
- `OPS_API_TOKEN` configured
- `VITE_OPS_API_TOKEN` matching backend token (if dashboard used)
- `TRADING_MODE=paper` (recommended default for local ops)

### Live operations (strict)

Runtime-enforced required keys when `TRADING_MODE=live` and `TRADING_ENABLED=true`:

- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER`

## Start / Stop

### Backend + dashboard

```bash
npm install
npm --prefix dashboard install
npm run dev:ops
```

Stop:

```bash
npm run dev:ops:down
```

### Backend only

```bash
npm run dev
```

### Dashboard only

```bash
npm --prefix dashboard run dev
```

## Ops API Surface

Complete API reference: `docs/API.md`.

### Health + telemetry

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `GET /slo`
- `GET /stream` (`once`, `maxPings` query params)

### Markets + incidents + portfolio

- `GET /allowlist`
- `GET /markets`
- `POST /allowlist/:marketId/resume`
- `GET /incidents`
- `GET /portfolio`
- `GET /decisions` (`agent`, `subjectId`, `limit`, `sinceMs`, `untilMs`)

### Config and control plane

- `GET /config`
- `GET /config/schema`
- `GET /config/infra`
- `GET /config/risk-profiles`
- `PATCH /config/policy`
- `PATCH /config/risk`
- `POST /config/risk-profile`
- `POST /config/trading-mode` (`?confirm=true` required for `mode=live`)

### Debug endpoints

- `POST /debug/learning/synthesize`
- `POST /debug/portfolio/analyze`
- `POST /debug/marketdata/outlier`
- `POST /debug/synthetic-opportunity`

## Authentication

When `OPS_API_TOKEN` is set:

```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

## Incident Response

1. Check `/health` and `/health/ready`.
2. Inspect `/incidents`, `/markets`, and `/allowlist`.
3. Keep unstable markets quarantined.
4. Resume explicitly only after verification:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  http://localhost:3000/allowlist/<marketId>/resume
```

## Trading Mode Change Safety

Switch to paper mode:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper","enabled":true}' \
  http://localhost:3000/config/trading-mode
```

Switch to live mode (explicit confirmation required):

```bash
curl -X POST \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"live","enabled":true}' \
  "http://localhost:3000/config/trading-mode?confirm=true"
```

## References

- Environment variable reference: `docs/Operations/environment-reference.md`
- Config knobs: `docs/Operations/config-knobs.md`
- Architecture: `docs/ARCHITECTURE.md`
- Setup spec: `docs/Development/setup.md`
