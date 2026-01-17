# Dashboard UI Handoff - Trading Mode + Settings

## Scope
Implement dashboard updates for:
- Current UI alignment (pages, shared components, styles) + ops API/SSE contract reference.
- Trading mode display (off/shadow/paper/live) + kill-switch state (`tradingEnabled`).
- Schema-driven settings UI for policy + risk using `/config` + `/config/schema` + PATCH endpoints.

Backend endpoints are already live in the ops API.

## Current Dashboard UI (Baseline)

Pages (see `dashboard/src/App.tsx`):
- Overview: hero + KPI cards + allowlist + incidents summary.
- Markets: allowlist table.
- Incidents: incident table.
- Positions: portfolio snapshot (polled).
- Risk Gates: settings UI + risk profile dropdown for applying gate presets.

Top status area:
- `TopNav` renders `StatusPill` (health) and a stream connectivity pill. This is the right place to surface trading mode state without adding new layout primitives.

Shared components:
- Use `Section`, `Panel`, `MetricCard`, `MetricsTable`, and `StatusPill` for new UI. These define the current layout and visual language.

Styling conventions:
- Styles live in `dashboard/src/styles/tokens.css` and `dashboard/src/styles/app.css`. Reuse existing classes (panels, tables, status pills, grids) to avoid visual drift.

## Client Data Flow

Initial REST fetches (App mount):
- `/health`, `/metrics`, `/allowlist`, `/incidents` are fetched via `opsFetch` and stored in App state.

SSE stream behavior:
- `useEventStream` connects to `/stream` and listens for events: `health`, `incident`, `opportunity`, `order`, `fill`, `risk`, `info`, `error`.
- On `health`, health state updates. On `incident`, incident list updates. On `info`, `risk`, `order`, `fill`, the client refreshes `/metrics`.
- The stream connectivity pill is driven by `useEventStream` open/error transitions.

## Environment and Auth

Dashboard env vars (see `dashboard/.env.example`):
- `VITE_OPS_BASE_URL` (recommended in dev: `http://localhost:3000`): base URL for ops API (if unset, uses relative paths / same origin).
- `VITE_OPS_API_TOKEN` (optional): if set, REST uses `Authorization: Bearer <token>`.
- `VITE_SLO_REFRESH_MS` (optional): polling cadence for `/slo` window aggregates.

Auth behavior:
- REST calls use `Authorization: Bearer <token>` when a token is provided.
- SSE cannot send headers; `/stream` uses `?token=<token>` when `VITE_OPS_API_TOKEN` is set.
- The server also accepts `x-ops-token` for compatibility.

## Ops API Endpoints
All paths are relative to `VITE_OPS_BASE_URL` and require auth when configured.

### GET /health
Returns ops health report.
- Fields: `status`, `checks`, `uptimeMs`, `lastCheckMs`.

### GET /metrics
Returns metrics snapshot.
- Fields: `counts`, `lastEventAt`.

### GET /slo
Returns rolling SLO window aggregates backed by SQLite telemetry.

### GET /allowlist
Returns allowlist entries.
- Fields: `key`, `entry.status`, `entry.until`, `entry.reason`.

### GET /incidents
Returns recent incident metrics.
- Fields: `timestamp`, `check`, `result.error`/`result.info`.

### GET /portfolio
Returns portfolio snapshot.
- Fields: `totalCapital`, `availableCapital`, `dailyPnL`, `marketExposure`.
- Note: if portfolio agent is not configured, API returns `{ error: 'portfolio agent not configured' }`.

### GET /config
Returns full config snapshot.
- Response shape:
```json
{
  "policy": { "...": "TradePolicy fields" },
  "risk": { "...": "RiskConfig fields" },
  "riskProfile": "near_zero|moderate|high|extra_high",
  "riskProfileSource": "defaults|<path>",
  "tradingMode": "off|shadow|paper|live",
  "tradingEnabled": false
}
```
- If config store is unavailable, returns `503 { "error": "config_store_not_configured" }`.

### GET /config/risk-profiles
Returns available risk profiles and the active selection.
- Response shape:
```json
{
  "activeProfile": "near_zero|moderate|high|extra_high",
  "activeProfileSource": "defaults|<path>",
  "availableProfiles": ["near_zero","moderate","high","extra_high"]
}
```

### POST /config/risk-profile
Applies a risk profile (and optional custom path).
- Body:
```json
{ "profile": "near_zero|moderate|high|extra_high", "path": "optional/path.json" }
```
- Success: `{ "ok": true, "profile": { ... }, "policy": { ... }, "risk": { ... }, "persisted": true }`.
- Note: only settings present in the profile are overwritten; other values stay unchanged.
- Errors: `400 { "error": "invalid_profile", "validProfiles": [...] }` or `503 { "error": "risk_profile_not_configured" }`.

### GET /config/schema
Returns schema for settings UI.
- Field types: `number`, `boolean`, `enum`.
- Field constraints: `min`, `max`, `step`, `unit`, `integer`.

### GET /config/infra
Returns env-only infra/ops knobs as a **read-only** snapshot (to avoid runtime/UI drift).
- Includes: ops SSE heartbeat + incident limits, Polymarket rate limit window, RPC wait defaults.

### PATCH /config/policy
Partial update of policy fields.
- Success: `{ "policy": { ...updated } }`.
- Errors: `400 { "error": "invalid_policy_update", "issues": [...] }` or `{ "message": "..." }`.

### PATCH /config/risk
Partial update of risk fields.
- Success: `{ "risk": { ...updated } }`.
- Errors: `400 { "error": "invalid_risk_update", "issues": [...] }` or `{ "message": "..." }`.

### GET /stream
SSE endpoint.
- Emits `event: <type>` with JSON `data`.
- Event types: `health`, `incident`, `opportunity`, `order`, `fill`, `risk`, `info`, `error`.
- Sends an initial `info` event and a heartbeat `: ping` every 15s.
- Supports `?once=1` to close after one event.

## Mode Display Plan

Placement and semantics:
- Phase 1 uses the Risk Gates page to display `tradingMode` and `tradingEnabled` alongside settings.
- If additional at-a-glance status is needed later, add a compact indicator in `TopNav`.

Data source and refresh:
- Use `GET /config` as the source of truth.
- Fetch on page load; refresh on demand or via a low-frequency interval.

## Settings UI Plan

Data loading:
- Fetch `/config/schema` and `/config` on the settings page mount.
- If `/config` returns 503, show an unavailable/read-only state and skip PATCH actions.

Schema-driven inputs:
- `number`: numeric input with `min/max/step`, and enforce `integer` when set.
- `boolean`: toggle/checkbox.
- `enum`: select with options.
- Display `unit` labels alongside input values.

Layout and patterns:
- Render Policy and Risk settings in separate `Section` + `Panel` blocks.
- Use existing table or grid styles to align with `MetricsTable` and `Panel` layouts.

Edit/apply workflow:
- Direct edit inputs with per-section Save (policy/risk).
- Risk profile dropdown should call `/config/risk-profiles` on load and `/config/risk-profile` on Apply.
- Keep policy and risk updates independent to avoid cross-section conflicts.

Validation and errors:
- Client-side validation should respect schema constraints.
- Surface server errors (`invalid_policy_update`, `invalid_risk_update`) inline or in a panel callout.

State sync:
- On successful PATCH, update local state from response.
- Optionally re-fetch `/config` to confirm server state, avoiding overwriting unsaved edits.

## UI Requirements
- Display `tradingMode` and `tradingEnabled` in the TopNav status area.
- Settings UI must be schema-driven (no hardcoded field lists).
- Use existing shared components and styling patterns (`Section`, `Panel`, `MetricsTable`, `StatusPill`).
- Provide read-only view with Edit/Apply workflow and inline error handling.
- Keep the UI modular and extensible for future plugin-driven settings sections.

## Suggested Sections
1. Mode Status (TopNav and optional Overview panel).
2. Policy Settings (schema-driven inputs).
3. Risk Settings (schema-driven inputs).
4. Infra (env-only) snapshot (read-only).

## Known Deviations and Open Decisions
- Positions page now uses `VITE_OPS_BASE_URL` + `VITE_OPS_API_TOKEN` (same ops backend as the rest of the dashboard).
- Settings UI is implemented in `RiskGates` for Phase 1; if a dedicated Settings page is preferred later, add a new nav item.

## Notes
- No visual redesign required; follow existing dashboard styles.
- Frontend changes should be done by the frontend-ui-ux-engineer per project rules.
