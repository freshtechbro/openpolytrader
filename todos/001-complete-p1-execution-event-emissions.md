---
status: complete
priority: p1
issue_id: "001"
tags: [execution, events, learning]
dependencies: []
---

# Emit execution outcome and fill events

## Problem Statement

ExecutionAgent completes trades but does not emit `execution:outcome` or `execution:fill`, so LearningAgent never receives execution outcomes/fill data.

## Findings

- `src/agents/learning/LearningAgent.ts` subscribes to `execution:outcome` and `execution:fill`.
- `rg "execution:outcome|execution:fill" src/agents/execution/ExecutionAgent.ts` returns no matches (no emits).
- `src/AGENTS.md` documents `fill:applied`, which is inconsistent with current subscriptions.

## Proposed Solutions

### Option 1: Emit events directly from ExecutionAgent (recommended)

**Approach:** Add MessageBus emits when execution completes and when fills are applied, align docs and event names.

**Pros:**
- Minimal change with clear ownership
- Restores learning feedback loop

**Cons:**
- Requires defining event payload shape

**Effort:** 2-4 hours

**Risk:** Medium (touches execution flow)

---

### Option 2: Route fills through PortfolioAgent and re-emit

**Approach:** Make ExecutionAgent emit to PortfolioAgent, which then emits fill events.

**Pros:**
- Clear separation of responsibilities

**Cons:**
- Larger refactor
- More moving parts

**Effort:** 6-10 hours

**Risk:** Medium

## Recommended Action

Triage after validation. Likely Option 1 with a small payload (orderId, size, price, marketId, timestamp) and doc alignment.

## Technical Details

**Affected files:**
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/learning/LearningAgent.ts`
- `src/AGENTS.md`
- `tests/unit/execution.test.ts`
- `tests/integration/event-store.test.ts`

## Acceptance Criteria

- [ ] ExecutionAgent emits `execution:outcome` and `execution:fill`
- [ ] LearningAgent receives and records both events
- [ ] Event names documented consistently
- [ ] Tests pass for execution flow

## Work Log

### 2026-01-13 - Validation

**By:** Codex

**Actions:**
- Confirmed LearningAgent subscriptions in `src/agents/learning/LearningAgent.ts`
- Verified no corresponding emits in `src/agents/execution/ExecutionAgent.ts`
- Noted doc mismatch (`fill:applied` vs `execution:fill`) in `src/AGENTS.md`

**Learnings:**
- Execution outcome events are required for learning feedback and auditability

---

### 2026-01-13 - Implementation

**By:** Codex

**Actions:**
- Emitted `execution:outcome` with marketId/opportunityId/status and timeout mapping in `src/agents/execution/ExecutionAgent.ts`
- Emitted `execution:fill` with slippage sample on trade updates in `src/agents/execution/ExecutionAgent.ts`
- Updated event naming in `src/AGENTS.md` to match `execution:fill`

**Learnings:**
- Centralized outcome emission covers all execution paths, including blocked and timeout cases

## Notes

- Event payload shape must be agreed before implementation
