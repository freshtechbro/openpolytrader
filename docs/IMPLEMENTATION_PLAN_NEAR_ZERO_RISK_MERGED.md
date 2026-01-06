# Near-Zero-Risk Arbitrage Implementation Plan (Merged)

> **Merged from**: IMPLEMENTATION_PLAN.md (Phase 1 Infrastructure) + IMPLEMENTATION_PLAN_NEAR_ZERO_RISK_P0_v1.md (Hardening) + NEAR_ZERO_RISK_ARBITRAGE_REPORT.md (Research)
>
> **Version**: 1.0 | **Date**: 2026-01-03

---

## Executive Summary

This merged plan consolidates the foundational infrastructure (Phase 1) with production-grade hardening (P0) for near-zero-risk arbitrage execution. Phase 1 infrastructure is **already implemented**; this plan focuses on the **18 remaining hardening tasks** required for production deployment.

### Definition: Near-Zero-Risk

- **Bounded maximum loss**: Every trade has a deterministic worst-case loss ceiling
- **Deterministic recovery**: Failed states trigger automatic, pre-computed unwind actions
- **No unbounded exposure**: Partial fills are immediately hedged or unwound

### P0 Strategy: Binary Complete-Set BUY

Buy YES + NO tokens when `YES_ask + NO_ask < 1 - buffer`, guaranteeing profit if both legs fill completely.

---

## SLO Targets (Non-Negotiable)

| Metric | Target | Rationale |
|--------|--------|-----------|
| Paired-fill rate | ≥99.9% | <1 one-leg per 1000 attempts |
| Decision latency | ≤100ms | Opportunity window typically <1s |
| Book staleness | ≤500ms | Stale data = phantom edge |
| Delayed ACK rate | ≤0.1% | Reject any venue not confirming within SLA |
| Max unwind loss | ≤10 ticks | Bounded failure cost |

---

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1: Infrastructure** | ✅ COMPLETE | Core runtime, agents, CLOB clients, dashboard |
| **Phase P0: Hardening** | 🔄 IN PROGRESS | This plan - production safety hardening |
| **Phase 2: Multi-Venue** | ⏳ FUTURE | Cross-venue arbitrage (Kalshi, etc.) |

---

## Overview

### Key Decisions (Merged Best-of-Both)

1. **Fill-or-Kill (FOK) for both legs** - No partial exposure risk on entry
2. **Immediate unwind on partial fill** - FAK at `maxUnwindLossTicks` cap
3. **Per-market circuit breakers** - Isolate failures, don't cascade
4. **State machine execution** - Deterministic state transitions, no race conditions
5. **Edge must pay for failures** - Minimum 3¢ edge covers worst-case unwind cost
6. **Depth buffer multiplier** - Require 1.5-2x order size available at price
7. **Reject delayed ACKs** - Venue latency > SLA = reject, don't queue

### Risk Gate Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                    GATE EVALUATION ORDER                     │
├─────────────────────────────────────────────────────────────┤
│ 1. Circuit Breaker     │ Is market circuit open?            │
│ 2. Book Freshness      │ Last update < maxBookStalenessMs?  │
│ 3. Edge Threshold      │ Edge ≥ minEdgeTicks (≥3¢)?         │
│ 4. Depth Buffer        │ Available depth ≥ size × buffer?   │
│ 5. Position Limits     │ Resulting position ≤ maxPosition?  │
│ 6. Exposure Limits     │ Total exposure ≤ maxExposure?      │
│ 7. Unwind Budget       │ Potential loss ≤ unwind budget?    │
│ 8. Correlation Check   │ No conflicting pending orders?     │
└─────────────────────────────────────────────────────────────┘
```

---

## Task 1 — Extend TradePolicy with SLO Configuration Flags

### Reasoning
Current `TradePolicy` lacks fields for enforcing SLO constraints. Adding these enables runtime configuration of risk tolerance without code changes.

### What to do
Add SLO-enforcement fields to `TradePolicy` interface and configuration.

### How
1. Add fields to `TradePolicy` in `src/config/policy.ts`:
   ```typescript
   strategyMode: 'binary_complete_set' | 'multi_outcome' | 'disabled';
   maxBookStalenessMs: number;      // default: 500
   minEdgeTicks: number;            // default: 3 (3¢)
   depthBufferMultiplier: number;   // default: 1.5
   maxUnwindLossTicks: number;      // default: 10
   ackTimeoutMs: number;            // default: 2000
   ```
2. Add defaults in `DEFAULT_TRADE_POLICY`
3. Update config loader to parse these from environment/config file

### Files impacted
- `src/config/policy.ts`
- `src/config/index.ts`
- `.env.example`

### End goal
TradePolicy contains all SLO-relevant thresholds, configurable per environment.

### Acceptance criteria
- [ ] All new fields exist with sensible defaults
- [ ] Config loads from environment variables
- [ ] TypeScript compilation passes
- [ ] Existing tests unaffected

---

## Task 2 — Extend RiskConfig with Unwind Loss Budget

### Reasoning
Unwind operations must have a bounded loss ceiling. This prevents catastrophic losses when exiting failed positions.

### What to do
Add unwind loss budget fields to `RiskConfig`.

### How
1. Add to `RiskConfig` in `src/config/risk.ts`:
   ```typescript
   maxUnwindLossFraction: number;   // default: 0.02 (2% of position value)
   maxUnwindLossTicks: number;      // default: 10
   unwindStrategy: 'fak_immediate' | 'ladder' | 'market';  // default: fak_immediate
   ```
2. Add constraint validation: `maxUnwindLossTicks ≤ minEdgeTicks` (loss can't exceed edge)
3. Export helper: `validateUnwindBudget(config: RiskConfig, edge: number): boolean`

### Files impacted
- `src/config/risk.ts`
- `src/config/index.ts`

### End goal
Unwind budget is explicitly configured and validated against edge requirements.

### Acceptance criteria
- [ ] Fields added with defaults
- [ ] Validation rejects `unwindLossTicks > minEdgeTicks`
- [ ] Unit test covers validation logic

---

## Task 3 — Add Latency Telemetry Event Types

### Reasoning
SLO monitoring requires granular latency tracking. Current telemetry lacks execution lifecycle visibility.

### What to do
Add structured event types for latency and execution lifecycle telemetry.

### How
1. Create `src/telemetry/events.ts` with:
   ```typescript
   interface LatencyEvent {
     type: 'latency';
     phase: 'decision' | 'submission' | 'ack' | 'fill' | 'total';
     durationMs: number;
     marketId: string;
     orderId?: string;
   }
   
   interface ExecutionLifecycleEvent {
     type: 'execution_lifecycle';
     state: ExecutionState;
     previousState?: ExecutionState;
     marketId: string;
     orderId: string;
     timestamp: number;
   }
   
   interface BookStalenessEvent {
     type: 'book_staleness';
     marketId: string;
     stalenessMs: number;
     threshold: number;
     violated: boolean;
   }
   
   interface SloViolationEvent {
     type: 'slo_violation';
     slo: 'paired_fill' | 'decision_latency' | 'book_staleness' | 'ack_timeout';
     actual: number;
     threshold: number;
     marketId: string;
   }
   ```
2. Add emitter functions in `src/telemetry/index.ts`
3. Wire to existing `MessageBus` for event distribution

### Files impacted
- `src/telemetry/events.ts` (new file)
- `src/telemetry/index.ts`
- `src/core/MessageBus.ts`

### End goal
All latency-relevant events are typed, emittable, and observable via MessageBus.

### Acceptance criteria
- [ ] Event types exported
- [ ] Emitter functions work
- [ ] Events flow through MessageBus
- [ ] Unit tests for event emission

---

## Task 4 — Expand Incident Taxonomy

### Reasoning
Current incident types don't cover all failure modes in near-zero-risk execution. Need explicit types for unwind, staleness, and timeout scenarios.

### What to do
Add new incident types and severity mappings.

### How
1. Extend `IncidentType` enum in `src/domain/incident.ts`:
   ```typescript
   | 'partial_fill'
   | 'unwind_triggered'
   | 'unwind_failed'
   | 'book_stale'
   | 'ack_timeout'
   | 'execution_timeout'
   | 'circuit_breaker_tripped'
   | 'slo_violation'
   ```
2. Add severity mapping:
   ```typescript
   const INCIDENT_SEVERITY: Record<IncidentType, 'critical' | 'high' | 'medium' | 'low'> = {
     partial_fill: 'high',
     unwind_failed: 'critical',
     book_stale: 'medium',
     ack_timeout: 'high',
     // ... etc
   };
   ```
3. Add recovery action suggestions per type

### Files impacted
- `src/domain/incident.ts`
- `src/services/IncidentTracker.ts`

### End goal
All failure modes have explicit incident types with severity and recovery guidance.

### Acceptance criteria
- [ ] All new types added
- [ ] Severity mapping complete
- [ ] IncidentTracker handles new types
- [ ] Runbook updated with recovery actions

---

## Task 5 — Enhance Gate Checks with Depth Buffer & Edge Ticks

### Reasoning
Current gates check basic limits but miss critical near-zero-risk requirements: depth adequacy and minimum edge threshold.

### What to do
Add `depthBufferGate` and `minEdgeGate` to gate evaluation chain.

### How
1. In `src/domain/gates.ts`, add:
   ```typescript
   export function depthBufferGate(
     orderbook: Orderbook,
     side: 'buy' | 'sell',
     size: number,
     bufferMultiplier: number
   ): GateResult {
     const availableDepth = getDepthAtPrice(orderbook, side, size);
     const required = size * bufferMultiplier;
     return {
       pass: availableDepth >= required,
       reason: availableDepth < required 
         ? `Insufficient depth: ${availableDepth} < ${required}` 
         : undefined
     };
   }
   
   export function minEdgeGate(
     edge: number,
     minEdgeTicks: number
   ): GateResult {
     return {
       pass: edge >= minEdgeTicks,
       reason: edge < minEdgeTicks 
         ? `Edge ${edge} below minimum ${minEdgeTicks}` 
         : undefined
     };
   }
   ```
2. Add staleness tracking to gate context:
   ```typescript
   export function bookFreshnessGate(
     lastUpdateTs: number,
     maxStalenessMs: number
   ): GateResult
   ```
3. Integrate into `evaluateAllGates()` chain

### Files impacted
- `src/domain/gates.ts`
- `src/agents/risk/RiskAgent.ts`

### End goal
All near-zero-risk gates are implemented and evaluated in correct order.

### Acceptance criteria
- [ ] `depthBufferGate` implemented and tested
- [ ] `minEdgeGate` implemented and tested
- [ ] `bookFreshnessGate` implemented and tested
- [ ] Gates integrated into RiskAgent evaluation
- [ ] Unit tests for each gate

---

## Task 6 — Integrate Unwind Budget Constraint in RiskAgent

### Reasoning
RiskAgent must reject opportunities where potential unwind loss exceeds budget, even if other gates pass.

### What to do
Add unwind budget check to RiskAgent opportunity evaluation.

### How
1. In `src/agents/risk/RiskAgent.ts`, add:
   ```typescript
   private checkUnwindBudget(
     opportunity: Opportunity,
     policy: TradePolicy,
     riskConfig: RiskConfig
   ): GateResult {
     const potentialUnwindLoss = this.calculateWorstCaseUnwindLoss(opportunity);
     const budget = Math.min(
       opportunity.size * riskConfig.maxUnwindLossFraction,
       riskConfig.maxUnwindLossTicks
     );
     return {
       pass: potentialUnwindLoss <= budget,
       reason: potentialUnwindLoss > budget
         ? `Unwind loss ${potentialUnwindLoss} exceeds budget ${budget}`
         : undefined
     };
   }
   ```
2. Add to gate evaluation sequence (after depth buffer, before position limits)

### Files impacted
- `src/agents/risk/RiskAgent.ts`
- `src/domain/gates.ts`

### End goal
No opportunity passes RiskAgent if worst-case unwind exceeds budget.

### Acceptance criteria
- [ ] Unwind budget check implemented
- [ ] Integrated into gate sequence
- [ ] Unit tests cover budget edge cases
- [ ] Telemetry emits when budget blocks opportunity

---

## Task 7 — Define ExecutionState Machine

### Reasoning
Current execution lacks formal state machine. Race conditions and invalid transitions are possible. State machine ensures deterministic behavior.

### What to do
Implement formal state machine for execution lifecycle.

### How
1. Create `src/domain/executionState.ts`:
   ```typescript
   export type ExecutionState =
     | 'idle'
     | 'submitting'
     | 'pending'
     | 'acked'
     | 'partially_filled'
     | 'filled'
     | 'unwinding'
     | 'unwound'
     | 'complete'
     | 'failed';
   
   export const VALID_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
     idle: ['submitting'],
     submitting: ['pending', 'failed'],
     pending: ['acked', 'failed'],
     acked: ['filled', 'partially_filled', 'failed'],
     partially_filled: ['unwinding'],
     filled: ['complete'],
     unwinding: ['unwound', 'failed'],
     unwound: ['complete'],
     complete: [],
     failed: [],
   };
   
   export function transition(
     current: ExecutionState,
     next: ExecutionState
   ): ExecutionState {
     if (!VALID_TRANSITIONS[current].includes(next)) {
       throw new InvalidStateTransitionError(current, next);
     }
     return next;
   }
   ```
2. Add `InvalidStateTransitionError` class
3. Add state history tracking for debugging

### Files impacted
- `src/domain/executionState.ts` (new file)
- `src/domain/execution.ts`

### End goal
All execution state transitions are validated and logged.

### Acceptance criteria
- [ ] State type defined
- [ ] Transition map complete
- [ ] `transition()` throws on invalid
- [ ] State history tracked
- [ ] 100% transition coverage in tests

---

## Task 8 — Refactor ExecutionAgent to Use State Machine

### Reasoning
ExecutionAgent must use the formal state machine to prevent race conditions and ensure deterministic behavior.

### What to do
Integrate state machine into ExecutionAgent execution flow.

### How
1. In `src/agents/execution/ExecutionAgent.ts`:
   - Add `private state: ExecutionState = 'idle'`
   - Replace ad-hoc status tracking with `transition()` calls
   - Emit `ExecutionLifecycleEvent` on each transition
   - Add state recovery on startup (check for incomplete executions)
2. Wrap all state changes in try-catch to handle invalid transitions
3. Add idempotency check: reject duplicate execution requests

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `src/domain/executionState.ts`

### End goal
ExecutionAgent has deterministic, auditable state transitions.

### Acceptance criteria
- [ ] State machine integrated
- [ ] Lifecycle events emitted
- [ ] Invalid transitions throw and are logged
- [ ] Recovery on startup implemented
- [ ] Integration tests cover full lifecycle

---

## Task 9 — Add Timeout Handling in ExecutionAgent

### Reasoning
Venues can hang indefinitely. Timeouts must trigger unwind, not leave orders in limbo.

### What to do
Implement timeout handling for ACK and fill phases.

### How
1. Add timeout configuration:
   ```typescript
   interface TimeoutConfig {
     ackTimeoutMs: number;      // default: 2000
     fillTimeoutMs: number;     // default: 5000
     unwindTimeoutMs: number;   // default: 3000
   }
   ```
2. In ExecutionAgent, add timeout watchers:
   ```typescript
   private async awaitAckWithTimeout(orderId: string): Promise<AckResult> {
     const timeout = setTimeout(() => {
       this.handleAckTimeout(orderId);
     }, this.config.ackTimeoutMs);
     
     try {
       return await this.venue.awaitAck(orderId);
     } finally {
       clearTimeout(timeout);
     }
   }
   
   private handleAckTimeout(orderId: string): void {
     this.transition('failed');
     this.emit(new SloViolationEvent('ack_timeout', ...));
     this.incidentTracker.report('ack_timeout', orderId);
   }
   ```
3. Add similar handling for fill timeout

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `src/config/policy.ts`

### End goal
All pending states have bounded timeouts that trigger clean failure paths.

### Acceptance criteria
- [ ] ACK timeout implemented
- [ ] Fill timeout implemented
- [ ] Timeout triggers SloViolationEvent
- [ ] Timeout triggers incident report
- [ ] Tests cover timeout scenarios

---

## Task 10 — Implement Partial-Fill Unwind Logic

### Reasoning
Partial fills create exposure. Immediate unwind with bounded loss is required.

### What to do
Implement automatic unwind when partial fill detected.

### How
1. Add unwind executor:
   ```typescript
   private async executeUnwind(
     position: Position,
     maxLossTicks: number
   ): Promise<UnwindResult> {
     const unwindPrice = this.calculateUnwindPrice(position, maxLossTicks);
     
     // FAK (Fill-and-Kill) at loss cap
     const order = {
       side: position.side === 'buy' ? 'sell' : 'buy',
       size: position.size,
       price: unwindPrice,
       timeInForce: 'FAK',
     };
     
     this.transition('unwinding');
     const result = await this.venue.submitOrder(order);
     
     if (result.filled) {
       this.transition('unwound');
       return { success: true, lossRealized: result.avgPrice - position.entryPrice };
     } else {
       // FAK didn't fill - escalate to market order or fail
       return this.escalateUnwind(position);
     }
   }
   ```
2. Wire to partial_fill state transition
3. Emit telemetry for unwind outcome

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `src/domain/execution.ts`

### End goal
Partial fills trigger immediate, bounded-loss unwind.

### Acceptance criteria
- [ ] Unwind logic implemented
- [ ] FAK order submission works
- [ ] Loss capped at maxUnwindLossTicks
- [ ] Escalation path for FAK failure
- [ ] Integration tests for partial fill scenarios

---

## Task 11 — Add SLO Health Check Endpoint

### Reasoning
Operations needs visibility into SLO compliance. Health endpoint enables alerting.

### What to do
Add SLO metrics endpoint to OpsAgent.

### How
1. Create `src/domain/sloChecks.ts`:
   ```typescript
   interface SloMetrics {
     pairedFillRate: number;         // 0-1
     avgDecisionLatencyMs: number;
     p99DecisionLatencyMs: number;
     avgBookStalenessMs: number;
     delayedAckRate: number;         // 0-1
     sloViolations: SloViolationSummary[];
   }
   
   export function calculateSloMetrics(
     events: TelemetryEvent[],
     windowMs: number = 3600000  // 1 hour
   ): SloMetrics
   ```
2. Add `/health/slo` endpoint in `src/api/server.ts`:
   ```typescript
   app.get('/health/slo', (req, res) => {
     const metrics = calculateSloMetrics(eventStore.recent(windowMs));
     const healthy = metrics.pairedFillRate >= 0.999 
       && metrics.avgDecisionLatencyMs <= 100;
     res.status(healthy ? 200 : 503).json(metrics);
   });
   ```
3. Add to OpsAgent periodic reporting

### Files impacted
- `src/domain/sloChecks.ts` (new file)
- `src/api/server.ts`
- `src/agents/ops/OpsAgent.ts`

### End goal
SLO compliance is continuously calculated and exposed via API.

### Acceptance criteria
- [ ] SLO calculation implemented
- [ ] `/health/slo` endpoint works
- [ ] Returns 503 when SLOs violated
- [ ] OpsAgent logs periodic SLO summary
- [ ] Dashboard can display SLO metrics

---

## Task 12 — Implement Per-Market CircuitBreakerRegistry

### Reasoning
Current single circuit breaker affects all markets. One bad market shouldn't halt everything.

### What to do
Implement registry for per-market circuit breakers.

### How
1. Create `src/core/CircuitBreakerRegistry.ts`:
   ```typescript
   export class CircuitBreakerRegistry {
     private breakers: Map<string, CircuitBreaker> = new Map();
     
     getOrCreate(marketId: string, config?: CircuitBreakerConfig): CircuitBreaker {
       if (!this.breakers.has(marketId)) {
         this.breakers.set(marketId, new CircuitBreaker(config));
       }
       return this.breakers.get(marketId)!;
     }
     
     tripMarket(marketId: string, reason: string): void {
       this.getOrCreate(marketId).trip(reason);
       this.emit('circuit_breaker_tripped', { marketId, reason });
     }
     
     getStatus(): Map<string, CircuitBreakerState> {
       return new Map([...this.breakers].map(([id, cb]) => [id, cb.state]));
     }
   }
   ```
2. Update RiskAgent to use registry instead of single breaker
3. Add API endpoint to view/reset breakers

### Files impacted
- `src/core/CircuitBreakerRegistry.ts` (new file)
- `src/core/CircuitBreaker.ts`
- `src/agents/risk/RiskAgent.ts`
- `src/api/server.ts`

### End goal
Circuit breakers are per-market; failure isolation is achieved.

### Acceptance criteria
- [ ] Registry implemented
- [ ] Per-market breakers work
- [ ] RiskAgent uses registry
- [ ] API endpoint for status/reset
- [ ] Tests cover multi-market scenarios

---

## Task 13 — Add Portfolio Reconciliation

### Reasoning
Local portfolio state can drift from venue truth. Periodic reconciliation ensures accuracy without requiring onchain indexing in Phase 1.

### What to do
Implement portfolio reconciliation against CLOB open orders + trades. Defer onchain reconciliation to Phase 2.

### How
1. Add reconciliation method to PortfolioAgent:
   ```typescript
   async reconcile(): Promise<ReconciliationResult> {
     const localPositions = this.getPositions();
     const openOrders = await this.clob.getOpenOrders();
     const trades = await this.clob.getTrades();
     
     const discrepancies: Discrepancy[] = [];
     // compare local state to venue truth derived from orders/trades
     
     if (discrepancies.length > 0) {
       this.incidentTracker.report('portfolio_drift', discrepancies);
     }
     
     return { discrepancies, corrected: discrepancies.length };
   }
   ```
2. Schedule periodic reconciliation (every 5 minutes)
3. Add manual reconciliation API endpoint

### Files impacted
- `src/agents/portfolio/PortfolioAgent.ts`
- `src/services/PolymarketClob.ts`
- `src/api/server.ts`

### End goal
Portfolio state is periodically verified against venue truth.

### Acceptance criteria
- [ ] Reconciliation logic implemented
- [ ] Discrepancies logged as incidents
- [ ] Scheduled reconciliation runs
- [ ] API endpoint for manual trigger
- [ ] Onchain reconciliation deferred to Phase 2

---

## Task 14 — Add Exposure Cleanup on Startup

### Reasoning
Unexpected shutdown may leave orphaned positions. Startup must detect and handle these.

### What to do
Implement exposure audit and cleanup on agent startup.

### How
1. Add startup hook in Supervisor:
   ```typescript
   async onStartup(): Promise<void> {
     // 1. Check for incomplete executions in EventStore
     const incomplete = await this.eventStore.findIncomplete();
     for (const exec of incomplete) {
       this.incidentTracker.report('orphaned_execution', exec);
       // Attempt recovery or manual review flag
     }
     
     // 2. Reconcile portfolio
     await this.portfolioAgent.reconcile();
     
     // 3. Check for unexpected exposure
     const exposure = this.portfolioAgent.getTotalExposure();
     if (exposure > 0) {
       this.incidentTracker.report('startup_exposure', { exposure });
       // Flag for review, don't auto-unwind without human approval
     }
   }
   ```
2. Add `findIncomplete()` to EventStore
3. Log startup audit results

### Files impacted
- `src/core/Supervisor.ts`
- `src/core/EventStore.ts`
- `src/agents/portfolio/PortfolioAgent.ts`

### End goal
System starts in known-good state or flags issues for human review.

### Acceptance criteria
- [ ] Incomplete execution detection works
- [ ] Portfolio reconciliation runs on startup
- [ ] Exposure flagged if non-zero
- [ ] Incidents created for anomalies
- [ ] Startup sequence logged

---

## Task 15 — Add Comprehensive Test Coverage

### Reasoning
All new functionality requires test coverage. Edge cases in financial systems are critical.

### What to do
Add unit and integration tests for all new components.

### How
1. Unit tests:
   - `tests/unit/slo-config.test.ts` - Policy and risk config validation
   - `tests/unit/execution-state.test.ts` - State machine transitions
   - `tests/unit/gates-enhanced.test.ts` - New gate implementations
   - `tests/unit/slo-checks.test.ts` - SLO calculation logic
2. Integration tests:
   - `tests/integration/partial-fill-unwind.test.ts` - End-to-end unwind flow
   - `tests/integration/circuit-breaker-registry.test.ts` - Multi-market isolation
   - `tests/integration/portfolio-reconciliation.test.ts` - Reconciliation flow
3. Test scenarios:
   - Happy path: both legs fill
   - Partial fill: one leg partial, unwind triggered
   - Timeout: ACK timeout, clean failure
   - Book stale: gate rejects stale data
   - Circuit trip: market isolated, others continue

### Files impacted
- `tests/unit/*.test.ts` (multiple new files)
- `tests/integration/*.test.ts` (multiple new files)
- `vitest.config.ts` (coverage thresholds)

### End goal
≥90% coverage on new code, all edge cases tested.

### Acceptance criteria
- [ ] Unit tests for all new modules
- [ ] Integration tests for critical flows
- [ ] Coverage ≥90% on new code
- [ ] All tests pass in CI

---

## Task 16 — Update Dashboard with SLO Metrics

### Reasoning
Operations needs visual monitoring of SLO compliance.

### What to do
Add SLO metrics panel to dashboard.

### How
1. Add SLO metrics component:
   - Real-time paired-fill rate gauge
   - Decision latency histogram
   - Book staleness trend
   - Circuit breaker status per market
2. Add alerts for SLO violations
3. Add execution state visualization

### Files impacted
- `dashboard/src/components/SloMetrics.tsx` (new file)
- `dashboard/src/pages/Overview.tsx`
- `dashboard/src/hooks/useEventStream.ts`

### End goal
Dashboard shows real-time SLO health.

### Acceptance criteria
- [ ] SLO metrics displayed
- [ ] Alerts on violations
- [ ] Circuit breaker status visible
- [ ] Responsive design works

---

## Task 17 — Update Runbook with New Incident Types

### Reasoning
Operations needs guidance for new failure modes.

### What to do
Extend runbook with recovery procedures for new incident types.

### How
1. Add sections for:
   - `partial_fill` - Verify unwind executed, check loss within budget
   - `unwind_failed` - CRITICAL - Manual intervention required
   - `book_stale` - Check venue connectivity, verify data feed
   - `ack_timeout` - Check venue latency, review SLO threshold
   - `circuit_breaker_tripped` - Review incident history, assess market health
   - `portfolio_drift` - Verify on-chain state, audit recent trades
2. Add decision trees for each incident type
3. Add escalation paths

### Files impacted
- `docs/Operations/runbook.md`

### End goal
Every incident type has documented recovery procedure.

### Acceptance criteria
- [ ] All new incident types documented
- [ ] Decision trees complete
- [ ] Escalation paths defined
- [ ] Reviewed by ops team

---

## Task 18 — End-to-End Integration Test

### Reasoning
Full system validation before production deployment.

### What to do
Create end-to-end test that exercises complete flow.

### How
1. Create `tests/e2e/near-zero-risk-flow.test.ts`:
   - Spin up test environment with mock venue
   - Inject opportunity with valid edge
   - Verify gates pass
   - Verify execution state transitions
   - Simulate partial fill
   - Verify unwind executes
   - Verify telemetry emitted
   - Verify incidents created
   - Verify SLO metrics calculated
2. Add test for circuit breaker isolation
3. Add test for startup recovery

### Files impacted
- `tests/e2e/near-zero-risk-flow.test.ts` (new file)
- `tests/e2e/fixtures/` (mock venue, test data)

### End goal
Complete flow validated in automated test.

### Acceptance criteria
- [ ] E2E test runs in CI
- [ ] All state transitions verified
- [ ] Partial fill + unwind tested
- [ ] Startup recovery tested
- [ ] Test completes in <30s

---

## File-by-File Implementation Sequence

To minimize merge conflicts and ensure dependencies are met:

| Order | File | Tasks |
|-------|------|-------|
| 1 | `src/config/policy.ts` | 1 |
| 2 | `src/config/risk.ts` | 2 |
| 3 | `src/telemetry/events.ts` | 3 |
| 4 | `src/domain/incident.ts` | 4 |
| 5 | `src/domain/gates.ts` | 5, 6 |
| 6 | `src/domain/executionState.ts` | 7 |
| 7 | `src/agents/risk/RiskAgent.ts` | 5, 6, 12 |
| 8 | `src/agents/execution/ExecutionAgent.ts` | 8, 9, 10 |
| 9 | `src/core/CircuitBreakerRegistry.ts` | 12 |
| 10 | `src/domain/sloChecks.ts` | 11 |
| 11 | `src/agents/portfolio/PortfolioAgent.ts` | 13 |
| 12 | `src/core/Supervisor.ts` | 14 |
| 13 | `src/core/EventStore.ts` | 14 |
| 14 | `src/api/server.ts` | 11, 12, 13 |
| 15 | `docs/Operations/runbook.md` | 17 |
| 16 | `dashboard/src/components/SloMetrics.tsx` | 16 |
| 17 | `tests/unit/*.test.ts` | 15 |
| 18 | `tests/integration/*.test.ts` | 15 |
| 19 | `tests/e2e/near-zero-risk-flow.test.ts` | 18 |

---

## Dependencies to Add

| Package | Version | Purpose |
|---------|---------|---------|
| None | - | All required packages already in Phase 1 |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-03 | Initial merged plan from v1, v2, and research report |

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
        ("min_edge", lambda: min_edge_gate(opp.edge, policy.min_edge_ticks)),
        ("depth_buffer", lambda: depth_buffer_gate(orderbook, opp.side, opp.size, policy.depth_buffer_multiplier)),
        ("unwind_budget", lambda: unwind_budget_gate(opp, risk_config)),
        ("position_limit", lambda: position_limit_gate(opp, risk_config)),
        ("exposure_limit", lambda: exposure_limit_gate(opp, risk_config)),
        ("correlation", lambda: correlation_gate(opp, pending_orders)),
    ]
    
    for name, gate_fn in gates:
        result = gate_fn()
        if not result.pass:
            emit_gate_rejection(name, result.reason)
            return GateResult(pass=False, blocked_by=name, reason=result.reason)
    
    return GateResult(pass=True)
```
