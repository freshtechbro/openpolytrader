#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
OpenPolyTrader root help

Commands (`npm run <name>`)
  help                          Print this command/tool/flag reference.
  h                             Alias for `npm run help`.
  dev                           Start backend only.
  dev:ops                       Start backend + dashboard in paper mode (requires OPS_API_TOKEN).
  dev:ops:down                  Stop `dev:ops` processes.
  dev:ops:status                Verify dev:ops component health (oracle/backend/dashboard).
  dev:live                      Start Docker backend + local dashboard dev server.
  dev:live:down                 Stop Docker backend.
  build                         Compile backend TypeScript.
  build:all                     Build backend, dashboard, and Docker images.
  build:all:up                  Build everything and start Docker containers.
  build:all:live                Build everything and then run `dev:live`.
  prestart                      Preflight market-catalog refresh before `npm start`.
  start                         Run compiled backend (`dist/main.js`).
  lint                          Run ESLint with zero warnings allowed.
  typecheck                     Run TypeScript no-emit checks.
  test                          Run Vitest tests.
  test:coverage                 Run tests with coverage gates.
  polymarket:check              Run live Polymarket connectivity checks.
  polymarket:authcheck          Validate Polymarket auth configuration.
  polymarket:derive-creds       Derive CLOB credentials from L1 key material.
  llm:smoke                     Smoke-test configured LLM provider routing.
  catalog:refresh:dev           Generate/merge catalog via TS CLI (no build).
  catalog:refresh               Generate/merge catalog via compiled JS CLI.

Dashboard commands (`npm --prefix dashboard run <name>`)
  dev                           Start dashboard dev server (default :5173).
  build                         Build dashboard production bundle.
  test:e2e                      Run Playwright e2e suite + smoke checks.

Tools
  scripts/dev-up.sh             Dev orchestrator that requires OPS_API_TOKEN and sets safe defaults.
  scripts/dev-down.sh           Stops backend/dashboard PIDs created by `dev:ops`.
  scripts/dev-status.sh         Checks oracle/backend/dashboard health for dev:ops.
  src/tools/marketCatalogGeneratorCli.ts  Market catalog generator (dev entrypoint).
  dist/tools/marketCatalogGeneratorCli.js Market catalog generator (built/runtime entrypoint).

Common flags (`catalog:refresh*`)
  --out <path>                  Write catalog JSON to this file.
  --mode near-zero              Apply strict near-zero-risk market filtering.
  --verify-books                Require both token books and non-empty asks.
  --require-metadata            Require `tick_size` and `min_order_size`.
  --yesno-only                  Keep only strict Yes/No outcome markets.
  --merge                       Merge generated pairs into existing file.
  --overwrite                   Replace existing file content completely.
  --max <n>                     Limit number of emitted market pairs.
  --tag <text>                  Keep only markets matching tag substring.

Common env flags
  OPS_API_TOKEN                 Required by dev:ops and authenticated /ops/* requests.
  OPS_DEV_SESSION_PREFILL_ENABLED  Toggle localhost token prefill for dashboard login.
  DASHBOARD_PORT                Override dev:ops dashboard port (default 5174).
  OPS_BASE_URL                  Override dashboard -> backend base URL in dev:ops.
  TRADING_MODE                  Runtime mode: off | shadow | paper | live.
  TRADING_ENABLED               Global runtime trading switch: true | false.
EOF
