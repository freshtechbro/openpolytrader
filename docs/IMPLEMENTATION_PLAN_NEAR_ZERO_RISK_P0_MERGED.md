# Near-Zero-Risk Polymarket Arbitrage System — Merged P0 Implementation Plan

> **Merged from**: IMPLEMENTATION_PLAN.md (Phase 1 Infrastructure) + IMPLEMENTATION_PLAN_NEAR_ZERO_RISK_P0_v1.md (Hardening) + NEAR_ZERO_RISK_ARBITRAGE_REPORT.md (Research) + Oracle Architecture Review + External Best Practices
>
> **Version**: 2.0 | **Date**: 2026-01-03

---

## Executive Summary

This merged plan consolidates the foundational infrastructure (Phase 1) with production-grade hardening (P0) for near-zero-risk arbitrage execution. Phase 1 infrastructure is **already implemented**; this plan focuses on the **27 remaining hardening tasks** required for production deployment.

### Definition: Near-Zero-Risk

- **Bounded maximum loss**: Every trade has a deterministic worst-case loss ceiling
- **Deterministic recovery**: Failed states trigger automatic, pre-computed unwind actions
- **No unbounded exposure**: Partial fills are immediately hedged or unwound

### P0 Strategy: Binary Complete-Set BUY

Buy YES + NO tokens when `YES_ask + NO_ask < 1 - buffer`, guaranteeing profit if both legs fill completely.

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1: Infrastructure** | ✅ COMPLETE | Core runtime, agents, CLOB clients, dashboard |
| **Phase P0: Hardening** | 🔄 IN PROGRESS | This plan - production safety hardening |
| **Phase 2: Multi-Venue** | ⏳ FUTURE | Cross-venue arbitrage (Kalshi, etc.) |

---

## Overview

### Scope

- **P0 Only**: Binary complete-set BUY (YES ask + NO ask < 1 − buffer) with strict gates
- No cross-market combinatorial, no weak dependencies, no directional carry
- Focus on achieving ≥99.9% paired-fill success rate with bounded worst-case loss
- Fail-closed: refuse to trade unless all safety gates pass

### Global SLO Targets

| SLO | Target |
|-----|--------|
| Paired-fill success rate | ≥ 99.9% |
| Decision latency p95 (detect→submit) | ≤ 100ms |
| Book freshness at decision time | ≤ 500ms staleness |
| Delayed ACK rate | ≤ 0.1% |
| Unwind loss bound | ≤ 1–2 ticks per set |

### Key Decisions

1. **Extend existing configs** rather than creating new files (DRY principle)
2. **Add new metric event types** to existing `MetricEventType` union
3. **State machine pattern** for paired execution without external dependencies
4. **Wire CircuitBreaker per-market** through IncidentTracker integration
5. **Follow existing test patterns** (Vitest, makeBook helpers, mock factories)
6. **User channel integration** for order lifecycle tracking (critical gap from oracle review)
7. **Cancel APIs** for delayed/timeout order cleanup (critical gap from oracle review)
8. **Graceful shutdown** with order cancellation and metrics flush
9. **Startup reconciliation** to prevent orphaned orders or unknown exposure

### Phased Approach (Safety-First)

| Phase | Goal | Tasks |
|-------|------|-------|
| 0 | Cannot lose money by default | Tasks 1-4 (config, kill-switch, shadow mode, fail-closed validation) |
| 1 | Explainability and observability | Tasks 5-8 (telemetry, incidents, gates, reason codes) |
| 2 | Deterministic execution | Tasks 9-14 (state machine, timeouts, cancel, idempotency, in-flight lock) |
| 3 | Bounded-loss unwind | Tasks 15-17 (unwind logic, worst-case sizing, user channel) |
| 4 | Reconciliation + isolation | Tasks 18-21 (portfolio reconciliation, circuit breakers, exposure cleanup) |
| 5 | Ops readiness + testing | Tasks 22-27 (SLO checks, alerts, graceful shutdown, startup recon, tests) |

### Risk Gate Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    GATE EVALUATION ORDER                     │
├─────────────────────────────────────────────────────────────┤
│ 1. Circuit Breaker     │ Is market circuit open?            │
│ 2. Book Freshness      │ Last update < maxBookStalenessMs?  │
│ 3. Leg Sync            │ YES/NO book skew < maxLegSkewMs?   │
│ 4. Edge Threshold      │ Edge ≥ minEdgeTicks (≥3¢)?         │
│ 5. Depth Buffer        │ Available depth ≥ size × buffer?   │
│ 6. Slippage Check      │ Top-of-book within tolerance?      │
│ 7. Position Limits     │ Resulting position ≤ maxPosition?  │
│ 8. Exposure Limits     │ Total exposure ≤ maxExposure?      │
│ 9. Unwind Budget       │ Potential loss ≤ unwind budget?    │
│ 10. Daily Loss         │ Daily headroom available?          │
│ 11. Velocity/OTR       │ Within rate limits?                │
│ 12. Correlation Check  │ No conflicting pending orders?     │
└─────────────────────────────────────────────────────────────┘
```

---

## Task 1 — Extend TradePolicy with near-zero-risk strategy flags

### Reasoning

The existing `TradePolicy` interface lacks explicit mode selection and SLO thresholds needed for configurable risk-free operation. Adding these to the centralized config enables feature flags and tunable thresholds without creating new configuration files.

### What to do

Extend `TradePolicy` in `src/config/policy.ts` with strategy mode, SLO knobs, and pre-trade controls.

### How

1. Add new fields to `TradePolicy` interface:
   ```typescript
   /** Strategy mode: near_zero_risk enforces strictest gates */
   strategyMode: 'near_zero_risk' | 'standard';
   /** Require book freshness check before execution */
   requireFreshBook: boolean;
   /** Maximum book staleness in milliseconds */
   maxBookStalenessMs: number;
   /** Maximum decision latency from detection to submission */
   maxDecisionLatencyMs: number;
   /** Maximum acceptable delayed ACK rate (0.001 = 0.1%) */
   maxDelayedAckRate: number;
   /** Minimum edge required in ticks (not just percentage) */
   minEdgeTicks: number;
   /** Depth buffer multiplier - require depth > size * multiplier */
   depthBufferMultiplier: number;
   /** Slippage tolerance in basis points for entry */
   entrySlippageToleranceBps: number;
   /** Minimum depth levels to check (top N levels) */
   minDepthLevels: number;
   /** Max orders per minute (velocity throttle) */
   maxOrdersPerMinute: number;
   /** Max order-to-trade ratio before throttling */
   maxOrderToTradeRatio: number;
   /** Order velocity window in milliseconds */
   orderVelocityWindowMs: number;
   /** Order-to-trade window in milliseconds */
   orderToTradeWindowMs: number;
   /** Price band tolerance in basis points */
   priceBandBps: number;
   ```

2. Update `DEFAULT_TRADE_POLICY` with conservative defaults:
   ```typescript
   strategyMode: 'near_zero_risk',
   requireFreshBook: true,
   maxBookStalenessMs: 500,
   maxDecisionLatencyMs: 250,
   maxDelayedAckRate: 0.001,
   minEdgeTicks: 3,
   depthBufferMultiplier: 1.5,
   entrySlippageToleranceBps: 50,
   minDepthLevels: 3,
   maxOrdersPerMinute: 60,
   maxOrderToTradeRatio: 10,
   orderVelocityWindowMs: 60000,
   orderToTradeWindowMs: 600000,
   priceBandBps: 500
   ```

3. Add JSDoc comments explaining each field's purpose and valid ranges

4. Export helper function:
   ```typescript
   export function isNearZeroRiskMode(policy: TradePolicy): boolean {
     return policy.strategyMode === 'near_zero_risk';
   }
   ```

### Files impacted

- `src/config/policy.ts`

### End goal

Policy config supports explicit near-zero-risk mode with all SLO thresholds and pre-trade controls configurable from a single location.

### Acceptance criteria

- [ ] TypeScript compiles with extended `TradePolicy` interface
- [ ] `DEFAULT_TRADE_POLICY` includes all new fields with documented defaults
- [ ] Existing code referencing `TradePolicy` continues to work (backward compatible)
- [ ] `isNearZeroRiskMode()` helper returns true when `strategyMode === 'near_zero_risk'`
- [ ] JSDoc comments document each new field

---

## Task 2 — Extend RiskConfig with unwind loss budget

### Reasoning

Current `RiskConfig` sizes positions based on depth and trade fraction but doesn't cap potential unwind losses. Adding a max unwind loss budget prevents sizing that could result in unacceptable losses if one leg fails and requires emergency liquidation.

### What to do

Add unwind loss budget constraints to `src/config/risk.ts`.

### How

1. Add new fields to `RiskConfig` interface:
   ```typescript
   /** Max loss as fraction of position notional if unwind needed */
   maxUnwindLossFraction: number;
   /** Max loss in price ticks per set on unwind */
   maxUnwindLossTicks: number;
   /** Slippage tolerance in basis points for unwind pricing */
   unwindSlippageToleranceBps: number;
   /** Hard per-trade worst-case loss bound in dollars */
   maxPerTradeLossDollars: number;
   /** Daily loss limit as fraction of capital */
   dailyLossLimitFraction: number;
   ```

2. Update `DEFAULT_RISK_CONFIG`:
   ```typescript
   maxUnwindLossFraction: 0.025, // 2.5% max loss on unwind
   maxUnwindLossTicks: 2,        // 2 ticks max loss
   unwindSlippageToleranceBps: 500,
   maxPerTradeLossDollars: 25,   // $25 max loss per trade
   dailyLossLimitFraction: 0.03  // 3% daily loss limit
   ```

3. Add helper function for unwind budget calculation:
   ```typescript
   export function calculateMaxSizeByUnwindBudget(
     edge: number,
     tickSize: number,
     availableCapital: number,
     config: RiskConfig
   ): number {
     const maxLossNotional = Math.min(
       availableCapital * config.maxUnwindLossFraction,
       config.maxPerTradeLossDollars
     );
     const lossPerSet = tickSize * config.maxUnwindLossTicks;
     if (lossPerSet <= 0) return availableCapital / Math.max(tickSize, 0.01);
     return maxLossNotional / lossPerSet;
   }
   ```

### Files impacted

- `src/config/risk.ts`

### End goal

Risk sizing incorporates unwind loss budget as an additional constraint, preventing oversized positions that could result in significant losses on emergency unwind.

### Acceptance criteria

- [ ] `RiskConfig` interface includes all new fields
- [ ] `DEFAULT_RISK_CONFIG` includes conservative defaults
- [ ] `calculateMaxSizeByUnwindBudget` correctly computes max size
- [ ] Helper handles edge cases (zero tick size, zero budget)
- [ ] Unit test validates budget calculation with sample inputs

---

## Task 3 — Add trading mode and kill-switch enforcement

### Reasoning

Near-zero-risk should never trade unless explicitly enabled. A global trading mode (off/shadow/paper/live) and kill-switch must be enforced at every execution path.

### What to do

Add trading mode enum and enforce it in scanner, execution, and unwind paths.

### How

1. Add to `src/config/env.ts`:
   ```typescript
   export type TradingMode = 'off' | 'shadow' | 'paper' | 'live';
   export const TRADING_MODE: TradingMode = 
     (process.env.TRADING_MODE as TradingMode) || 'off';
   ```

2. Update `ExecutionAgent` to check mode before any order placement:
   ```typescript
   if (TRADING_MODE === 'off') {
     return { success: false, reason: 'trading_disabled' };
   }
   if (TRADING_MODE === 'shadow') {
     this.metrics.record({ type: 'shadow_decision', ... });
     return { success: false, reason: 'shadow_mode' };
   }
   ```

3. Update `ScannerAgent` to log opportunities but not emit in shadow mode

4. Add mode display to ops dashboard

### Files impacted

- `src/config/env.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/scanner/ScannerAgent.ts`
- `dashboard/src/App.tsx`

### End goal

System is incapable of placing orders unless `TRADING_MODE=live` and `TRADING_ENABLED=true`.

### Acceptance criteria

- [ ] In `off` mode, no network order calls are reachable
- [ ] In `shadow` mode, decisions are logged but no orders placed
- [ ] In `paper` mode, order placement remains blocked until a simulator is implemented
- [ ] Mode is visible in ops dashboard (UI work delegated to frontend-ui-ux-engineer)
- [ ] Kill-switch (`TRADING_ENABLED=false`) blocks all order paths

---

## Task 4 — Add fail-closed config validation

### Reasoning

System must refuse to start with invalid or missing P0-critical configuration values.

### What to do

Add config validation at startup that fails closed on missing/invalid values.

### How

1. Create `src/config/schema.ts` with a config schema registry (field metadata + min/max).
2. Update `src/config/validate.ts` to validate policy/risk using the schema registry and cross-field checks.
3. Call validation in `src/main.ts` before starting supervisor.
4. Log validated config values at startup.
5. Expose settings API endpoints for config reads/updates (UI delegated):
   - `GET /config`
   - `GET /config/schema`
   - `PATCH /config/policy`
   - `PATCH /config/risk`

### Files impacted

- `src/config/schema.ts` (new file)
- `src/config/validate.ts` (new file)
- `src/config/index.ts`
- `src/main.ts`
- `src/config/store.ts` (new file)
- `src/api/server.ts`

### End goal

No silent defaults for P0 safety-critical params; system fails closed on invalid config.

### Acceptance criteria

- [ ] Missing required fields throw descriptive error
- [ ] Out-of-range values throw descriptive error
- [ ] Valid config logs all values at startup
- [ ] System refuses to start on validation failure

---

## Task 5 — Add structured latency event types to telemetry

### Reasoning

Current `MetricEventType` lacks specific types for latency measurement across the execution pipeline. Adding structured latency events enables SLO monitoring, performance debugging, and identifying bottlenecks.

### What to do

Extend `MetricEventType` and add typed latency event interfaces in telemetry.

### How

1. Add new metric types to `MetricEventType` union in `src/telemetry/metrics.ts`:
   ```typescript
   | 'latency'
   | 'execution_lifecycle'
   | 'book_staleness'
   | 'slo_violation'
   | 'gate_rejection'
   | 'shadow_decision'
   ```

2. Create `src/telemetry/events.ts` with typed event interfaces:
   ```typescript
   export interface LatencyEvent {
     stage: 'detected' | 'gated' | 'risk_approved' | 'submitted' | 'acked' | 'filled' | 'complete';
     opportunityId: string;
     marketId: string;
     timestampMs: number;
     latencyMs?: number;
     cumulativeMs?: number;
   }

   export interface GateRejectionEvent {
     opportunityId: string;
     marketId: string;
     reasons: string[];
     gateDecision: Record<string, unknown>;
     timestampMs: number;
   }

   export interface SloViolationEvent {
     sloName: 'decision_latency' | 'book_freshness' | 'delayed_ack_rate' | 'paired_fill_rate';
     threshold: number;
     actual: number;
     marketId?: string;
     timestampMs: number;
   }
   ```

3. Update `src/telemetry/index.ts` to export new types

4. Add convenience method to `MetricsStore`:
   ```typescript
   recordLatency(event: LatencyEvent): void {
     this.record({ type: 'latency', timestamp: event.timestampMs, data: event });
   }
   ```

### Files impacted

- `src/telemetry/metrics.ts`
- `src/telemetry/events.ts` (new file)
- `src/telemetry/index.ts`

### End goal

Telemetry system can record structured latency and SLO events with type safety.

### Acceptance criteria

- [ ] New metric types added without breaking existing code
- [ ] Event interfaces are exported and usable by agents
- [ ] `recordLatency` helper simplifies emission
- [ ] TypeScript enforces correct event shapes

---

## Task 6 — Extend incident taxonomy for near-zero-risk scenarios

### Reasoning

Current `IncidentReason` type covers basic failures but lacks specific categories for near-zero-risk execution failures. A complete taxonomy enables proper incident response and market quarantine decisions.

### What to do

Extend incident types in `src/domain/incident.ts` to cover all failure modes.

### How

1. Expand `IncidentReason` union type:
   ```typescript
   export type IncidentReason =
     | 'order_delayed' | 'order_rejected' | 'order_failed' | 'order_timeout'
     | 'ws_disconnected' | 'rpc_degraded' | 'api_429' | 'api_5xx' | 'auth_failure'
     | 'partial_fill' | 'unwind_triggered' | 'unwind_failed'
     | 'book_stale' | 'book_inconsistent' | 'latency_exceeded' | 'slippage_exceeded'
     | 'depth_insufficient' | 'price_moved' | 'velocity_throttle' | 'otr_exceeded'
     | 'circuit_breaker' | 'recon_drift' | 'fill_mismatch'
     | 'unknown';
   ```

2. Add `IncidentSeverity` type and extend `IncidentRecord`:
   ```typescript
   export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';

   export interface IncidentRecord {
     marketId: string;
     reason: IncidentReason;
     severity: IncidentSeverity;
     timestamp: number;
     opportunityId?: string;
     detail?: Record<string, unknown>;
     recoveryAction?: 'block' | 'quarantine' | 'pause' | 'alert_only';
   }
   ```

3. Add helper functions:
   ```typescript
   export function getDefaultSeverity(reason: IncidentReason): IncidentSeverity;
   export function getDefaultRecoveryAction(reason: IncidentReason): IncidentRecord['recoveryAction'];
   ```

### Files impacted

- `src/domain/incident.ts`

### End goal

Incident taxonomy covers all near-zero-risk failure modes with severity and recovery actions.

### Acceptance criteria

- [ ] All new incident reasons documented with JSDoc
- [ ] Severity levels assigned appropriately
- [ ] Existing code continues to work (backward compatible)
- [ ] `getDefaultSeverity` and `getDefaultRecoveryAction` cover all reasons

---

## Task 7 — Add book freshness and depth buffer gates to evaluateGates

### Reasoning

Current `evaluateGates` needs enhanced checks for `maxBookStalenessMs`, `minEdgeTicks`, `depthBufferMultiplier`, and slippage tolerance.

### What to do

Enhance gate evaluation in `src/domain/gates.ts` with stricter checks and explainability.

### How

1. Update `GateInputs` interface:
   ```typescript
   export interface GateInputs {
     yesBook: OrderBookState;
     noBook: OrderBookState;
     policy: TradePolicy;
     nowMs: number;
     desiredSize?: number;
     tickSize?: number;
   }
   ```

2. Update `GateDecision` to include detailed rejection info:
   ```typescript
   export interface GateDecision {
     passed: boolean;
     reasons: string[];
     costPerSet: number;
     edge: number;
     edgeInTicks?: number;
     maxSizeByDepth: number;
     yesStalenessMs?: number;
     noStalenessMs?: number;
     depthAtLevels?: { yes: number; no: number };
   }
   ```

3. Add new gate checks:
   - Book staleness using `maxBookStalenessMs`
   - Min edge in ticks using `minEdgeTicks`
   - Depth buffer using `depthBufferMultiplier`
   - Multi-level depth check using `minDepthLevels`
   - Slippage pre-check using top-of-book snapshot

4. Emit `gate_rejection` telemetry event on failure with full context

### Files impacted

- `src/domain/gates.ts`

### End goal

Gate evaluation enforces all near-zero-risk requirements with detailed explainability.

### Acceptance criteria

- [ ] All new policy fields are enforced
- [ ] Staleness values included in `GateDecision`
- [ ] `edgeInTicks` calculated and returned
- [ ] Gate rejection events emitted with full context
- [ ] Existing tests pass; new tests added for each gate

---

## Task 8 — Add pre-trade controls (velocity, OTR, price band)

### Reasoning

Pre-trade controls reduce operational risk and detect runaway conditions before orders hit the venue.

### What to do

Add order velocity throttling, order-to-trade ratio limits, and price-band checks.

### How

1. Add rolling counters to `MetricsStore`:
   ```typescript
   private orderCounts = new Map<string, { orders: number[]; fills: number[] }>();
   
   recordOrderAttempt(marketId: string, nowMs?: number): void;
   recordFill(marketId: string, nowMs?: number): void;
   getOrderStats(marketId: string, windowMs: number): { orders: number; fills: number };
   getOTR(marketId: string, windowMs: number): number;
   getOrderVelocity(windowMs: number): number;
   ```

2. Add velocity/OTR checks in `ExecutionAgent.executeArbitrage`:
   ```typescript
   const windowMs = policy.orderVelocityWindowMs;
   const velocity = this.metrics.getOrderVelocity(windowMs);
   const limit = policy.maxOrdersPerMinute * (windowMs / 60_000);
   if (velocity > limit) {
     return { success: false, reason: 'velocity_throttle' };
   }
   ```

3. Add price-band validation before order submission

### Files impacted

- `src/telemetry/metrics.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/domain/incident.ts`

### End goal

System throttles unsafe order bursts and blocks trading when pre-trade limits are exceeded.

### Acceptance criteria

- [ ] Velocity check rejects orders when exceeded
- [ ] OTR check rejects orders when exceeded
- [ ] Price-band check blocks orders beyond tolerance
- [ ] Incidents created for all pre-trade rejections

---

## Task 9 — Create ExecutionState type and state machine for paired execution

### Reasoning

Current `ExecutionAgent` lacks explicit state tracking for paired orders. A state machine makes transitions deterministic, debuggable, and enables proper recovery from partial fills.

### What to do

Define execution state machine types in `src/domain/execution.ts`.

### How

1. Add execution state type:
   ```typescript
   export type ExecutionState =
     | 'idle'
     | 'submitting'
     | 'yes_pending' | 'no_pending' | 'both_pending'
     | 'yes_acked' | 'no_acked' | 'both_acked'
     | 'yes_filled' | 'no_filled' | 'both_filled'
     | 'partial_fill' | 'unwinding' | 'unwind_complete' | 'unwind_failed'
     | 'cancelling' | 'cancelled'
     | 'failed' | 'timeout' | 'complete';
   ```

2. Add `PairedExecutionState` interface with full context

3. Add `ExecutionEvent` types that trigger state transitions

4. Add `transitionExecutionState` pure function

5. Add `getRequiredAction` helper

6. Add `createInitialExecutionState` factory

### Files impacted

- `src/domain/execution.ts`

### End goal

Type-safe state machine for paired execution with deterministic transitions.

### Acceptance criteria

- [ ] All execution states defined with JSDoc
- [ ] State transitions are pure functions (no side effects)
- [ ] Invalid transitions throw descriptive errors
- [ ] `getRequiredAction` returns correct action for each state
- [ ] Unit tests cover all state transitions

---

## Task 10 — Refactor ExecutionAgent with state machine and latency tracking

### Reasoning

Execution must be deterministic and measurable across stages.

### What to do

Refactor `ExecutionAgent` to use `PairedExecutionState` and emit latency events.

### How

1. Replace ad-hoc flow with state machine transitions
2. Emit latency events at each stage (detect, submit, ack, fill)
3. Track active executions in a Map for monitoring
4. Persist state transitions to EventStore
5. Add execution state to telemetry/dashboard

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`

### End goal

Execution flow is deterministic, persisted, and fully instrumented.

### Acceptance criteria

- [ ] Execution uses state machine transitions
- [ ] Latency events emitted at required stages
- [ ] Active executions tracked in map
- [ ] State transitions logged via `execution_lifecycle` events
- [ ] Restart can recover from persisted state

---

## Task 11 — Add deterministic timeout handling to ExecutionAgent

### Reasoning

Timeouts must be explicit and lead to deterministic recovery actions.

### What to do

Add configurable timeouts for submit, ack, and fill phases.

### How

1. Add timeout config to `ExecutionAgentConfig`:
   ```typescript
   submitTimeoutMs: number;  // default 2000
   ackTimeoutMs: number;     // default 2500
   fillTimeoutMs: number;    // default 5000
   cancelTimeoutMs: number;  // default 2000
   ```

2. Implement timeout wrapper using `Promise.race`

3. On timeout: transition to `cancelling` state, cancel both legs, record incident

4. Treat delayed ACKs as failures (transition to cancel)

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`
- `src/config/policy.ts`

### End goal

Execution never hangs; timeouts trigger deterministic recovery.

### Acceptance criteria

- [ ] Orders timeout at configured thresholds
- [ ] Timeout triggers incident with severity 'high'
- [ ] Delayed responses treated as failures
- [ ] Market quarantined after timeout incidents
- [ ] Tests cover timeout scenarios

---

## Task 12 — Add cancel APIs and cancel-on-delay/timeout

### Reasoning

**CRITICAL GAP**: `PolymarketClob` has no cancel endpoints; delayed orders remain live, creating inventory risk.

### What to do

Add cancel endpoints to `PolymarketClob` and wire cancel-on-delay/timeout logic.

### How

1. Add cancel methods to `PolymarketClob`:
   ```typescript
   async cancelOrder(orderId: string): Promise<CancelResult>;
   async cancelAll(): Promise<CancelResult>;
   async cancelMarketOrders(tokenId: string): Promise<CancelResult>;
   ```

2. Update `ExecutionAgent` to cancel both legs on:
   - Delayed ACK
   - Timeout
   - One leg rejected
   - Partial fill requiring unwind

3. Verify cancellation success before proceeding

4. Handle cancel failures as critical incidents

### Files impacted

- `src/services/PolymarketClob.ts`
- `src/agents/execution/ExecutionAgent.ts`

### End goal

Delayed/timeout orders never remain live after failure.

### Acceptance criteria

- [ ] Cancel APIs implemented and tested
- [ ] Delayed orders cancelled immediately
- [ ] Cancel verification before state transition
- [ ] Cancel failure triggers critical incident

---

## Task 13 — Add idempotency hardening (stable nonce + dedup)

### Reasoning

**CRITICAL GAP**: Current implementation retries with new nonce, risking duplicate orders.

### What to do

Persist idempotency keys, use stable nonces, and handle duplicate errors gracefully.

### How

1. Extend `src/domain/idempotency.ts`:
   ```typescript
   export interface IdempotencyRecord {
     key: string;
     orderId?: string;
     nonce: string;
     status: 'pending' | 'submitted' | 'confirmed' | 'failed';
     createdAt: number;
   }
   ```

2. Persist idempotency records to EventStore

3. Update `PolymarketClob` to:
   - Use stable nonce for a single order attempt
   - Treat "duplicate order" errors as success
   - Lookup existing order by idempotency key on retry

4. Add cleanup for stale idempotency records

### Files impacted

- `src/domain/idempotency.ts`
- `src/services/PolymarketClob.ts`
- `src/core/EventStore.ts`

### End goal

Retries never create duplicate live orders.

### Acceptance criteria

- [ ] Idempotency keys persisted with order IDs
- [ ] Retries use stable nonce
- [ ] Duplicate errors treated as success
- [ ] Stale records cleaned up

---

## Task 14 — Add per-market in-flight lock and leg-sync gate

### Reasoning

**HIGH GAP**: Nothing prevents concurrent executions on same market or enforces leg-skew bounds.

### What to do

Enforce one in-flight execution per market and add leg-sync gate.

### How

1. Add in-flight tracking to `Supervisor`:
   ```typescript
   private inFlightMarkets = new Set<string>();
   
   async executeIfAvailable(marketId: string, opportunity: Opportunity): Promise<boolean> {
     if (this.inFlightMarkets.has(marketId)) {
       return false;
     }
     this.inFlightMarkets.add(marketId);
     try {
       await this.executor.execute(opportunity);
     } finally {
       this.inFlightMarkets.delete(marketId);
     }
     return true;
   }
   ```

2. Add leg-sync gate in `gates.ts`:
   ```typescript
   const bookSkewMs = Math.abs(yesBook.lastUpdateMs - noBook.lastUpdateMs);
   if (bookSkewMs > policy.maxLegSkewMs) {
     reasons.push('leg_sync_skew');
   }
   ```

3. Add `maxLegSkewMs` to policy (default 100ms)

### Files impacted

- `src/core/Supervisor.ts`
- `src/domain/gates.ts`
- `src/config/policy.ts`

### End goal

No concurrent executions on same market; leg skew bounded.

### Acceptance criteria

- [ ] Concurrent execution attempts on same market rejected
- [ ] Leg skew gate enforced
- [ ] Rejected attempts logged with reason

---

## Task 15 — Add partial-fill safety hook with unwind logic

### Reasoning

If one leg fills but the other fails, the system must immediately unwind with bounded loss.

### What to do

Implement robust unwind logic in `ExecutionAgent`.

### How

1. Add unwind order builder with price cap based on `maxUnwindLossTicks`

2. Implement `handleUnwind` method:
   ```typescript
   async handleUnwind(state: PairedExecutionState): Promise<UnwindResult> {
     const filledLeg = state.yesStatus === 'filled' ? 'yes' : 'no';
     const unwindPrice = this.calculateUnwindPrice(state, filledLeg);
     
     // Place FAK order at capped price
     const result = await this.clob.placeFAKOrder({...});
     
     // Record outcome
     this.recordUnwindResult(state, result);
     
     // Quarantine market
     this.incidentTracker.record({...});
   }
   ```

3. Wire portfolio updates after unwind

4. Add `UnwindResult` type to domain

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`
- `src/domain/portfolio.ts`
- `src/domain/execution.ts`

### End goal

Partial fills are automatically unwound with bounded loss.

### Acceptance criteria

- [ ] Unwind triggered when one leg fills and other fails
- [ ] FAK order used for unwind
- [ ] Price capped at `maxUnwindLossTicks`
- [ ] Unwind failure triggers 'block' action (critical)
- [ ] Portfolio updated after unwind
- [ ] Tests cover success, partial, and failure paths

---

## Task 16 — Update RiskAgent with unwind loss budget sizing

### Reasoning

Sizing must cap worst-case unwind loss and be observable.

### What to do

Use unwind budget helper and return binding constraint in `RiskDecision`.

### How

1. Extend `RiskDecision`:
   ```typescript
   export interface RiskDecision {
     approved: boolean;
     reason: string;
     positionSize?: number;
     constraints?: {
       maxByTradeFraction: number;
       maxByDepth: number;
       maxByUnwindBudget: number;
       maxByDailyLoss: number;
       binding: 'trade_fraction' | 'depth' | 'unwind_budget' | 'daily_loss' | 'exposure';
     };
     worstCaseLoss?: number;
   }
   ```

2. Apply `calculateMaxSizeByUnwindBudget` in sizing

3. Verify `worstCaseLoss <= config.maxPerTradeLossDollars` and daily headroom

### Files impacted

- `src/agents/risk/RiskAgent.ts`

### End goal

Risk sizing bounded by worst-case loss and fully observable.

### Acceptance criteria

- [ ] Sizing honors unwind budget
- [ ] Worst-case loss computed and verified
- [ ] Daily loss headroom checked
- [ ] Binding constraint recorded

---

## Task 17 — Add user channel order/trade integration

**Status**: ✅ Implemented (requires `POLYMARKET_USER_WS_URL` for near-zero-risk live mode).

### Reasoning

**CRITICAL GAP**: `ExecutionAgent` only reads REST responses; order updates, partial fills, and trade confirmations require user channel.

### What to do

Subscribe to user channel and wire order/trade events to execution state machine.

### How

1. Update `PolymarketRealtime` to parse user channel events:
   ```typescript
   interface OrderUpdate {
     orderId: string;
     status: 'live' | 'matched' | 'cancelled';
     sizeMatched: number;
     timestamp: number;
   }
   
   subscribeUser(callback: (event: OrderUpdate) => void): void;
   ```

2. Wire user channel events to `ExecutionAgent`:
   - Update execution state on order updates
   - Detect partial fills via `sizeMatched`
   - Trigger unwind on unexpected status changes

3. Add order state store for tracking

### Files impacted

- `src/services/PolymarketRealtime.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/market-data/MarketDataAgent.ts`

### End goal

Partial fills and delayed updates detected within SLA via user channel.

### Acceptance criteria

- [ ] User channel subscription implemented
- [ ] Order updates parsed and routed
- [ ] Partial fills detected via `sizeMatched`
- [ ] Execution state updated on channel events

---

## Task 18 — Add expected vs observed basket reconciliation to PortfolioAgent

**Status**: ✅ Implemented.

### Reasoning

After execution, `PortfolioAgent` should verify that actual fills match expected positions.

### What to do

Add reconciliation logic to `PortfolioAgent`.

### How

1. Add expected fill tracking:
   ```typescript
   interface ExpectedFill {
     opportunityId: string;
     tokenId: string;
     expectedSize: number;
     expectedPrice: number;
     timestamp: number;
   }
   ```

2. Add methods:
   - `expectFill(fill: ExpectedFill): void`
   - `applyFillWithReconciliation(actual: Fill): ReconciliationResult`
   - `checkStalePending(maxAgeMs: number): ExpectedFill[]`

3. Emit incidents on mismatch

### Files impacted

- `src/agents/portfolio/PortfolioAgent.ts`
- `src/domain/portfolio.ts`

### End goal

Portfolio reconciles expected vs actual fills; mismatches trigger incidents.

### Acceptance criteria

- [x] Size mismatches detected with tolerance
- [x] Price mismatches detected with tolerance
- [x] Unexpected fills flagged
- [x] Missing legs detected via `checkStalePending`

---

## Task 19 — Add per-market CircuitBreaker registry

**Status**: ✅ Implemented.

### Reasoning

Per-market circuit breakers prevent cascading failures and isolate problematic markets.

### What to do

Create per-market CircuitBreaker registry and wire to execution outcomes.

### How

1. Add `CircuitBreakerRegistry` class:
   ```typescript
   export class CircuitBreakerRegistry {
     private breakers = new Map<string, CircuitBreaker>();
     
     get(marketId: string): CircuitBreaker;
     recordSuccess(marketId: string): void;
     recordFailure(marketId: string): void;
     isOpen(marketId: string): boolean;
     getOpenMarkets(): string[];
     getSummary(): Map<string, CircuitBreakerState>;
   }
   ```

2. Wire to `ExecutionAgent` and `Supervisor`

3. Integrate with `IncidentTracker` quarantine

### Files impacted

- `src/core/CircuitBreaker.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/core/Supervisor.ts`

### End goal

Problem markets isolated without halting all trading.

### Acceptance criteria

- [x] Per-market breakers managed lazily
- [x] Open circuit blocks execution
- [x] Failures record to correct market
- [x] `getOpenMarkets()` returns tripped markets

---

## Task 20 — Add exposure cleanup after unwind/quarantine

**Status**: ✅ Implemented.

### Reasoning

Exposure tracking must reflect actual positions after unwind.

### What to do

Add exposure cleanup methods to `PortfolioAgent`.

### How

1. Add methods:
   - `clearMarketExposure(marketId: string): void`
   - `reduceMarketExposure(marketId: string, amount: number): void`
   - `applyUnwind(unwindResult: UnwindResult): void`

2. Wire to unwind and quarantine flows

3. Track PnL impact on unwind

### Files impacted

- `src/agents/portfolio/PortfolioAgent.ts`
- `src/domain/portfolio.ts`

### End goal

Exposure tracking accurate after safety actions.

### Acceptance criteria

- [x] Exposure cleanups work correctly
- [x] Zero positions removed from tracking
- [x] PnL impact recorded on unwind

---

## Task 21 — Add portfolio reconciliation loop with venue truth

**Status**: ✅ Implemented (CLOB open orders + Data API positions; positions require `POLYMARKET_POSITIONS_USER` in live mode).

### Reasoning

**HIGH GAP**: No periodic reconciliation between internal ledger and venue API truth.

### What to do

Add periodic reconciliation that detects drift and triggers incidents.

### How

1. Add reconciliation method to `PortfolioAgent`:
   ```typescript
   async reconcileWithVenue(): Promise<ReconciliationResult> {
     const openOrders = await this.clob.getOpenOrders();
     const positions = await this.clob.getPositions();
     
     // Compare with internal state
     const drift = this.calculateDrift(openOrders, positions);
     
     if (drift.hasDiscrepancy) {
       this.incidentTracker.record({
         reason: 'recon_drift',
         detail: drift
       });
     }
     
     return drift;
   }
   ```

2. Run reconciliation:
   - On startup
   - Every 5 minutes during operation
   - After any incident

3. Optional onchain reconciliation (PolygonRpc, Phase 2 only — deferred in Phase 1):
   - Fetch onchain balances and settlement events for conditional tokens (ERC-1155) and USDC.
   - Map asset IDs to token IDs, handle confirmations/reorgs, and reconcile against CLOB fills.
   - Expect higher complexity due to chain indexing, rate limits, and latency tradeoffs.

### Files impacted

- `src/agents/portfolio/PortfolioAgent.ts`
- `src/services/PolymarketClob.ts`
- `src/core/Supervisor.ts`

### End goal

Drift is detectable, explained, and triggers deterministic response.

### Acceptance criteria

- [x] Reconciliation fetches venue state
- [x] Drift detection with tolerance
- [x] Incidents created on discrepancy
- [x] Periodic and event-triggered runs

---

## Task 22 — Add trading SLO health checks to OpsAgent

**Status**: ✅ Implemented (in-memory windows via `MetricsStore` until Task 23 persistence).

### Reasoning

Ops needs real-time SLO monitoring with configurable thresholds.

### What to do

Create SLO check factory functions and wire into `OpsAgent`.

### How

1. Create `src/agents/ops/sloChecks.ts`:
   ```typescript
   export function createBookFreshnessCheck(threshold: number): HealthCheck;
   export function createDelayedAckRateCheck(threshold: number): HealthCheck;
   export function createLatencyPercentileCheck(percentile: number, threshold: number): HealthCheck;
   export function createPairedFillRateCheck(threshold: number): HealthCheck;
   export function createCircuitBreakerCheck(registry: CircuitBreakerRegistry): HealthCheck;
   ```

2. Wire checks into `OpsAgent` constructor

3. Add SLO metrics aggregation with 1h/24h windows

### Files impacted

- `src/agents/ops/sloChecks.ts` (new file)
- `src/agents/ops/OpsAgent.ts`
- `src/core/Supervisor.ts`

### End goal

OpsAgent monitors trading SLOs and alerts on violations.

### Acceptance criteria

- [x] All SLO checks implemented
- [x] Checks return `ok: false` when thresholds violated
- [x] Checks configurable via policy
- [x] SLO metrics available for dashboard

---

## Task 23 — Add telemetry retention and SLO windowing

### Reasoning

**MEDIUM GAP**: In-memory ring buffer (1000 events) cannot compute reliable 1h SLO windows.

### What to do

Store telemetry in SQLite and compute SLOs over explicit windows.

### How

1. Add telemetry persistence in `EventStore`:
   ```typescript
   async persistMetric(event: MetricEvent): Promise<void>;
   async queryMetrics(type: string, windowMs: number): Promise<MetricEvent[]>;
   ```

2. Add SLO aggregation with rolling windows:
   ```typescript
   export interface SLOAggregate {
     window: '1h' | '24h';
     pairedFillRate: number;
     p95Latency: number;
     delayedAckRate: number;
     bookFreshnessViolations: number;
   }
   ```

3. Add retention policy (7 days default)

### Files impacted

- `src/telemetry/metrics.ts`
- `src/core/EventStore.ts`
- `src/db/schema.sql`

### End goal

SLO metrics are stable, audit-ready, and not truncated.

### Acceptance criteria

- [x] Metrics persisted to SQLite
- [x] Rolling window queries work correctly
- [x] Retention policy enforced
- [x] Dashboard shows 1h/24h SLOs

---

## Task 24 — Add alert delivery and readiness/liveness checks

### Reasoning

**MEDIUM GAP**: No external alert delivery; `/health` is just uptime.

### What to do

Add webhook/Slack alerting and proper health endpoints.

### How

1. Add alert delivery to `OpsAgent`:
   ```typescript
   async sendAlert(incident: IncidentRecord): Promise<void> {
     if (this.webhookUrl) {
       await fetch(this.webhookUrl, {
         method: 'POST',
         body: JSON.stringify(incident)
       });
     }
   }
   ```

2. Add health endpoints to `src/api/server.ts`:
   ```typescript
   app.get('/health/ready', async (req, reply) => {
     const checks = await opsAgent.runChecks();
     const ready = checks.every(c => c.ok);
     reply.status(ready ? 200 : 503).send({ ready, checks });
   });
   
   app.get('/health/live', async (req, reply) => {
     reply.send({ live: true, uptime: process.uptime() });
   });
   ```

3. Add healthcheck to `Dockerfile` and `docker-compose.yml`

4. Add manual resume endpoint for quarantined markets (ops API):
   - `POST /allowlist/:marketId/resume`
   - Records an info event for auditability

### Files impacted

- `src/agents/ops/OpsAgent.ts`
- `src/api/server.ts`
- `Dockerfile`
- `docker-compose.yml`

### End goal

Ops can get alerts; health checks reflect dependency status.

### Acceptance criteria

- [x] Webhook alerts sent on incidents
- [x] `/health/ready` checks all dependencies
- [x] `/health/live` returns uptime
- [x] Container healthcheck configured
- [x] Manual resume endpoint unquarantines a market

---

## Task 25 — Add graceful shutdown with order cleanup

### Reasoning

**HIGH GAP**: No SIGTERM/SIGINT handling; orders not cancelled on exit.

### What to do

Implement graceful shutdown in `src/main.ts`.

### How

1. Add signal handlers:
   ```typescript
   async function shutdown(signal: string): Promise<void> {
     console.log(`Received ${signal}, shutting down...`);
     
     // Stop accepting new work
     supervisor.stop();
     
     // Cancel all open orders
     await clob.cancelAll();
     
     // Flush metrics
     await metrics.flush();
     
     // Close connections
     await realtime.disconnect();
     await fastify.close();
     
     // Final reconciliation
     await portfolio.reconcileWithVenue();
     
     console.log('Shutdown complete');
     process.exit(0);
   }
   
   process.on('SIGTERM', () => shutdown('SIGTERM'));
   process.on('SIGINT', () => shutdown('SIGINT'));
   ```

2. Add `onClose` hook to Fastify for cleanup

3. Set shutdown timeout (30s) with forced exit

### Files impacted

- `src/main.ts`
- `src/api/server.ts`

### End goal

Shutdown cancels all open orders, closes WS, emits final telemetry, exits cleanly.

### Acceptance criteria

- [x] SIGTERM/SIGINT handled gracefully
- [x] Open orders cancelled
- [x] Metrics flushed
- [x] Connections closed
- [x] Timeout prevents hanging

---

## Task 26 — Add startup reconciliation

### Reasoning

**HIGH GAP**: No open-order reconciliation or state replay on startup.

### What to do

On startup, fetch open orders, cancel stale ones, rebuild state, and reconcile portfolio.

### How

1. Add startup sequence in `Supervisor.start()`:
   ```typescript
   async start(): Promise<void> {
     // 1. Replay events from EventStore
     const lastState = await this.stateRebuilder.rebuild();
     
     // 2. Fetch open orders from venue
     const openOrders = await this.clob.getOpenOrders();
     
     // 3. Cancel any orphaned orders
     for (const order of openOrders) {
       if (!lastState.hasOrder(order.id)) {
         await this.clob.cancelOrder(order.id);
       }
     }
     
     // 4. Reconcile portfolio
     await this.portfolio.reconcileWithVenue();
     
     // 5. Start agents
     await this.startAgents();
   }
   ```

2. Add `hasOrder` and state recovery to `StateRebuilder`

### Files impacted

- `src/core/Supervisor.ts`
- `src/core/StateRebuilder.ts`
- `src/services/PolymarketClob.ts`

### End goal

No orphaned orders or unknown exposure post-boot.

### Acceptance criteria

- [x] Events replayed from EventStore
- [x] Open orders fetched and compared
- [x] Orphaned orders cancelled
- [x] Portfolio reconciled before trading

---

## Task 27 — Add comprehensive unit and integration tests

### Reasoning

All new functionality requires thorough test coverage using existing patterns.

### What to do

Add unit tests, integration scenarios, and latency stress tests.

### How

1. Create new test files:
   - `tests/unit/gates-extended.test.ts` - enhanced gate logic
   - `tests/unit/risk-extended.test.ts` - unwind budget sizing
   - `tests/unit/execution-state.test.ts` - state machine transitions
   - `tests/unit/portfolio-reconciliation.test.ts` - reconciliation logic
   - `tests/integration/near-zero-risk-flow.test.ts` - end-to-end flow

2. Test patterns:
   - Use `vi.useFakeTimers()` for timeout tests
   - Mock external deps with `vi.mock()`
   - Use existing `makeBook` helpers
   - Follow AAA pattern (Arrange-Act-Assert)

3. Coverage targets:
   - Unit: ≥90% branch coverage on new code
   - Integration: critical flows (scanner→risk→exec)
   - E2E: smoke tests (dashboard loads, metrics display)

### Files impacted

- `tests/unit/gates-extended.test.ts` (new)
- `tests/unit/risk-extended.test.ts` (new)
- `tests/unit/execution-state.test.ts` (new)
- `tests/unit/portfolio-reconciliation.test.ts` (new)
- `tests/unit/execution.test.ts` (extend)
- `tests/integration/near-zero-risk-flow.test.ts` (new)

### End goal

All near-zero-risk functionality verified via automated tests.

### Acceptance criteria

- [x] All new gates have unit tests
- [x] State machine transitions fully tested
- [x] Timeout handling tested with fake timers
- [x] Unwind logic tested for all paths
- [x] Integration test validates end-to-end flow
- [x] All tests pass: `npm run test`
- [x] Coverage ≥90% on new code

---

## File-by-file implementation sequence

[To minimize conflicts and ensure dependencies are available, implement files in this order]

1. `src/config/policy.ts` — Tasks 1, 7, 8, 11, 14
2. `src/config/risk.ts` — Task 2
3. `src/config/env.ts` — Task 3
4. `src/config/validate.ts` — Task 4 (new file)
5. `src/config/index.ts` — Task 4
6. `src/telemetry/events.ts` — Task 5 (new file)
7. `src/telemetry/metrics.ts` — Tasks 5, 8, 23
8. `src/telemetry/index.ts` — Task 5
9. `src/domain/incident.ts` — Task 6
10. `src/domain/gates.ts` — Tasks 7, 14
11. `src/domain/execution.ts` — Task 9
12. `src/domain/idempotency.ts` — Task 13
13. `src/domain/portfolio.ts` — Tasks 15, 18, 20
14. `src/services/PolymarketClob.ts` — Tasks 12, 13, 21, 26
15. `src/services/PolymarketRealtime.ts` — Task 17
16. `src/agents/risk/RiskAgent.ts` — Task 16
17. `src/agents/execution/ExecutionAgent.ts` — Tasks 3, 8, 10, 11, 12, 15, 17
18. `src/agents/portfolio/PortfolioAgent.ts` — Tasks 18, 20, 21
19. `src/agents/scanner/ScannerAgent.ts` — Task 3
20. `src/core/CircuitBreaker.ts` — Task 19
21. `src/core/EventStore.ts` — Tasks 13, 23
22. `src/core/StateRebuilder.ts` — Task 26
23. `src/core/Supervisor.ts` — Tasks 14, 19, 21, 22, 26
24. `src/agents/ops/sloChecks.ts` — Task 22 (new file)
25. `src/agents/ops/OpsAgent.ts` — Tasks 22, 24
26. `src/api/server.ts` — Tasks 24, 25
27. `src/main.ts` — Tasks 3, 4, 25, 26
28. `src/db/schema.sql` — Task 23
29. `Dockerfile` — Task 24
30. `docker-compose.yml` — Task 24
31. `dashboard/src/App.tsx` — Task 3
32. `tests/unit/gates-extended.test.ts` — Task 27 (new file)
33. `tests/unit/risk-extended.test.ts` — Task 27 (new file)
34. `tests/unit/execution-state.test.ts` — Task 27 (new file)
35. `tests/unit/portfolio-reconciliation.test.ts` — Task 27 (new file)
36. `tests/unit/execution.test.ts` — Task 27
37. `tests/integration/near-zero-risk-flow.test.ts` — Task 27 (new file)

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| None required | — | All functionality implemented with existing dependencies |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-03 | Initial merged plan from P0 v1/v2 |
| 2.0 | 2026-01-03 | Integrated oracle architecture review (8 critical/high gaps), strategic planning breakdown (5 phases, 15 tasks), and external best practices (16 bullets) |
| 2.1 | 2026-01-03 | Incorporated unique content from IMPLEMENTATION_PLAN_NEAR_ZERO_RISK_MERGED.md: Executive Summary, Phase Status, Risk Gate Hierarchy diagram, State Machine diagram (Appendix A), Gate Evaluation pseudocode (Appendix B), SLO Monitoring Matrix (Appendix C) |

---

## Resolved Defaults (P0)

1. **Per-trade worst-case loss bound**: Default $25 / 2.5% until overridden.
2. **Operator intervention model**: Hands-off auto-quarantine with manual resume option via ops API.
3. **Reconciliation data sources**: CLOB fills/open orders as baseline; optional onchain settlement via PolygonRpc (added complexity).
4. **Alert delivery method**: Optional webhook via env.

---

**End of Implementation Plan**

---

## Appendix A: State Machine Diagram

```
                    ┌──────────────────────────────────────────────┐
                    │              EXECUTION STATE MACHINE          │
                    └──────────────────────────────────────────────┘
                    
┌──────┐    submit    ┌────────────┐    sent    ┌─────────┐
│ idle │─────────────→│ submitting │───────────→│ pending │
└──────┘              └────────────┘            └─────────┘
                            │                        │
                            │ error                  │ ack
                            ▼                        ▼
                      ┌────────┐              ┌───────────┐
                      │ failed │              │   acked   │
                      └────────┘              └───────────┘
                            ▲                   │       │
                            │                   │       │ partial
                            │           filled  │       ▼
                            │                   │ ┌──────────────────┐
                            │                   │ │ partially_filled │
                            │                   │ └──────────────────┘
                            │                   │         │
                            │                   ▼         │ unwind
                            │             ┌────────┐      ▼
                            │             │ filled │ ┌───────────┐
                            │             └────────┘ │ unwinding │
                            │                   │    └───────────┘
                            │                   │         │
                            │                   ▼         │ unwound
                            │            ┌──────────┐     ▼
                            └────────────│ complete │←────┘
                                         └──────────┘
```

---

## Appendix B: Gate Evaluation Sequence

```python
def evaluate_opportunity(opp, policy, risk_config, orderbook):
    gates = [
        ("circuit_breaker", lambda: circuit_breaker_gate(opp.market_id)),
        ("book_freshness", lambda: book_freshness_gate(orderbook.last_update, policy.max_book_staleness_ms)),
        ("leg_sync", lambda: leg_sync_gate(orderbook.yes_update, orderbook.no_update, policy.max_leg_skew_ms)),
        ("min_edge", lambda: min_edge_gate(opp.edge, policy.min_edge_ticks)),
        ("depth_buffer", lambda: depth_buffer_gate(orderbook, opp.side, opp.size, policy.depth_buffer_multiplier)),
        ("slippage", lambda: slippage_gate(orderbook, opp.size, policy.slippage_tolerance_bps)),
        ("unwind_budget", lambda: unwind_budget_gate(opp, risk_config)),
        ("position_limit", lambda: position_limit_gate(opp, risk_config)),
        ("exposure_limit", lambda: exposure_limit_gate(opp, risk_config)),
        ("daily_loss", lambda: daily_loss_gate(opp, risk_config)),
        ("velocity", lambda: velocity_gate(metrics, policy.max_orders_per_minute)),
        ("otr", lambda: otr_gate(metrics, policy.max_order_to_trade_ratio)),
        ("correlation", lambda: correlation_gate(opp, pending_orders)),
    ]
    
    for name, gate_fn in gates:
        result = gate_fn()
        if not result.pass:
            emit_gate_rejection(name, result.reason, opp.market_id)
            return GateResult(pass=False, blocked_by=name, reason=result.reason)
    
    return GateResult(pass=True)
```

---

## Appendix C: SLO Monitoring Matrix

| SLO | Metric Source | Threshold | Alert Severity | Recovery Action |
|-----|---------------|-----------|----------------|-----------------|
| Paired-fill rate | `execution_lifecycle` events | ≥99.9% | Critical | Halt trading |
| Decision latency p95 | `latency` events | ≤100ms | High | Review scanner |
| Book staleness | `book_staleness` events | ≤500ms | Medium | Check WS feed |
| Delayed ACK rate | `slo_violation` events | ≤0.1% | High | Quarantine venue |
| Unwind loss | `unwind_triggered` incidents | ≤2 ticks | High | Review sizing |
