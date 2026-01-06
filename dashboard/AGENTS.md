# Dashboard Frontend

## Overview

React 18 + Vite ops dashboard for monitoring trading system.

## Structure

```
dashboard/
├── src/
│   ├── components/   # Reusable UI (6 files)
│   ├── pages/        # Route views (5 files)
│   ├── hooks/        # Custom hooks
│   ├── lib/          # Utilities (opsClient, config)
│   └── styles/       # CSS (tokens.css, app.css)
├── tests/e2e/        # Playwright
└── index.html        # Vite entry
```

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

| Page | Route | Content | Notes |
|------|-------|---------|-------|
| Overview | `/` | System metrics, health | |
| Markets | `/markets` | Market allowlist | |
| Incidents | `/incidents` | Failure log | |
| Positions | `/positions` | Portfolio state | |
| RiskGates | `/risk` | Gate status/config | 500+ lines - complexity hotspot |

## Patterns

### State Management
- Local `useState` / `useEffect`
- No Redux/Zustand - simple prop drilling
- Data fetched via `opsClient`

### Real-time Updates
- `useEventStream` hook for SSE
- Backend pushes via `/stream`
- Events: `health`, `incident`, `order`

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

Token: `VITE_OPS_API_TOKEN` env var

## Commands

```bash
npm run dev      # Vite :5173
npm run build    # Production
npm run test:e2e # Playwright
```

## Conventions

- TypeScript strict mode
- Functional components only
- Props interfaces for each component
- Error handling with try/catch
- useMemo for computed values
