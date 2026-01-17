---
status: complete
priority: p1
issue_id: "002"
tags: [risk, config, persistence]
dependencies: []
---

# Persist active risk profile selection

## Problem Statement

Risk profile selection is in-memory only; restarting the process loses the chosen profile and reverts to defaults.

## Findings

- `src/config/riskProfile.ts` loads profile JSON files but does not persist active selection.
- `src/main.ts` applies profiles at runtime but does not write any active profile marker.
- No `settings/risk-gates/active.json` exists or is read on boot.

## Proposed Solutions

### Option 1: Write `settings/risk-gates/active.json` on apply (recommended)

**Approach:** Persist `{ id, source, updatedAt }` on apply; load on boot when env override is absent.

**Pros:**
- Simple, transparent behavior
- Works without env changes or restarts

**Cons:**
- Requires file IO and schema validation

**Effort:** 2-4 hours

**Risk:** Low

---

### Option 2: Only persist in env and require restart

**Approach:** Update env and require process restart to pick up profile.

**Pros:**
- No disk writes

**Cons:**
- Operationally slower
- Higher chance of misconfiguration

**Effort:** 3-5 hours

**Risk:** Medium

## Recommended Action

Option 1, with precedence: `RISK_PROFILE` env > `active.json` > default `near_zero`.

## Technical Details

**Affected files:**
- `src/config/riskProfile.ts`
- `src/main.ts`
- `settings/risk-gates/active.json` (new file)
- `tests/unit/api-config.test.ts`

## Acceptance Criteria

- [ ] Applying a profile writes `settings/risk-gates/active.json`
- [ ] Boot loads `active.json` when no env override is set
- [ ] `/config` shows the active profile + source

## Work Log

### 2026-01-13 - Validation

**By:** Codex

**Actions:**
- Reviewed `src/config/riskProfile.ts` (load-only)
- Confirmed no persistence handling in `src/main.ts`

**Learnings:**
- Persistence required to keep profile across restarts

---

### 2026-01-13 - Implementation

**By:** Codex

**Actions:**
- Added active profile load/persist helpers in `src/config/riskProfile.ts`
- Wired boot to load `settings/risk-gates/active.json` with env precedence in `src/main.ts`
- Persisted active selection on apply in `src/main.ts`

**Learnings:**
- Using env overrides avoids unexpected persisted selections

## Notes

- Validate `active.json` schema to avoid corrupt selections
