# OpenPolyTrader UI + Dashboard Proposal

**Date:** 2026-02-16  
**Status:** Proposed (discussion-ready)  
**Scope:** Public web landing experience + authenticated operations dashboard

---

## Decision Lock (2026-02-16)

- Approved concept: **Concept 1 - Signal Grid**
- Approved build strategy: **Strategy A - single app with route split (`/` + `/ops/*`)**
- Approved auth strategy: **runtime token acquisition with server-side session/proxy** (replace build-time `VITE_OPS_API_TOKEN`)

---

## 1) Executive Summary

This proposal defines a modern, sleek, responsive UX strategy for OpenPolyTrader across:

- a **public landing layer** for product positioning, trust, and onboarding,
- an **operations dashboard layer** for monitoring, control, and risk configuration.

Recommendation: adopt **Concept 1: Signal Grid** as the primary direction, and implement in a single frontend app with route split:

- Public: `/`, `/product`, `/risk-safety`, `/architecture`, `/get-started`
- Ops: `/ops/*`

Security implementation lock:
- Authenticate ops routes via runtime token exchange and server-side session/proxy.
- Do not ship ops bearer tokens in frontend build artifacts.

This minimizes duplication, preserves delivery speed, and reuses existing dashboard components and API contracts.

---

## 2) Current-State Audit (Code-Backed)

### 2.1 Existing dashboard surface

- Current route/page set:
  - `overview`, `markets`, `incidents`, `positions`, `risk-gates`, `decisions`
  - Source: `dashboard/src/App.tsx`
- Existing ops top navigation, stream + mode indicators:
  - Source: `dashboard/src/components/TopNav.tsx`
- Existing reusable UI primitives:
  - `Panel`, `Section`, `MetricsTable`, `MetricCard`, `StatusPill`
  - Source: `dashboard/src/components/*`
- Existing data plumbing:
  - API fetch helpers + token auth: `dashboard/src/lib/opsClient.ts`
  - SSE stream consumption: `dashboard/src/hooks/useEventStream.ts`

### 2.2 Existing backend/ops API capability

Supported and production-relevant endpoints already available:

- Health/monitoring: `/health`, `/health/live`, `/health/ready`, `/metrics`, `/slo`, `/stream`
- Ops data: `/markets`, `/incidents`, `/portfolio`, `/decisions`
- Runtime config/control: `/config`, `/config/schema`, `/config/infra`, `/config/risk-profiles`, `/config/policy`, `/config/risk`, `/config/risk-profile`, `/config/trading-mode`
- Debug utilities: `/debug/*`

Source: `src/api/server.ts`, `docs/API.md`

### 2.3 Runtime-editable config model

- Schema-driven policy/risk forms are already supported and robust.
- Source: `src/config/schema.ts`, `dashboard/src/pages/RiskGates.tsx`

---

## 3) Design-Agent Findings

Audit command:

```bash
python3 ~/.codex/skills/design-agent/scripts/audit_ui.py --min-severity warning --json dashboard/src
```

Top findings to address during UI refresh:

1. Focus handling risk (`outline: none` pattern flagged in stylesheet).
2. Reduced-motion fallback gaps for animated UI sections.
3. Table-heavy rendering patterns with potential scaling issues on large datasets.
4. Form labeling warnings on filter controls (should be normalized to explicit accessible associations).

Implication: the redesign should include accessibility and performance hardening as first-class requirements, not polish tasks.

---

## 4) Product Goals and UX Principles

### 4.1 Primary goals

- Communicate trust and technical credibility on the public site.
- Make daily operational workflows fast and low-friction in `/ops`.
- Keep UI simple, calm, and whitespace-driven without sacrificing depth.
- Preserve fail-safe semantics around trading mode/risk controls.

### 4.2 Design principles

- Clear visual hierarchy and progressive disclosure.
- Strong keyboard and focus visibility.
- Meaningful motion with reduced-motion support.
- Dense data views only where operationally necessary.
- Tokenized design system with consistent spacing, typography, and state colors.

---

## 5) Information Architecture

### 5.1 Landing IA (public)

1. `/` Home  
2. `/product` Product capabilities  
3. `/risk-safety` Risk controls and safety model  
4. `/architecture` System/agent architecture + event flow  
5. `/get-started` Setup and paper-mode onboarding

### 5.2 Dashboard IA (authenticated)

1. `/ops/overview`  
2. `/ops/markets`  
3. `/ops/incidents`  
4. `/ops/positions`  
5. `/ops/risk`  
6. `/ops/decisions`

---

## 6) Full Functionality List

### 6.1 Landing functionality

#### Home (`/`)
- Hero value proposition + explicit risk-first posture
- Real-time credibility strip (health/state summary snapshot, non-sensitive)
- Pipeline explanation (Signal -> Scanner -> Risk -> Execution -> Portfolio)
- CTA paths: Explore product, Review risk model, Open docs, Enter ops dashboard

#### Product (`/product`)
- Capability map by workflow stage
- Feature cards for monitoring, risk controls, decisions audit, and operations
- “Why this architecture” section with concise technical rationale

#### Risk & Safety (`/risk-safety`)
- Risk profile model overview (`near_zero`, `moderate`, `high`, `extra_high`)
- Trading mode behavior summary (`off`, `shadow`, `paper`, `live`)
- Guardrail explanation: staleness gates, exposure limits, fill/ack controls
- Incident and quarantine model explanation

#### Architecture (`/architecture`)
- Agent topology, message bus, event store, and ops API surfaces
- Runtime event flow and decision lifecycle
- Optional debug/testing endpoints summary for operators

#### Get Started (`/get-started`)
- Safe startup defaults (paper mode)
- Environment checklist
- Command-based setup and validation steps
- Links to API and operational docs

### 6.2 Dashboard functionality

#### Overview (`/ops/overview`)
- Global health + stream connection state
- Core metrics cards (incident/opportunity/order/fill)
- SLO windows (1h/24h)
- Final intents tables (gated + executed)
- Incident preview

#### Markets (`/ops/markets`)
- Allowlist/quarantine list with metadata
- Status, until, reason, live/offline indicators
- Manual refresh + list expansion controls
- Detail-ready row model

#### Incidents (`/ops/incidents`)
- Incident timeline table
- Check/error visibility
- Preview/all toggle

#### Positions (`/ops/positions`)
- Capital summary metrics
- Market exposure breakdown
- Loading/error handling for operational clarity

#### Risk (`/ops/risk`)
- Active risk profile display + profile apply action
- Trading enabled/mode status visibility
- Infra snapshot (read-only, collapsible)
- Runtime editable policy/risk form sections generated from `/config/schema`
- Section-level save state feedback

#### Decisions (`/ops/decisions`)
- Query filters (agent, subject, limit, since/until)
- Live update toggle with stream state indicator
- Persisted + live decision rows
- Decision detail inspector (decision JSON + reasoning JSON)
- Copy actions for audit and incident workflows

#### Ops auth/session (`/ops/*`)
- Runtime token entry/session bootstrap for operators
- Session-aware route guard and unauthorized fallback state
- Cookie/proxy-backed auth flow for API + SSE without build-time token embedding

---

## 7) Wireframe Directions (5 Concepts)

## Concept 1 — Signal Grid (Recommended)

### Style intent
- Structured, modern control-plane look
- Calm neutrals, strong accent hierarchy
- Comfortable spacing with dense data where needed

### Landing wireframe map
- `/` Home:
  - `Top Nav`
  - `Hero Split (copy + visual)`
  - `Proof Strip (status/trust)`
  - `Pipeline Card Grid`
  - `Risk Pillars`
  - `CTA Footer`
- `/product`:
  - `Sticky TOC`
  - `Workflow Feature Grid`
  - `Mode Comparison`
  - `API capability block`
- `/risk-safety`:
  - `Risk profile ladder`
  - `Guardrail matrix`
  - `Incident/quarantine flow`
- `/architecture`:
  - `Agent diagram`
  - `Event flow timeline`
  - `Ops API surface cards`
- `/get-started`:
  - `Step timeline`
  - `Env checklist`
  - `Command run blocks`

### Dashboard wireframe map
- Global layout:
  - `Top Status Bar`
  - `Left Nav Rail`
  - `Primary Content Grid`
- `/ops/overview`:
  - `KPI Row`
  - `SLO Panel`
  - `Final Intents Table`
  - `Incidents Feed`
- `/ops/markets`:
  - `Filter/Action Toolbar`
  - `Markets Table`
  - `Right Detail Drawer`
- `/ops/risk`:
  - `Profile Action Bar`
  - `Policy/Risk Config Sections`
  - `Infra accordion`
- `/ops/decisions`:
  - `Filter Bar`
  - `Decisions Table`
  - `JSON Inspector Pane`

---

## Concept 2 — Editorial Ops

### Style intent
- Strong typography and narrative rhythm
- Maximum whitespace and low visual noise
- Documentation-grade readability

### Landing wireframe map
- Long-form storytelling structure with chapter-style sections
- Architecture/risk pages prioritize explanatory depth over cards

### Dashboard wireframe map
- Three-column reading layout:
  - `Left navigation`
  - `Main table/content`
  - `Context/help notes`
- Better for operators who prefer analysis over quick-action density

---

## Concept 3 — Split-Pane Analyst

### Style intent
- Analytical workstation feel
- Persistent context and drill-down inspection

### Landing wireframe map
- Product-first hero with simulated live panel
- Technical capability blocks with lower narrative overhead

### Dashboard wireframe map
- Persistent split panes:
  - `Main data table`
  - `Right inspector`
- Every major page supports immediate row-level inspection

---

## Concept 4 — Command Center Light

### Style intent
- High operational clarity with denser instrumentation
- Lightweight “mission control” tone without dark UI bias

### Landing wireframe map
- Tactical positioning and concise trust metrics
- Strong transition into dashboard workflows

### Dashboard wireframe map
- Persistent command/action strip
- Dense cards and event-driven views
- Optimized for fast operational triage

---

## Concept 5 — Ultra-Minimal Product

### Style intent
- Minimal chrome, restrained components
- Quiet and premium with strict simplicity

### Landing wireframe map
- Lean 5-page structure, concise copy, high whitespace

### Dashboard wireframe map
- Mostly table + card primitives
- Reduced ornamentation and minimal animation

---

## 8) Recommendation

Adopt **Concept 1 (Signal Grid)**.

Why:

- Best balance of modern polish, operational density, and simplicity.
- Closest fit to the existing component and API model.
- Lowest migration risk from current dashboard architecture.
- Supports future expansion without forcing immediate major re-platforming.

---

## 9) Technical Delivery Strategy

### 9.1 App structure recommendation

- Keep one frontend app (`dashboard`) and add route partition:
  - Public landing routes
  - `/ops/*` authenticated dashboard routes

Benefits:

- shared design tokens/components,
- single build/test/deploy path,
- reduced duplication and drift.

### 9.2 Initial implementation phases

1. **Foundation**
   - Add route architecture and shared layout primitives.
   - Normalize tokens and spacing scale.
2. **Landing rollout**
   - Implement 5 landing pages and copy structure.
3. **Dashboard IA refresh**
   - Introduce improved navigation, panel layout, and drill-down ergonomics.
4. **Hardening**
   - Resolve focus/motion/performance audit items.
   - Improve table scalability and filter accessibility.
5. **QA + docs parity**
   - Keep e2e coverage and docs in sync with updated IA/routes.

---

## 10) Non-Functional Requirements

- Accessibility:
  - WCAG 2.2 focus visibility compliance
  - keyboard-first navigation across all controls
  - reduced-motion support
- Performance:
  - avoid costly full re-renders on streaming tables
  - consider virtualization/windowing for high-volume rows
- Responsive behavior:
  - mobile-first layout adaptation for landing
  - tablet/desktop optimized ops layout
- Security:
  - retain token-auth requirements for ops routes and stream access

---

## 11) Discussion Decisions Needed

1. Confirm route strategy:
   - **Option A (recommended):** one app with `/` + `/ops/*`
   - Option B: separate landing and ops apps
2. Confirm primary concept:
   - **Option 1 (recommended):** Signal Grid
   - Option 2-5 as alternatives
3. Confirm tone priority:
   - technical/enterprise balance,
   - stronger narrative marketing,
   - or operator-first utility density.

---

## 12) Source Evidence

- `dashboard/src/App.tsx`
- `dashboard/src/pages/Overview.tsx`
- `dashboard/src/pages/Markets.tsx`
- `dashboard/src/pages/Incidents.tsx`
- `dashboard/src/pages/Positions.tsx`
- `dashboard/src/pages/RiskGates.tsx`
- `dashboard/src/pages/Decisions.tsx`
- `dashboard/src/components/MetricsTable.tsx`
- `dashboard/src/styles/app.css`
- `src/api/server.ts`
- `src/config/schema.ts`
- `docs/API.md`
- `docs/Operations/config-knobs.md`
