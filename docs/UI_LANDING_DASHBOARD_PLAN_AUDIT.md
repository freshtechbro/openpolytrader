# UI Landing + Dashboard Plan Audit (Design-Agent)

**Date:** 2026-02-16  
**Audited plan:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md`  
**Method:** design-agent criteria + repository feasibility cross-check  
**Audit mode:** findings-first, severity-ranked

---

## Overall Assessment

The plan is structurally strong and mostly implementable. The original critical blocker (token handling) is now resolved at plan level, with medium-risk gaps still to address during execution prep.

Status: **Execution-ready for Task 1 after plan patch, with medium findings tracked**.

### Decision update (2026-02-16)

- Selected remediation: **runtime token acquisition with server-side session/proxy** for `/ops/*`.
- Plan implication: High finding #1 is now resolved at plan level, pending implementation.

---

## Findings

## High Severity

### 1) Public-token leakage risk in single-bundle route strategy

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:5`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:33`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:37`
- **Repo evidence:** `dashboard/src/lib/dashboardConfig.ts:16`, `dashboard/src/lib/opsClient.ts:4`, `dashboard/src/lib/opsClient.ts:6`
- **Issue:** The plan assumes route-level separation is enough for security, but current ops token usage is build-time env replacement. In a single bundle, `VITE_OPS_API_TOKEN` can be embedded in shipped JS and exposed to public landing traffic.
- **Impact:** Auth token exposure, unauthorized ops API/SSE access risk, and compromised control-plane boundary.
- **Selected fix (locked):** Runtime token acquisition with server-side session/proxy. Remove build-time ops token embedding and authenticate `/ops/*` at runtime.

---

## Medium Severity

### 2) Ops fetch/SSE side effects are not explicitly scoped to `/ops/*`

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:53`
- **Repo evidence:** `dashboard/src/App.tsx:101`, `dashboard/src/App.tsx:184`, `dashboard/src/App.tsx:227`
- **Issue:** Existing app behavior initializes event stream and ops fetches at app mount. If routing is introduced without explicit containment, landing routes may still trigger ops polling/SSE.
- **Impact:** Unnecessary backend load, noisy errors for unauthenticated visitors, possible token/endpoint behavior leakage.
- **Fix:** Add explicit acceptance criterion in Task 1/5:
  - landing routes do not instantiate `useEventStream` or call `opsFetch*`;
  - ops data providers mount only under `/ops/*`.

### 3) Accessibility requirements are present but under-specified for verification

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:84`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:227`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:240`
- **Issue:** Focus/motion concerns are captured, but no concrete measurable checks are defined (focus order, skip links, keyboard trap checks, reduced-motion behavior per route).
- **Impact:** A11y regressions can pass implementation and only surface late.
- **Fix:** Expand Task 2/7 acceptance criteria:
  - include skip-link requirement for both public and ops shells;
  - keyboard-only navigation success criteria for nav rail, filters, tables, inspector;
  - reduced-motion verification on all animated surfaces.

### 4) Responsive behavior is not defined with breakpoint-level contracts

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:100`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:164`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:211`
- **Issue:** Plan asks for responsive behavior but lacks explicit breakpoint behavior for nav conversion, table fallback, and page section collapse.
- **Impact:** Visual consistency and operability can drift across pages.
- **Fix:** Add a responsive matrix section to plan:
  - navigation behavior at mobile/tablet/desktop,
  - table fallback strategy per page,
  - public hero/grid collapse rules.

### 5) QA scope misses rollout safety and rollback mechanics

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:246`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:273`
- **Issue:** QA includes tests/docs/gates but no explicit staged rollout, feature switch, or rollback procedure.
- **Impact:** Recovery path is undefined if routing/layout rollout causes production regressions.
- **Fix:** Add rollout controls:
  - feature flag or deploy gating;
  - rollback checklist;
  - monitoring checkpoints during rollout window.

### 6) Documentation update list is incomplete for routing/API surface change

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:264`
- **Issue:** Plan updates README/setup/runbook but omits docs that users/operators rely on for route and control-plane semantics.
- **Impact:** Documentation drift post-release.
- **Fix:** Include at minimum:
  - `docs/API.md`
  - `docs/Operations/config-knobs.md`
  - any route references in architecture/setup docs.

---

## Low Severity

### 7) DRY component contract is implied, not explicit

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:68`, `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:131`
- **Issue:** Shared components are proposed, but no prop/variant contract is documented.
- **Impact:** Risk of divergent one-off components during implementation.
- **Fix:** Add a small component contract table for new shared primitives (`PageContainer`, `PageHero`, `SectionBlock`, etc.).

### 8) Public route test plan lacks explicit deep-link and navigation-state checks

- **Plan reference:** `docs/UI_LANDING_DASHBOARD_IMPLEMENTATION_PLAN.md:273`
- **Issue:** Coverage is route-access oriented but does not mandate deep-link refresh and back/forward navigation checks for public pages.
- **Impact:** SPA routing regressions could slip through.
- **Fix:** Add test criteria for deep-link reload and browser history behavior across public and ops shells.

---

## Required Plan Amendments Before Build

1. Security architecture decision for token handling in Strategy A (single app): **DONE** (runtime token acquisition + server-side session/proxy).
2. Add **route-scoped data lifecycle constraints** to prevent ops SSE/fetch on public routes.
3. Add **breakpoint matrix + accessibility verification matrix**.
4. Add **rollout/rollback section** in Task 8.
5. Expand **docs parity scope** beyond README/setup/runbook.

---

## Execution Readiness Verdict

- **Current:** Ready for Task 1 kickoff with auth strategy locked.
- **Remaining prep:** Track and close medium findings during Task 1 and Task 8 acceptance updates.
