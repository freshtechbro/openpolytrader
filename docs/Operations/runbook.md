# Operations Runbook

## Purpose

Operate OpenPolyTrader safely across `off`, `shadow`, `paper`, and `live` modes.

## Strategy Quick Reference

Know the active strategy class before making operational decisions:

| Strategy label | Primary intent shape | Distinguishing characteristics | Main runtime controls |
| --- | --- | --- | --- |
| `near_zero` | Paired YES/NO arbitrage | Strongest two-leg safety posture; strict spread/depth/staleness/fill discipline | `strategyMode`, `signalMode`, `edgeRequired`, `minPairedFillRate`, `maxLegSkewMs` |
| `ev` | Single-sided directional | Confidence-thresholded intent, cooldown throttling, EV-specific notional caps | `signalMode`, `evEdgeRequired`, `evConfidenceMin`, `evCooldownSeconds`, `evMaxPerMarketNotional`, `evMaxPortfolioNotional` |
| `fw_projection` | Dependency-aware projected intent | Frank-Wolfe solver constraints; non-converged/non-feasible outputs are rejected | `fwDependency*`, `fwGapAbsTolerance`, `fwGapRelTolerance`, `fwMaxLoopRuntimeMs`, `fwMinEdgeThreshold` |
| `fw_basket` | Multi-market projected basket | Basket-level sizing and execution mode constraints | `fwBasketExecutionMode`, `fwBasketMinMarkets`, `fwBasketMaxMarkets`, `fwMaxPerMarketNotional`, `fwMaxPortfolioNotional` |

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
npm run h
```

Full command inventory:

- `docs/Development/commands.md`

### Backend + dashboard

Set `OPS_API_TOKEN` in `.env` (or shell env) before startup; `npm run dev:ops` exits if missing.

```bash
npm install
npm --prefix dashboard install
npm run dev:ops
```

Preferred alias:

```bash
npm run dev:up
# or
npm run paper:up
```

`dev:ops` starts all FW-coupled local components:
- backend API (`:3000`)
- dashboard (`:5174`)
- IP oracle sidecar (`127.0.0.1:7071`)

`dev:ops` requires oracle health plus backend `/health/ready`. Dashboard probe timeout is warning-only (oracle/backend stay up). Re-check full status with:

```bash
npm run dev:ops:status
# or
npm run paper:status
```

Deterministic lifecycle smoke:

```bash
npm run dev:ops:smoke
# or
npm run paper:smoke
```

Stop:

```bash
npm run dev:ops:down
# or
npm run paper:down
```

`npm run dev:ops:down` sends `SIGTERM` first, escalates to `SIGKILL` when needed, and performs best-effort cleanup on ports `3000`, `5174`, and `7071`.

Dashboard startup noise control knobs:
- `OPS_DASHBOARD_READY_RETRY_ATTEMPTS`
- `OPS_DASHBOARD_READY_RETRY_BACKOFF_SECONDS`
- `OPS_DASHBOARD_READY_RETRY_WINDOW_SECONDS`

### Backend only

```bash
npm run dev
```

When `TRADING_MODE=paper` and `TRADING_ENABLED=true`, backend startup fails fast if `FW_ORACLE_BASE_URL/health` is unavailable. Use `npm run dev:ops`/`npm run paper:up` for reliable paper runs.

### Dashboard only

```bash
npm --prefix dashboard run dev
```

### Docker backend + local dashboard

```bash
npm run dev:live
```

Stop:

```bash
npm run dev:live:down
```

### Compiled runtime

```bash
npm run build
npm run start
```

Manual fallback process kill (only when PID tracking is stale):

```bash
lsof -ti tcp:3000,tcp:5174,tcp:7071 | xargs kill
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
When dashboard/API hostnames differ (for example `127.0.0.1` vs `localhost`), dashboard requests still authenticate via
`x-ops-token` header fallback and stream URLs append `?token=<token>` for `EventSource`.

## Ops UI Intent Semantics

The Overview page exposes two intent tables sourced from stream events:

- **All intents (gated):** driven by `latency` events with `stage=gated`.
- **Executed intents:** driven by `order` events, especially `status=submitted`.

Displayed strategy labels are normalized to:

- `near_zero`
- `ev`
- `fw_projection`
- `fw_basket`

Normalization details:

- `ev_single_side` is displayed as `ev`.
- Opportunity IDs can infer strategy when explicit strategy metadata is missing (`:fw:`, `:fwb:`, `:yes:`, `:no:`).

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
- `fw_dependency` (`event=llm_extraction`, `reason`, and edge counts)

Correlate with:

- `gate_rejection` reasons (`fw_*`, `fw_basket:*`),
- `execution_lifecycle` transitions,
- `incident` events (`partial_fill`, `unwind_failed`, `circuit_breaker`).

### FW dependency mode verification checklist

1. Confirm active runtime mode is deterministic:

```bash
curl -s -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/config | jq '.policy.fwDependencyMode'
```

2. Confirm FW dependency extraction is no longer on the hot path:

```bash
curl -s -H "Authorization: Bearer $OPS_API_TOKEN" "http://localhost:3000/metrics" | jq '.events[]? | select(.type=="fw_dependency") | select(.data.event=="llm_extraction")'
```

Expected: no new `llm_extraction` events while `fwDependencyMode=deterministic`.

3. If throughput drops after enabling deterministic mode, revert using risk-profile apply or policy patch and re-check `/config`:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":"extra_high"}' \
  http://localhost:3000/config/risk-profile
```

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
