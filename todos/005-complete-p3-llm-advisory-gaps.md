---
status: complete
priority: p3
issue_id: "005"
tags: [llm, advisory, market-data]
dependencies: []
---

# Identify and address LLM advisory gaps

## Problem Statement

Some LLM outputs are recorded but not applied, reducing their impact on trading decisions.

## Findings

- ExecutionAdvisor provides `unwindHint`, but ExecutionAgent only applies timeout multipliers.
- MarketDataAgent emits `marketdata:outlier`, but no subscribers are registered.

## Proposed Solutions

### Option 1: Apply advisory outputs where safe (recommended)

**Approach:** Decide which hints should influence execution/unwind logic and add a consumer for outliers (e.g., OpsAgent or Supervisor).

**Pros:**
- Leverages existing LLM insights
- Makes advisory signals actionable

**Cons:**
- Requires careful guardrails

**Effort:** 4-8 hours

**Risk:** Medium

---

### Option 2: Keep advisory-only, document explicitly

**Approach:** Leave outputs as telemetry-only and document rationale.

**Pros:**
- Lower risk
- No behavior change

**Cons:**
- LLM outputs provide limited operational value

**Effort:** 1-2 hours

**Risk:** Low

## Recommended Action

Decide per-signal with explicit acceptance: apply or keep advisory-only with documentation.

## Technical Details

**Affected files:**
- `src/agents/execution/ExecutionAdvisor.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/market-data/MarketDataAgent.ts`
- `src/core/Supervisor.ts`

## Acceptance Criteria

- [ ] Advisory gaps are documented with a chosen approach
- [ ] Applied hints have guardrails and tests
- [ ] Telemetry-only hints are explicitly documented

## Work Log

### 2026-01-13 - Validation

**By:** Codex

**Actions:**
- Confirmed ExecutionAgent records `unwindHint` but does not apply it
- Found no subscribers to `marketdata:outlier`

**Learnings:**
- Advisory outputs exist but are not currently used in decision flow

---

### 2026-01-13 - Implementation

**By:** Codex

**Actions:**
- Added `marketdata:outlier` capture to OpsAgent metrics as info events (`src/agents/ops/OpsAgent.ts`)
- Kept ExecutionAdvisor `unwindHint` advisory-only; documented in audit validation and todo notes

**Learnings:**
- Outlier events are now visible without changing trading behavior

## Notes

- May require stakeholder approval before applying hints to live trading
