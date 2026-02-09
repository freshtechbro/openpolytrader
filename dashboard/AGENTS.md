# Dashboard Frontend

## Overview

React 18 + Vite ops dashboard for monitoring trading system.

## Structure

```
dashboard/
├── src/
│   ├── components/   # Reusable UI (6 files)
│   ├── pages/        # View pages (6 files)
│   ├── hooks/        # Custom hooks
│   ├── lib/          # Utilities (opsClient, config)
│   └── styles/       # CSS (tokens.css, app.css)
├── tests/e2e/        # Playwright
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
| `TopNav` | Navigation + connection status |
| `MetricCard` | Single metric display |
| `MetricsTable` | Tabular data |
| `StatusPill` | Status indicators |
| `Section` | Content grouping |
| `Panel` | Card containers |

## Pages

| Page | View Key | Content | Notes |
|------|----------|---------|-------|
| Overview | `overview` | System metrics, health | |
| Markets | `markets` | Market allowlist | |
| Incidents | `incidents` | Failure log | |
| Positions | `positions` | Portfolio state | |
| RiskGates | `risk-gates` | Gate status/config | 500+ lines - complexity hotspot |
| Decisions | `decisions` | Decision stream and outcomes | |

Navigation is currently in-app state switching (`useState`), not URL routing.

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
  headers: { Authorization: `Bearer ${token}` }
})
```

Env vars: `VITE_OPS_API_TOKEN`, `VITE_OPS_BASE_URL`

## Commands

```bash
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
