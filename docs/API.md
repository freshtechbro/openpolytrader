# Ops API Reference

Base URL: `http://localhost:3000`

## Authentication

If `OPS_API_TOKEN` is configured, requests must include one of:

- `Authorization: Bearer <token>`
- `x-ops-token: <token>`
- `?token=<token>`
- an active HttpOnly session cookie created by `POST /ops/session`

Dashboard runtime session endpoints:

- `GET /ops/session` returns current session/auth state
- `POST /ops/session` accepts `{ "token": "<OPS_API_TOKEN>" }` and sets an HttpOnly session cookie
- `DELETE /ops/session` clears the session cookie
- Dev-only prefill: `GET /ops/session?prefill=1` may include `prefillToken` only when
  `OPS_DEV_SESSION_PREFILL_ENABLED=true` and request originates from localhost.
- Dashboard API requests include `x-ops-token` automatically when a runtime token is present
  and no explicit auth header was provided.
- For cross-host UI/API setups (for example `127.0.0.1` UI -> `localhost` API),
  dashboard stream URLs append `?token=<token>` so `EventSource` remains authenticated.

## Endpoints

### Health + Monitoring

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/ops/session` | Session/auth status for dashboard runtime login |
| `POST` | `/ops/session` | Start dashboard ops session with token body |
| `DELETE` | `/ops/session` | End dashboard ops session |
| `GET` | `/health` | Full ops health report |
| `GET` | `/health/live` | Liveness probe (`uptimeMs`) |
| `GET` | `/health/ready` | Readiness probe (returns `503` when degraded) |
| `GET` | `/metrics` | Metrics snapshot (`counts`, `lastEventAt`) |
| `GET` | `/slo` | Rolling SLO aggregates (requires event store) |
| `GET` | `/stream` | SSE event stream |

`GET /stream` query params:

- `once=true` to connect and immediately close after initial info event
- `maxPings=<positive-int>` to auto-close after N heartbeat pings

`GET /stream` event naming:

- metric event names mirror metric types
- metric type `error` is emitted as SSE event name `metric_error`

Dashboard stream subscriptions (`useEventStream`) register listeners for:

- `health`
- `incident`
- `opportunity`
- `order`
- `fill`
- `risk`
- `info`
- `metric_error`
- `latency`
- `execution_lifecycle`
- `book_staleness`
- `slo_violation`
- `gate_rejection`
- `shadow_decision`
- `llm_decision`
- `allowlist_updated`
- `trading_mode_changed`
- `trading_enabled_changed`

FWMM metric counters exposed in `GET /metrics` `counts` include:

- `fw_iteration`
- `fw_gap`
- `fw_active_set`
- `fw_contraction`
- `fw_basket`

When present, these same metric types are emitted on `GET /stream` as SSE event names.

Ops intent-table semantics in dashboard:

- `latency` events with `stage=gated` create/update "All intents (gated)" rows.
- `order` events update order outcome/status and drive "Executed intents" rows.
- Strategy labels shown in UI normalize to `near_zero`, `ev`, `fw_projection`, `fw_basket`;
  `ev_single_side` is normalized to `ev`.

### Markets + Incidents + Portfolio

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/allowlist` | Current allowlist/quarantine state |
| `GET` | `/markets` | Allowlist entries enriched with market metadata (if CLOB client configured) |
| `POST` | `/allowlist/:marketId/resume` | Resume a quarantined market |
| `GET` | `/incidents` | Recent incident events |
| `GET` | `/portfolio` | Portfolio snapshot (requires portfolio agent) |
| `GET` | `/decisions` | Decision log query (requires event store) |

`GET /decisions` query params:

- `agent`: filter by agent name
- `subjectId`: filter by subject id
- `limit`: positive int, capped at `1000` (default `200`)
- `sinceMs`: lower timestamp bound (ms)
- `untilMs`: upper timestamp bound (ms)

### Config + Runtime Control

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/config` | Runtime config snapshot + trading state |
| `GET` | `/config/schema` | Runtime-editable policy/risk schema |
| `GET` | `/config/infra` | Infra env snapshot (read-only) |
| `GET` | `/config/risk-profiles` | Active + available risk profiles |
| `PATCH` | `/config/policy` | Partial policy update |
| `PATCH` | `/config/risk` | Partial risk update |
| `POST` | `/config/risk-profile` | Apply named risk profile |
| `POST` | `/config/trading-mode` | Change mode and/or enabled state |

`POST /config/risk-profile` body:

```json
{
  "profile": "near_zero|moderate|high|extra_high",
  "path": "/optional/profile/path.json"
}
```

`POST /config/trading-mode` body:

```json
{
  "mode": "off|shadow|paper|live",
  "enabled": true
}
```

Live mode safety rule:

- `mode=live` requires `?confirm=true` query parameter or request is rejected.

### Debug Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/debug/learning/synthesize` | Trigger learning synthesis |
| `POST` | `/debug/portfolio/analyze` | Trigger portfolio anomaly analysis |
| `POST` | `/debug/marketdata/outlier` | Force market-data outlier check |
| `POST` | `/debug/synthetic-opportunity` | Inject synthetic opportunity for validation |

`POST /debug/marketdata/outlier` body:

```json
{
  "tokenId": "<token-id>"
}
```

`POST /debug/synthetic-opportunity` body fields:

- `marketId`
- `yesPrice`
- `noPrice`
- `costPerSet`
- `edge`
- `tickSize`
- `minOrderSize`
- `maxSizeByDepth`
- `execute` (boolean)
- `executionMode` (`off|shadow|paper|live`)

## Example Requests

Health:

```bash
curl -H "Authorization: Bearer $OPS_API_TOKEN" http://localhost:3000/health
```

Apply policy patch:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"edgeRequired":0.002,"maxSpread":0.03}' \
  http://localhost:3000/config/policy
```

Switch to paper mode:

```bash
curl -X POST \
  -H "Authorization: Bearer $OPS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper","enabled":true}' \
  http://localhost:3000/config/trading-mode
```
