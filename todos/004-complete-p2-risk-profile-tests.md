---
status: complete
priority: p2
issue_id: "004"
tags: [tests, api, dashboard]
dependencies: ["002"]
---

# Add tests for risk profile selection

## Problem Statement

There are no unit or E2E tests covering `/config/risk-profile` or the dashboard dropdown flow.

## Findings

- `rg "risk-profile" tests` returns no test coverage.
- Playwright is set up in `dashboard/tests/e2e` with a smoke spec only.

## Proposed Solutions

### Option 1: Add unit tests + Playwright spec (recommended)

**Approach:** Extend API unit tests and add a minimal UI spec for dropdown selection.

**Pros:**
- Covers both API and UI integration paths
- Minimal runtime overhead

**Cons:**
- Requires stable test fixtures or mocks

**Effort:** 3-6 hours

**Risk:** Low

---

### Option 2: Unit tests only

**Approach:** Cover API behavior and skip UI flow.

**Pros:**
- Lower effort

**Cons:**
- Does not validate dashboard wiring

**Effort:** 1-2 hours

**Risk:** Low

## Recommended Action

Option 1 with minimal Playwright test that asserts the request payload and UI state.

## Technical Details

**Affected files:**
- `tests/unit/api-config.test.ts`
- `dashboard/tests/e2e/risk-profile.spec.ts` (new file)
- `dashboard/scripts/e2e-smoke.mjs`

## Acceptance Criteria

- [ ] Unit tests cover apply + invalid profile cases
- [ ] E2E test covers dropdown selection
- [ ] Tests pass locally

## Work Log

### 2026-01-13 - Validation

**By:** Codex

**Actions:**
- Verified no existing tests for `/config/risk-profile`
- Confirmed Playwright setup exists for dashboard

**Learnings:**
- Test gap is currently unaddressed

---

### 2026-01-13 - Implementation

**By:** Codex

**Actions:**
- Added unit tests for `/config/risk-profile` in `tests/unit/api-config.test.ts`
- Added Playwright E2E risk profile spec and shared server helper in `dashboard/tests/e2e`
- Updated dashboard `test:e2e` script to run Playwright with ops base unset

**Learnings:**
- E2E tests require a local server to avoid absolute ops base URL failures

## Notes

- Coordinate with profile persistence work to validate `active.json`
