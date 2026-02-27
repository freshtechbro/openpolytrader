# Operations Runbook

## Purpose

Operate OpenPolyTrader safely across `off`, `shadow`, `paper`, and `live` modes.

## Minimum Requirements

### Local safe operations

- Node.js 20+
- `OPS_API_TOKEN` configured
- Runtime ops session login enabled for dashboard (`/ops/*`)
- `TRADING_MODE=paper` (recommended default for local ops)

### Live operations (strict)

Runtime-enforced required keys when `TRADING_MODE=live` and `TRADING_ENABLED=true`:

- `ALCHEMY_API_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_POSITIONS_USER`

## Start / Stop

Root command/tool/flag index:

```bash
npm run help
```

### Backend + dashboard

Set `OPS_API_TOKEN` in `.env` (or shell env) before startup; `npm run dev:ops` exits if missing.

```bash
npm install
npm --prefix dashboard install
npm run dev:ops
```

`dev:ops` starts all FW-coupled local components:
- backend API (`:3000`)
- dashboard (`:5174`)
- IP oracle sidecar (`127.0.0.1:7071`)

`dev:ops` now blocks on startup health checks for all three. Re-check status with:

```bash
npm run dev:ops:status
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

Dashboard operators authenticate via runtime session at `/ops/*` by submitting `OPS_API_TOKEN` once per session.
`npm run dev:ops` defaults `OPS_DEV_SESSION_PREFILL_ENABLED=true`, so localhost token prefill is enabled automatically via `GET /ops/session?prefill=1`.
To run without prefill, start with `OPS_DEV_SESSION_PREFILL_ENABLED=false npm run dev:ops`.

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

## FWMM Basket Rollout + Triage

### Stage progression

1. Replay: keep execution disabled, verify convergence and basket candidate quality only.
2. Shadow: keep execution disabled, run full FW loop + gate/risk simulation on live market data.
3. Paper: enable execution with conservative caps and keep FW baskets gap-converged only.

Promotion checklist before moving to the next stage:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run test:coverage`
- `npm --prefix dashboard run build`
- `npm --prefix dashboard run test:e2e`

Rollback triggers:

- sustained `fw_gap_not_converged` / `fw_loop_runtime_exceeded` / `fw_contraction_floor`,
- elevated basket partial-fill or unwind-failed incidents,
- order velocity or OTR guardrail violations.

### Operator signals

Monitor these in `/metrics` and `/stream`:

- `fw_iteration`
- `fw_gap`
- `fw_active_set`
- `fw_contraction`
- `fw_basket`

Correlate with:

- `gate_rejection` reasons (`fw_*`, `fw_basket:*`),
- `execution_lifecycle` transitions,
- `incident` events (`partial_fill`, `unwind_failed`, `circuit_breaker`).

### Failure playbooks

Non-convergence triage:

1. Confirm projection load and solver health in `/metrics` (`fw_iteration`, `fw_gap`, `fw_oracle`).
2. Inspect gate-rejection reasons for `fw_gap_not_converged`, `fw_loop_runtime_exceeded`, or `fw_contraction_floor`.
3. Reduce blast radius by lowering `fwBasketMaxMarkets` and/or disabling baskets.

Partial-fill / unwind triage:

1. Check `execution:outcome` and `execution_lifecycle` for `partial_fill` and unwind transitions.
2. Inspect incident records for `unwind_failed` details.
3. Lower basket size risk by tightening `fwMaxPerMarketNotional` and `fwMaxPortfolioNotional`.

Emergency containment path:

Reduce FW basket scope to one market:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fwBasketMinMarkets":1,"fwBasketMaxMarkets":1}' \
  http://localhost:3000/config/policy
```

Then tighten FW emission thresholds if needed:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fwMinEdgeThreshold":0.02,"fwMaxPortfolioNotional":25}' \
  http://localhost:3000/config/policy
```

## References

- Environment variable reference: `docs/Operations/environment-reference.md`
- Config knobs: `docs/Operations/config-knobs.md`
- Architecture: `docs/ARCHITECTURE.md`
- Setup spec: `docs/Development/setup.md`
