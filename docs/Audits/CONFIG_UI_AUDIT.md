# Config/UI Audit — Remaining Knobs (P0)

This audit documents where configuration lives, which knobs are UI-editable vs env-only, and how we enforce “no hard-coded settings”.

## Summary

- **Trade-critical knobs (UI-editable)** live in the **policy + risk** config store and are surfaced in the dashboard Risk Gates page.
- **Infra/ops knobs** remain **env-only** to avoid runtime/UI drift, but are now surfaced **read-only** via ops API + dashboard.
- **Hard-coded endpoints** are disallowed outside `src/config/env.ts` (enforced by unit test).
- `.env.example` and `dashboard/.env.example` are enforced to stay in sync with their respective schema/usage.

## Config surfaces

### UI-editable (trade-critical)

- Backend config store: `src/config/store.ts`
- Schema + validation: `src/config/schema.ts`, `src/config/validate.ts`
- Dashboard UI: `dashboard/src/pages/RiskGates.tsx`

Sections:
- `policy` — gating + execution guardrails (edge, freshness, leg skew, velocity/OTR, timeouts, tick/min-size fallbacks)
- `risk` — sizing + loss bounds (trade fraction caps, drawdown caps, unwind budget, unwind slippage, per-trade loss cap)

### Env-only (infra/ops)

Source of truth:
- `src/config/env.ts` (schema + defaults + validation)
- `.env.example` (backend env coverage)
- `dashboard/.env.example` (dashboard env coverage)

Ops API exposure (read-only):
- `GET /config/infra` in `src/api/server.ts`
- Snapshot builder: `src/config/infra.ts`

Dashboard exposure (read-only):
- Infra panels in `dashboard/src/pages/RiskGates.tsx`

## “No hard-coded settings” enforcement

### Hard-coded endpoints

- Unit test: `tests/unit/no-hardcoded-urls.test.ts`
- Rule: `http(s)://` and `ws(s)://` literals may only appear in `src/config/env.ts` (defaults) or env example files/docs.

### Env example coverage

- Backend env coverage: `tests/unit/env-example-coverage.test.ts`
- Dashboard env coverage: `tests/unit/dashboard-env-example-coverage.test.ts`

These tests prevent drift between:
- `src/config/env.ts` ↔ `.env.example`
- `dashboard/src/lib/dashboardConfig.ts` ↔ `dashboard/.env.example`

## Notes / Recommendations

- **Infra knobs remain env-only**: The UI is intentionally read-only to avoid conflicting semantics and runtime drift.
- **Risk-only unwind semantics**: `unwindSlippageToleranceBps` lives under `risk` so “unwind” is owned by a single surface area.
- **Fallback telemetry**: Market-data tick/min-size fallbacks emit `book_fallback` telemetry (`src/agents/market-data/MarketDataAgent.ts`).

