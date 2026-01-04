# Approach Critique and Hardening Notes

Last Updated: 2026-01-01

## Purpose
Identify loopholes in the current approach, propose defensive mechanisms against losses, and highlight profitability levers. This document complements `docs/RESEARCH_REPORT.md` and `docs/ARCHITECTURE.md`.

---

## Critical loopholes (must close)

1) **Two-leg atomicity is not guaranteed**
- FOK is per-order only; batch create does not promise atomicity.
- Impact: one-leg fills can still happen and dominate long-run PnL if not tightly gated.
- Blocker: treat any delayed matching as no-trade, require deep/stable books, and run an incident playbook that flattens exposure fast.

2) **Orderbook staleness and quote flicker**
- Using only top-of-book snapshots increases exposure to stale or spoofed liquidity.
- Impact: higher one-leg fill probability; adverse selection.
- Blocker: enforce freshness (WS age threshold), stability windows, and depth headroom across multiple levels.

3) **Sizing by profit instead of notional (logic bug risk)**
- Risk sizing must be based on notional and depth-limited size, not projected profit.
- Impact: position sizes could be materially wrong under fast books.
- Blocker: size by notional, cap by depth, and tie size to loss budget.

4) **No per-market quarantine after incidents**
- A market that triggered `ORDER_DELAYED` or a partial fill is likely unsafe for a window.
- Impact: repeated tail losses from the same market.
- Blocker: quarantine the market, cool down globally, and require fresh telemetry before re-adding.

5) **Pre-trade funds/allowance checks not explicit**
- One-leg failures can happen if allowance or balance is insufficient at the moment of placement.
- Impact: unnecessary inventory risk.
- Blocker: confirm allowance + balance in the critical path (fast cache + periodic on-chain refresh).

---

## Profitability levers (safe improvements)

- **EV gating with tail-loss accounting**: require `p2 * edge - pFail * L - costs > 0`, and enforce very low `pFail` for any trade labeled "risk-free".
- **Telemetry-based market allowlist**: only trade markets with strong recent fill success and low delayed-rate.
- **Auto-sizing by loss budget**: compute a conservative loss-per-failed-attempt and shrink size when uncertainty increases.
- **Batch placement to reduce skew**: batch both legs where supported; reduce time between legs to lower failure risk.
- **Liquidity rewards (optional, not risk-free)**: if enabled later, two-sided quoting can add income but must be isolated from the risk-free strategy.

---

## Risk-free trading hardening (policy checklist)

- Fresh WS snapshot and stable top-of-book (N updates or T ms).
- Depth headroom: trade size <= 25% of depth across top 3 levels.
- Edge buffer: strict `YES_ask + NO_ask <= 0.97` until telemetry justifies loosening.
- Strict delay handling: treat `status=delayed` / `ORDER_DELAYED` as a hard no-trade.
- Single-shot orders: no retry without a new book check.
- Incident playbook: bounded completion attempt, then immediate unwind with max-loss cap.

---

## Phase 2 readiness (infuse now)

- Introduce a `VenueAdapter` interface and a `ContractMapper` for strict contract equivalence.
- Track per-venue fees and rate limits in the EV gate (Kalshi fees are non-zero).
- Pre-fund both venues; transfers must stay out of the critical path.
- Per-venue health checks and kill switches (rate limit, maintenance, trading pause).

---

## Recommended doc updates

- Fix FOK language in `docs/POLYMARKET_CLOB_LIQUIDITY_GUIDE.md` to avoid implying two-leg atomicity.
- Add execution hardening and Phase 2 scaffolding to `docs/ARCHITECTURE.md`.
- Add profitability + defense addendum to `docs/RESEARCH_REPORT.md`.
