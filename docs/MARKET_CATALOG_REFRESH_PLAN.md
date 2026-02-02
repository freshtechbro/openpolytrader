# Market Catalog Refresh Improvements Plan

Improve market discovery reliability by relaxing volume/breadth thresholds and adding pagination or newest ordering to the Gamma market fetch.

---

## Overview

### Scope
- Relax the catalog selection thresholds to include more markets
- Increase breadth of markets scanned per refresh
- Add pagination and/or newest ordering for Gamma `/markets` fetch
- Update docs and tests to reflect new behavior and knobs

### Key decisions
- Make volume/breadth knobs configurable via env with sensible defaults (to allow safe local overrides).
- Implement pagination with a capped page limit; add optional newest ordering if supported by Gamma.
- Preserve existing validation (accepting orders, order book enabled, min order size/tick size, spread limits).

---

## Task 1 — Relax volume + increase breadth (env/config + docs)

### Reasoning
Current defaults favor high-liquidity markets, which can exclude newly listed or niche markets and reduce discovery coverage.

### What to do
Lower `MARKET_CATALOG_MIN_VOLUME_24H` and increase `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS` defaults; document the knobs in `.env.example` and ops docs.

### How
1. Adjust default values in `src/config/env.ts` for `MARKET_CATALOG_MIN_VOLUME_24H` and `MARKET_CATALOG_BOOTSTRAP_MAX_PAIRS` (pick safe new defaults based on desired breadth).
2. Update `.env.example` to match the new defaults and add a brief comment on expected tradeoffs.
3. Update docs to reflect the new defaults and how to override them for different environments.

### Files impacted
- `src/config/env.ts`
- `.env.example`
- `docs/Operations/config-knobs.md`
- `docs/Development/market-catalog.md`
- `docs/Operations/runbook.md`

### End goal
Catalog selection is less restrictive by default and fully documented for operators.

### Acceptance criteria
- [ ] Defaults in `src/config/env.ts` reflect the new volume/breadth targets
- [ ] `.env.example` documents the updated defaults
- [ ] Docs explain how these knobs affect discovery and refresh behavior

---

## Task 2 — Add pagination or newest ordering for Gamma `/markets`

### Reasoning
The refresher currently fetches only one page ordered by volume, which can miss newly listed markets.

### What to do
Implement multi-page fetching for Gamma `/markets` and optionally support newest ordering if Gamma exposes it.

### How
1. Verify Gamma `/markets` pagination and ordering parameters (e.g., `cursor`, `offset`, `order=createdAt/created_at`) via docs or a quick test call.
2. Add a pagination loop in `MarketCatalogRefresher.fetchLiquidMarkets()` with a hard page cap (e.g., `MARKET_CATALOG_MAX_PAGES`) to avoid unbounded scans.
3. Add optional ordering mode (e.g., `MARKET_CATALOG_ORDER=volume24hr|createdAt`) that defaults to `volume24hr`.
4. Stop pagination early when enough valid pairs are collected (`maxPairs`) to keep refresh latency bounded.

### Files impacted
- `src/services/MarketCatalogRefresher.ts`
- `src/config/env.ts` (new env knobs, if added)
- `.env.example`
- `docs/Operations/config-knobs.md`
- `docs/Development/market-catalog.md`

### End goal
Refresh can discover newly listed markets without requiring a separate bootstrap step, while staying bounded and safe.

### Acceptance criteria
- [ ] Pagination is capped and respects `maxPairs`
- [ ] Ordering is configurable (volume vs newest) and defaults to volume
- [ ] Refresh continues to emit `market_catalog_refresh_empty` when no valid pairs are found

---

## Task 3 — Update tests for refresher behavior

### Reasoning
Pagination and ordering logic add new paths that should be validated.

### What to do
Extend refresher unit tests to cover multi-page fetch and ordering configuration.

### How
1. Add tests for pagination: multiple pages, early exit when `maxPairs` satisfied.
2. Add tests for ordering config: verify correct query params are passed based on config.
3. Ensure existing tests for empty refresh/backoff still pass.

### Files impacted
- `tests/unit/market-catalog-refresher.test.ts`

### End goal
Refresher behavior is validated for pagination and ordering changes.

### Acceptance criteria
- [ ] New tests cover multi-page fetch and ordering selection
- [ ] Existing refresher tests remain green

---

## File-by-file implementation sequence

1. `src/config/env.ts` — Task 1 defaults and Task 2 new env knobs (if needed)
2. `src/services/MarketCatalogRefresher.ts` — Task 2 pagination/ordering logic
3. `tests/unit/market-catalog-refresher.test.ts` — Task 3 coverage
4. `.env.example` — Task 1/2 documentation
5. `docs/Development/market-catalog.md` — Task 1/2 documentation
6. `docs/Operations/config-knobs.md` — Task 1/2 documentation
7. `docs/Operations/runbook.md` — Task 1/2 documentation

---

## Dependencies to add

| Package | Version | Purpose |
|---------|---------|---------|
| None | N/A | No new dependencies required |

---

## Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-02 | Initial plan |
