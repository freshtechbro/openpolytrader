# Dashboard Frontend

## Overview

React 18 + Vite ops dashboard for monitoring trading system.

## Structure

```
dashboard/
├── src/
│   ├── components/   # Reusable UI (14 files)
│   ├── pages/        # Route pages (11 files)
│   ├── hooks/        # Custom hooks
│   ├── lib/          # Utilities (opsClient, config)
│   ├── routes/       # React Router layouts/router
│   └── styles/       # CSS (tokens.css, app.css)
├── tests/e2e/        # Playwright specs (4 files)
└── index.html        # Vite entry
```

## Local Instructions

Local `AGENTS.md` files refine these rules:
- `dashboard/src/AGENTS.md`
- `dashboard/src/components/AGENTS.md`
- `dashboard/src/pages/AGENTS.md`
- `dashboard/src/hooks/AGENTS.md`
- `dashboard/src/lib/AGENTS.md`
- `dashboard/src/styles/AGENTS.md`
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
| `/ops/risk` | `RiskGates` | Gate status/config | 708 lines, 27694 bytes |
| `/ops/decisions` | `Decisions` | Decision stream and outcomes | Ops layout |

Navigation uses React Router (`AppRouter`) with public routes and nested `/ops/*` routes.

## Patterns

### State Management
- Local `useState` / `useEffect`
- No Redux/Zustand - simple prop drilling
- Data fetched via `opsClient`

### Real-time Updates
- `useEventStream` hook for SSE
- Backend pushes via `/stream`
- Commonly handled events: `health`, `incident`, `allowlist_updated`, `info`, `risk`, `order`, `fill`
- Stream subscription also includes telemetry/ops events such as `execution_lifecycle`, `gate_rejection`, and `slo_violation`

### Styling
- CSS variables in `tokens.css`
- Glass effects with `backdrop-filter`
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
(cd .. && npm run help) # root command/tool/flag reference
npm run dev      # Vite :5173
npm run build    # Production
npm run test:e2e # Playwright

# Live (from repo root)
npm run dev:live      # Docker backend + local dashboard dev server
npm run dev:live:down # Stop Docker backend
```

## Conventions

- TypeScript strict mode
- Functional components only
- Props interfaces for each component
- Error handling with try/catch
- useMemo for computed values
