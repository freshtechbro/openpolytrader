Goal (incl. success criteria):
- Land EV-signal remediation + market-catalog refresh reliability updates with tests/docs aligned, then commit the working tree.

Constraints/Assumptions:
- Follow AGENTS.md instructions, skill usage rules, and Multi-Agent Orchestrator guidance; sub-agents append only to `sub_continuity.md`.
- Use RepoPrompt MCP to gather repo context before implementation; use Exa + Context7 MCP for latest docs/examples as required.
- No stubs/placeholders; remove dead code after changes; avoid destructive git commands.
- Do not add new dependencies; keep validation logic intact; keep refresh bounded and stop early once enough valid pairs collected.
- Begin replies with a brief Ledger Snapshot (Goal + Now/Next + Open Questions).

Key decisions:
- Implement defensive pagination: use Gamma cursor when provided, otherwise offset paging; stop on empty/short page or cursor repetition.
- Added ordering mode `MARKET_CATALOG_ORDER` with `volume24hr` default and `newest` mapped to Gamma `order=id` (keep until Gamma confirms a better field).
- New defaults: `MARKET_CATALOG_MIN_VOLUME_24H=1000`, `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS=80`, `MARKET_CATALOG_PAGE_SIZE=100`, `MARKET_CATALOG_MAX_PAGES=5`.
- Ops API requires `Authorization: Bearer <OPS_API_TOKEN>`; dashboard must set `VITE_OPS_API_TOKEN` to match.

State:
  - Done:
    - Updated env defaults and added pagination/ordering knobs in `src/config/env.ts`.
    - Set default risk profile to `extra_high` (env schema, main fallback, API default, `.env.example`, tests).
    - Implemented paginated Gamma /markets fetch with cursor/offset fallback and ordering in `src/services/MarketCatalogRefresher.ts`.
    - Wired new config into `src/main.ts` and aligned prestart fallback in `src/tools/marketCatalogPrestart.ts`.
    - Extended refresher unit tests for pagination, ordering, and cursor handling in `tests/unit/market-catalog-refresher.test.ts`.
    - Updated `.env.example` and docs: `docs/Development/market-catalog.md`, `docs/Operations/config-knobs.md`, `docs/Operations/runbook.md`.
    - Fixed build/type errors in `src/domain/gates.ts`, `src/agents/execution/ExecutionAgent.ts`, `src/services/websearch/ExaClient.ts`, `src/services/websearch/FirecrawlClient.ts`.
    - Fixed lint issues in `src/utils/concurrency.ts` and `tests/unit/execution.test.ts`.
    - Updated prestart defaults test in `tests/unit/market-catalog-prestart-defaults.test.ts`.
    - Full checks: `npm run lint`, `npm run build`, `npm run test` (pass); paper-mode tests: `TRADING_ENABLED=false TRADING_MODE=paper npm run test` (pass).
    - Started backend + dashboard + monitors in tmux session `openpoly` (ports 3000/5174) with token from `dashboard/.env`.
    - Verified Ops API endpoints with token: `/health`, `/config`, `/stream?once=true` all 200.
    - Verified dashboard HTTP responds: `curl -I http://localhost:5174` returns 200.
    - Decision monitoring active: SSE stream -> `tmp/decision-stream.log`, 5-min `/decisions` polling -> `tmp/decision-poll.log`.
    - Provided a tmux one-liner to start backend + dashboard + monitors persistently.
    - Traced LLM timeout/latency behavior in `LLMClient`/`OpenAISdkClient`/`ZenMessagesClient` and summarized recent decisions across event stores.
    - Pulled live `/decisions` summary from Ops API (current window contains only the ScannerAgent decision).
    - Implemented EV-signal pipeline and websearch reliability updates with new tests and supporting docs (see `src/agents/signal/`, `src/services/websearch/`, `tests/unit/*websearch*`).
    - Added book freshness quarantine handling and expanded market data/risk/execution coverage (see `src/agents/ops/bookFreshnessQuarantine.ts`, `tests/unit/book-freshness-quarantine.test.ts`).
  - Now:
    - Split changes into multiple Conventional Commits (feature, tests, docs/chore) and stage accordingly.
  - Next:
    - Verify doc deletions are intentional; restore any required references. Outcome: docs cleanup is accurate; files: `docs/*.md`.
    - Re-run core tests after commit to confirm stability. Outcome: clean test run; files: `tests/unit/*.test.ts`, `vitest.config.ts`.
    - Validate EV/websearch defaults are consistent across config layers. Outcome: matching defaults; files: `src/config/{env,policy,schema,validate}.ts`, `.env.example`.
    - Confirm ops/market-data updates are documented. Outcome: runbook/architecture aligned; files: `docs/Operations/runbook.md`, `docs/ARCHITECTURE.md`.

Open questions (UNCONFIRMED if needed):
  - None.

Working set (files/ids/commands):
- `CONTINUITY.md`
- `dashboard/.env`
- `dashboard/vite.config.ts`
- `dashboard/src/lib/dashboardConfig.ts`
- `dashboard/src/lib/opsClient.ts`
- `src/api/server.ts`
- `src/config/env.ts`
- `src/services/MarketCatalogRefresher.ts`
- `tests/unit/market-catalog-refresher.test.ts`
- `.env.example`
- `docs/Development/market-catalog.md`
- `docs/Operations/config-knobs.md`
- `docs/Operations/runbook.md`
- Logs: `tmp/decision-stream.log`, `tmp/decision-poll.log`
- Commands: `npm run lint`, `npm run build`, `npm run test`, `TRADING_ENABLED=false TRADING_MODE=paper npm run test`, `npm run dev`, `npm --prefix dashboard run dev`

Key learnings:
- Gamma `/markets` supports `limit`, `offset`, `order`, and `ascending`; a cursor can be handled defensively when present in responses.
