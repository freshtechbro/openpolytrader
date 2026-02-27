# OpenPolyTrader Landing + Dashboard Implementation Plan

Execution plan for implementing the approved design direction:

- Concept: `Signal Grid` (approved)
- Build strategy: single app route split (`/` public landing + `/ops/*` authenticated dashboard) with runtime auth session (no build-time `VITE_OPS_API_TOKEN`)

---

## Overview

### Scope
- Add a public landing experience inside the existing `dashboard` app.
- Preserve and upgrade the existing operations dashboard as `/ops/*`.
- Keep implementation minimal, DRY, and aligned with current API contracts.

### Key decisions
- Keep one frontend codebase (`dashboard`) to avoid duplicated components and routing logic.
- Introduce route architecture with clear public vs ops separation.
- Lock auth strategy to runtime token acquisition and server-side session/proxy for `/ops/*`.
- Remove build-time ops token injection (`VITE_OPS_API_TOKEN`) from dashboard runtime.
- Reuse existing ops pages first; redesign incrementally page by page.
- Prioritize accessibility and performance hardening from audit findings.

---

## Task 1 — Route Foundation, Auth Boundary, and App Shell Split

### Reasoning
Current dashboard uses in-component page state. Landing + ops requires URL-driven routing and a stable shell.

### What to do
Add route-level app structure for public pages and `/ops/*` pages with runtime/session auth boundary.

### How
1. Add routing dependency and bootstrap router in `main.tsx`.
2. Create route tree with public pages and ops pages.
3. Add runtime auth-session flow for `/ops/*` (token exchange/login + server-side session/cookie).
4. Keep existing ops content functional by mounting current pages under `/ops/*`.
5. Add a thin route guard utility for ops session-dependent navigation behavior.
6. Ensure landing routes never instantiate ops fetch/SSE hooks.

### Files impacted
- `dashboard/package.json`
- `dashboard/src/main.tsx`
- `dashboard/src/App.tsx`
- `dashboard/src/routes/AppRouter.tsx` (new file)
- `dashboard/src/routes/OpsLayout.tsx` (new file)
- `dashboard/src/routes/PublicLayout.tsx` (new file)
- `dashboard/src/lib/opsClient.ts`
- `dashboard/src/lib/dashboardConfig.ts`
- `dashboard/src/hooks/useEventStream.ts`
- `src/api/server.ts`
- `src/security/Auth.ts`

### End goal
Navigation is URL-based, public pages are isolated from ops side effects, and `/ops/*` is protected by runtime/session auth.

### Acceptance criteria
- [ ] `/` renders landing shell and `/ops/overview` renders ops shell.
- [ ] Direct deep-link reload works for `/ops/*` routes.
- [ ] Existing ops API fetch and SSE logic still works under routed layout.
- [ ] No build-time ops token is embedded in dashboard bundle (`VITE_OPS_API_TOKEN` removed from runtime path).
- [ ] Landing routes do not call `opsFetch*` or mount `useEventStream`.

---

## Task 2 — Shared Design System Foundation (Signal Grid)

### Reasoning
Landing and dashboard must feel cohesive without duplicating style logic.

### What to do
Establish shared tokens and layout primitives for Signal Grid styling.

### How
1. Normalize color, spacing, radius, typography, and motion tokens in `tokens.css`.
2. Split global styles into clear sections: base, layout, components, utilities.
3. Add shared primitives for page container, section header, and grid variants.
4. Add reduced-motion defaults globally.

### Files impacted
- `dashboard/src/styles/tokens.css`
- `dashboard/src/styles/app.css`
- `dashboard/src/components/Section.tsx`
- `dashboard/src/components/Panel.tsx`
- `dashboard/src/components/MetricCard.tsx`
- `dashboard/src/components/PageContainer.tsx` (new file)

### End goal
A reusable style foundation supports both public and ops surfaces with consistent visual language.

### Acceptance criteria
- [ ] Landing and ops pages use the same token set.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] No regression in current ops readability on desktop/mobile.

---

## Task 3 — Landing Home Page (`/`)

### Reasoning
The homepage is the highest-impact entry point for positioning and trust.

### What to do
Build the Signal Grid home page with clear product value and risk-first framing.

### How
1. Create home page sections: hero, trust strip, pipeline cards, risk pillars, CTA.
2. Reuse existing architecture and risk language from project docs.
3. Add responsive behavior for mobile/tablet/desktop with generous whitespace.
4. Keep copy concise and technical.

### Files impacted
- `dashboard/src/pages/public/HomePage.tsx` (new file)
- `dashboard/src/components/public/Hero.tsx` (new file)
- `dashboard/src/components/public/TrustStrip.tsx` (new file)
- `dashboard/src/components/public/PipelineGrid.tsx` (new file)
- `dashboard/src/components/public/RiskPillars.tsx` (new file)
- `dashboard/src/styles/app.css`

### End goal
`/` clearly communicates what OpenPolyTrader is, how it works, and why it is risk-disciplined.

### Acceptance criteria
- [ ] Home page has complete desktop/mobile layouts.
- [ ] CTA routes correctly to `/get-started` and `/ops/overview`.
- [ ] No visual overlap or overflow on narrow screens.

---

## Task 4 — Remaining Landing Pages

### Reasoning
Product, risk, architecture, and setup pages complete the public funnel and reduce operator confusion.

### What to do
Implement `/product`, `/risk-safety`, `/architecture`, and `/get-started`.

### How
1. Create each page with a consistent section pattern and page header system.
2. Reuse structured content blocks rather than duplicating markup.
3. Link to existing docs where deeper detail is needed.
4. Add shared side TOC component for long pages where helpful.

### Files impacted
- `dashboard/src/pages/public/ProductPage.tsx` (new file)
- `dashboard/src/pages/public/RiskSafetyPage.tsx` (new file)
- `dashboard/src/pages/public/ArchitecturePage.tsx` (new file)
- `dashboard/src/pages/public/GetStartedPage.tsx` (new file)
- `dashboard/src/components/public/PageHero.tsx` (new file)
- `dashboard/src/components/public/SectionBlock.tsx` (new file)
- `dashboard/src/styles/app.css`

### End goal
All approved landing pages are implemented and internally consistent.

### Acceptance criteria
- [ ] All 5 public routes resolve and render.
- [ ] Internal links between landing pages and docs are valid.
- [ ] Content hierarchy is readable and scannable on mobile.

---

## Task 5 — Ops Navigation and Layout Refactor (`/ops/*`)

### Reasoning
Current ops navigation is flat and inline; Signal Grid requires clearer IA and action placement.

### What to do
Refactor ops shell with persistent navigation and standardized page headers.

### How
1. Convert current top nav + inline buttons into structured ops layout.
2. Add left rail (or top tabs at smaller breakpoints) for route-level ops navigation.
3. Keep trading mode controls and stream status in persistent header area.
4. Preserve existing page components and progressively adapt styling.

### Files impacted
- `dashboard/src/App.tsx`
- `dashboard/src/components/TopNav.tsx`
- `dashboard/src/routes/OpsLayout.tsx`
- `dashboard/src/styles/app.css`

### End goal
Ops users can move between monitoring and control workflows with less friction.

### Acceptance criteria
- [ ] All existing ops pages are reachable via persistent nav.
- [ ] Trading mode + enabled controls remain visible and functional.
- [ ] Route transitions do not reset critical UI state unexpectedly.

---

## Task 6 — Ops Page Modernization (Overview, Markets, Incidents, Positions)

### Reasoning
These pages carry daily operational load and must match the new IA while remaining fast.

### What to do
Upgrade page structure and table ergonomics for overview, markets, incidents, and positions.

### How
1. Re-layout overview into clear metric, SLO, intents, and incidents zones.
2. Add better toolbars and row density controls for markets/incidents.
3. Improve positions page hierarchy (capital summary first, exposure second).
4. Apply reusable table metadata and empty/loading states across pages.

### Files impacted
- `dashboard/src/pages/Overview.tsx`
- `dashboard/src/pages/Markets.tsx`
- `dashboard/src/pages/Incidents.tsx`
- `dashboard/src/pages/Positions.tsx`
- `dashboard/src/components/MetricsTable.tsx`
- `dashboard/src/styles/app.css`

### End goal
Core ops pages are visually coherent, easier to scan, and remain aligned to live API data.

### Acceptance criteria
- [ ] Overview loads with no regressions in health/SLO/intents display.
- [ ] Markets/incidents tables are usable on tablet/mobile breakpoints.
- [ ] Positions still refreshes with `VITE_PORTFOLIO_REFRESH_MS`.

---

## Task 7 — Ops Page Modernization (Risk, Decisions) + Audit Hardening

### Reasoning
Risk and decisions are high-stakes surfaces; they require stronger accessibility and performance handling.

### What to do
Improve risk/decisions UX and address design-agent findings.

### How
1. Keep schema-driven risk form behavior, but improve grouping and progressive disclosure.
2. Improve decisions filtering and detail inspection layout.
3. Resolve focus-style issues and label/association warnings.
4. Add reduced-motion fallback and table scalability strategy (windowing or strict paging limits).

### Files impacted
- `dashboard/src/pages/RiskGates.tsx`
- `dashboard/src/pages/Decisions.tsx`
- `dashboard/src/components/MetricsTable.tsx`
- `dashboard/src/styles/app.css`

### End goal
Risk and decisions workflows are safer, clearer, and compliant with accessibility/motion expectations.

### Acceptance criteria
- [ ] Design-agent `focus` and `motion` issues are resolved.
- [ ] Decisions filters remain fully usable via keyboard.
- [ ] Large decision lists are handled without major UI jank.

---

## Task 8 — Test, QA, Docs, and Release Readiness

### Reasoning
Large UI changes must keep operational confidence and documentation parity.

### What to do
Update tests and docs to match new routing and UX behavior.

### How
1. Extend dashboard e2e coverage for public routes and `/ops/*` navigation.
2. Update setup/README/docs references for new routing.
3. Run full repo quality gates and capture evidence.
4. Final audit pass using design-agent tooling.

### Files impacted
- `dashboard/tests/e2e/smoke.spec.ts`
- `dashboard/tests/e2e/risk-profile.spec.ts`
- `dashboard/tests/e2e/landing.spec.ts` (new file)
- `README.md`
- `docs/Development/setup.md`
- `docs/Operations/runbook.md`
- `docs/API.md`
- `docs/Operations/config-knobs.md`
- `docs/UI_LANDING_DASHBOARD_PROPOSAL.md`

### End goal
Implementation ships with validated behavior and accurate operational documentation.

### Acceptance criteria
- [ ] Dashboard e2e covers public + ops route access.
- [ ] Docs reflect route changes and run commands.
- [ ] Auth docs reflect runtime/session flow (no build-time dashboard token).
- [ ] Full quality gates are green before merge.

---

## File-by-file implementation sequence

1. `dashboard/package.json` - Task 1
2. `dashboard/src/main.tsx` - Task 1
3. `dashboard/src/routes/AppRouter.tsx` - Task 1 (new file)
4. `dashboard/src/routes/PublicLayout.tsx` - Tasks 1, 3 (new file)
5. `dashboard/src/routes/OpsLayout.tsx` - Tasks 1, 5 (new file)
6. `dashboard/src/styles/tokens.css` - Task 2
7. `dashboard/src/styles/app.css` - Tasks 2, 3, 4, 5, 6, 7
8. `dashboard/src/components/PageContainer.tsx` - Task 2 (new file)
9. `dashboard/src/pages/public/*` - Tasks 3, 4 (new files)
10. `dashboard/src/App.tsx` - Task 5
11. `dashboard/src/pages/Overview.tsx` - Task 6
12. `dashboard/src/pages/Markets.tsx` - Task 6
13. `dashboard/src/pages/Incidents.tsx` - Task 6
14. `dashboard/src/pages/Positions.tsx` - Task 6
15. `dashboard/src/pages/RiskGates.tsx` - Task 7
16. `dashboard/src/pages/Decisions.tsx` - Task 7
17. `dashboard/src/components/MetricsTable.tsx` - Tasks 6, 7
18. `dashboard/tests/e2e/*` - Task 8
19. `README.md` - Task 8
20. `docs/Development/setup.md` - Task 8
21. `docs/Operations/runbook.md` - Task 8

---

## Dependencies to add

### Task and subtask dependency mapping

| Task | Depends on | Subtasks enabled | Why |
|------|------------|------------------|-----|
| Task 1 | None | Tasks 3, 4, 5 | Routing foundation required before page rollout |
| Task 2 | None | Tasks 3, 4, 5, 6, 7 | Shared tokens/primitives prevent duplicate styling |
| Task 3 | Tasks 1, 2 | Task 8 | Home page validates public-shell viability |
| Task 4 | Tasks 1, 2, 3 | Task 8 | Completes landing IA |
| Task 5 | Tasks 1, 2 | Tasks 6, 7 | Ops layout must exist before page modernization |
| Task 6 | Task 5 | Task 8 | Core ops page refresh |
| Task 7 | Task 5 | Task 8 | High-stakes controls and audit fixes |
| Task 8 | Tasks 3, 4, 6, 7 | Release | QA and docs parity closeout |

| Package | Version | Purpose |
|---------|---------|---------|
| `react-router-dom` | `^7.0.0` | Route architecture for `/` and `/ops/*` split |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-16 | Initial implementation plan aligned to approved Concept 1 + Strategy A |
