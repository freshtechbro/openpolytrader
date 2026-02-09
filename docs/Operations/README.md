# Operations Rollout Guide

This guide covers immediate-enable rollout and rollback for low-risk runtime hardening changes.

## Scope

- Catalog spread correctness and discovery stability
- Exa auth/billing cooldown controls
- Near-zero fee-aware gate enforcement
- Websearch observability for active-pair skips

## Recommended Rollout Sequence

1. Apply catalog spread, catalog exploration, and Exa cooldown env knobs.
   - `MARKET_CATALOG_MAX_SPREAD`
   - `MARKET_CATALOG_PAGE_SIZE=100`
   - `MARKET_CATALOG_EXPLORATION_ENABLED=true`
   - `MARKET_CATALOG_EXPLORATION_MAX_PAIRS=30`
   - `MARKET_CATALOG_EXPLORATION_MAX_PAGES=3`
   - `MARKET_CATALOG_EXPLORATION_MIN_VOLUME_24H=1000`
   - `EXA_COOLDOWN_MS`
   - `EXA_COOLDOWN_FAILURE_THRESHOLD`
2. Enable near-zero fee-aware gating with conservative fee.
   - Set `nearZeroFeeBps` via policy config (Ops API / dashboard).
   - Start at `0` for parity, then increase gradually if needed.
3. Validate metrics for 24h after enablement.
   - Confirm bounded exploration additions and stable rejection mix.

## Validation Checklist (First 24h)

- [ ] `market_catalog_refreshed` shows non-collapsing pair counts and expected `discoveredCore`/`discoveredExploration`.
- [ ] `market_catalog_funnel` shows bounded exploration additions.
- [ ] `web_search` cooldown events appear only on auth/billing failures:
  - `provider_cooldown_started`
  - `provider_cooldown_skip`
  - `provider_cooldown_recovered`
- [ ] `web_search` event `active_pair_skip_allowlist` remains consistent with allowlist status.
- [ ] Near-zero `gate_rejection` reasons remain stable and understandable when fees are enabled.

## Rollback

If pair quality degrades or signal pipeline cost/quality regresses:

1. Disable exploration immediately:
   - `MARKET_CATALOG_EXPLORATION_ENABLED=false`
2. Revert spread threshold to last known-good value:
   - `MARKET_CATALOG_MAX_SPREAD=<previous>`
3. Return near-zero fee gating to parity mode:
   - `nearZeroFeeBps=0`
4. If Exa API is unstable, increase backoff:
   - raise `EXA_COOLDOWN_MS`
   - lower request pressure via `EV_WEBSEARCH_*` knobs

## Notes

- Keep changes incremental; change one major knob group at a time.
- Always compare against a baseline window before and after each rollout stage.
