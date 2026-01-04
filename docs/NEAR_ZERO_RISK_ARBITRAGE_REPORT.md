# Near-Zero Risk Arbitrage: Actionable Lessons Report

**Source:** arXiv:2508.03474 + Internal Reports (polymarket_arbitrage_report 1-3)  
**Date:** 2026-01-03  
**Scope:** Speed of execution, strategies, technology stack, trading methodologies

---

## Executive Summary

This report synthesizes findings from the academic paper "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets" (arXiv:2508.03474) and three internal analysis reports to produce actionable guidance for enhancing our Polymarket arbitrage system while maintaining a **strict near-zero-risk posture**.

**Key insight:** Polymarket CLOB execution is **non-atomic across legs**. Therefore "near-zero risk" cannot mean "theoretically risk-free" — it must mean **bounded, pre-budgeted worst-case losses with deterministic recovery playbooks**.

---

## 1. Definition: "Near-Zero Risk" in This Domain

Given non-atomic execution, we define near-zero risk as:

1. **No unhedged exposure** unless immediately unwindable within a pre-budgeted max loss
2. **Deterministic failure playbook** for every opportunity (timeouts, cancellations, unwind orders, market quarantine)
3. **Expected edge pays for failures** (slippage + unwind losses + operational delays), not just fees

This aligns with the paper's repeated emphasis: **execution is the real risk surface**.

---

## 2. Empirical Findings from the Research

### 2.1 Profit Distribution (arXiv:2508.03474)

| Strategy Type | Realized Profit | Key Observation |
|---------------|-----------------|-----------------|
| Single-condition rebalancing | ~$10.6M | Dominated by YES+NO < $1 opportunities |
| Multi-outcome rebalancing | ~$28.3M (buying NO) | NO-heavy strategy outperforms |
| Combinatorial (cross-market) | ~$95K across 5 pairs | Rare, low liquidity, high complexity |
| **Total extracted** | **~$40M** | Rebalancing >> Combinatorial |

### 2.2 Key Parameters Used in Detection

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Minimum profit threshold | $0.05 per $1 | Covers non-atomic execution risk |
| Price validity window | 5,000 blocks (~2.5 hours) | Carry forward last known price |
| Uncertainty filter | No token > $0.95 | Focus on liquid, uncertain markets |
| Trade grouping window | 950 blocks (~1 hour) | Captures 75% of arbitrage attempts |
| Bid size filter | > $2.00 | Focus on meaningful opportunities |

### 2.3 LLM Dependency Detection

- Model: DeepSeek-R1-Distill-Qwen-32B
- Markets with >4 conditions reduced to top 4 by volume + 1 OR "other" condition
- 90%+ of liquidity resides in top 4 conditions
- Success rate: 81.45% valid JSON returns for single-market inference

---

## 3. Near-Zero Risk Strategy Hierarchy

### P0 (Primary) — Binary Complete-Set BUY

**Condition:** `YES_ask + NO_ask < 1.00 - buffer`

**Mechanics:**
- Buy one unit of both YES and NO positions
- Merge to collateral ($1.00) at resolution OR hold to resolution
- Guaranteed profit = `1.00 - (YES_ask + NO_ask)`

**Edge Formula:**
```
edge = 1.0 - (p_yes + p_no) - fees_estimate - expected_slippage - merge_gas_amortized
```

**Production Gates:**
| Gate | Threshold | Rationale |
|------|-----------|-----------|
| Minimum edge | ≥ 3¢ (0.03) initially | Covers unwind failures |
| Depth buffer | 1.5-2.0x trade size | Ensures fillability |
| Book freshness | < 500ms since update | Rejects stale data |
| Delayed ACK | Hard reject | Treat as execution uncertainty |

**Execution:**
```typescript
// Batch-submit both legs as FOK
await Promise.all([
  client.createOrder({ tokenID: yesTokenId, amount: q, price: yesAsk, OrderType.FOK }),
  client.createOrder({ tokenID: noTokenId, amount: q, price: noAsk, OrderType.FOK })
]);
```

**Failure Recovery:**
```typescript
if (yesFilled && !noFilled) {
  // Immediate unwind with max-loss cap
  await client.createOrder({ 
    tokenID: yesTokenId, 
    amount: filledSize, 
    side: SELL,
    OrderType.FAK,
    maxSlippage: MAX_UNWIND_LOSS_BPS
  });
  circuitBreaker.quarantine(marketId, 600); // 10 min cooldown
  incidentTracker.record({ type: 'one_leg_filled', severity: 'high' });
}
```

---

### P0 (Secondary) — Binary Complete-Set SELL

**Condition:** `YES_bid + NO_bid > 1.00 + buffer`

**Mechanics:**
- Split collateral into YES + NO positions (or use existing inventory)
- Sell both legs
- Guaranteed profit = `(YES_bid + NO_bid) - 1.00`

**Additional Requirements:**
- Reliable split pipeline OR pre-positioned inventory
- Higher edge threshold (≥ 50-100 bps) due to operational complexity

**Implementation Priority:** After BUY is stable in production.

---

### P1 — Multi-Outcome Complete-Set BUY

**Condition:** `Σ(outcome_asks) < 1.00 - buffer`

**Mechanics:**
- Buy one unit of all N outcomes
- One outcome resolves true → receive $1.00

**Additional Constraints:**
- More legs = higher failure probability
- Size determined by weakest-liquidity outcome
- Edge threshold: ≥ 50-150 bps depending on N

**Implementation Priority:** After binary strategies are stable.

---

### Deprioritized (NOT Near-Zero Risk)

| Strategy | Why Deprioritized |
|----------|-------------------|
| Combinatorial/cross-market | 62% failure rate in paper; semantic mismatch risk; only 13 strong pairs found |
| Weak/temporal dependency | Directional exposure unless perfectly hedged |
| Cross-venue arbitrage | Contract equivalence risk; oracle divergence; Phase 2+ only |
| Implied probability parity | Requires external options market; model risk |

---

## 4. Speed of Execution Enhancements

### 4.1 Latency Instrumentation (Must-Have)

Add metrics for:

| Metric | Description | Target |
|--------|-------------|--------|
| `book_staleness_ms` | `now - last_book_update_ms` per token | < 500ms |
| `decision_latency_ms` | Opportunity detected → orders submitted | < 50ms |
| `api_ack_latency_ms` | Submit → ACK per leg | Baseline + monitor |
| `api_fill_latency_ms` | Submit → FILL per leg | Baseline + monitor |
| `fill_probability` | By market, spread regime, time-of-day | > 95% for active markets |
| `delayed_rejection_rate` | ORDER_DELAYED / total submits | < 1% |
| `one_leg_fill_rate` | Partial fills / total paired attempts | < 0.1% |

### 4.2 Reduce Time-to-Submit

| Optimization | Implementation |
|--------------|----------------|
| **Persistent connections** | Keep WS (market + user) and HTTP connections warm; no cold-start DNS/TLS |
| **Precompute order templates** | Cache tokenId, tickSize rounding, size bounds per market |
| **Single fast path** | opportunity → validate → submit with no extra awaits |
| **Batch submission** | Submit both legs in single batch request (up to ~15 orders supported) |

### 4.3 Infrastructure Placement

| Action | Rationale |
|--------|-----------|
| Deploy in low-RTT region to Polymarket CLOB | Network latency dominates; language micro-optimizations secondary |
| Co-locate with RPC provider | On-chain reconciliation benefits from low latency |
| Enforce network SLOs | If p95 RTT crosses threshold, widen edges or halt trading |

### 4.4 Runtime Optimization (Node/TS)

| Optimization | Implementation |
|--------------|----------------|
| Async logging | Buffer structured logs; emit metrics asynchronously |
| Single orderbook cache | One in-memory cache per token; avoid deep array copies |
| Minimal hot-path middleware | Separate ops API from trading core |
| Avoid sync JSON in hot path | Use streaming parsers if needed |

---

## 5. Trading Methodology Hardening

### 5.1 Paired-Order State Machine (Critical)

```
States:
  validated_book
    → submit_both
      → ack_both
        → filled_both ✓
      → one_leg_ack_failed
        → cancel_other → quarantine_market
    → any_delayed_ack
      → cancel_all → quarantine_market
  book_stale
    → reject_opportunity
  one_leg_filled
    → immediate_unwind → quarantine_market
```

**Success Criteria:** Provable max loss per incident is capped.

### 5.2 Sizing Policy

Size each trade as:
```
size = min(
  capital_fraction_limit,           // e.g., 10% of equity
  depth_limit,                      // 10-20% of top-3-level depth
  max_unwind_loss_budget / worst_case_slippage
)
```

Scale only when:
- Paired-fill success rate > 99%
- Realized slippage < budget
- No repeated one-leg incidents

### 5.3 Execution Regimes

Maintain per-market/token stats:
- Regime classification: stable/liquid vs unstable/thin
- Typical spread, depth, fill rate
- Regime-specific thresholds:

| Regime | Min Edge (ticks) | Min Edge (bps) | Depth Buffer |
|--------|------------------|----------------|--------------|
| Stable/Liquid | 1-2 | 20-50 | 1.5x |
| Unstable/Thin | 3-4 | 100-200 | 2.5x |
| Sports/Volatile | Exclude initially | — | — |

---

## 6. Risk Controls (Priority Order)

1. **Kill switch** — Global `TRADING_ENABLED` flag
2. **Circuit breakers** — Trigger on:
   - Repeated partial fills (> 2 in 10 min)
   - Repeated unwind losses exceeding budget
   - WS disconnect / stale book (> 5s)
   - RPC degradation (p95 > 2x baseline)
3. **Market allowlist + quarantine** — Freeze anomalous markets
4. **Exposure caps** — Per market/condition + global
5. **Reconciliation** — CLOB fills vs internal position vs on-chain balances

---

## 7. Technology Stack Guidance

### Current Stack Assessment (Node/TypeScript)

**Verdict:** Acceptable for production. Network latency dominates; language is not the bottleneck.

**Real leverage comes from:**
1. Deployment locality + persistent connections
2. Batch order submission
3. Tight hot path + instrumentation
4. Risk-state machine + deterministic recovery

**Consider language switch (Rust/Go) only if:** Metrics show CPU/GC is the bottleneck after above optimizations (usually won't be).

---

## 8. Implementation Checklist

### Phase 1: Instrumentation + Hardening (1-2 weeks)

- [ ] Add latency metrics (book staleness, submit→ack, submit→fill)
- [ ] Add fill probability tracking by market regime
- [ ] Add one-leg-fill incident tracking + unwind cost distribution
- [ ] Implement strict execution gates:
  - [ ] Reject stale books (> 500ms)
  - [ ] Reject delayed acks
  - [ ] Require depth buffers (1.5x minimum)
  - [ ] Require min edge (3¢ initially)
- [ ] Implement paired-order state machine with deterministic unwind
- [ ] Implement market quarantine on incidents
- [ ] Deploy shadow mode for threshold calibration

### Phase 2: Strategy Expansion (after shadow validation)

- [ ] Enable SELL-side (split + dual-sell) with stricter thresholds
- [ ] Add multi-outcome complete-set detection
- [ ] Calibrate per-regime thresholds from fill stats
- [ ] Scale sizing based on observed reliability

### Phase 3: Advanced (only after proven stability)

- [ ] Evaluate combinatorial opportunities (manual validation only)
- [ ] Consider cross-venue integration (Kalshi)
- [ ] Implement passive maker/taker hybrid (inventory-bounded)

---

## 9. Metrics for Success

### Operational Metrics

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Paired-fill success rate | > 99% | < 98% |
| One-leg-fill incidents | < 1 per 1000 attempts | > 3 per day |
| Unwind loss per incident | < budgeted max | Any breach |
| Decision latency p95 | < 100ms | > 200ms |
| API roundtrip p95 | Baseline + 20% | Baseline + 50% |

### Financial Metrics

| Metric | Description |
|--------|-------------|
| Gross edge captured | Sum of theoretical edge on executed opportunities |
| Net PnL | After slippage, unwind losses, gas |
| Edge leakage | Gross edge - Net PnL (target: < 20% of gross) |
| Sharpe ratio | Risk-adjusted returns (target: > 3.0 for near-zero-risk) |

---

## 10. Key Lessons Summary

1. **Execution is the risk surface** — not price theory
2. **Edge thresholds must pay for failures** — not just fees
3. **Size to worst-case unwind** — not to available capital
4. **Rebalancing dominates** — ~99% of realized profit from single-market strategies
5. **Combinatorial is Phase 2+** — complexity and failure rate too high for near-zero-risk
6. **Measure everything** — can't optimize what you can't see
7. **Batch is essential** — tightest possible window for multi-leg submission
8. **Quarantine fast** — any anomaly → immediate market freeze

---

## Appendix A: Paper Citation Reference

| Section | Key Content |
|---------|-------------|
| 3.2.1 | Market Rebalancing Arbitrage definition (long/short) |
| 3.2.2 | Combinatorial Arbitrage definition |
| 5 | LLM-based dependency detection methodology |
| 6 | Arbitrage opportunity detection with VWAP |
| 7 | Arbitrageur identification and profit measurement |
| Appendix B | LLM prompt for pair detection |
| Appendix F | Dependent pair markets for US election |

---

## Appendix B: Strategy Suitability Matrix

| Strategy | Near-Zero Risk? | Phase | Rationale |
|----------|-----------------|-------|-----------|
| Binary complete-set BUY | ✅ Yes | 1 | Simple, proven, bounded risk with proper gates |
| Binary complete-set SELL | ✅ Yes | 1 | Same mechanics, requires inventory/split |
| Multi-outcome complete-set | ⚠️ Conditional | 2 | More legs = higher failure probability |
| Combinatorial/cross-market | ❌ No | 3+ | 62% failure rate, semantic risk |
| Cross-venue arbitrage | ❌ No | 3+ | Oracle divergence, settlement mismatch |
| Implied probability parity | ❌ No | N/A | Requires external venue, model risk |

---

*Report generated from synthesis of arXiv:2508.03474 and internal research reports.*
