# Polymarket CLOB Arbitrage Bot Implementation Plan (Phase 1 + Phase 2 Scaffolding)

This plan translates the research, architecture, and critique documents into an actionable build sequence. It includes a minimal operations UI for monitoring and aligns with the “near-risk-free only” execution policy.

---

## Overview

### Scope
- Phase 1 single-venue Polymarket CLOB arbitrage with strict gating, incident playbooks, and full event-sourced state.
- Phase 2 scaffolding only (interfaces for multi-venue integration, no live cross-venue trading).
- Operational UI dashboard for monitoring, incident triage, and risk gate visibility.

### Key decisions
- TypeScript/Node.js for execution core; SQLite for event sourcing.
- WebSocket-first market data with REST snapshots for reconciliation.
- FOK orders for both legs; hard reject delayed matching; strict depth/edge gating.
- UI delivered as a web dashboard (React + Vite) with accessible, WCAG AA-friendly UI.

---

## Task 1 — Repository scaffolding + configuration baseline

### Reasoning
The system needs a consistent, testable project structure with typed configuration and environment validation before implementing agents.

### What to do
Establish a TypeScript project scaffold with centralized configuration and logging.

### How
1. Create `package.json`, `tsconfig.json`, and lint/test scripts.
2. Add `src/config/env.ts` to validate env vars (keys, capital, thresholds).
3. Add `src/config/policy.ts` and `src/config/risk.ts` for gating defaults and risk limits.
4. Wire `src/config/rpc.ts` into a shared config index.

### Files impacted
- `package.json`
- `tsconfig.json`
- `src/main.ts` (new file)
- `src/config/env.ts` (new file)
- `src/config/policy.ts` (new file)
- `src/config/risk.ts` (new file)
- `src/config/rpc.ts`

### End goal
Project builds with validated config and a clear entry point.

### Acceptance criteria
- [ ] Build and type-check command runs successfully.
- [ ] Missing/invalid env vars fail fast with clear errors.
- [ ] Risk and policy config are centralized and versioned.

---

## Task 2 — Core runtime: MessageBus, EventStore, StateRebuilder, CircuitBreaker

### Reasoning
Agents must communicate reliably and the system must recover from crashes with full state reconstruction.

### What to do
Implement the core eventing and persistence layer for event-sourced state.

### How
1. Implement a typed in-process event bus in `src/core/MessageBus.ts`.
2. Implement `src/core/EventStore.ts` with SQLite persistence and append-only writes.
3. Add `src/core/StateRebuilder.ts` to rebuild state from events on startup.
4. Add `src/core/CircuitBreaker.ts` for service-level protection.
5. Define SQLite schema and migrations for events, orders, fills, and decisions.

### Files impacted
- `src/core/MessageBus.ts` (new file)
- `src/core/EventStore.ts` (new file)
- `src/core/StateRebuilder.ts` (new file)
- `src/core/CircuitBreaker.ts` (new file)
- `src/db/schema.sql` (new file)
- `src/db/migrations/0001_init.sql` (new file)

### End goal
Reliable event sourcing with crash recovery and circuit breakers in place.

### Acceptance criteria
- [ ] Events append and replay deterministically rebuild state.
- [ ] Circuit breaker trips after configured failures and recovers.
- [ ] Schema covers events, orders, fills, and decisions.

---

## Task 3 — External integrations: Polymarket CLOB + Polygon RPC

### Reasoning
Trading requires robust, rate-limited API clients with proper auth and error handling.

### What to do
Implement Polymarket REST/WS clients and integrate the Polygon RPC provider.

### How
1. Create `PolymarketClob` client wrapper with auth, retries, and rate limiting.
2. Create `PolymarketRealtime` WebSocket client with reconnect + resync logic.
3. Implement `PolygonRpc` wrapper to centralize settlement and confirmations.
4. Standardize error mapping (`delayed`, `ORDER_DELAYED`, `FOK_ORDER_NOT_FILLED_ERROR`).

### Files impacted
- `src/services/PolymarketClob.ts` (new file)
- `src/services/PolymarketRealtime.ts` (new file)
- `src/services/PolygonRpc.ts` (new file)
- `src/services/RateLimiter.ts` (new file)
- `src/services/RetryPolicy.ts` (new file)
- `src/config/rpc.ts`

### End goal
Stable, observable integration layer for all external services.

### Acceptance criteria
- [ ] WS connection auto-recovers and re-syncs orderbook snapshots.
- [ ] Rate limits are enforced client-side.
- [ ] Error conditions are normalized into typed error classes.

---

## Task 4 — Market data ingestion + orderbook engine

### Reasoning
Accurate, fresh orderbooks are mandatory for near-risk-free gating.

### What to do
Implement MarketDataAgent and a reliable in-memory orderbook with freshness checks.

### How
1. Implement `OrderBook` structure with top-of-book and depth sweeps.
2. Handle snapshots + deltas with sequence/hash checks.
3. Emit `market:updated` events with freshness metadata.
4. Record tick-size changes and min-order-size constraints.

### Files impacted
- `src/agents/market-data/MarketDataAgent.ts` (new file)
- `src/domain/orderbook.ts` (new file)
- `src/domain/market.ts` (new file)
- `src/domain/sequence.ts` (new file)

### End goal
Low-latency, trustworthy orderbook state for all active markets.

### Acceptance criteria
- [ ] Stale or out-of-sequence updates trigger resync.
- [ ] Orderbook depth queries match live snapshots.
- [ ] Tick size and min size are enforced in book logic.

---

## Task 5 — Scanner + risk gates + allowlist/quarantine

### Reasoning
Strict gating and market hygiene are required to keep one-leg risk near zero.

### What to do
Implement arbitrage scanning, gating logic, and market allowlist/quarantine.

### How
1. Implement ScannerAgent for complete-set detection.
2. Build gating rules for edge, depth headroom, spread, and stability windows.
3. Add allowlist/quarantine state with cooldown timers.
4. Integrate risk sizing with notional + loss budget rules.

### Files impacted
- `src/agents/scanner/ScannerAgent.ts` (new file)
- `src/agents/risk/RiskAgent.ts` (new file)
- `src/domain/gates.ts` (new file)
- `src/domain/allowlist.ts` (new file)
- `src/config/risk.ts`
- `src/config/policy.ts`

### End goal
Only “near-risk-free” opportunities are approved for execution.

### Acceptance criteria
- [ ] Gating rejects stale, thin, or delayed markets.
- [ ] Allowlist/quarantine state updates on incidents.
- [ ] Sizing never exceeds depth and loss budget caps.

---

## Task 6 — Execution engine + incident playbook

### Reasoning
Two-leg atomicity is not guaranteed; execution must be paired, idempotent, and recoverable.

### What to do
Implement paired FOK execution and the incident playbook for one-leg exposure.

### How
1. Place both legs as FOK using shared correlation IDs and idempotency keys.
2. Hard-reject any delayed matching responses.
3. Implement bounded completion attempt with strict price caps.
4. Implement immediate unwind with FAK under max-loss caps.
5. Emit incident events and trigger quarantine rules.

### Files impacted
- `src/agents/execution/ExecutionAgent.ts` (new file)
- `src/domain/execution.ts` (new file)
- `src/domain/incident.ts` (new file)
- `src/domain/idempotency.ts` (new file)

### End goal
Execution remains near-risk-free with controlled, bounded incident responses.

### Acceptance criteria
- [ ] FOK orders are paired and correlated per opportunity.
- [ ] Any delayed response cancels the attempt.
- [ ] One-leg exposure is closed within configured max time.

---

## Task 7 — Portfolio, PnL, learning logs, telemetry

### Reasoning
Persistent accounting and decision logging are required for auditability and safe learning.

### What to do
Implement portfolio tracking, PnL calculations, and learning telemetry.

### How
1. Implement PortfolioAgent to reconcile open orders and fills.
2. Track daily PnL and drawdown thresholds.
3. Implement LearningAgent event logging (no live policy changes in Phase 1).
4. Emit telemetry for allowlist, incident, and execution outcomes.

### Files impacted
- `src/agents/portfolio/PortfolioAgent.ts` (new file)
- `src/agents/learning/LearningAgent.ts` (new file)
- `src/domain/portfolio.ts` (new file)
- `src/telemetry/metrics.ts` (new file)
- `src/telemetry/allowlist.ts` (new file)

### End goal
Accurate portfolio state and reliable telemetry for ops and future ML.

### Acceptance criteria
- [ ] PnL calculations reconcile with fills and order history.
- [ ] Decision logs are persisted for every opportunity.
- [ ] Drawdown limits trigger automatic pause.

---

## Task 8 — Ops agent + health API + streaming metrics

### Reasoning
24/7 operation requires continuous health monitoring and a clean API for UI consumption.

### What to do
Implement OpsAgent, health endpoints, and live metrics streaming.

### How
1. Implement OpsAgent health checks and reconnection logic.
2. Add a lightweight HTTP server for `/health`, `/metrics`, `/allowlist`, `/incidents`.
3. Provide SSE/WS stream for real-time UI updates.
4. Redact secrets and enforce least-privilege output.

### Files impacted
- `src/agents/ops/OpsAgent.ts` (new file)
- `src/api/server.ts` (new file)
- `src/api/routes/health.ts` (new file)
- `src/api/routes/metrics.ts` (new file)
- `src/api/routes/allowlist.ts` (new file)
- `src/api/routes/incidents.ts` (new file)
- `src/api/stream.ts` (new file)

### End goal
Operational APIs support live monitoring without exposing sensitive data.

### Acceptance criteria
- [ ] `/health` reports agent, WS, and RPC status.
- [ ] Metrics stream updates within 1s of events.
- [ ] API responses are scrubbed of secrets.

---

## Task 9 — UI monitoring dashboard

### Reasoning
Operators need a clear, accessible interface for monitoring health, gates, and incidents.

### What to do
Build a responsive, accessible web dashboard for live monitoring.

### How
1. Scaffold a React + Vite UI in `dashboard/`.
2. Define design tokens (color, type, spacing) and typography (avoid default system fonts).
3. Implement pages: Overview, Markets, Incidents, Positions/PnL, Risk Gates.
4. Connect to the ops API and SSE/WS stream for live updates.
5. Apply WCAG AA checks: contrast, focus states, keyboard navigation.

### Files impacted
- `dashboard/` (new folder)
- `dashboard/index.html` (new file)
- `dashboard/src/App.tsx` (new file)
- `dashboard/src/pages/Overview.tsx` (new file)
- `dashboard/src/pages/Markets.tsx` (new file)
- `dashboard/src/pages/Incidents.tsx` (new file)
- `dashboard/src/pages/Positions.tsx` (new file)
- `dashboard/src/pages/RiskGates.tsx` (new file)
- `dashboard/src/styles/tokens.css` (new file)
- `dashboard/src/styles/app.css` (new file)

### End goal
Operators can monitor system health and trading state in real time.

### Acceptance criteria
- [ ] Dashboard loads on desktop and mobile viewports.
- [ ] Live updates render within 1s of backend events.
- [ ] Keyboard navigation works across all pages (WCAG AA).

---

## Task 10 — Security hardening and secrets management

### Reasoning
Keys and signed orders are sensitive; the ops API must be protected.

### What to do
Add secrets handling, API auth, and audit logging for critical actions.

### How
1. Implement a secrets provider interface (env for dev, pluggable for prod).
2. Add API auth for ops endpoints (token or mTLS).
3. Ensure logs are redacted and secrets never appear in telemetry.
4. Document key rotation and access control procedures.

### Files impacted
- `src/security/Secrets.ts` (new file)
- `src/security/Auth.ts` (new file)
- `src/config/env.ts`
- `docs/Operations/security.md` (new file)

### End goal
Operational surfaces are protected and secrets are handled safely.

### Acceptance criteria
- [ ] Ops API rejects unauthenticated requests.
- [ ] Secrets are redacted from logs and metrics.
- [ ] Security procedures are documented.

---

## Task 11 — Testing strategy and automation

### Reasoning
Critical gating, execution, and UI flows must be verified before running live.

### What to do
Implement unit, integration, and UI E2E tests aligned with MCAF verification rules.

### How
1. Set up unit + integration test frameworks for agents and services.
2. Create fixtures for orderbooks, delayed signals, and incident scenarios.
3. Add integration tests for gating, execution, and incident playbooks.
4. Add Playwright E2E tests for the dashboard.

### Files impacted
- `tests/unit/` (new folder)
- `tests/integration/` (new folder)
- `tests/e2e/` (new folder)
- `vitest.config.ts` (new file)
- `playwright.config.ts` (new file)
- `docs/Testing/strategy.md` (new file)

### End goal
Core behaviour is verified through automated tests.

### Acceptance criteria
- [ ] Gating and incident flows have integration tests.
- [ ] UI smoke tests cover dashboard navigation.
- [ ] Tests run in CI without manual steps.

---

## Task 12 — CI/CD, deployment, and runbook

### Reasoning
24/7 operation needs reproducible builds, health checks, and a clear recovery path.

### What to do
Create CI pipelines, containerization, and an ops runbook.

### How
1. Add Dockerfile and docker-compose for local + prod deployment.
2. Add GitHub Actions pipeline to run lint, build, and tests.
3. Define monitoring/alerting hooks (Sentry + Slack as documented).
4. Create operational docs for deployment, rollback, and incident response.

### Files impacted
- `Dockerfile` (new file)
- `docker-compose.yml` (new file)
- `.github/workflows/ci.yml` (new file)
- `docs/Operations/runbook.md` (new file)
- `docs/Development/setup.md` (new file)

### End goal
Deployments and recoveries are standardized and repeatable.

### Acceptance criteria
- [ ] CI runs tests and lint on every push.
- [ ] Docker image builds and starts with documented commands.
- [ ] Runbook covers rollback and incident steps.

---

## Task 13 — Phase 2 cross-venue scaffolding

### Reasoning
Phase 2 cross-venue trading is high-risk; scaffolding now prevents rewrites later.

### What to do
Introduce venue abstraction, fee models, and contract mapping stubs.

### How
1. Define `VenueAdapter` interface with normalized methods.
2. Add `ContractMapper` allowlist and equivalence checks.
3. Implement `FeeModel` for per-venue fees and EV gating.
4. Stub Kalshi adapter with no live trading enabled.

### Files impacted
- `src/venues/VenueAdapter.ts` (new file)
- `src/venues/PolymarketAdapter.ts` (new file)
- `src/venues/KalshiAdapter.ts` (new file)
- `src/domain/feeModel.ts` (new file)
- `src/domain/contractMapper.ts` (new file)
- `src/config/venues.ts` (new file)

### End goal
Phase 1 remains stable while Phase 2 interfaces are ready.

### Acceptance criteria
- [ ] Phase 1 execution path remains unchanged behind a feature flag.
- [ ] Contract mapping enforces strict allowlist checks.
- [ ] Fee model integrates into EV checks without breaking Phase 1.

---

## File-by-file implementation sequence

1. `package.json` — Tasks 1, 11, 12
2. `tsconfig.json` — Task 1
3. `src/main.ts` — Tasks 1, 8
4. `src/config/env.ts` — Tasks 1, 10
5. `src/config/policy.ts` — Tasks 1, 5
6. `src/config/risk.ts` — Tasks 1, 5
7. `src/config/rpc.ts` — Tasks 1, 3
8. `src/core/MessageBus.ts` — Task 2
9. `src/core/EventStore.ts` — Task 2
10. `src/core/StateRebuilder.ts` — Task 2
11. `src/core/CircuitBreaker.ts` — Tasks 2, 3
12. `src/services/PolymarketClob.ts` — Tasks 3, 6
13. `src/services/PolymarketRealtime.ts` — Tasks 3, 4
14. `src/services/PolygonRpc.ts` — Task 3
15. `src/agents/market-data/MarketDataAgent.ts` — Task 4
16. `src/agents/scanner/ScannerAgent.ts` — Task 5
17. `src/agents/risk/RiskAgent.ts` — Task 5
18. `src/agents/execution/ExecutionAgent.ts` — Task 6
19. `src/agents/portfolio/PortfolioAgent.ts` — Task 7
20. `src/agents/learning/LearningAgent.ts` — Task 7
21. `src/agents/ops/OpsAgent.ts` — Task 8
22. `src/api/server.ts` — Task 8
23. `src/venues/VenueAdapter.ts` — Task 13
24. `dashboard/src/App.tsx` — Task 9
25. `tests/` — Task 11
26. `.github/workflows/ci.yml` — Task 12
27. `docs/Operations/runbook.md` — Task 12

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| `@fastify/cors` | `^8.5.0` | CORS support for ops API |
| `fastify` | `^4.28.1` | Ops API server |
| `zod` | `^3.23.8` | Config/env validation |
| `dotenv` | `^16.4.5` | Local env loading |
| `ethers` | `^6.13.4` | Polygon RPC and signing |
| `ws` | `^8.18.0` | Polymarket websocket client |
| `better-sqlite3` | `^9.6.0` | SQLite event store |
| `vitest` | `^4.0.16` | Unit/integration tests |
| `playwright` | `^1.48.2` | Dashboard E2E tests |
| `react` | `^18.3.1` | Dashboard UI |
| `react-dom` | `^18.3.1` | Dashboard UI |
| `vite` | `^7.3.0` | Dashboard build tooling |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-01 | Initial plan |
