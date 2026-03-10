# Search Provider Cost Review - 2026-03-08

This report reviews OpenPolyTrader's current EV web-search path, critiques the proposed `GDELT -> Exa|Serper` idea, compares current provider facts as of March 8, 2026, and recommends the lowest-cost deployment shape that preserves decision quality and speed.

Companion implementation contract: [SEARCH_PROVIDER_ROUTING_TECHNICAL_SPEC.md](./SEARCH_PROVIDER_ROUTING_TECHNICAL_SPEC.md)

Audit refresh on March 10, 2026:

- corrected "current repo behavior" to distinguish policy defaults from runtime activation;
- corrected the provider fallback path so content fetch now follows the provider that produced the result URLs;
- refreshed Exa pricing facts after Exa's March 3, 2026 pricing update, which now includes contents for 10 search results per request at no additional cost on search requests;
- noted the spend controls that are already landed in code.

---

## Executive summary

The best fit for this repo is not a flat three-provider blend and not a pure GDELT replacement.

The best fit is a tiered router:

1. `GDELT` as the cheap narrative/change detector.
2. `Serper` as the default paid confirmer for live escalation.
3. `Exa` kept as an optional premium fallback for ambiguous or high-value cases only.

This is the best cost-quality tradeoff for OpenPolyTrader because:

- the current repo already has a clean `search()` then `fetchContents()` abstraction and a primary/fallback pattern;
- `Serper` still presents the clearest low-cost Google-grounded confirmation path from its live homepage pricing/profile;
- `GDELT` is useful for cheap broad monitoring, but its 15-minute cadence and noisy event/tone signals make it a bad sole live-decision layer;
- `Exa` is still useful when you need richer semantic retrieval or bundled content, but it should stop being the default polling surface for every eligible market.

The immediate low-risk savings move is to reduce the current Exa cost before any provider swap:

- stop fetching full contents for every market by default;
- reduce the fixed three-query fanout;
- separate web-search cadence from `evModelRefreshMinutes` before adding a router or heartbeat layer;
- only escalate to a paid confirmer after a cheap trigger.

---

## Current repo behavior

### What the code does today

Policy defaults still make `Exa` primary and `Firecrawl` optional:

- `signalMode='both'`
- `evWebSearchExaEnabled=true`
- `evWebSearchFirecrawlEnabled=false`
- `evWebSearchPrimary='exa'`
- `evWebSearchMaxResults=10`
- `evWebSearchCacheTtlSeconds=7200`
- `evWebSearchMaxConcurrency=3`
- `evWebSearchFirecrawlMaxDepth=2`
- `evWebSearchFirecrawlMaxPages=10`

Source:

- [`src/config/policy.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/config/policy.ts)
- [`src/boot/runtimeServices.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/boot/runtimeServices.ts)

Runtime activation is narrower than those defaults imply:

- `SignalAggregatorAgent` is only constructed when at least one enabled provider also has an API key at runtime.
- Missing provider credentials are recorded as `web_search` metrics instead of silently enabling a half-configured client.

The per-market search path is:

1. Build up to 3 queries:
   - base question
   - `question + outcome1`
   - `question + outcome2`
2. Run those searches against the primary provider.
3. If the primary returns zero results, run the same searches against the secondary provider.
4. Deduplicate URLs.
5. Fetch contents for up to 8 URLs using the provider that produced the surviving result set.
6. Emit one `learning:insight` event with a TTL.

Scheduling is still coupled to the EV model refresh surface:

- `SignalAggregatorAgent.applySchedule()` uses `evModelRefreshMinutes` for polling cadence.
- Market metadata cache TTL also reuses `evModelRefreshMinutes`.

That coupling is workable today, but it becomes a rollout constraint for router/GDELT work. Search polling needs its own config surface instead of silently inheriting model-refresh timing.

Source:

- [`src/agents/signal/SignalAggregatorAgent.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/agents/signal/SignalAggregatorAgent.ts)
- [`tests/unit/signal-aggregator.test.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/tests/unit/signal-aggregator.test.ts)

### Why the current Exa path is expensive

The repo already applied several good spend and safety controls:

- Exa is forced to `type: 'neural'`
- content fanout is capped to 8 URLs
- insight TTL is 2 hours
- shared web-search cache is bounded to 1000 entries by default
- search and content cache keys are provider-isolated
- Firecrawl crawl fallback is capped by policy depth/page limits
- Exa enters cooldown after repeated auth/billing failures instead of hammering a broken paid path

Source:

- [`src/services/websearch/ExaClient.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/services/websearch/ExaClient.ts)
- [`src/services/websearch/FirecrawlClient.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/services/websearch/FirecrawlClient.ts)
- [`src/agents/signal/SignalAggregatorAgent.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/agents/signal/SignalAggregatorAgent.ts)
- [`src/config/policy.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/config/policy.ts)
- [`src/services/websearch/WebSearchCache.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/services/websearch/WebSearchCache.ts)
- [`src/services/websearch/WebSearchProviderCache.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/src/services/websearch/WebSearchProviderCache.ts)
- [`tests/unit/websearch_cache.test.ts`](/Users/bishopdotun/Documents/DevProjects/openpolytrader/tests/unit/websearch_cache.test.ts)

The remaining spend driver is structural:

- 3 paid searches per eligible market cycle
- then a separate Exa `/contents` read for up to 8 pages
- repeated across eligible markets with concurrency

So the cost problem is not just "Exa is expensive." It is also "the current repo calls it in a relatively costly shape."

### Current strengths

- clean provider abstraction
- strong local caching
- graceful fail-open behavior for advisory signals
- tested allowlist and fallback behavior

### Current weaknesses

- no cheap trigger layer before paid search
- fallback is only `zero results`, not `low confidence` or `ambiguous evidence`
- the agent still attempts content resolution whenever URLs exist; cache hits suppress network spend, but uncached hits still trigger content fetch immediately
- search cadence and market-metadata TTL still ride `evModelRefreshMinutes`, which is the wrong control surface for router or heartbeat rollout

---

## Critique of the current stack

The current Exa-first path is operationally simple, but it is not economical for broad market scanning.

Main issues:

- It pays for search before it knows whether there was any meaningful narrative change.
- It pays for full content retrieval too early.
- It treats all eligible EV markets too similarly; there is no spend budget based on market importance, resolution horizon, or unexplained price movement.
- It has no cheap "news heartbeat" layer.

This means the current design is better than a naive loop, but it is still too eager to spend on premium retrieval.

---

## Critique of the proposed `GDELT + Exa|Serper` idea

### What is right about it

- Using `GDELT` as an always-on change detector is directionally correct.
- Using `Serper` or `Exa` only on escalation is much better than polling a paid API for every market.
- Comparing change features is better than raw sentiment for event markets.
- Caching, deduping, and selective LLM use are absolutely correct.

### What is weak or incomplete about it

1. `GDELT` is not a safe sole live-decision news layer.

`GDELT` updates on a 15-minute cycle and is excellent for broad coverage, but that is not "real-time" in the same sense as a live Google-grounded confirmer. For fast resolution windows or unexplained price moves, 15 minutes can be too stale.

2. `GDELT tone` is not the same as market-relevant probability signal.

Tone helps for broad monitoring, but event-market decisions often depend on exact claims, official statements, timestamps, and resolution semantics. Raw GDELT tone should be treated as a trigger feature, not as direct evidence to trade on.

3. `GDELT Context API` is useful but narrow.

Its same-sentence requirement is good for precision, but it only searches a short window and can miss broader context. It is a filter, not a full confirmer.

4. `Exa` and `Serper` should not be treated as equivalent replacements.

- `Serper` is best as a cheap, fast Google-grounded confirmer.
- `Exa` is better when you need richer semantic retrieval, content-rich results, or higher-quality fallback.

5. Not every market should use the same trigger profile.

Markets tied to official releases, courts, elections, or specific agencies should escalate faster to official-domain checks than markets driven by diffuse narrative flow.

### Bottom line on the proposal

The proposal is good as a routing idea, but not yet good enough as a production policy. It needs:

- event-type-specific routing;
- strict escalation thresholds;
- explicit official-source checks;
- a distinction between cheap monitoring features and trade-grade evidence.

---

## Current provider facts and what they imply

### Exa

Relevant current official docs:

- Search endpoint: [docs.exa.ai/reference/search](https://docs.exa.ai/reference/search)
- Pricing page: [exa.ai/pricing](https://exa.ai/pricing)
- Pricing update: [exa.ai/docs/changelog/pricing-update](https://exa.ai/docs/changelog/pricing-update)
- Fast search: [docs.exa.ai/changelog/new-fast-search-type](https://docs.exa.ai/changelog/new-fast-search-type)
- Instant search: [exa.ai/docs/changelog/instant-search-launch](https://exa.ai/docs/changelog/instant-search-launch)

Important current facts:

- Exa search can return contents directly in search responses.
- Exa's March 3, 2026 pricing update says search requests now include contents for up to 10 search results at no additional cost, and extra results beyond 10 remain incremental.
- Exa's pricing page still lists `Search` and `Contents` as separate billable products, so the "included contents" rule should be treated as a search-path bundle, not a global removal of content pricing.
- The dedicated `/contents` endpoint still exists at separate per-page pricing, which makes the repo's current `search` then `/contents` shape a clearer optimization target than the previous audit stated.
- Exa Fast is documented with p50 latency below 425ms.
- Exa Instant is documented as sub-200ms.

Implication for this repo:

The repo's current separate `/contents` call is now a stronger optimization target than before. If Exa remains in the stack, Phase 0 should explicitly compare the current `search` plus `/contents` flow against bounded `search with contents` requests capped at 10 results, then choose based on payload size, latency, and signal quality rather than the older pricing model.

### Serper

Relevant official docs:

- Product homepage: [serper.dev](https://serper.dev)

Important current facts:

- Serper advertises real-time Google Search and Google News APIs.
- Pricing currently starts at $50 for 50k credits.
- Higher tiers go down to $0.30 per 1k credits.
- Credits are deducted on successful responses.
- Serper advertises roughly 1-2 second response time on its live homepage.
- The previously cited `/pricing` page now returns 404, so homepage pricing is the live official source.

Implication for this repo:

Serper remains the cleanest default for "cheap paid confirmation" if you want Google-grounded results and can accept a thinner retrieval layer than Exa.

### GDELT

Relevant official docs:

- About: [gdeltproject.org/about.html](https://www.gdeltproject.org/about.html)
- DOC API: [blog.gdeltproject.org/gdelt-doc-2-0-api-debuts](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- Context API: [blog.gdeltproject.org/introducing-the-gdelt-doc-2-0-context-2-0-api](https://blog.gdeltproject.org/introducing-the-gdelt-doc-2-0-context-2-0-api/)

Important current facts:

- GDELT is free and open.
- GDELT updates every 15 minutes.
- GDELT monitors global news across many languages.
- DOC API supports English querying across many machine-translated languages.
- Context API is good for same-sentence precision checks.

Implication for this repo:

GDELT is well suited for cheap heartbeat monitoring, narrative drift detection, and backtest feature generation. It is not a sufficient trade-grade evidence layer by itself for fast or resolution-critical markets.

### Quality caveat on GDELT

A credible external review to keep in mind:

- ONS review: [ons.gov.uk/.../reviewofgdeltnewsdataforqualityrelevanceandaccuracy](https://www.ons.gov.uk/economy/environmentalaccounts/methodologies/reviewofgdeltnewsdataforqualityrelevanceandaccuracy)

The practical takeaway is simple:

- use GDELT as a broad detector;
- do not treat it as clean ground truth without confirmation.

---

## What others appear to do

Across public and research usage, the pattern is usually not "trade directly from GDELT tone."

Typical pattern:

1. use broad news/event feeds to generate candidates;
2. cluster or filter for relevance;
3. confirm with richer sources or domain-specific models;
4. evaluate on out-of-sample predictive performance, not anecdotal wins.

Examples:

- GDELT itself highlights financial-prediction studies using GDELT-derived features as model inputs, not as final evidence:
  - [The Benefit Of Narratives For Prediction Of The S&P 500 Index](https://blog.gdeltproject.org/the-benefit-of-narratives-for-prediction-of-the-sp-500-index/)
- Recent macro-alpha research using GDELT processes GDELT with domain-specific finance models such as FinBERT instead of relying on raw tone:
  - [Interpretable Machine Learning for Macro Alpha: A News Sentiment Case Study](https://arxiv.org/abs/2505.16136)
- Event-database workflows built around large news feeds often combine automated retrieval with additional filtering and review rather than treating raw news-stream hits as clean events:
  - [START Cyber Events Data System](https://www.start.umd.edu/data-tools/cyber-events-data-system)

That pattern supports the same conclusion for OpenPolyTrader:

- cheap broad feed for detection;
- higher-precision confirmer for trade-grade evidence;
- domain-aware scoring on only a small top slice.

---

## Option comparison for OpenPolyTrader

### Option A - Keep Exa-first and optimize it

Pros:

- smallest architecture change
- keeps current abstraction and tests mostly intact
- best if semantic retrieval quality matters more than cost

Cons:

- still expensive relative to Serper
- current code shape still overpays
- no cheap trigger layer

Verdict:

Worth doing immediately as a tactical savings step, but not the final answer if Exa spend is already a real pain point.

### Option B - Replace Exa with Serper only

Pros:

- lower-cost in the current repo shape
- fast
- simple mental model
- strong for live Google-grounded confirmation

Cons:

- weaker content/retrieval ergonomics than Exa
- no cheap prefilter
- still wasteful if used as a polling layer

Verdict:

Better than current Exa-first on cost, but still not the best architecture by itself.

### Option C - GDELT plus Serper, Exa removed

Pros:

- lowest recurring cost among serious options
- good narrative detection
- good confirmation economics

Cons:

- no premium fallback when Serper is ambiguous
- more sensitive to GDELT precision problems
- can lose quality on messy, semantic, or long-tail markets

Verdict:

Good if cost pressure is extreme and market set is narrow, but slightly too brittle as the only long-term design.

### Option D - GDELT plus Serper default plus Exa premium fallback

Pros:

- best cost-quality balance
- preserves speed
- limits Exa to the small set of cases where it is actually valuable
- reuses parts of the existing provider abstraction, but still requires a new router and trigger service

Cons:

- more routing logic
- more configuration and testing work than a simple swap

Verdict:

Best overall choice for this repo.

---

## Recommended architecture for OpenPolyTrader

### Recommendation

Deploy:

- `GDELT` as the free heartbeat layer
- `Serper` as the default paid escalation layer
- `Exa` as optional premium fallback only

Do not run all three on every market.

### Recommended routing policy

This is a target-state policy, not something the current repo can switch on immediately. It requires new router inputs and config for market priority, near-resolution thresholds, unexplained move triggers, and GDELT heartbeat state.

#### Stage 0 - Market eligibility

Only consider markets that are:

- allowlisted/active;
- within a configured resolution horizon;
- or showing unexplained price/volume movement.

#### Stage 1 - Cheap heartbeat via GDELT

Every 15 minutes for high-priority markets, compute:

- article-count delta
- tone delta
- unique-source delta
- geography spread
- contradiction ratio
- novelty score

Use Context API only when the market is ambiguous enough to need same-sentence precision.

#### Stage 2 - Serper escalation

Escalate to `Serper News` or `Serper Search` when one of these is true:

- GDELT spike crosses threshold
- price moved with no internal explanation
- market is near resolution
- official-source confirmation is missing
- GDELT results are contradictory or low precision

Use 1 or 2 focused queries, not the repo's current default of 3 for every case.

#### Stage 3 - Exa premium fallback

Only escalate to Exa when:

- Serper returns conflicting evidence;
- there are too few high-authority hits;
- deeper semantic retrieval is needed;
- or the market value/risk justifies premium spend.

#### Stage 4 - LLM summarization

Only summarize the top 2-3 documents after routing, not the full result set.

### Why this is best for this repo

- It preserves the current provider abstraction and normalized `learning:insight` output shape, while leaving room to replace some separate Exa `/contents` calls with bundled inline contents.
- It moves spend from always-on premium search to event-triggered confirmation.
- It keeps a quality escape hatch for hard markets.
- It does not bet trade quality on GDELT tone alone.

---

## Immediate implementation guidance

### Phase 0 - Cheap savings without provider change

Do this first even if you later add Serper/GDELT:

1. Stop immediate separate `/contents` fetches for every uncached hit unless the result set crosses a confidence or market-priority threshold; if Exa stays in the path, benchmark bounded inline contents on `search` first.
2. Reduce fixed query fanout from 3 to 2 for standard Yes/No markets.
3. Add a dedicated `evWebSearchRefreshMinutes` control so polling cadence and market-metadata TTL stop piggybacking on `evModelRefreshMinutes`.
4. Make content fanout configurable and lower the default.
5. Revisit forced `neural` mode against current Exa `fast`, `instant`, or inline-content search behavior using the March 3, 2026 pricing update and current latency docs.

These are the lowest-risk savings moves.

### Phase 1 - Add provider router

Add a routing layer ahead of `WebSearchClient` rather than hardwiring providers into `SignalAggregatorAgent`.

The router should decide:

- skip paid search
- use Serper
- use Exa
- use Serper then Exa

based on trigger state and market profile.

### Phase 2 - Add GDELT monitor service

Create a separate monitor/cache component instead of forcing GDELT directly into the current `WebSearchClient` contract.

That service should:

- maintain per-market heartbeat features;
- store short-lived trigger state;
- expose "should escalate" plus "why".

### Phase 3 - Add evaluation gates

Do not ship on intuition alone. Track:

- paid queries per market per day
- median and p95 provider latency
- insight agreement/disagreement rate
- EV signal quality before/after routing change
- trade outcome deltas for markets that used escalation

---

## Final recommendation

The best deployable option for OpenPolyTrader is:

`GDELT heartbeat -> Serper default confirmer -> Exa premium fallback`

with two important caveats:

1. First reduce the current Exa cost shape inside the repo, because there is still easy money being wasted.
2. Do not let GDELT directly drive trades; let it drive escalation.

If you want the cheapest robust operating mode, use:

`GDELT + Serper` by default, with `Exa` disabled except for explicit premium escalation.

If you want the safest migration path, use:

1. optimize current Exa usage;
2. add Serper as a second provider;
3. add GDELT trigger state in front of both;
4. move Exa from default to premium fallback after measurement proves parity.

---

## Sources

- Exa Search reference: [https://docs.exa.ai/reference/search](https://docs.exa.ai/reference/search)
- Exa pricing: [https://exa.ai/pricing](https://exa.ai/pricing)
- Exa pricing update: [https://exa.ai/docs/changelog/pricing-update](https://exa.ai/docs/changelog/pricing-update)
- Exa Fast search: [https://docs.exa.ai/changelog/new-fast-search-type](https://docs.exa.ai/changelog/new-fast-search-type)
- Exa Instant search: [https://exa.ai/docs/changelog/instant-search-launch](https://exa.ai/docs/changelog/instant-search-launch)
- Serper homepage: [https://serper.dev](https://serper.dev)
- GDELT about: [https://www.gdeltproject.org/about.html](https://www.gdeltproject.org/about.html)
- GDELT DOC API: [https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- GDELT Context API: [https://blog.gdeltproject.org/introducing-the-gdelt-doc-2-0-context-2-0-api/](https://blog.gdeltproject.org/introducing-the-gdelt-doc-2-0-context-2-0-api/)
- ONS GDELT review: [https://www.ons.gov.uk/economy/environmentalaccounts/methodologies/reviewofgdeltnewsdataforqualityrelevanceandaccuracy](https://www.ons.gov.uk/economy/environmentalaccounts/methodologies/reviewofgdeltnewsdataforqualityrelevanceandaccuracy)
- START Cyber Events Data System: [https://www.start.umd.edu/data-tools/cyber-events-data-system](https://www.start.umd.edu/data-tools/cyber-events-data-system)
- GDELT financial-forecasting example: [https://blog.gdeltproject.org/the-benefit-of-narratives-for-prediction-of-the-sp-500-index/](https://blog.gdeltproject.org/the-benefit-of-narratives-for-prediction-of-the-sp-500-index/)
- Macro alpha study using GDELT plus FinBERT: [https://arxiv.org/abs/2505.16136](https://arxiv.org/abs/2505.16136)
