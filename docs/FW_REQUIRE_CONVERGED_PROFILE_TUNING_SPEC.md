# FW Require Converged Profile Tuning Spec

Add a profile-tunable FW convergence policy field so non-converged iterate acceptance is explicit, consistent, and test-covered across projection emission, downstream gating, and risk-profile application.

---

## Overview

### Scope
- Add a boolean `fwRequireConverged` policy field that can be edited live and stored in risk-profile presets.
- Enforce the field consistently for both `fw_projection` and `fw_basket` paths.
- Keep profile application deterministic despite sparse preset overlays.
- Update telemetry, tests, and docs so runtime behavior and operator guidance match.

### Current runtime gaps
- `FwProjectionAgent` currently accepts a non-converged iterate when `canProceedWithApproximateLoopIterate(loop)` is true.
- `evaluateFwProjectionGates` allows `solverStatus='feasible'`, which means downstream re-gating still tolerates non-converged FW opportunities.
- Basket filtering and basket re-gating do not thread convergence state explicitly; one path synthesizes `solverStatus='feasible'`, another synthesizes `solverStatus='optimal'`.
- Risk profiles are sparse overlays, so omitting a new field from any preset can silently inherit stale runtime state.
- Several docs already claim non-converged FW outputs are rejected, but current runtime is looser than that wording.

### Key decisions
- Use `fwRequireConverged`, not a generic `requireConverged`.
  Rationale: keeps the knob namespaced to FW behavior and avoids collisions with future non-FW solvers.
- Set `DEFAULT_TRADE_POLICY.fwRequireConverged = true`.
  Rationale: safer boot-time fallback when defaults or persisted startup sources do not yet carry the field.
- Set the field explicitly in every preset.
  Recommended preset values: `near_zero=true`, `moderate=true`, `high=true`, `extra_high=false`.
- Use existing loop diagnostics as the convergence source of truth.
  Rationale: `FwProjectionMetadata.loop` and `FwBasketMetadata.loop` already carry `converged`, so no new duplicate state is needed if all gate paths receive that data.
- Emit explicit rejection reasons for the policy.
  Recommended runtime reason names: `projection_requires_converged` for pre-emission rejection, `fw_requires_converged` for single-market gate rejection, and `fw_basket_requires_converged` for whole-basket rejection.
  Rationale: current basket paths have one shared FW loop per basket, not independent per-market loop diagnostics, so convergence should stay a basket-level rejection until the architecture carries distinct leg-level loop truth.
- Do not edit `settings/risk-gates/active.json` as part of the implementation.
  Rationale: preset definition and active-profile selection are separate concerns; activation should continue to flow through normal runtime profile application.
- Treat `src/api/contracts.ts`, `src/config/schemaTypes.ts`, and most dashboard risk-gates components as generic consumers unless implementation proves otherwise.
  Rationale: the config snapshot and schema contracts are already record-driven, so unnecessary edits here would widen the change set without adding behavior.

---

## Task 1 — Add the policy field to runtime config

### Reasoning
The new switch cannot be profile-tunable until it exists in `TradePolicy`, the default policy, and the runtime-editable schema.

### What to do
Add `fwRequireConverged` to the policy model, defaults, and schema surface.

### How
1. Add `fwRequireConverged: boolean` to `TradePolicy` in `src/config/policy.ts`.
2. Add `fwRequireConverged: true` to `DEFAULT_TRADE_POLICY`.
3. Add a schema field in `src/config/schema.ts` with label `FW Require Converged` and a short description that explains it rejects non-converged FW iterates and baskets.
4. Bump `CONFIG_SCHEMA.version` because the runtime-editable contract changed.
5. Keep `validateP0Config` minimal for this field.
   No inter-field numeric constraint is required because it is a standalone boolean, and the existing schema-backed `assertSectionValues` path should already enforce the field type.
6. Do not pre-emptively edit `src/api/contracts.ts` or `src/config/schemaTypes.ts`.
   The existing `OpsConfigSnapshot` and `ConfigSchema` shapes are already generic enough to carry the new field once the schema is updated.

### Files impacted
- `src/config/policy.ts`
- `src/config/schema.ts`
- `src/config/validate.ts` (only if implementation adds a non-schema rule beyond the existing `assertSectionValues` path)

### End goal
`fwRequireConverged` is a first-class runtime policy field visible anywhere the policy schema is consumed.

### Acceptance criteria
- [ ] `TradePolicy` and `DEFAULT_TRADE_POLICY` include `fwRequireConverged`.
- [ ] `/config/schema` includes the new boolean field.
- [ ] Config validation still passes for default policy/risk snapshots.

---

## Task 2 — Make the field deterministic across profile application

### Reasoning
Risk profiles are sparse overlays. If the new field is absent from any preset, applying that preset can preserve an older runtime value and produce surprising behavior.

### What to do
Add `fwRequireConverged` explicitly to every risk-profile JSON and validate that profile application preserves the intended preset semantics.

### How
1. Update all preset files under `settings/risk-gates/` to include `policy.fwRequireConverged`.
2. Keep stricter presets explicit with `true`.
3. Keep `extra_high` explicit with `false` if the intent is to preserve a permissive exploratory profile.
4. Confirm no loader changes are required in `src/config/riskProfile.ts`; it already supports arbitrary `Partial<TradePolicy>` fields.
5. Confirm no runtime profile-apply code changes are required in `src/boot/runtimeCatalog.ts` beyond the new field being present in the loaded overlay.
6. Do not edit `settings/risk-gates/active.json`; profile activation should remain an operator action.
7. Add tests that load/apply presets and assert the resulting policy value.

### Files impacted
- `settings/risk-gates/near_zero.json`
- `settings/risk-gates/moderate.json`
- `settings/risk-gates/high.json`
- `settings/risk-gates/extra_high.json`
- `tests/unit/config.test.ts`
- `tests/unit/runtime-catalog-direct.test.ts`

### End goal
Applying any preset deterministically sets the FW convergence policy instead of inheriting prior runtime state.

### Acceptance criteria
- [ ] Every preset includes `fwRequireConverged`.
- [ ] Applying `high` yields `fwRequireConverged=true`.
- [ ] Applying `extra_high` yields the explicitly chosen permissive value.

---

## Task 3 — Enforce the policy at FW projection emission

### Reasoning
Current runtime first decides whether a non-converged loop can proceed in `FwProjectionAgent`. That is the earliest and most direct acceptance point.

### What to do
Gate non-converged iterate acceptance in `FwProjectionAgent` using `fwRequireConverged`.

### How
1. Replace the current unconditional approximate-iterate acceptance check with a policy-aware decision.
2. Recommended shape:
   - If `loop.diagnostics.converged` is `true`, proceed.
   - If `loop.diagnostics.converged` is `false` and `policy.fwRequireConverged` is `true`, reject with `projection_requires_converged`.
   - If `loop.diagnostics.converged` is `false` and `policy.fwRequireConverged` is `false`, keep the existing `canProceedWithApproximateLoopIterate(loop)` fallback.
3. Keep `mapNonConvergedReason` for the permissive branch so permissive profiles still distinguish runtime-budget, max-iteration, and generic non-convergence failures.
4. Record explicit telemetry for the strict rejection path.
   Recommended event payload: `event: 'projection_rejected'`, `marketId`, `reason: 'projection_requires_converged'`, plus `loopId`, `terminalReason`, `runtimeMs`, and `iterationCount`.
5. Preserve the existing `non_converged_iterate_accepted` telemetry for permissive profiles only.

### Files impacted
- `src/agents/projection/FwProjectionAgent.ts`
- `src/agents/projection/FwProjectionLoopSupport.ts` (optional only if shared helper extraction is needed)
- `tests/unit/fw-projection-agent.test.ts`
- `tests/unit/fw-projection-support-direct.test.ts` (optional if helper behavior changes)

### End goal
Projection emission obeys the new profile switch and no longer accepts non-converged output when the profile forbids it.

### Acceptance criteria
- [ ] Strict profiles reject non-converged loops even when the iterate has positive weights.
- [ ] Permissive profiles keep current approximate-iterate behavior.
- [ ] Telemetry distinguishes strict rejection from permissive acceptance.

---

## Task 4 — Close the downstream gate leaks for FW projection and FW basket

### Reasoning
Emission-only enforcement is not sufficient. Downstream re-gating currently tolerates non-converged state through `solverStatus='feasible'`, and basket paths do not consistently carry loop convergence into gates.

### What to do
Make downstream FW gates convergence-aware and thread loop diagnostics through every path that can re-evaluate FW opportunities.

### How
1. Update `evaluateFwProjectionGates` in `src/domain/gates.ts`:
   - Read convergence from `inputs.projection.loop?.converged`.
   - If `policy.fwRequireConverged` is `true` and `projection.loop?.converged !== true`, add `fw_requires_converged`.
   - Keep the existing `solverStatus` checks for infeasible/timeout/error cases.
   - Treat missing loop diagnostics as a strict-profile failure, so every `evaluateFwProjectionGates` call site must be updated in the same change set.
2. Update basket candidate filtering in `src/agents/projection/FwProjectionUniverseSupport.ts`:
   - Thread the shared FW loop diagnostics through `FwProjectionAgent.filterBasketCandidates(...)` and its inner `filterExecutableBasketCandidates(...)` call.
   - Pass the same loop diagnostics object used by `buildBasketOpportunity` into the synthetic projection metadata used by `evaluateFwProjectionGates`.
   - Stop hardcoding `solverStatus='feasible'` without the corresponding loop state.
3. Update basket re-gating:
   - Extend `FwBasketGateInputs` so `evaluateFwBasketGates` receives the full basket `FwLoopDiagnostics`.
   - If `policy.fwRequireConverged` is `true` and the basket loop is not converged, reject before per-market evaluation with `fw_basket_requires_converged`.
   - When `evaluateFwBasketGates` synthesizes per-market `FwProjectionMetadata`, attach that same shared basket loop diagnostics so downstream single-market gate logic reads the same truth source.
   - Keep per-market prefixed reasons for per-market gate failures such as missing books or depth, but do not invent per-market convergence reasons unless the runtime later carries distinct leg-level loop diagnostics.
4. Update `Supervisor` call sites to pass the basket loop data into `evaluateFwBasketGates`.
5. Do not add new fields to `src/domain/opportunity.ts` unless implementation proves the existing `fw.loop` and `fwBasket.loop` diagnostics are insufficient.
6. Keep the reason naming consistent across single-market and basket paths so ops/runbooks remain readable.

### Files impacted
- `src/domain/gates.ts`
- `src/agents/projection/FwProjectionAgent.ts`
- `src/agents/projection/FwProjectionUniverseSupport.ts`
- `src/core/Supervisor.ts`
- `tests/unit/gates.test.ts`
- `tests/unit/supervisor-reconciliation.test.ts`
- `tests/unit/fw-projection-agent.test.ts`
- `tests/unit/fw-projection-support-direct.test.ts`

### End goal
No FW path can bypass the convergence requirement once a strict profile enables it.

### Acceptance criteria
- [ ] `fw_projection` re-gating fails when `fwRequireConverged=true` and loop convergence is false.
- [ ] `fw_basket` re-gating fails when `fwRequireConverged=true` and basket loop convergence is false.
- [ ] Every strict-mode `evaluateFwProjectionGates` call site provides loop diagnostics instead of relying on synthetic solver status alone.
- [ ] Basket candidate pre-filtering and final basket gating use the same convergence truth source.

---

## Task 5 — Update API, dashboard expectations, and operator docs

### Reasoning
The field is runtime-editable, so the API schema, dashboard view, and documentation must all align. The dashboard is schema-driven, but the operator-facing meaning still needs explicit wording.

### What to do
Document the new field, keep the API and dashboard surfaces aligned, and correct the current stale claims about FW non-converged rejection.

### How
1. Confirm the dashboard needs no bespoke form code beyond the schema update.
   The risk-gates page renders fields from `/config/schema`, but it seeds draft values from `/config`.
2. Explicitly verify the API surface stays aligned:
   - `GET /config/schema` exposes the editable boolean field.
   - `GET /config` exposes the current `policy.fwRequireConverged` value used to seed the dashboard draft.
   - `PATCH /config/policy` can round-trip the boolean without any contract-specific changes.
3. Add or refine field description text so the UI explains the operational effect clearly.
4. Update operator docs to describe the actual behavior:
   - Strict profiles reject non-converged FW iterates and baskets.
   - Permissive profiles may still allow approximate iterates if positive weights exist.
5. Correct stale wording that currently says all non-converged FW outputs are rejected unconditionally, and align runbook reason names with the actual `mapNonConvergedReason` outputs plus the new convergence-specific reasons.
6. Touch dashboard risk-gates components only if copy changes are actually needed.
   The schema-driven form should render the new field without structural component work.
7. Update any profile guidance docs that describe preset intent so `extra_high` permissiveness versus `high` strictness is explicit.

### Files impacted
- `src/config/schema.ts`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/Operations/runbook.md`
- `docs/Operations/config-knobs.md`
- `agents.md`
- `dashboard/src/pages/risk-gates/RiskConfigSettingsSection.tsx` (optional copy only)
- `dashboard/src/pages/risk-gates/RiskProfilePanels.tsx` (optional copy only)

### End goal
Operators and future agents see the same convergence behavior in the API, UI, docs, and runtime.

### Acceptance criteria
- [ ] `GET /config` and `GET /config/schema` both surface `fwRequireConverged`.
- [ ] The dashboard can render and save `fwRequireConverged` without bespoke form code.
- [ ] FW strategy docs no longer overstate rejection behavior.
- [ ] Profile guidance explains the intended strict/permissive split.

---

## Task 6 — Add regression coverage for config, gates, and profile application

### Reasoning
This change cuts across configuration, projection emission, and gate re-evaluation. Without targeted tests, it is easy to re-open the acceptance leak later.

### What to do
Add focused regression tests that prove the switch works across strict and permissive profiles.

### How
1. Add config tests for schema exposure, default value, and profile overlay behavior.
2. Add projection-agent tests for:
   - strict rejection of non-converged positive iterates
   - permissive acceptance of the same iterate
3. Add gate tests for:
   - strict rejection when `projection.loop?.converged=false`
   - strict basket rejection when `fwBasket.loop.converged=false`
4. Add API/config tests for the exact round trip the dashboard depends on:
   - `GET /config/schema` exposes `fwRequireConverged`
   - `GET /config` exposes `policy.fwRequireConverged`
   - `PATCH /config/policy` accepts and returns the boolean
5. Add dashboard unit coverage in both schema and controller layers:
   - Use `tests/unit/dashboard-risk-sections.test.ts` for rendered field coverage.
   - Use `tests/unit/dashboard-controller-direct.test.ts` to assert the `/config` snapshot seeds the draft and the save handler can emit `fwRequireConverged` in the policy PATCH body.
6. Add or extend Playwright coverage in `dashboard/tests/e2e/risk-profile.spec.ts` only as a preset-application guard.
   Do not rely on that spec as the sole proof of direct field rendering or save wiring.

### Files impacted
- `tests/unit/config.test.ts`
- `tests/unit/api-config.test.ts`
- `tests/unit/fw-projection-agent.test.ts`
- `tests/unit/fw-projection-support-direct.test.ts` (optional if helper behavior changes)
- `tests/unit/gates.test.ts`
- `tests/unit/dashboard-risk-sections.test.ts`
- `tests/unit/dashboard-controller-direct.test.ts`
- `dashboard/tests/e2e/risk-profile.spec.ts` (optional end-to-end guard)

### End goal
The new switch is protected by fast tests at every layer that can regress it.

### Acceptance criteria
- [ ] Strict and permissive profile cases are both covered.
- [ ] Schema, `/config`, `/config/policy`, controller wiring, and runtime gate behavior all have direct assertions.
- [ ] Coverage remains above the repo threshold after the change.

---

## File-by-file implementation sequence

1. `src/config/policy.ts` — add `fwRequireConverged` to the policy contract and defaults.
2. `src/config/schema.ts` — expose the field in the runtime-editable schema.
   `src/config/validate.ts` only changes if the implementation adds a new non-schema validation rule.
3. `settings/risk-gates/*.json` — set explicit preset values to avoid sparse-overlay leakage.
4. `src/agents/projection/FwProjectionAgent.ts` — enforce strict rejection at emission.
   `src/agents/projection/FwProjectionLoopSupport.ts` only changes if the implementation intentionally extracts shared helper logic.
5. `src/agents/projection/FwProjectionAgent.ts`, `src/agents/projection/FwProjectionUniverseSupport.ts`, `src/domain/gates.ts`, and `src/core/Supervisor.ts` — close downstream projection and basket leaks.
6. `tests/unit/*.test.ts` — add regression coverage for config, API, gates, and projection behavior.
7. `README.md`, `docs/ARCHITECTURE.md`, `docs/Operations/*.md`, `agents.md` — align operator docs and repo guidance with runtime.

## Files with no direct change expected

- `src/api/contracts.ts` — config payloads are already record-based.
- `src/config/schemaTypes.ts` — the schema type system already supports new boolean fields.
- `src/config/validate.ts` — schema-backed validation should already enforce the new boolean type unless implementation adds a new non-schema rule.
- `src/config/riskProfile.ts` — profile loading already treats preset payloads as generic `Partial<TradePolicy>` overlays.
- `src/boot/runtimeCatalog.ts` — profile application already merges loaded policy overlays generically.
- `src/domain/opportunity.ts` — existing FW loop diagnostics should be reused unless implementation proves they are insufficient.
- `settings/risk-gates/active.json` — active profile state should remain operator-controlled.

---

## Dependencies to add

No new dependencies are required.

### Task dependency mapping
- Task 1 unlocks Tasks 2, 5, and 6 because the field must exist before presets, docs, and tests can reference it.
- Task 2 must land before Task 6 profile-application assertions are stable.
- Task 3 and Task 4 should be implemented together in the same change set to avoid partial enforcement.
- Task 5 should be finalized after Tasks 3 and 4 so docs reflect the actual rejection reasons and flows.
- Task 6 closes the loop and should run after all runtime changes are in place.

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-11 | Initial spec covering config, profile overlays, projection/gate enforcement, telemetry, docs, and regression coverage |
| 1.1 | 2026-03-11 | Audit pass resolved reason-name ambiguity, clarified optional versus mandatory files, and added missing dashboard regression targets |
| 1.2 | 2026-03-11 | Second-pass audit corrected boot-versus-live default semantics, added the missing `FwProjectionAgent` basket-loop threading touchpoint, and removed unsupported per-market convergence reasons for baskets |
| 1.3 | 2026-03-11 | Third-pass audit narrowed helper and controller files from mandatory edits to optional touchpoints where the current design does not require direct changes |
| 1.4 | 2026-03-11 | Fourth-pass audit moved generic overlay/validation files to verify-only status and redirected basket-loop regression coverage to the actual projection and support layers |
| 1.5 | 2026-03-11 | Fifth-pass audit tightened `/config` plus dashboard-controller proof requirements and limited Playwright coverage to preset-application scope |
