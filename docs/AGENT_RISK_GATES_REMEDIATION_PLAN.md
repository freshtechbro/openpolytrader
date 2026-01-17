# Risk Profiles & Agent Wiring Remediation Plan

Plan to validate audit findings, close risk-profile gaps, and verify agent wiring/decision flow.

---

## Overview

### Scope
- Validate audit findings against code and document evidence.
- Persist active risk profile selection and load on boot.
- Reschedule book/catalog refresh intervals when profiles change.
- Close event-wiring gaps (execution outcomes + fills).
- Add targeted API + dashboard E2E tests for risk profile selection.
- Identify LLM advisory gaps and propose fixes.

### Key decisions
- Persist profile selection to `settings/risk-gates/active.json` on apply; load on boot if env does not override.
- Recompute book freshness and refresh intervals when profile changes.
- Emit `execution:outcome` and `execution:fill` from ExecutionAgent; align docs/subscriptions.

---

## Task 1 — Validate audit findings and document evidence

### Reasoning
Fixes must target verified gaps; documented evidence prevents regressions and aligns stakeholders.

### What to do
Cross-check audit claims in code and record confirmed issues with file/line references.

### How
1. Re-read `docs/Audits/AGENT_RISK_GATES_AUDIT_2026-01-13.md` and list each claimed gap.
2. Use `rg` to confirm event emissions, subscriptions, and config wiring.
3. Verify risk profile persistence does not exist and identify the load/apply paths.
4. Confirm refresh scheduling is static and not recalculated on profile change.
5. Append a short "Validation" section to the audit report or create a small validation note in `docs/`.

### Files impacted
- `docs/Audits/AGENT_RISK_GATES_AUDIT_2026-01-13.md`
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/learning/LearningAgent.ts`
- `src/main.ts`
- `src/core/Supervisor.ts`
- `src/services/MarketCatalogRefresher.ts`

### End goal
A consolidated, evidence-backed list of confirmed issues.

### Acceptance criteria
- [ ] Each audit claim is marked confirmed or refuted with file references
- [ ] Validation notes are recorded in docs
- [ ] Confirmed issue list aligns with todos

---

## Task 2 — Persist active risk profile selection

### Reasoning
Risk profile selection must survive restarts to ensure consistent trade behavior.

### What to do
Write active selection to disk on apply and load it on boot when env does not override.

### How
1. Add read/write helpers for `settings/risk-gates/active.json` in `src/config/riskProfile.ts`.
2. Define precedence: `RISK_PROFILE` env > `active.json` > default `near_zero`.
3. Update `applyRiskProfile` to persist `active.json` and include source metadata.
4. Load the persisted profile during boot (before config store initialization).
5. Add a small schema check for the active profile file (id + optional path).

### Files impacted
- `src/config/riskProfile.ts`
- `src/main.ts`
- `settings/risk-gates/active.json` (new file)
- `tests/unit/api-config.test.ts`

### End goal
Profile selection persists across restarts and is visible in `/config`.

### Acceptance criteria
- [ ] Applying a profile writes `settings/risk-gates/active.json`
- [ ] Boot uses `active.json` when env override is not set
- [ ] `/config` reports the correct active profile and source

---

## Task 3 — Reschedule book/catalog refresh and book freshness checks on profile change

### Reasoning
Staleness thresholds and refresh cadence must follow the active risk profile.

### What to do
Ensure book refresh, catalog refresh, and SLO checks rebind to updated thresholds when profiles change.

### How
1. Add a Supervisor method to update `bookRefresh` interval and restart the timer.
2. Add `updateConfig` to `MarketCatalogRefresher` to restart with a new `refreshIntervalMs`.
3. Refactor `createBookFreshnessCheck` to read `maxBookStalenessMs` and `bookIdleCutoffMs` from current config on each check.
4. Call these updates from the risk profile apply path.

### Files impacted
- `src/core/Supervisor.ts`
- `src/services/MarketCatalogRefresher.ts`
- `src/main.ts`
- `src/agents/ops/sloChecks.ts`

### End goal
Refresh cadence and freshness checks reflect the current profile without restart.

### Acceptance criteria
- [ ] Changing profile updates book refresh interval immediately
- [ ] Catalog refresh interval updates without restarting the process
- [ ] Book freshness SLO uses current staleness thresholds

---

## Task 4 — Emit execution outcome and fill events

### Reasoning
Learning and audit pipelines rely on execution outcomes and fills to close feedback loops.

### What to do
Emit `execution:outcome` and `execution:fill` from ExecutionAgent and align docs.

### How
1. Add MessageBus emits when execution completes with outcome data.
2. Emit `execution:fill` when applying a fill to portfolio reconciliation.
3. Update any docs or expectations that reference `execution:fill` to match actual event names.
4. Add or update tests for event emission paths.

### Files impacted
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/learning/LearningAgent.ts`
- `src/AGENTS.md`
- `tests/unit/execution.test.ts`
- `tests/integration/event-store.test.ts`

### End goal
Execution outcomes and fill events are captured by learning and metrics pipelines.

### Acceptance criteria
- [ ] LearningAgent receives both `execution:outcome` and `execution:fill`
- [ ] Event store contains execution outcome events
- [ ] No regression in execution state machine tests

---

## Task 5 — Add API + dashboard tests for risk profile selection

### Reasoning
Risk profile updates are operationally critical and must be tested at API and UI layers.

### What to do
Add unit tests for `/config/risk-profile` and a small dashboard e2e spec for the dropdown flow.

### How
1. Extend `tests/unit/api-config.test.ts` to cover apply and error cases.
2. Add a persistence test to assert `active.json` is written.
3. Add a Playwright spec in `dashboard/tests/e2e/` that selects a profile and asserts the request payload.

### Files impacted
- `tests/unit/api-config.test.ts`
- `dashboard/tests/e2e/risk-profile.spec.ts` (new file)
- `dashboard/scripts/e2e-smoke.mjs`

### End goal
API and UI flows for risk profile selection are covered by tests.

### Acceptance criteria
- [ ] Unit tests cover apply + invalid profile cases
- [ ] E2E test confirms dropdown selection triggers apply call
- [ ] Tests pass locally

---

## Task 6 — Identify LLM advisory gaps and propose fixes

### Reasoning
LLM recommendations should influence trade decisions where intended; advisory-only gaps must be explicit.

### What to do
Audit LLM advisory paths and decide which outputs should be applied vs logged.

### How
1. Trace ExecutionAdvisor and MarketData outlier usage.
2. Document current behavior vs expected impact.
3. Propose minimal changes (or keep advisory-only with justification).

### Files impacted
- `src/agents/execution/ExecutionAdvisor.ts`
- `src/agents/execution/ExecutionAgent.ts`
- `src/agents/market-data/MarketDataAgent.ts`
- `src/core/Supervisor.ts`

### End goal
Clear understanding of LLM advisory gaps with agreed fixes or acceptance.

### Acceptance criteria
- [ ] Gaps documented with evidence
- [ ] Fix plan or explicit acceptance recorded

---

## File-by-file implementation sequence

1. `docs/Audits/AGENT_RISK_GATES_AUDIT_2026-01-13.md` — Task 1
2. `src/config/riskProfile.ts` — Task 2
3. `src/main.ts` — Tasks 2, 3
4. `src/core/Supervisor.ts` — Task 3
5. `src/services/MarketCatalogRefresher.ts` — Task 3
6. `src/agents/execution/ExecutionAgent.ts` — Task 4
7. `src/agents/learning/LearningAgent.ts` — Task 4
8. `tests/unit/api-config.test.ts` — Task 5
9. `dashboard/tests/e2e/risk-profile.spec.ts` — Task 5

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| (none) | - | - |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-13 | Initial plan |
