# Near-Zero-Risk Polymarket Arbitrage System Enhancements — Implementation Plan (P0)

This plan covers critical hardening for the near-zero-risk complete-set arbitrage strategy. It adds policy/SLO knobs, latency telemetry, stricter gating, bounded sizing, explicit execution state machine, and reconciliation hardening.

---

## Overview

### Scope

- **P0 Only**: Binary complete-set BUY (YES ask + NO ask < 1 − buffer) with strict gates
- No cross-market combinatorial, no weak dependencies, no directional carry
- Focus on achieving ≥99.9% paired-fill success rate

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

---

## Task 1 — Extend TradePolicy with near-zero-risk strategy flags

### Reasoning

The existing `TradePolicy` interface lacks explicit mode selection and SLO thresholds needed for configurable risk-free operation. Adding these to the centralized config enables feature flags and tunable thresholds without creating new configuration files.

### What to do

Extend `TradePolicy` in `src/config/policy.ts` with strategy mode and SLO knobs.

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
   /** Maximum loss in ticks if unwind is required */
   maxUnwindLossTicks: number;
   ```

2. Update `DEFAULT_TRADE_POLICY` with conservative defaults:
   ```typescript
   export const DEFAULT_TRADE_POLICY: TradePolicy = {
     // Existing fields
     edgeRequired: 0.03,
     maxEdge: 0.05,
     depthHeadroomFraction: 0.25,
     maxSpread: 0.05,
     orderbookFreshnessMs: 500,
     topOfBookStabilityMs: 250,
     maxOpenInventorySeconds: 2,
     rejectDelayed: true,
     // New fields
     strategyMode: 'near_zero_risk',
     requireFreshBook: true,
     maxBookStalenessMs: 500,
     maxDecisionLatencyMs: 100,
     maxDelayedAckRate: 0.001,
     minEdgeTicks: 3,
     depthBufferMultiplier: 1.5,
     maxUnwindLossTicks: 2
   };
   ```

3. Add JSDoc comments explaining each field's purpose and valid ranges

4. Export a helper function:
   ```typescript
   export function isNearZeroRiskMode(policy: TradePolicy): boolean {
     return policy.strategyMode === 'near_zero_risk';
   }
   ```

### Files impacted

- `src/config/policy.ts`

### End goal

Policy config supports explicit near-zero-risk mode with all SLO thresholds configurable from a single location.

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
   export interface RiskConfig {
     // Existing fields
     targetTradeFraction: number;
     maxTradeFraction: number;
     maxAttemptLossFraction: number;
     maxDailyDrawdownFraction: number;
     maxMarketExposureFraction: number;
     marketCooldownSeconds: number;
     // New fields
     /** Max loss as fraction of position notional if unwind needed */
     maxUnwindLossFraction: number;
     /** Max loss in price ticks per set on unwind */
     maxUnwindLossTicks: number;
   }
   ```

2. Update `DEFAULT_RISK_CONFIG`:
   ```typescript
   export const DEFAULT_RISK_CONFIG: RiskConfig = {
     targetTradeFraction: 0.1,
     maxTradeFraction: 0.1,
     maxAttemptLossFraction: 0.0025,
     maxDailyDrawdownFraction: 0.02,
     maxMarketExposureFraction: 0.5,
     marketCooldownSeconds: 600,
     // New fields
     maxUnwindLossFraction: 0.02,  // 2% max loss on unwind
     maxUnwindLossTicks: 2         // 2 ticks max loss
   };
   ```

3. Add helper function for unwind budget calculation:
   ```typescript
   /**
    * Calculate maximum position size based on unwind loss budget.
    * This ensures that if we need to unwind a position, the max loss
    * is bounded by the configured fraction of available capital.
    */
   export function calculateMaxSizeByUnwindBudget(
     edge: number,
     tickSize: number,
     availableCapital: number,
     config: RiskConfig
   ): number {
     const maxLossNotional = availableCapital * config.maxUnwindLossFraction;
     const lossPerSet = tickSize * config.maxUnwindLossTicks;
     
     if (lossPerSet <= 0) {
       return Infinity; // No constraint if tick size unknown
     }
     
     return maxLossNotional / lossPerSet;
   }
   ```

### Files impacted

- `src/config/risk.ts`

### End goal

Risk sizing incorporates unwind loss budget as an additional constraint, preventing oversized positions that could result in significant losses on emergency unwind.

### Acceptance criteria

- [ ] `RiskConfig` interface includes `maxUnwindLossFraction` and `maxUnwindLossTicks`
- [ ] `DEFAULT_RISK_CONFIG` includes conservative defaults (2% loss, 2 ticks)
- [ ] `calculateMaxSizeByUnwindBudget` correctly computes max size
- [ ] Helper handles edge cases (zero tick size, zero budget)
- [ ] Unit test validates budget calculation with sample inputs

---

## Task 3 — Add structured latency event types to telemetry

### Reasoning

Current `MetricEventType` lacks specific types for latency measurement across the execution pipeline. Adding structured latency events enables SLO monitoring, performance debugging, and identifying bottlenecks in the detect→submit→ack→fill pipeline.

### What to do

Extend `MetricEventType` and add typed latency event interfaces in telemetry.

### How

1. Add new metric types to `MetricEventType` union in `src/telemetry/metrics.ts`:
   ```typescript
   export type MetricEventType =
     | 'health'
     | 'incident'
     | 'opportunity'
     | 'order'
     | 'fill'
     | 'risk'
     | 'info'
     | 'error'
     // New types
     | 'latency'
     | 'execution_lifecycle'
     | 'book_staleness'
     | 'slo_violation';
   ```

2. Create `src/telemetry/events.ts` (new file) with typed event interfaces:
   ```typescript
   import type { ExecutionState } from '../domain/execution.js';

   /**
    * Latency measurement at each stage of the execution pipeline.
    * Used for SLO monitoring and performance debugging.
    */
   export interface LatencyEvent {
     stage: 'detected' | 'gated' | 'risk_approved' | 'submitted' | 'acked' | 'filled' | 'complete';
     opportunityId: string;
     marketId: string;
     timestampMs: number;
     /** Time in ms since previous stage */
     latencyMs?: number;
     /** Time in ms since opportunity detection */
     cumulativeMs?: number;
   }

   /**
    * Execution state transitions for debugging and audit.
    */
   export interface ExecutionLifecycleEvent {
     opportunityId: string;
     marketId: string;
     state: ExecutionState;
     previousState?: ExecutionState;
     yesOrderId?: string;
     noOrderId?: string;
     reason?: string;
     timestampMs: number;
   }

   /**
    * Book staleness measurement for freshness monitoring.
    */
   export interface BookStalenessEvent {
     tokenId: string;
     marketId: string;
     stalenessMs: number;
     threshold: number;
     violated: boolean;
     timestampMs: number;
   }

   /**
    * SLO violation event for alerting.
    */
   export interface SloViolationEvent {
     sloName: 'decision_latency' | 'book_freshness' | 'delayed_ack_rate' | 'paired_fill_rate';
     threshold: number;
     actual: number;
     marketId?: string;
     opportunityId?: string;
     timestampMs: number;
   }

   /**
    * Union type for all telemetry event data payloads.
    */
   export type TelemetryEventData =
     | LatencyEvent
     | ExecutionLifecycleEvent
     | BookStalenessEvent
     | SloViolationEvent;
   ```

3. Update `src/telemetry/index.ts` to export new types:
   ```typescript
   export * from './metrics.js';
   export * from './events.js';
   export * from './allowlist.js';
   ```

4. Add convenience method to `MetricsStore`:
   ```typescript
   /**
    * Record a latency event with automatic cumulative calculation.
    */
   recordLatency(event: LatencyEvent): void {
     this.record({
       type: 'latency',
       timestamp: event.timestampMs,
       data: event
     });
   }
   ```

### Files impacted

- `src/telemetry/metrics.ts`
- `src/telemetry/events.ts` (new file)
- `src/telemetry/index.ts`

### End goal

Telemetry system can record structured latency and SLO events with type safety, enabling real-time monitoring of execution pipeline performance.

### Acceptance criteria

- [ ] New metric types added to `MetricEventType` without breaking existing code
- [ ] Event interfaces are exported and usable by agents
- [ ] `recordLatency` helper simplifies emission
- [ ] TypeScript enforces correct event shapes
- [ ] Existing `metrics.recent()` and `metrics.snapshot()` work with new types

---

## Task 4 — Extend incident taxonomy for near-zero-risk scenarios

### Reasoning

Current `IncidentReason` type covers basic failures (order_delayed, order_rejected, ws_disconnected) but lacks specific categories for near-zero-risk execution failures like partial fills, unwind triggers, and SLO violations. A complete taxonomy enables proper incident response and market quarantine decisions.

### What to do

Extend incident types in `src/domain/incident.ts` to cover all failure modes.

### How

1. Expand `IncidentReason` union type:
   ```typescript
   export type IncidentReason =
     // Existing reasons
     | 'order_delayed'
     | 'order_rejected'
     | 'order_failed'
     | 'ws_disconnected'
     | 'rpc_degraded'
     // New reasons for near-zero-risk execution
     | 'partial_fill'        // One leg filled, other didn't
     | 'unwind_triggered'    // Unwind was executed due to partial fill
     | 'unwind_failed'       // Unwind attempt also failed (critical)
     | 'book_stale'          // Book freshness SLO violated at execution time
     | 'latency_exceeded'    // Decision latency SLO violated
     | 'depth_insufficient'  // Depth dried up mid-execution
     | 'price_moved'         // Price moved beyond threshold during execution
     | 'timeout'             // Execution timeout waiting for response
     | 'circuit_breaker'     // Circuit breaker tripped for market
     | 'unknown';
   ```

2. Add `IncidentSeverity` type:
   ```typescript
   /**
    * Severity levels for incidents, used to determine response actions.
    */
   export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
   ```

3. Extend `IncidentRecord` interface:
   ```typescript
   export interface IncidentRecord {
     marketId: string;
     reason: IncidentReason;
     /** Severity determines response action */
     severity: IncidentSeverity;
     timestamp: number;
     /** Opportunity ID if incident occurred during execution */
     opportunityId?: string;
     /** Additional context for debugging */
     detail?: Record<string, unknown>;
     /** Recommended recovery action */
     recoveryAction?: 'quarantine' | 'block' | 'alert_only';
   }
   ```

4. Add helper function for default severity:
   ```typescript
   /**
    * Get default severity for an incident reason.
    */
   export function getDefaultSeverity(reason: IncidentReason): IncidentSeverity {
     switch (reason) {
       case 'unwind_failed':
       case 'partial_fill':
         return 'critical';
       case 'order_delayed':
       case 'timeout':
       case 'unwind_triggered':
       case 'circuit_breaker':
         return 'high';
       case 'order_rejected':
       case 'order_failed':
       case 'book_stale':
       case 'latency_exceeded':
       case 'depth_insufficient':
       case 'price_moved':
         return 'medium';
       case 'ws_disconnected':
       case 'rpc_degraded':
       case 'unknown':
       default:
         return 'low';
     }
   }

   /**
    * Get default recovery action for an incident reason.
    */
   export function getDefaultRecoveryAction(
     reason: IncidentReason
   ): 'quarantine' | 'block' | 'alert_only' {
     switch (reason) {
       case 'unwind_failed':
         return 'block';
       case 'partial_fill':
       case 'order_delayed':
       case 'timeout':
       case 'circuit_breaker':
         return 'quarantine';
       default:
         return 'alert_only';
     }
   }
   ```

### Files impacted

- `src/domain/incident.ts`

### End goal

Incident taxonomy covers all near-zero-risk failure modes with severity classification and default recovery actions.

### Acceptance criteria

- [ ] All new incident reasons documented with JSDoc comments
- [ ] Severity levels assigned appropriately based on risk
- [ ] Existing incident recording code continues to work (backward compatible)
- [ ] `getDefaultSeverity` provides sensible defaults for all reasons
- [ ] `getDefaultRecoveryAction` returns appropriate action for each reason

---

## Task 5 — Add book freshness and depth buffer gates to evaluateGates

### Reasoning

Current `evaluateGates` checks `orderbookFreshnessMs` but the new policy has `maxBookStalenessMs`, `requireFreshBook`, `minEdgeTicks`, and `depthBufferMultiplier` flags. Gates need to honor these new thresholds to enforce near-zero-risk requirements.

### What to do

Enhance gate evaluation in `src/domain/gates.ts` to use new policy fields.

### How

1. Update `GateInputs` interface to include additional context:
   ```typescript
   export interface GateInputs {
     yesBook: OrderBookState;
     noBook: OrderBookState;
     policy: TradePolicy;
     nowMs: number;
     desiredSize?: number;
     /** Tick size for min-edge-in-ticks calculation */
     tickSize?: number;
   }
   ```

2. Update `GateDecision` to include staleness info:
   ```typescript
   export interface GateDecision {
     passed: boolean;
     reasons: string[];
     costPerSet: number;
     edge: number;
     /** Edge expressed in ticks for SLO comparison */
     edgeInTicks?: number;
     maxSizeByDepth: number;
     /** YES book staleness in ms */
     yesStalenessMs?: number;
     /** NO book staleness in ms */
     noStalenessMs?: number;
   }
   ```

3. Add new gate checks in `evaluateGates` function (insert after existing freshness check):
   ```typescript
   // Calculate staleness for reporting
   const yesStalenessMs = nowMs - yesBook.lastUpdateMs;
   const noStalenessMs = nowMs - noBook.lastUpdateMs;

   // Enhanced book staleness gate (uses maxBookStalenessMs if set)
   const maxStaleness = policy.maxBookStalenessMs ?? policy.orderbookFreshnessMs;
   if (policy.requireFreshBook !== false) {
     if (yesStalenessMs > maxStaleness) {
       reasons.push('yes_book_stale');
     }
     if (noStalenessMs > maxStaleness) {
       reasons.push('no_book_stale');
     }
   }

   // Min edge in ticks gate
   const tickSize = inputs.tickSize ?? yesBook.tickSize ?? 0.01;
   const edgeInTicks = edge / tickSize;
   if (policy.minEdgeTicks !== undefined && policy.minEdgeTicks > 0) {
     if (edgeInTicks < policy.minEdgeTicks) {
       reasons.push('edge_below_min_ticks');
     }
   }

   // Depth buffer gate - ensure sufficient headroom
   if (policy.depthBufferMultiplier !== undefined && desiredSize !== undefined) {
     const requiredDepth = desiredSize * policy.depthBufferMultiplier;
     if (maxSizeByDepth < requiredDepth) {
       reasons.push('insufficient_depth_buffer');
     }
   }
   ```

4. Update return statement to include new fields:
   ```typescript
   return {
     passed: reasons.length === 0,
     reasons,
     costPerSet,
     edge,
     edgeInTicks,
     maxSizeByDepth,
     yesStalenessMs,
     noStalenessMs
   };
   ```

### Files impacted

- `src/domain/gates.ts`

### End goal

Gate evaluation enforces stricter freshness, edge, and depth requirements for near-zero-risk mode with detailed staleness reporting.

### Acceptance criteria

- [ ] `requireFreshBook` flag is respected (defaults to true)
- [ ] `maxBookStalenessMs` overrides `orderbookFreshnessMs` when set
- [ ] `minEdgeTicks` gate correctly rejects insufficient edge
- [ ] `depthBufferMultiplier` gate ensures sufficient headroom
- [ ] Staleness values (`yesStalenessMs`, `noStalenessMs`) included in `GateDecision`
- [ ] `edgeInTicks` calculated and returned for logging
- [ ] Existing tests pass without modification
- [ ] New tests added for each new gate

---

## Task 6 — Update RiskAgent with unwind loss budget sizing

### Reasoning

`RiskAgent.evaluate()` currently sizes based on depth and trade fraction but doesn't consider unwind loss budget. Adding this constraint ensures positions are sized to limit worst-case losses if one leg fails and requires emergency liquidation.

### What to do

Enhance `RiskAgent` to include unwind loss budget in sizing calculation.

### How

1. Update `RiskDecision` interface to include constraint details:
   ```typescript
   export interface RiskDecision {
     approved: boolean;
     reason: string;
     positionSize?: number;
     positionNotional?: number;
     /** Details of which constraint was binding */
     constraints?: {
       maxByTradeFraction: number;
       maxByDepth: number;
       maxByUnwindBudget: number;
       binding: 'trade_fraction' | 'depth' | 'unwind_budget' | 'exposure' | 'min_size';
     };
   }
   ```

2. Update `RiskAgent.evaluate()` method to calculate unwind budget constraint and take minimum of all constraints.

3. Return which constraint was binding for observability.

### Files impacted

- `src/agents/risk/RiskAgent.ts`

### End goal

Risk sizing includes unwind loss budget as a binding constraint, ensuring positions are sized conservatively enough that worst-case unwind losses are acceptable.

### Acceptance criteria

- [ ] `maxUnwindLossFraction` and `maxUnwindLossTicks` from config are used
- [ ] Position size never exceeds unwind budget limit
- [ ] `RiskDecision.constraints` shows all three limits and which was binding
- [ ] Handles edge cases (zero tick size, missing config fields)
- [ ] Unit tests verify unwind budget limits sizing when it's the binding constraint
- [ ] Existing tests continue to pass

---

## Task 7 — Create ExecutionState type and state machine for paired execution

### Reasoning

Current `ExecutionAgent` lacks explicit state tracking for paired orders. A state machine makes transitions deterministic, debuggable, and enables proper recovery from partial fills. This is foundational for Tasks 8-10.

### What to do

Define execution state machine types in `src/domain/execution.ts`.

### How

1. Add execution state type:
   ```typescript
   export type ExecutionState =
     | 'idle'           // No execution in progress
     | 'submitting'     // Orders being submitted
     | 'yes_pending'    // YES submitted, waiting for response
     | 'no_pending'     // NO submitted, waiting for response
     | 'both_pending'   // Both submitted, waiting for responses
     | 'yes_acked'      // YES acknowledged, NO pending
     | 'no_acked'       // NO acknowledged, YES pending
     | 'both_acked'     // Both acknowledged, waiting for fills
     | 'yes_filled'     // YES filled, NO pending/acked
     | 'no_filled'      // NO filled, YES pending/acked
     | 'both_filled'    // SUCCESS: Both filled
     | 'partial_fill'   // One filled, other failed - needs unwind
     | 'unwinding'      // Unwind in progress
     | 'unwind_complete'// Unwind succeeded
     | 'unwind_failed'  // Unwind failed - critical
     | 'failed'         // Both failed (clean failure)
     | 'timeout'        // Execution timed out
     | 'complete';      // Terminal success state
   ```

2. Add `PairedExecutionState` interface with full context.

3. Add `ExecutionEvent` types that trigger state transitions.

4. Add `transitionExecutionState` pure function for deterministic state transitions.

5. Add `getRequiredAction` helper to determine next action based on state.

6. Add `createInitialExecutionState` factory function.

### Files impacted

- `src/domain/execution.ts`

### End goal

Type-safe state machine for paired execution with deterministic transitions and clear action recommendations.

### Acceptance criteria

- [ ] All execution states defined with JSDoc documentation
- [ ] State transitions are pure functions (no side effects)
- [ ] Invalid transitions throw descriptive errors
- [ ] `getRequiredAction` returns correct action for each state
- [ ] `createInitialExecutionState` creates valid initial state
- [ ] Unit tests cover all state transitions including edge cases

---

## Task 8 — Refactor ExecutionAgent with state machine and latency tracking

### Reasoning

Current `ExecutionAgent.executeArbitrage()` uses `Promise.all` without explicit state tracking. Refactoring to use the state machine enables proper partial-fill handling, latency measurement at each stage, and deterministic recovery.

### What to do

Refactor `ExecutionAgent` to use `PairedExecutionState` and emit latency events.

### How

1. Update constructor to accept additional dependencies (metrics, portfolio, circuitBreakers).
2. Add latency emission helper methods.
3. Add state transition logging helper.
4. Refactor `executeArbitrage` to use state machine.
5. Add response processing helper.
6. Add result builder that maps state to ExecutionResult.

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`

### End goal

ExecutionAgent uses explicit state machine with full latency tracking, proper state transitions, and foundation for unwind handling.

### Acceptance criteria

- [ ] State machine transitions logged for debugging via `execution_lifecycle` events
- [ ] Latency events emitted at `submitted` and `acked` stages
- [ ] Active executions tracked in map for monitoring
- [ ] State transitions are deterministic and logged
- [ ] All existing tests pass
- [ ] New tests verify state machine integration

---

## Task 9 — Add deterministic timeout handling to ExecutionAgent

### Reasoning

Delayed or timeout responses must be handled deterministically. The system should never be in an uncertain state about whether orders were placed or filled. Timeouts trigger incidents and market quarantine.

### What to do

Add timeout handling and deterministic failure recovery to `ExecutionAgent`.

### How

1. Extend `ExecutionAgentConfig` for timeouts (orderTimeoutMs, unwindTimeoutMs, maxRetries).
2. Add timeout wrapper helper using `Promise.race`.
3. Update order submission to use timeout.
4. Add timeout incident recording.
5. Add delayed response detection with stricter handling.

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`

### End goal

Timeouts and delayed responses are handled deterministically with appropriate recovery actions and market quarantine.

### Acceptance criteria

- [ ] Orders timeout after configurable duration (default 2000ms)
- [ ] Timeout triggers incident recording with severity 'high'
- [ ] Timeout with one filled leg triggers unwind
- [ ] Delayed responses treated as failures
- [ ] Market quarantined after timeout incidents
- [ ] Latency recorded for both successful and timed-out submissions
- [ ] Tests cover timeout scenarios for both legs

---

## Task 10 — Add partial-fill safety hook with unwind logic

### Reasoning

If one leg fills but the other fails (rejects or times out), the system must immediately attempt to unwind the filled position using FAK at a price cap to limit losses. This is the critical safety mechanism for near-zero-risk execution.

### What to do

Implement robust unwind logic in `ExecutionAgent`.

### How

1. Add unwind order builder with price cap based on `maxUnwindLossTicks`.
2. Implement `handleUnwind` method.
3. Add `UnwindResult` type to domain/portfolio.
4. Wire portfolio updates after unwind.

### Files impacted

- `src/agents/execution/ExecutionAgent.ts`
- `src/domain/portfolio.ts`

### End goal

Partial fills are automatically unwound with bounded loss, using FAK orders at a price cap.

### Acceptance criteria

- [ ] Unwind triggered when one leg fills and other fails/times out
- [ ] FAK order used for unwind (accepts partial fills)
- [ ] Price capped at `maxUnwindLossTicks` below entry price
- [ ] Unwind failure triggers 'block' action on market (severity critical)
- [ ] Unwind success triggers 'quarantine' action on market (severity high)
- [ ] Portfolio updated after successful unwind
- [ ] Metrics recorded for unwind events via `execution_lifecycle`
- [ ] Tests cover unwind success, partial fill, and failure paths

---

## Task 11 — Add trading SLO health checks to OpsAgent

### Reasoning

Current `OpsAgent` runs generic health checks but lacks trading-specific SLO monitoring. Adding checks for WS lag, book freshness, and delayed ACK rate enables proactive alerting before SLO violations impact trading.

### What to do

Add trading SLO check factory functions and wire them into `OpsAgent`.

### How

1. Create `src/agents/ops/sloChecks.ts` (new file) with check factories:
   - `createBookFreshnessCheck`
   - `createDelayedAckRateCheck`
   - `createWsConnectionCheck`
   - `createLatencyPercentileCheck`
   - `createPairedFillRateCheck`

2. Wire checks into `Supervisor`.

3. Add `getAllOrderBooks` method to `MarketDataAgent` if not present.

### Files impacted

- `src/agents/ops/sloChecks.ts` (new file)
- `src/core/Supervisor.ts`
- `src/agents/market-data/MarketDataAgent.ts`

### End goal

OpsAgent monitors trading SLOs and alerts on violations through the existing health check infrastructure.

### Acceptance criteria

- [ ] Book freshness check detects stale books and reports count
- [ ] Delayed ACK rate check calculates correctly over time window
- [ ] WS connection check reports connection status and subscription count
- [ ] Latency percentile check calculates p99 correctly
- [ ] Paired fill rate check monitors success rate
- [ ] All checks return `ok: false` when thresholds violated
- [ ] Checks are configurable via policy values
- [ ] Tests verify check logic with mock metrics

---

## Task 12 — Wire CircuitBreaker to per-market execution outcomes

### Reasoning

Current `CircuitBreaker` is generic and not wired to market-specific failures. Per-market circuit breakers prevent cascading failures and isolate problematic markets without halting all trading.

### What to do

Create per-market CircuitBreaker registry and wire it to execution outcomes.

### How

1. Add `CircuitBreakerRegistry` class to `src/core/CircuitBreaker.ts`.
2. Update `ExecutionAgent` constructor to accept circuit breakers.
3. Add circuit breaker check at start of `executeArbitrage`.
4. Record outcomes to circuit breaker.
5. Wire in `Supervisor`.

### Files impacted

- `src/core/CircuitBreaker.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/core/Supervisor.ts`

### End goal

Per-market circuit breakers prevent execution on problematic markets while allowing trading on healthy markets to continue.

### Acceptance criteria

- [ ] `CircuitBreakerRegistry` manages per-market breakers lazily
- [ ] Open circuit blocks execution with 'circuit_breaker_open' reason
- [ ] Failures record to correct market's breaker
- [ ] Successes reset failure count for market
- [ ] `getOpenMarkets()` returns list of tripped markets
- [ ] `getSummary()` provides overview of all breaker states
- [ ] Integration test verifies circuit breaker opens after threshold failures

---

## Task 13 — Add expected vs observed basket reconciliation to PortfolioAgent

### Reasoning

After execution, `PortfolioAgent` should verify that actual fills match expected positions. Discrepancies indicate execution issues requiring investigation. This reconciliation catches silent failures and position drift.

### What to do

Add reconciliation logic to `PortfolioAgent`.

### How

1. Add expected fill tracking types to `src/domain/portfolio.ts`.
2. Add `expectFill` method to register expected fills.
3. Add `applyFillWithReconciliation` method.
4. Add `checkStalePending` to detect missing legs.
5. Add cleanup methods.

### Files impacted

- `src/agents/portfolio/PortfolioAgent.ts`
- `src/domain/portfolio.ts`

### End goal

Portfolio reconciles expected vs actual fills and flags discrepancies for investigation.

### Acceptance criteria

- [ ] `expectFill` registers expected position before execution
- [ ] `applyFillWithReconciliation` returns reconciliation status
- [ ] Size mismatches detected with tolerance
- [ ] Price mismatches detected with tolerance
- [ ] Unexpected fills flagged
- [ ] `checkStalePending` identifies missing legs
- [ ] Both legs filling clears expected fill record
- [ ] Tests verify reconciliation logic

---

## Task 14 — Add exposure cleanup after unwind/quarantine

### Reasoning

After an unwind or market quarantine, exposure tracking must be updated to reflect the actual position state. Stale exposure data leads to incorrect risk calculations and potential over-exposure.

### What to do

Add exposure cleanup methods to `PortfolioAgent`.

### How

1. Add `clearMarketExposure`, `reduceMarketExposure`, `clearPositions`, `reducePosition` methods.
2. Add `applyUnwind` method that handles both full and partial unwinds.
3. Add position and exposure accessor methods.
4. Wire `applyUnwind` call from `ExecutionAgent.handleUnwind`.

### Files impacted

- `src/agents/portfolio/PortfolioAgent.ts`
- `src/domain/portfolio.ts`

### End goal

Portfolio exposure is correctly updated after unwinds, keeping risk calculations accurate.

### Acceptance criteria

- [ ] `clearMarketExposure` removes market from tracking
- [ ] `reduceMarketExposure` decreases exposure correctly, cleans up at zero
- [ ] `clearPositions` removes specified token positions
- [ ] `reducePosition` decreases position size, cleans up at zero
- [ ] `applyUnwind` handles both full and partial unwind
- [ ] PnL impact recorded on unwind
- [ ] `getPosition` and `getAllPositions` accessors work correctly
- [ ] Tests verify exposure cleanup in all scenarios

---

## Task 15 — Add comprehensive unit tests for new functionality

### Reasoning

All new functionality requires thorough test coverage to ensure correctness and prevent regressions. Tests follow existing patterns in the codebase using Vitest, mock factories, and helper functions.

### What to do

Add unit tests for new gates, risk constraints, state machine, and reconciliation.

### How

1. Create `tests/unit/gates-extended.test.ts` for new gate tests.
2. Create `tests/unit/risk-extended.test.ts` for unwind budget sizing tests.
3. Create `tests/unit/execution-state.test.ts` for state machine tests.
4. Create `tests/unit/portfolio-reconciliation.test.ts` for reconciliation tests.
5. Update `tests/unit/execution.test.ts` with timeout, circuit breaker, and unwind tests.

### Files impacted

- `tests/unit/gates-extended.test.ts` (new file)
- `tests/unit/risk-extended.test.ts` (new file)
- `tests/unit/execution-state.test.ts` (new file)
- `tests/unit/portfolio-reconciliation.test.ts` (new file)
- `tests/unit/execution.test.ts` (extend existing)

### End goal

≥90% code coverage on new functionality with comprehensive edge case testing following existing patterns.

### Acceptance criteria

- [ ] All new gates have unit tests with pass/fail cases
- [ ] Risk sizing constraints tested including edge cases
- [ ] State machine transitions fully tested (all states, all events)
- [ ] Reconciliation logic tested for all discrepancy types
- [ ] Timeout handling tested
- [ ] Circuit breaker integration tested
- [ ] Unwind logic tested for success and failure paths
- [ ] All tests pass: `npm run test`
- [ ] Coverage report shows ≥90% on new code

---

## File-by-file Implementation Sequence

To minimize conflicts and ensure dependencies are available, implement in this order:

| Order | File | Tasks |
|-------|------|-------|
| 1 | `src/config/policy.ts` | Task 1 |
| 2 | `src/config/risk.ts` | Task 2 |
| 3 | `src/telemetry/events.ts` (new) | Task 3 |
| 4 | `src/telemetry/metrics.ts` | Task 3 |
| 5 | `src/telemetry/index.ts` | Task 3 |
| 6 | `src/domain/incident.ts` | Task 4 |
| 7 | `src/domain/gates.ts` | Task 5 |
| 8 | `src/agents/risk/RiskAgent.ts` | Task 6 |
| 9 | `src/domain/execution.ts` | Task 7 |
| 10 | `src/domain/portfolio.ts` | Task 13, 14 |
| 11 | `src/agents/portfolio/PortfolioAgent.ts` | Task 13, 14 |
| 12 | `src/core/CircuitBreaker.ts` | Task 12 |
| 13 | `src/agents/execution/ExecutionAgent.ts` | Tasks 8, 9, 10, 12 |
| 14 | `src/agents/market-data/MarketDataAgent.ts` | Task 11 (add getAllOrderBooks) |
| 15 | `src/agents/ops/sloChecks.ts` (new) | Task 11 |
| 16 | `src/core/Supervisor.ts` | Tasks 11, 12 |
| 17 | `tests/unit/gates-extended.test.ts` (new) | Task 15 |
| 18 | `tests/unit/risk-extended.test.ts` (new) | Task 15 |
| 19 | `tests/unit/execution-state.test.ts` (new) | Task 15 |
| 20 | `tests/unit/portfolio-reconciliation.test.ts` (new) | Task 15 |
| 21 | `tests/unit/execution.test.ts` | Task 15 |

---

## Dependencies to Add

| Package | Version | Purpose |
|---------|---------|---------|
| None required | — | All functionality implemented with existing dependencies |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-03 | Initial near-zero-risk enhancement plan with 15 tasks across 7 epics |

---

**End of Implementation Plan**
