Goal (incl. success criteria):
- Apply all verified documentation corrections from the deep review (high/medium/low).
- Success criteria:
  - Every verified finding is corrected in docs (`README*`, `AGENTS.md`, `docs/**`).
  - Updates are aligned with current code/config/scripts behavior.
  - No unrelated code logic changes are introduced.

Constraints/Assumptions:
- Follow AGENTS.md requirements: no stubs/placeholders, DRY cleanup, avoid destructive git commands.
- Preserve unrelated pre-existing workspace changes.
- Keep behavior changes config-driven and consistent across env defaults, active env, tests, and ops docs.

Key decisions:
- Correct all previously validated doc findings in one pass rather than partial rollout.
- Prefer source-of-truth alignment to code/config/scripts over preserving outdated prose.
- Review scope includes all repo documentation categories requested by user: root/project `README*`, all nested `README*`, all `AGENTS.md`, and architecture/operations/testing docs.
- Use multiple sub-agents with non-overlapping doc subsets and aggregate findings centrally in the main agent report.
- Prioritize source-of-truth validation against current code, scripts, config defaults, tests, and package scripts instead of trusting stale prose.
- Treat this as a code-review style audit: report findings first, ordered by severity, with concrete line references.
- Do not stage exploration rollout; enable immediately for testing.
- Set exploration defaults to `enabled=true`, `maxPairs=30`, `maxPages=3`, `minVolume24h=1000`.
- Keep `MARKET_CATALOG_PAGE_SIZE=100` explicitly in active env.
- Keep `nearZeroFeeBps=0` default so fee-aware gating is backward-compatible until explicitly configured.
- Implement Exa cooldown on auth/billing failures (`401/402`) with explicit telemetry events rather than silent retries.
- Use `npm run dev:ops` / `npm run dev:ops:down` as the canonical persistent runtime workflow because it enforces paper mode and writes logs to `tmp/backend.log` and `tmp/dashboard.log`.
- Apply a conservative tuning strategy first: dedupe/throttle repeated scanner/supervisor rejection events before changing risk thresholds.
- If threshold tuning is needed, start with a small EV relaxation in `extra_high` only (`evEdgeRequired`, `evConfidenceMin`) while preserving safety checks (depth, slippage, max edge, sizing caps).

State:
  - Done:
    - Task 1: Fixed catalog spread validation to use true best prices (max bid, min ask) instead of index-0 levels in `src/services/MarketCatalogRefresher.ts`.
    - Task 1: Added spread-ordering regression tests in `tests/unit/market-catalog-refresher.test.ts`.
    - Task 2: Added env/config knobs for catalog spread and exploration pass in `src/config/env.ts`, `.env.example`, and wired in `src/main.ts`.
    - Task 2: Added config parsing tests for new knobs in `tests/unit/config.test.ts` and kept `.env.example` coverage green.
    - Task 3: Added Exa provider cooldown state in `src/services/websearch/ExaClient.ts` with events `provider_cooldown_started`, `provider_cooldown_skip`, `provider_cooldown_recovered`.
    - Task 3: Added cooldown tests in `tests/unit/websearch.test.ts`.
    - Task 4: Switched near-zero runtime gating to fee-aware checks in scanner + supervisor via `evaluateGatesWithFees` and shared fee model helper in `src/domain/feeModel.ts`.
    - Task 4: Added `nearZeroFeeBps` policy knob in `src/config/policy.ts` and `src/config/schema.ts`.
    - Task 4: Added scanner/supervisor fee-aware regression tests in `tests/unit/scanner-llm.test.ts` and `tests/unit/supervisor-reconciliation.test.ts`.
    - Task 5: Implemented dual-pass catalog discovery (core + bounded exploration) with source-aware funnel metrics in `src/services/MarketCatalogRefresher.ts`.
    - Task 5: Added dual-pass discovery tests for fill order/caps/metrics in `tests/unit/market-catalog-refresher.test.ts`.
    - Task 6: Added active-pair websearch skip metrics in `src/agents/signal/SignalAggregatorAgent.ts` and test coverage in `tests/unit/signal-aggregator.test.ts`.
    - Task 6: Updated ops docs (`docs/Operations/config-knobs.md`) and added rollout runbook (`docs/Operations/README.md`).
    - Validation complete: `npm run lint`, `npm run typecheck`, and full `npm run test` all pass.
    - 2026-02-08: Full validation rerun in paper trading mode passed: `TRADING_MODE=paper npm run lint`, `TRADING_MODE=paper npm run typecheck`, `TRADING_MODE=paper npm run test`.
    - 2026-02-08: Started live paper runtime for observation (`backend` on `:3000`, `dashboard` on `:5174`) using persistent foreground sessions.
    - 2026-02-08: Confirmed authenticated ops endpoints are reachable (`/health`, `/allowlist`, `/incidents`, `/stream`).
    - 2026-02-08: Captured live telemetry: `web_search` and `ev_signal` events active, but `risk`/`order`/`execution_lifecycle` remained `0` in current run.
    - 2026-02-08: Identified recurring blocker in live run: `book_freshness` degraded with `error=no_orderbooks` and repeated incidents.
    - 2026-02-08: Captured recurring realtime parse error during market pair updates: `realtime_error` with detail `Unexpected token 'I', \"INVALID OPERATION\" is not valid JSON` (observed near `market_pairs_updated` events).
    - 2026-02-08: Patched websocket subscription-update path in `src/services/PolymarketRealtime.ts` to stop sending incremental market unsubscribe payloads and instead restart/reconnect with the updated subscription set.
    - 2026-02-08: Patched market-data subscription update ordering in `src/agents/market-data/MarketDataAgent.ts` to apply unsubscribe/restart before new subscriptions during pair rotation.
    - 2026-02-08: Added regression tests for websocket subscription update behavior in `tests/unit/polymarket-realtime.test.ts` and for market-data update ordering in `tests/unit/marketdata-subscriptions.test.ts`.
    - 2026-02-08: Re-ran live paper monitoring loop after patch and confirmed no new `realtime_error` events across subsequent catalog refresh cycles (`market_catalog_refreshed`, `market_pairs_updated`).
    - 2026-02-08: Post-fix live state now reaches healthy book freshness (`book_freshness.ok=true`) with active gate/EV decision streaming.
    - 2026-02-08: Added shared event dedupe helper in `src/utils/eventDedupe.ts` (`normalizeReasonKey`, `shouldEmitScopedReason`) for keyed cooldown suppression.
    - 2026-02-08: Added scanner telemetry dedupe in `src/agents/scanner/ScannerAgent.ts` for repeated near-zero `gate_rejection` and EV rejection `ev_signal` reasons using market/side/reason cooldown keys.
    - 2026-02-08: Added supervisor telemetry dedupe in `src/core/Supervisor.ts` for repeated identical `gate_rejection` emissions in `handleRiskApproved`.
    - 2026-02-08: Tuned paper profile thresholds in `settings/risk-gates/extra_high.json`:
      - Iteration 1: `evEdgeRequired=0.002`, `evConfidenceMin=0.3`.
      - Iteration 2 (paper flow unblock): `evConfidenceMin=0.0`, `evConfidenceMinFloor=0.0`.
    - 2026-02-08: Added scanner dedupe coverage in `tests/unit/scanner-llm.test.ts` and supervisor dedupe coverage in `tests/unit/supervisor-reconciliation.test.ts`.
    - 2026-02-08: Validation passed:
      - Targeted tests: `npm run test -- tests/unit/polymarket-realtime.test.ts tests/unit/marketdata-subscriptions.test.ts tests/unit/scanner-llm.test.ts tests/unit/supervisor-reconciliation.test.ts tests/unit/gates.test.ts tests/unit/telemetry.test.ts`
      - Full paper mode: `TRADING_MODE=paper npm run lint`, `TRADING_MODE=paper npm run typecheck`, `TRADING_MODE=paper npm run test`
    - 2026-02-08: Live paper observation (120s stream sample) after iteration-1 dedupe/tuning:
      - `health` remained healthy with `book_freshness.ok=true`.
      - No `realtime_error` observed in sampled stream.
      - Stream showed `gate_rejection`/`ev_signal` only; no `risk`, `order`, or `execution_lifecycle` events.
      - Dominant blockers remained `edge_below_threshold`, `ev_edge_below_threshold`, and `ev_confidence_below_min`.
      - Dedupe effect confirmed for exact repeats (no consecutive duplicate market/side/reason keys in sampled stream), but alternating reason sets still generate high event volume.
    - 2026-02-08: Live paper observation (90s stream sample) after iteration-2 confidence tuning:
      - `health` remained healthy with `book_freshness.ok=true`.
      - No `realtime_error` observed.
      - Stream included non-zero flow into risk/order path: `event: risk` = 1 and `event: order` = 1 (paper-mode blocked execution as expected), `event: execution_lifecycle` remained 0 in sampled window.
      - Remaining dominant blockers: `edge_below_threshold` and `ev_edge_below_threshold` (confidence blocker largely removed after `evConfidenceMin=0`).
    - 2026-02-08: Iteration-3 tuning applied in `extra_high`: `evEdgeRequired` lowered from `0.002` to `0.001` while keeping `evConfidenceMin=0` and `evConfidenceMinFloor=0`.
    - 2026-02-08: Iteration-3 targeted validation passed: `npm run test -- tests/unit/risk-profile-active.test.ts tests/unit/config.test.ts tests/unit/gates.test.ts`.
    - 2026-02-08: Iteration-3 live paper observation (90s stream sample):
      - Stream events: `gate_rejection`=975, `ev_signal`=883, `risk`=1, `order`=1, `execution_lifecycle`=0, `realtime_error`=0.
      - Dominant blockers remained `edge_below_threshold` and `ev_edge_below_threshold`.
      - Compared with iteration-2, rejection volume increased while risk/order throughput stayed flat in the sampled window.
    - 2026-02-08: Full paper validation on iteration-3 state passed after rerun:
      - `TRADING_MODE=paper npm run lint` passed.
      - `TRADING_MODE=paper npm run typecheck` passed.
      - `TRADING_MODE=paper npm run test` first run had one transient failure (`tests/unit/execution-llm-hints.test.ts` TTL case), rerun passed with 902/902 tests.
    - 2026-02-08: Unexpected runtime issue observed during backend shutdown/run loop: `SQLITE_READONLY_DBMOVED` from `EventStore.persistMetric` while writing metrics.
    - 2026-02-08: Root cause validated for SQLite anomaly: if the live DB file is moved/replaced while prepared statements remain active, SQLite raises `SQLITE_READONLY_DBMOVED` on subsequent writes.
    - 2026-02-08: Implemented EventStore write recovery in `src/core/EventStore.ts`:
      - centralized write wrapper with one-time retry on `SQLITE_READONLY_DBMOVED`,
      - DB close/reopen + statement re-prepare before retry,
      - applied to event append, metric/decision persistence, and idempotency/metrics prune writes.
    - 2026-02-08: Added integration regression test in `tests/integration/event-store.test.ts` that moves/replaces the DB file and verifies write recovery without throwing.
    - 2026-02-08: Validation after SQLite fix:
      - Targeted: `npm run test -- tests/integration/event-store.test.ts tests/unit/slo-aggregates.test.ts tests/unit/main-shutdown.test.ts` (pass).
      - Full: `npm run lint`, `npm run typecheck`, `npm run test` (pass; 903 tests).
    - 2026-02-08: Refined reason-key normalization in `src/utils/eventDedupe.ts` to treat `unstable_top_of_book` and `leg_sync_skew` as transient when a core blocker reason exists, preventing false reason-change emissions within cooldown windows.
    - 2026-02-08: Added/updated dedupe coverage:
      - `tests/unit/event-dedupe.test.ts` (normalization + cooldown behavior),
      - `tests/unit/scanner-llm.test.ts` (scanner suppression when only transient reasons toggle).
    - 2026-02-08: Validation after reason-key normalization:
      - Targeted: `npm run test -- tests/unit/polymarket-realtime.test.ts tests/unit/marketdata-subscriptions.test.ts tests/unit/scanner-llm.test.ts tests/unit/supervisor-reconciliation.test.ts tests/unit/gates.test.ts tests/unit/telemetry.test.ts tests/unit/event-dedupe.test.ts` (pass; 62 tests).
      - Full paper mode: `TRADING_MODE=paper npm run lint`, `TRADING_MODE=paper npm run typecheck`, `TRADING_MODE=paper npm run test` (pass; 907 tests).
    - 2026-02-08: Live paper comparison after reason-key normalization (120s authenticated SSE sample):
      - Baseline sample (`tmp/live-pass/stream-post-sqlite.sse`): `gate_rejection=2238`, `ev_signal=2208`, `risk=1`, `order=0`, `execution_lifecycle=0`, `realtime_error=0`.
      - Updated sample (`tmp/live-pass/stream-post-dedupe-v2.sse`): `gate_rejection=386`, `ev_signal=387`, `risk=2`, `order=1`, `execution_lifecycle=0`, `realtime_error=0`.
      - Result: material telemetry-noise reduction with non-zero risk/order flow retained in paper mode.
    - 2026-02-08: Completed conservative EV-focused tuning pass using one penalty adjustment in `settings/risk-gates/extra_high.json`: `entrySlippageToleranceBps` lowered `150 -> 120`.
    - 2026-02-08: EV-focused 120s before/after live sampling:
      - Baseline (`tmp/live-pass/stream-ev-baseline-before.sse`): `ev_signal=385`, `risk=1`, `order=1`, `execution_lifecycle=0`, `realtime_error=0`, `gate_rejection=385`; dominant EV reasons: `ev_edge_below_threshold` (349), `leg_sync_skew` (315), `unstable_top_of_book` (78).
      - After adjustment (`tmp/live-pass/stream-ev-after-slippage120.sse`): `ev_signal=420`, `risk=2`, `order=2`, `execution_lifecycle=0`, `realtime_error=0`, `gate_rejection=422`; dominant EV reasons: `ev_edge_below_threshold` (326), `leg_sync_skew` (284), `ev_cooldown` (92), `unstable_top_of_book` (66).
      - Net effect in sampled window: `risk`/`order` throughput increased (1→2 each), `ev_edge_below_threshold` occurrences decreased (~6.6%), while total EV event volume increased (~9.1%).
    - 2026-02-08: Post-adjustment targeted validation passed: `npm run test -- tests/unit/risk-profile-active.test.ts tests/unit/config.test.ts tests/unit/gates.test.ts` (94/94).
    - 2026-02-08: Completed threshold-only EV attribution pass with slippage held constant (`entrySlippageToleranceBps=120`) and one config change `evEdgeRequired: 0.001 -> 0.0008` in `settings/risk-gates/extra_high.json`.
    - 2026-02-08: EV threshold-only 120s before/after sampling:
      - Baseline (`tmp/live-pass/stream-evedge-baseline-001.sse`): `ev_signal=453`, `risk=6`, `order=4`, `execution_lifecycle=0`, `realtime_error=0`, `gate_rejection=452`; top EV reasons: `ev_edge_below_threshold` (311), `leg_sync_skew` (276), `ev_cooldown` (133), `unstable_top_of_book` (77).
      - After `evEdgeRequired=0.0008` (`tmp/live-pass/stream-evedge-after-0008.sse`): `ev_signal=442`, `risk=5`, `order=5`, `execution_lifecycle=0`, `realtime_error=0`, `gate_rejection=433`; top EV reasons: `ev_edge_below_threshold` (332), `leg_sync_skew` (279), `ev_cooldown` (98), `unstable_top_of_book` (91).
      - Net effect in sampled window: `ev_signal` down (~2.4%), `gate_rejection` down (~4.2%), `risk` down (6→5), `order` up (4→5), and `ev_edge_below_threshold` count up (~6.8%).
    - 2026-02-08: Threshold-only post-change targeted validation passed: `npm run test -- tests/unit/risk-profile-active.test.ts tests/unit/config.test.ts tests/unit/gates.test.ts` (94/94).
    - 2026-02-08: Completed longer 10-minute confirmation run on current profile (`entrySlippageToleranceBps=120`, `evEdgeRequired=0.0008`) with authenticated SSE capture `tmp/live-pass/stream-evedge-long-10min.sse`.
    - 2026-02-08: 10-minute sample summary:
      - Event counts: `ev_signal=2170`, `gate_rejection=2151`, `risk=29` (`approved=22`, `rejected=7`), `order=21`, `execution_lifecycle=0`, `realtime_error=0`.
      - Per-minute rates: `ev_signal≈217.0/min`, `gate_rejection≈215.1/min`, `risk≈2.90/min`, `order≈2.10/min`.
      - Dominant EV reasons: `ev_edge_below_threshold` (1598), `leg_sync_skew` (1376), `ev_cooldown` (500), `unstable_top_of_book` (293), `below_min_order_size` (53), `ev_selected` (29).
      - Dominant risk reject reason remained `unwind_loss_bps_exceeded` (`7` in sample).
    - 2026-02-08: Applied post-analysis profile decision in `settings/risk-gates/extra_high.json`: reverted `evEdgeRequired` back to `0.001` while keeping `entrySlippageToleranceBps=120`.
    - 2026-02-08: Post-decision targeted validation passed: `npm run test -- tests/unit/risk-profile-active.test.ts tests/unit/config.test.ts tests/unit/gates.test.ts` (94/94).
    - 2026-02-08: Completed multi-agent deep documentation audit across all `README*`, all `AGENTS.md`, and all `docs/*.md` architecture/operations/testing docs.
    - 2026-02-08: Consolidated severity-ranked documentation findings with source-backed evidence and correction recommendations.
    - 2026-02-08: Applied documentation corrections for all reported `High`, `Medium`, and `Low` findings across architecture docs, README, root/backend/dashboard AGENTS docs, and testing/websearch/signal AGENTS docs.
    - 2026-02-08: Completed post-edit grep consistency sweep for previously flagged stale phrases and references (no remaining matches).
    - 2026-02-08: Generated five Gemini README hero image concepts in `docs/assets/readme/` using project-aligned palette and architecture motifs.
    - 2026-02-08: User feedback received: prior set does not read clearly as a trading tool.
    - 2026-02-08: Read project README and core runtime code for architecture-faithful image direction:
      - `src/main.ts` boot wiring (catalog, allowlist, ops, signal/scanner/risk/execution/portfolio agents).
      - `src/core/Supervisor.ts` event-driven pipeline and gate/risk handoff.
      - `src/agents/market-data/MarketDataAgent.ts` + `src/services/PolymarketRealtime.ts` + `src/services/PolymarketClob.ts` for WS/REST orderbook flow.
      - `src/domain/gates.ts` for edge/spread/staleness/depth/slippage gate semantics.
      - `src/agents/risk/RiskAgent.ts` and `src/agents/execution/ExecutionAgent.ts` for sizing, idempotency, ACK/fill lifecycle, partial-fill unwind handling.
      - `src/api/server.ts` + dashboard pages for ops surfaces (`/health`, `/metrics`, `/slo`, `/allowlist`, `/markets`, `/portfolio`, `/stream`).
    - 2026-02-08: Generated v2 image batch at `docs/assets/readme/v2/` with stronger trading UI prompts.
    - 2026-02-08: Generated code-faithful v3 image batch at `docs/assets/readme/v3/` using prompts derived from README + core trading code.
    - 2026-02-08: Completed v3 visual review; strongest trading-tool fidelity options are v3-01, v3-05, and v3-04.
    - 2026-02-08: User selected `docs/assets/readme/v2/readme-hero-v2-05.jpg` for README usage.
    - 2026-02-08: Embedded selected image in `README.md` directly under badge row.
    - 2026-02-08: Applied visual tweaks in `README.md`: moved hero below tagline, wrapped in centered HTML, and added caption text.
    - 2026-02-09: Re-ran multi-agent documentation audit across all `README*`, all `AGENTS.md`, and all `docs/**/*.md` with non-overlapping reviewer scopes.
    - 2026-02-09: Validated reported issues against source-of-truth code/config/scripts and prepared severity-ranked correction backlog.
    - 2026-02-09: Applied all verified `High`/`Medium`/`Low` documentation corrections across `README.md`, `AGENTS.md`, `src/AGENTS.md`, `dashboard/AGENTS.md`, `dashboard/src/pages/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/Development/setup.md`, `docs/Development/market-catalog.md`, `docs/Development/architecture-decisions.md`, `docs/Operations/security.md`, `docs/Operations/config-knobs.md`, and `docs/Operations/runbook.md`.
    - 2026-02-09: Completed post-edit validation: markdown link sweep reports `NO_MISSING_LOCAL_LINKS`; stale-phrase grep checks report no remaining matches for corrected findings.
  - Now:
    - Documentation correction pass is complete and ready for user verification.
  - Next:
    - User acceptance check.
      action: confirm corrected documentation language and scope meets expectations.
      expected outcome: explicit acceptance or additional change requests.
      files: all edited documentation files.
    - Optional consistency hardening.
      action: reduce brittle hardcoded file/test counts in AGENTS docs where possible.
      expected outcome: fewer future doc drifts from repository growth.
      files: `AGENTS.md`, `src/AGENTS.md`.
    - Optional automation.
      action: add a CI lint/check step for local markdown link validity.
      expected outcome: broken local links are caught automatically on PRs.
      files: CI workflow and docs lint script (if requested).
    - Publish final correction summary.
      action: provide a concise changelog of what was fixed and why.
      expected outcome: clear maintainer handoff.
      files: final response and continuity ledger entry.

Open questions (UNCONFIRMED if needed):
- None at this stage.

Working set (files/ids/commands):
- Docs reviewed:
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `docs/Development/setup.md`
  - `docs/Development/market-catalog.md`
  - `docs/Development/architecture-decisions.md`
  - `docs/Operations/README.md`
  - `docs/Operations/config-knobs.md`
  - `docs/Operations/runbook.md`
  - `docs/Operations/security.md`
  - `docs/Testing/strategy.md`
  - `docs/assets/readme/README_IMAGE_PROMPTS.md`
  - `docs/assets/readme/README_IMAGE_PROMPTS_v2.md`
  - `docs/assets/readme/README_IMAGE_PROMPTS_v3.md`
- AGENTS reviewed:
  - `AGENTS.md`
  - `src/**/AGENTS.md`
  - `dashboard/**/AGENTS.md`
  - `tests/**/AGENTS.md`
  - `scripts/AGENTS.md`
- Validation references:
  - `package.json`
  - `docker-compose.yml`
  - `src/config/env.ts`
  - `src/config/policy.ts`
  - `src/config/risk.ts`
  - `src/config/validate.ts`
  - `src/telemetry/metrics.ts`
  - `src/api/server.ts`
  - `src/agents/execution/ExecutionAgent.ts`
  - `dashboard/src/pages/RiskGates.tsx`

Key learnings: what worked; what didn't work, best approach identified for next time
- Spread correctness should be fixed before threshold tuning; otherwise telemetry interpretation is confounded.
- Provider cooldowns are most useful when paired with explicit skip/start/recover metrics for operational clarity.
- Fee-aware gating can be introduced safely by defaulting fee knobs to zero and adding targeted regression tests for both fee-on and fee-off paths.
- Changing exploration defaults affects refresher tests that assume one-pass behavior; those tests should explicitly set `explorationEnabled` to avoid brittle dependency on global defaults.
- In live paper mode, EV/websearch can appear healthy while trading remains fully blocked if orderbook ingestion is empty; `book_freshness=no_orderbooks` must be treated as a primary pipeline health gate.
- For dynamic market rotation, apply unsubscribe/restart first and then add new subscriptions to avoid transient invalid operations during large pair-set changes.
- Multi-agent documentation audits are effective when split by doc category (architecture, AGENTS policies, dashboard docs, command/path validation) and merged centrally with evidence-backed severity ranking.
- For README hero generation, grounding prompts in existing design tokens (`tokens.css`) and favicon accents yields visually consistent outputs quickly.
