---
status: complete
priority: p2
issue_id: "003"
tags: [risk, scheduling, market-data]
dependencies: ["002"]
---

# Reschedule book/catalog refresh on profile change

## Problem Statement

Book refresh interval, catalog refresh interval, and book freshness SLO checks are derived once at boot and do not update when a new risk profile is applied.

## Findings

- `src/main.ts` computes `bookRefreshIntervalMs`, `bookIdleCutoffMs`, `catalogRefreshMs` once at startup.
- `syncRuntimeConfig()` does not recompute these intervals.
- `src/core/Supervisor.ts` only sets book refresh timer in `start()`.
- `src/services/MarketCatalogRefresher.ts` has `start()`/`stop()` but no update method.

## Proposed Solutions

### Option 1: Add update methods and restart timers on profile apply (recommended)

**Approach:** Add `Supervisor.updateBookRefresh()` and `MarketCatalogRefresher.updateConfig()`; recompute values and restart intervals when profile changes.

**Pros:**
- Keeps runtime behavior aligned with selected risk profile
- Minimal surface-area change

**Cons:**
- Requires careful timer teardown/restart

**Effort:** 3-5 hours

**Risk:** Medium

---

### Option 2: Require restart to apply scheduling changes

**Approach:** Document that profile change requires restart to refresh scheduling.

**Pros:**
- Lower code changes

**Cons:**
- Operationally brittle
- Conflicts with profile switching UX

**Effort:** 1-2 hours

**Risk:** Medium

## Recommended Action

Option 1 with explicit reschedule logic on profile apply.

## Technical Details

**Affected files:**
- `src/main.ts`
- `src/core/Supervisor.ts`
- `src/services/MarketCatalogRefresher.ts`
- `src/agents/ops/sloChecks.ts`

## Acceptance Criteria

- [ ] Book refresh timer updates on profile switch
- [ ] Catalog refresh timer updates on profile switch
- [ ] Book freshness SLO uses current staleness thresholds

## Work Log

### 2026-01-13 - Validation

**By:** Codex

**Actions:**
- Confirmed intervals are derived in `src/main.ts` once at boot
- Verified Supervisor sets book refresh in `start()` only
- Verified MarketCatalogRefresher lacks update method

**Learnings:**
- Profile changes do not propagate to refresh intervals without new code

---

### 2026-01-13 - Implementation

**By:** Codex

**Actions:**
- Added `Supervisor.updateBookRefresh` and reusable scheduling in `src/core/Supervisor.ts`
- Added `MarketCatalogRefresher.updateConfig` to restart refresh interval
- Recomputed refresh settings on config updates in `src/main.ts`
- Made book freshness SLO derive staleness settings per check

**Learnings:**
- Rescheduling required in both supervisor and catalog refresher to keep intervals aligned

## Notes

- Dependent on profile persistence (002) for full end-to-end behavior
