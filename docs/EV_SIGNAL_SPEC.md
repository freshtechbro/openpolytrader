# EV / Model-Based Signal Spec (Non-Arb)

## Summary
Introduce an EV-based signal path that can run alongside the existing near-zero (paired-ask arbitrage) logic. The system can run:
- both near-zero and EV (default)
- near-zero only
- EV only

EV opportunities are created when a model-derived probability indicates positive expected value relative to market prices, even when yes_ask + no_ask >= 1.

## Research Summary (Best Practices)
- Prediction market prices are informative but can be biased by risk aversion and belief dispersion; treat market price as a strong prior, not ground truth. [Wolfers and Zitzewitz 2006]
- Probabilistic forecasts should be evaluated with proper scoring rules (e.g., log score, Brier) and calibration diagnostics; calibration and sharpness are distinct goals. [Gneiting and Raftery 2007; Brier 1950]
- Modern models are often miscalibrated; temperature scaling is a low-overhead post-hoc calibration method. [Guo et al. 2017]
- Forecast combination (weighted averages / model averaging) often outperforms single models; use validation-based weights when blending market prior + model outputs. [Winkler and Makridakis 1983; EBMA]
- Web search and content retrieval can supply broad, low-cost signals when dedicated social/news APIs are disabled; use Exa search + contents by default, and optional Firecrawl search/scrape/crawl for heavier extraction. [Exa Search/Contents; Firecrawl Search/Crawl/Scrape]
- Limit order book imbalance and liquidity measures can correlate with short-horizon price moves, but predictive power decays quickly; treat microstructure signals as short-term, high-noise features. [Corradi et al. 2015; Cont et al. 2010/2013; Gould and Bonart 2015; Chordia et al. 2002]

## Goals
- Add an EV signal path without removing near-zero arb logic.
- Allow operators to select signal mode: both | near_zero | ev (default: both).
- Maintain existing gate safety (staleness, spreads, depth, tick alignment, min order size).
- Provide clear observability for EV decisions, model confidence, and outcomes.

## Non-Goals
- Replace execution logic or existing risk controls.
- Mandate a specific model provider. The spec allows pluggable models.
- Assume inventory-risk-free execution. EV mode is explicitly risk-taking.

## Configuration

### Signal Mode
- signalMode: near_zero | ev | both
- default: both

### EV Signal Knobs (policy)
- evEdgeRequired (fraction, default 0.01)
- evFeeBps (default 0)
- evConfidenceMin (0..1, default 0.6)
- evMaxPerMarketNotional (default 100)
- evMaxPortfolioNotional (default 300)
- evCooldownSeconds (default 120)

### EV Modeling Knobs
- evModelMode: baseline | hybrid | llm_only (default hybrid)
- evModelRefreshMinutes (default 60)
- evCalibrationMethod: sigmoid | isotonic | temperature (default sigmoid)
- evModelConfidenceFloor (default 0.55)

### Web Search Signal Knobs (default Exa on, Firecrawl off)
- evWebSearchExaEnabled (default true)
- evWebSearchFirecrawlEnabled (default false)
- evWebSearchPrimary: exa | firecrawl (default exa)
- evWebSearchLookbackDays (default 7)
- evWebSearchMaxResults (default 10)
- evWebSearchCacheTtlSeconds (default 3600)
- evWebSearchMaxConcurrency (default 3)
- evWebSearchFirecrawlMaxDepth (default 2)
- evWebSearchFirecrawlMaxPages (default 10)
- evWebSearchDomainAllowlist (optional)
- evWebSearchDomainDenylist (optional)

### Web Search Credentials / Limits
- EXA_API_KEY (required if evWebSearchExaEnabled)
- FIRECRAWL_API_KEY (required if evWebSearchFirecrawlEnabled)
- evWebSearchRequestsPerMinute (default 30)
- evWebSearchMaxContentBytes (default 500000)

## Signal Families and Sources

### 1) Market Prior (mandatory)
Use the market price as a prior probability. For EV use mid or microprice, not just best ask. [Wolfers and Zitzewitz 2006]

### 2) Web Search & Scrape Signals (Exa default; Firecrawl optional)
Use web search to collect relevant news, blog posts, filings, and data sources without paid social/news APIs.
- Exa: use /search + /contents to retrieve relevant pages and extract text. [Exa Search/Contents]
- Firecrawl (optional): use /search for discovery and /scrape or /crawl for JS-heavy or deep extraction. [Firecrawl Search/Crawl/Scrape]
- Prefer domain allowlists, deduplication, and TTL caching to control cost and avoid repeated fetches.
- Normalize sources via entity extraction, date filtering, and credibility weighting.

### 3) Market Microstructure Signals
Use only as short-horizon features; microstructure signals can be predictive at intraday horizons but decay quickly.
- Order flow imbalance (OFI) and multi-level book imbalance can improve near-term forecasts. [Cont et al. 2010/2013; Gould and Bonart 2015]
- Liquidity imbalance can correlate with subsequent price moves on short time scales. [Corradi et al. 2015]
- Order imbalance effects are mostly contemporaneous and do not persist at longer horizons. [Chordia et al. 2002]

## Probability Estimation Architecture (Most Efficient + Accurate)

### Recommended Hybrid Stack
1. Market prior (price-based) -> logit(p_mkt)
2. Fast numeric model (logistic regression or gradient boosting) on structured features
3. Optional text model (LLM or transformer) for complex or ambiguous events
4. Calibrated meta-model (stacking) to combine signals into final probability p_final

This balances efficiency (fast numeric model) and accuracy (text-aware model) while anchoring to market priors.

### Efficiency Strategy
- Two-stage inference:
  - Stage A: fast model only for all markets
  - Stage B: expensive model only if Stage A uncertainty is high or EV close to threshold
- Cache text embeddings and news summaries with TTL

### Calibration
- Apply post-hoc calibration to final probabilities (sigmoid/Platt, isotonic, temperature). [Guo et al. 2017; Kull et al. 2023]
- Track calibration curves, ECE, Brier, and log loss. [Gneiting and Raftery 2007; Brier 1950]

## Evaluation & Validation
- Use rolling-origin / time-series cross-validation to avoid leakage in temporal data. [Hyndman and Athanasopoulos FPP3]
- Maintain strict out-of-sample holdouts for live performance estimation.

## EV Signal Generation
- Obtain p_final for YES.
- EV formulas:
  - ev_yes = p_final - yes_ask
  - ev_no = (1 - p_final) - no_ask
- Apply evEdgeRequired, confidence gate, and fee/slippage adjustments:
  - ev_net = ev_raw - evFeeBps/10000 - slippage_estimate
- Choose the side with max ev_net if positive.

## Agent Usage (Yes, but not as sole estimator)
- Use a dedicated Signal Aggregator Agent to:
  - run Exa search + contents by default, and optional Firecrawl search/scrape/crawl
  - produce structured features and summaries
- Probability estimation remains a calibrated model output, not raw LLM output.
- LLMs are used for text extraction, entity resolution, and summarization, with strict guardrails and calibration.

## Integration Options (Direct API vs MCP)
- Direct API (recommended for production): backend service calls Exa and Firecrawl HTTP APIs directly and stores normalized outputs.
- MCP: use Exa MCP or Firecrawl MCP to give LLM tool access for on-demand research; treat as optional and gated by config.
- Both modes can coexist (API for scheduled ingestion, MCP for ad-hoc enrichment).

### Direct API Integration Design (Recommended)
1. Build query set from market metadata (question, outcomes, tags, resolution criteria).
2. Exa primary: run /search, then /contents for top-N results.
3. Firecrawl optional: when Exa has thin content or JS-heavy pages, run /scrape or /crawl on selected URLs.
4. Normalize: extract entities, timestamps, claims, and sentiment cues; drop stale or low-credibility sources.
5. Cache: store URL hash + fetched text with TTL; skip re-fetch within TTL.
6. Cache bounds: prune expired entries and cap cache size to avoid unbounded growth.
7. Emit features: mention counts, recency-weighted sentiment, event indicators, and source credibility score.

## Risk Controls
- Portfolio caps and per-market EV caps
- EV cooldowns
- Source weighting, deduplication, and stale-content rejection
- EV trades require user WebSocket fill tracking; block EV execution when user WS is unavailable.
- Hard limits on slippage/OTR/latency remain unchanged

## Observability
- signal_ev count, model_probability, model_confidence
- ev_estimate, ev_rejection_reason
- calibration metrics: brier, log loss, ECE
- web_search: requests, cache_hit_ratio, failures, latency_ms, bytes_fetched
- source health: missing signals, API errors, rate limit events

## Rollout Plan
1. Shadow: generate EV signals only
2. Paper: low caps, high confidence thresholds
3. Live: gradual caps with monitoring and rollback

## References
- https://www.nber.org/papers/w12200 (Wolfers and Zitzewitz 2006)
- https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf (Gneiting and Raftery 2007)
- https://ui.adsabs.harvard.edu/abs/1950MWRv...78....1B/abstract (Brier 1950)
- https://proceedings.mlr.press/v70/guo17a.html (Guo et al. 2017)
- https://link.springer.com/article/10.1007/s10994-023-06336-7 (Kull et al. 2023 calibration survey)
- https://otexts.com/fpp3/tscv.html (Hyndman and Athanasopoulos - time series CV)
- https://academic.oup.com/jrsssa/article/146/2/150/7105981 (Winkler and Makridakis 1983)
- https://www.cambridge.org/core/journals/political-analysis/article/improving-predictions-using-ensemble-bayesian-model-averaging/11866974EE2888D4A2988309FC6B602F (EBMA)
- https://docs.exa.ai/reference/search (Exa Search)
- https://docs.exa.ai/reference/contents-retrieval (Exa Contents)
- https://docs.exa.ai/reference/exa-mcp (Exa MCP)
- https://docs.firecrawl.dev/api-reference/endpoint/search (Firecrawl Search)
- https://docs.firecrawl.dev/api-reference/endpoint/scrape (Firecrawl Scrape)
- https://docs.firecrawl.dev/api-reference/endpoint/crawl (Firecrawl Crawl)
- https://docs.firecrawl.dev/mcp (Firecrawl MCP)
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2477801 (Corradi et al. 2015)
- https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1719682 (Cont et al. 2010)
- https://arxiv.org/abs/1303.4853 (Cont et al. 2013)
- https://arxiv.org/abs/1411.6863 (Gould and Bonart 2015)
- https://doi.org/10.1111/1540-6261.00488 (Chordia et al. 2002)
