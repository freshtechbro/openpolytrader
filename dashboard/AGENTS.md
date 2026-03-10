# Dashboard Frontend

## Overview

React 18 + Vite public site plus ops dashboard for the trading system.

## Structure

```
dashboard/
├── src/
│   ├── components/   # Shared ops/public UI primitives
│   ├── hooks/        # Shared runtime hooks
│   ├── lib/          # API/runtime helpers
│   ├── pages/        # Public pages plus ops feature folders
│   ├── routes/       # AppRouter, public/ops layouts, controller hooks
│   └── styles/       # Tokens + split app/dashboard/ops/public stylesheets
├── tests/e2e/        # Playwright smoke and flow specs
└── index.html        # Vite entry
```

## Local Instructions

Local `AGENTS.md` files refine these rules:
- `dashboard/src/AGENTS.md`
- `dashboard/src/components/AGENTS.md`
- `dashboard/src/components/public/AGENTS.md`
- `dashboard/src/pages/AGENTS.md`
- `dashboard/src/pages/public/AGENTS.md`
- `dashboard/src/hooks/AGENTS.md`
- `dashboard/src/lib/AGENTS.md`
- `dashboard/src/routes/AGENTS.md`
- `dashboard/src/styles/AGENTS.md`
- `dashboard/public/AGENTS.md`
- `dashboard/scripts/AGENTS.md`
- `dashboard/tests/AGENTS.md`
- `dashboard/tests/e2e/AGENTS.md`

## Components

| Component | Purpose |
|-----------|---------|
| `TopNav` | Ops header, health, trading mode controls |
| `MetricCard`, `MetricsTable`, `StatusPill` | Metric and status presentation |
| `Section`, `Panel`, `PageContainer` | Shared layout primitives |
| `GitHubRepoLink` | Shared repo/brand link |
| `components/public/*` | Landing page sections (`Hero`, `PipelineGrid`, `RiskPillars`, etc.) |

## Pages

| Route | Page | Content | Notes |
|------|------|---------|-------|
| `/` | `HomePage` | Landing/overview | Public layout |
| `/product` | `ProductPage` | Product details | Public layout |
| `/risk-safety` | `RiskSafetyPage` | Risk controls and safety model | Public layout |
| `/architecture` | `ArchitecturePage` | System architecture summary | Public layout |
| `/get-started` | `GetStartedPage` | Setup + onboarding flow | Public layout |
| `/ops/overview` | `Overview` | System metrics, health | Ops layout |
| `/ops/markets` | `Markets` | Market allowlist | Ops layout |
| `/ops/incidents` | `Incidents` | Failure log | Ops layout |
| `/ops/positions` | `Positions` | Portfolio state | Ops layout |
| `/ops/risk` | `RiskGates` | Gate status/config | Split across `pages/risk-gates/*` helpers |
| `/ops/decisions` | `Decisions` | Decision stream and outcomes | Ops layout |

Navigation uses React Router (`AppRouter`) with public routes and nested `/ops/*` routes backed by `useOpsLayoutController`.

## Patterns

### State Management
- Route-level controller hooks (`useOpsLayoutController`, `useRiskGatesController`, `useDecisionsController`)
- Local `useState` / `useEffect` for page state
- Data fetched via `opsClient` helpers

### Real-time Updates
- `useEventStream` hook for SSE
- Backend pushes via `/stream`
- Commonly handled events: `health`, `incident`, `allowlist_updated`, `info`, `risk`, `order`, `fill`
- Stream subscription also includes telemetry/ops events such as `execution_lifecycle`, `gate_rejection`, and `slo_violation`

### Styling
- CSS variables in `tokens.css`
- Split global styles across `app-base.css`, `app-dashboard.css`, `app-ops.css`, `app-public.css`, and `app-responsive.css`
- No Tailwind or CSS-in-JS

## API Client

```typescript
// lib/opsClient.ts
fetch(`${BASE_URL}/endpoint`, {
  credentials: 'include'
})
```

Env vars: `VITE_OPS_BASE_URL`

## Commands

```bash
# From dashboard/
npm run dev
npm run build
npm run test:e2e

# Live (from repo root)
npm run help
npm run dev:live
npm run dev:live:down
npm --prefix dashboard run build
npm --prefix dashboard run test:e2e
```

## Conventions

- TypeScript strict mode
- Functional components only
- Props interfaces for each component
- Error handling with try/catch
- Prefer controller/helper extraction over adding inline route logic
- Avoid memoization unless it materially simplifies or stabilizes the current code path
