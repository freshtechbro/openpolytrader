# Continuity Ledger - openpolytrader

## Goal (incl. success criteria):
- Implement and harden “near-zero-risk” P0 execution per `docs/IMPLEMENTATION_PLAN_NEAR_ZERO_RISK_P0_MERGED.md`, with no hard-coded operational settings, env-only infra knobs, and UI only for trade-critical knobs.
- Success criteria: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage` all pass with 100% tests and ≥95% branch coverage; dashboard `npm --prefix dashboard run build` + `npm --prefix dashboard run test:e2e` pass.
- Provide an automated way to fetch Polymarket market pairs and generate a `MARKET_CATALOG_PATH` JSON file for allowlist seeding.

## Constraints/Assumptions:
- Infra knobs (RPC/WS/ops) are env-only to avoid runtime/UI drift; UI may display infra read-only.
- Prefer “risk-only” semantics for overlapping controls to avoid conflicting meanings.
- Configurable defaults are allowed, but should emit telemetry when fallbacks/defaults are used.
- No hard-coded endpoints/URLs outside config modules; `.env.example` coverage enforced by tests.

## Key decisions:
- Infra env-only + read-only snapshot via `GET /config/infra`; dashboard shows infra in `RiskGates` without edit controls.
- Enforce “no hard-coded URL literals” via unit tests; enforce env example coverage via unit tests.
- `unwindSlippageToleranceBps` lives in risk config and is enforced as a risk rejection gate.
- Treat complete-set (hedged) inventory as not-open inventory for `open_inventory_timeout`; derive token→market mapping from configured `marketPairs`.
- Keep `/health/live` for Docker liveness; use `/health/ready` for orchestrator readiness.
- Risk sizing incorporates `depthBufferMultiplier` to avoid approving sizes that will be rejected by the depth buffer gate at execution-time.
- P0 “agents” are deterministic in-process modules orchestrated by `Supervisor`/`messageBus`; no LLM integration is implemented yet (LLM dependency detection is research/Phase 2 scope).

## State:
  - Done:
    - Tasks 1–18 implemented locally (Phase P0 hardening through portfolio fill reconciliation); plan doc marks Tasks 17–18 as implemented.
    - Task 19 implemented: per-market `CircuitBreakerRegistry` wired into `Supervisor` and `ExecutionAgent` with trade gate + incidents; new trade-critical risk knobs (`marketCircuitFailureThreshold`, `marketCircuitHalfOpenSuccesses`).
    - Task 20 implemented: portfolio market exposure now derived from positions; unwind recording wired; zero-size positions removed; exposure cleanup APIs added; tests updated.
    - Ops SSE tests adapted for environment (no TCP bind) via injectable `listen` and `/stream` `maxPings` support.
    - Task 21 implemented: periodic reconciliation (startup/interval/incident) using CLOB active orders + Data API positions; incidents on drift; new env-only reconciliation knobs.
    - Task 22 implemented: OpsAgent SLO health checks (book freshness, delayed ACK, decision latency p95, paired-fill rate, circuit breakers) using in-memory telemetry windows.
    - Task 23 implemented: SQLite-backed telemetry persistence + retention, rolling 1h/24h SLO aggregates (`GET /slo`), and dashboard SLO windows panel.
    - Task 24 implemented: webhook alert delivery (`OPS_ALERT_WEBHOOK_URL`), readiness/liveness endpoints (`GET /health/ready`, `GET /health/live`), and container healthcheck wiring (Dockerfile + docker-compose).
    - Task 25 implemented: graceful shutdown (SIGTERM/SIGINT) with supervisor shutdown + cancel-all (live mode) + connection teardown + timeout (`OPS_SHUTDOWN_TIMEOUT_MS`).
    - Task 26 completed: startup reconciliation already runs; added startup orphan order cancellation + Supervisor `stop()` / `shutdown()` for clean teardown.
    - Task 27 completed: added end-to-end integration coverage (`tests/integration/near-zero-risk-flow.test.ts`) and updated merged plan checkboxes for Tasks 23–27.
    - Docker Compose healthcheck now respects `PORT` (avoids hard-coded runtime port in probe).
    - Ops/docs updated to explicitly distinguish liveness (`/health/live`) vs readiness (`/health/ready`).
    - RiskAgent depth sizing now applies `depthBufferMultiplier` (reduces avoidable `insufficient_depth_buffer` rejects when books are stable).
    - Final knob inventory documented: `docs/Operations/config-knobs.md`.
    - Runbook + setup now reference `.env.example` / `dashboard/.env.example` as env source of truth.
    - Runbook includes “where to get values for blank keys” guidance for common secrets (`OPS_API_TOKEN`, `OPS_ALERT_WEBHOOK_URL`, `POLYMARKET_POSITIONS_USER`, `QUICKNODE_RPC_URL`).
    - Added market catalog generator script (`scripts/fetch-market-catalog.ts`) and documented auto-generation flow (`docs/Development/market-catalog.md`).
    - Gitignores the default generated catalog path (`data/market-catalog.json`).
    - `.env` now contains all keys from `.env.example` without overwriting any existing `.env` values.
    - `dashboard/.env` now contains all keys from `dashboard/.env.example` (created since it was missing).
    - Quality gates passing: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, `npm run test:coverage` (≥95% branch).
    - Dashboard gates passing: `npm --prefix dashboard run build`, `npm --prefix dashboard run test:e2e` (smoke runner; Playwright browser launch is not permitted in this environment).
  - Now:
    - P0 hardening tasks (1–27) implemented and gated; UI/config knob inventory, env coverage, and `.env`/`dashboard/.env` parity verified.
    - Provide “where to get values” guidance for env keys that are present but still empty in local `.env`/`dashboard/.env` (e.g., `OPS_API_TOKEN`, `OPS_ALERT_WEBHOOK_URL`, `POLYMARKET_POSITIONS_USER`, `QUICKNODE_RPC_URL`, `VITE_OPS_API_TOKEN`).
    - Add a script to auto-fetch Polymarket binary markets with orderbooks and generate a market catalog JSON for `MARKET_CATALOG_PATH`.
  - Next:
    - Complete final “knob inventory” pass: confirm all trade-critical knobs are runtime-editable and all infra knobs are env-only/read-only in UI (expected outcome: no UI drift; files: `src/config/**`, `dashboard/src/**`, `docs/Operations/config-knobs.md`).
    - Validate deployment/runbook env coverage: confirm `.env.example` and `dashboard/.env.example` include every required key + document how to obtain secrets (expected outcome: copy/pasteable setup; files: `docs/Operations/runbook.md`, `docs/Development/setup.md`, `.env.example`, `dashboard/.env.example`).
    - Observe depth-buffer-driven rejects in telemetry and adjust `depthBufferMultiplier` only if rejects are avoidable (expected outcome: fewer `insufficient_depth_buffer` incidents without increasing risk; files: `src/config/policy.ts`, `dashboard/src/pages/RiskGates.tsx`).
    - Defer Phase 2 planning until ops sign-off on P0 SLO behavior and reconciliation stability (expected outcome: approved scope; files: new `docs/PHASE_2_PLAN.md` if approved).
    - Automate market catalog generation with a CLI script, document filters and safety guidance, and keep generated catalogs out of git by default (expected outcome: reproducible allowlist seeding; files: new `scripts/*`, `docs/Development/market-catalog.md`, `.gitignore`).

## Open questions (UNCONFIRMED if needed):
- None.

## Working set (files/ids/commands):
- Plan: `docs/IMPLEMENTATION_PLAN_NEAR_ZERO_RISK_P0_MERGED.md`
- Task 23: `src/core/EventStore.ts`, `src/agents/ops/sloAggregates.ts`, `src/api/server.ts`, `dashboard/src/pages/Overview.tsx`
- Task 24-26: `src/agents/ops/OpsAgent.ts`, `src/core/Supervisor.ts`, `src/main.ts`, `Dockerfile`, `docker-compose.yml`
- Task 27: `tests/integration/near-zero-risk-flow.test.ts`
- Inventory hedging: `src/agents/portfolio/PortfolioAgent.ts`, `src/main.ts`, `tests/unit/portfolio.test.ts`
- Quality: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`, `npm --prefix dashboard run build`, `npm --prefix dashboard run test:e2e`
