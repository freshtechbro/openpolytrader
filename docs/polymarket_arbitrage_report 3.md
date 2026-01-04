# Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets (arXiv:2508.03474)

## Executive summary

This paper presents a large-scale empirical analysis of arbitrage on Polymarket, a prediction-market platform built on Polygon. The authors start from a basic constraint: if a market’s outcomes are mutually exclusive and exhaustive, the combined probability of “some outcome happens” should be 1, so prices across mutually exclusive outcomes should sum to 1. When prices violate these constraints, an arbitrageur can assemble positions that guarantee a payout greater than the purchase cost.

The paper contributes (1) a market-dependence taxonomy that distinguishes independence from semantic dependence across markets, (2) formal definitions of two arbitrage families, and (3) a measurement pipeline that combines LLM-based dependency inference with on-chain execution data from Polymarket’s Conditional Tokens contract events.

Across markets resolving from April 1, 2024 to April 1, 2025, the authors report pervasive intra-market mispricing and meaningful realized profits. They estimate roughly 40 million USD of profit extracted during the measurement period, with profit concentrated among a small set of high-activity accounts.

## Polymarket mechanics relevant to arbitrage

Polymarket markets are defined by one or more **conditions** (binary questions). A “market” can contain multiple mutually exclusive outcomes (multi-condition markets are referred to as NegRisk markets in the paper), and in a properly specified market exactly one condition should resolve true.

Trading occurs via a hybrid central limit order book (CLOB): users submit limit orders to Polymarket’s API, matching happens centrally, and executions are recorded on-chain. The paper focuses on three on-chain event types that allow reconstruction of trades and liquidity actions:

- **OrderFilled**: a token trades for USDC.
- **PositionSplit**: USDC is locked and “YES” and “NO” tokens are minted.
- **PositionsMerge**: “YES” and “NO” tokens are burned and USDC is withdrawn.

A key practical detail is that these arbitrage trades are typically **non-atomic**. Even if an arbitrage exists theoretically, execution risk exists because only some legs of a multi-order plan may fill at favorable prices.

## Market dependence taxonomy

### Single market outcome space

For a market with conditions \(C_1,\dots,C_n\), the paper models a market resolution as a boolean vector \(v = (c_1,\dots,c_n)\) where \(c_i \in \{0,1\}\). Because outcomes are mutually exclusive and exhaustive, the valid outcome set has size \(n\), and in every valid vector exactly one entry is 1.

This framing matters for arbitrage because it turns “market correctness” into a constraint satisfaction problem: if one condition is true, all others must be false.

### Two-market joint outcome space

For two markets \(M_1\) and \(M_2\) with \(n\) and \(m\) conditions, independence means every outcome of \(M_1\) can co-occur with every outcome of \(M_2\), yielding \(n \cdot m\) joint outcomes.

Dependence means some joint assignments are impossible (for example, a “win by at least 2 goals” market implies a “team wins” market). The paper captures this by the existence of dependent subsets \(S \subset M_1\) and \(S' \subset M_2\) where truth assignments in one subset constrain the other, shrinking the feasible joint outcome set.

## Arbitrage types formalized in the paper

### 1) Market Rebalancing Arbitrage (intra-market)

Interpret the price of a “YES” token as the market-implied probability. In a multi-outcome market, the sum of all “YES” prices should be 1.

- **Long rebalancing arbitrage** exists when \(\sum_i \text{val}(Y_i,t) < 1\). A trader buys one unit of each “YES” outcome; at settlement exactly one pays out 1, so the guaranteed profit is \(1 - \sum_i \text{val}(Y_i,t)\).

- **Short rebalancing arbitrage** exists when \(\sum_i \text{val}(Y_i,t) > 1\). The paper discusses equivalent shorting strategies, including buying “NO” positions or creating splits and immediately selling overpriced “YES” positions, to lock in the overpricing as profit.

A special case is a single condition’s “YES” and “NO” tokens, where the constraint becomes \(\text{val}(Y,t) + \text{val}(N,t) = 1\).

### 2) Combinatorial Arbitrage (inter-market)

For two dependent markets, define dependent subsets \(S \subset M_1\) and \(S' \subset M_2\). A combinatorial arbitrage opportunity exists when the market value of one subset differs from the other, enabling a portfolio that guarantees at least one winning position.

Operationally, the strategy buys “YES” on one side and “YES” on the complement of the other side (equivalently, buying “NO” on that subset). Profit is the absolute difference in the subset valuations (the paper formalizes this using the sum of token values in the dependent subsets).

## Methodology

### Data collection scope

The dataset covers markets resolving between April 1, 2024 and April 1, 2025. The authors combine:

- Market metadata (questions, topic labels, end dates, and condition structure) retrieved via the Polymarket API.
- On-chain executions reconstructed from Conditional Tokens contract events (including OrderFilled, PositionSplit, and PositionsMerge).

They report 8,659 single-condition markets and 1,578 multi-condition (NegRisk) markets, totaling 17,218 conditions.

### Topic grouping for search-space reduction

To avoid comparing every market to every other market, the authors group markets into Polymarket-style topic buckets (Politics, Economy, Technology, Crypto, Twitter, Culture, Sports). They embed market questions and topic labels with Linq-Embed-Mistral, assign topics via cosine similarity, and validate with a small manual sample, reporting about 92 percent accuracy.

This topic assignment is used as a heuristic filter: when testing for cross-market dependence, they only compare markets that share a topic and an end date.

### Dependency inference with an LLM

The key technical step is to infer whether two markets are independent or dependent by constructing (or approximating) the feasible outcome table.

- **Single market inference**: the LLM is prompted to output the set of valid outcome vectors for a market (exactly one condition true per vector). The paper reports that for a U.S. election day sample of 128 NegRisk markets, most returned valid outputs and 81.45 percent met all correctness checks.

- **Two-market inference**: the LLM is given the union of conditions from two markets and asked for the feasible joint outcome set, with checks enforcing exactly one true condition per market and bounding the number of returned vectors.

The authors observe that LLMs can fail on large prompts (for example, reasoning loops or invalid JSON). To mitigate this, they reduce any market with more than four conditions to the top four by traded volume plus a fifth “other outcomes” condition, designed as a logical OR to preserve dependencies while shrinking the prompt.

They use DeepSeek-R1-Distill-Qwen-32B for this dependency inference step.

## Findings

### How many dependent market pairs were found?

The paper reports that true cross-market dependence that satisfies their strict combinatorial-arbitrage definition is uncommon.

- For non-U.S. election markets, they checked 2,267 candidate pairs; most were classified independent, and only one pair appeared dependent (but it did not strictly satisfy their combinatorial-arbitrage definition).

- For the U.S. election day Politics group (end date November 5, 2024), they evaluated 46,360 market pairs. After discarding cases where the LLM returned no JSON or failed consistency checks, they obtained 1,576 pairs characterized as dependent by the LLM. They then applied a subset-checker and manual validation, ending with 13 pairs that satisfy the paper’s Combinatorial Arbitrage definition.

### Arbitrage opportunity detection

After dependency detection, the authors compute token prices over time from executed bids. They use a volume-weighted average price (VWAP) at block-level granularity, carrying forward the last observed price for up to 5,000 blocks (about 2.5 hours) if a token is not traded. They also filter to periods of uncertainty (they exclude times when any token price exceeds 0.95) and only count opportunities with at least 0.05 profit per dollar, to focus on higher-reward cases under non-atomic execution risk.

### Arbitrage prevalence (within a single condition)

Across 17,218 conditions, the authors report 7,051 conditions with at least one arbitrage opportunity under their parameters. These were long opportunities (YES plus NO pricing below 1). The paper highlights very large discounts in some cases, suggesting significant inefficiency.

### Arbitrage within multi-outcome markets (NegRisk)

Among 1,578 NegRisk markets, 662 had at least one Market Rebalancing Arbitrage opportunity. Unlike the single-condition case, both long and short opportunities appear at the market level (sum of YES outcomes below or above 1). The paper notes that Sports markets produce many opportunities, while Politics contains some of the most lucrative periods (notably around U.S. election activity).

### Arbitrage across dependent market pairs

For the 13 dependent U.S. election pairs, cross-market opportunities exist but are less frequent and tend to occur in lower-liquidity moments. The median number of opportunities per pair is reported as 8, with some pairs producing far more opportunities (one pair is reported at 6,630).

### Evidence of exploitation and profits

To test whether arbitrage was actually executed, the authors process roughly 86 million bids. They group trades by Polygon address and treat bids within a 950-block window (about 1 hour) as belonging to the same attempt, then compute profit from the minimum held amount across the basket of positions.

Key reported outcomes:

- **Single-condition arbitrage**: total profit from buying below one dollar is reported as 5,899,287.427 USD, and profit from selling above one dollar is reported as 4,682,074.77 USD.

- **Market (NegRisk) arbitrage strategies**: the paper reports total profits by strategy as follows: buying YES 11,092,286.31 USD; selling YES 612,188.83 USD; selling NO 4,264.33 USD; buying NO 17,307,113.81 USD.

- **Cross-market arbitrage extraction**: among the dependent election pairs, they report evidence of extraction in 5 cases, with example totals including pair 2 at 60,236.71 USD and pair 4 at 18,472.31 USD.

Aggregating across strategies, the paper reports approximately 39,587,585.02 USD of extracted profit during the measurement period (under their accounting assumptions).

## Synchronization with arbitrage trading practice

This paper maps cleanly onto a general arbitrage workflow that applies to crypto, sports books, and DeFi, with one twist: the “fair value” constraint is not a statistical model but a hard logical constraint induced by market design.

### 1) Constraint discovery is the alpha

In classic arbitrage, you need a relationship that must hold (triangular FX parity, AMM invariants, cash-and-carry parity, etc.). Here, the relationships are:

- Intra-market parity: sums of mutually exclusive outcomes should equal 1.
- Inter-market parity: if market A implies market B (or vice versa), then subset valuations should match up under the implication.

The paper’s “probabilistic forest” framing is essentially a constraint graph over outcomes.

### 2) Finding dependent markets is equivalent to building a tradable graph

From a systems point of view, the dependency step produces a graph where nodes are conditions and edges encode semantic implication or complementarity. This is directly tradable because it turns an unstructured universe of markets into small candidate baskets where you can compute mispricing. The authors use an LLM to infer feasible outcome tables; in a production arb stack you could implement a hybrid:

- Deterministic rules for obvious templates (winner vs margin, qualification vs champion, state vs national, etc.).
- LLM or other NLP models as a backstop for long-tail market phrasing.

### 3) Execution is the real risk surface

The paper repeatedly emphasizes non-atomic execution. That should feel familiar if you have built:

- CEX orderbook arbitrage where fills can occur on one venue but not another.
- DEX arbitrage under slippage and MEV.

Practical implication: the edge you compute is not the edge you realize unless you solve execution. A realistic arb bot needs:

- An execution planner that sizes orders to available depth.
- Fill monitoring and hedging logic for partial fills.
- Conservative thresholds (the paper uses a 0.05 profit-per-dollar cutoff) so the theoretical edge can survive slippage.

### 4) Data engineering and labeling matter

The authors reduce the cross-market search space using topic and end-date alignment (markets about the same event should resolve together). This mirrors what arb teams do in other domains: aggressive candidate filtering to make search tractable, then expensive exact checks only on the filtered set.

If you were to productize this, the “cheap filters” layer would likely include:

- Entity extraction (teams, candidates, locations).
- Resolution-time proximity.
- Text similarity and template matching.
- Liquidity thresholds.

## Limitations and open problems (as implied by the study)

- **LLM reliability**: invalid JSON and reasoning loops appear, especially as prompts grow.
- **Scaling beyond pairs**: dependencies among 3 or more markets quickly become combinatorial.
- **Weaker dependencies**: the paper focuses on unequivocal, guaranteed-profit opportunities; temporal or probabilistic dependencies (semi-final vs final) create a different class of strategy.

## Practical takeaways

1. Most of the measurable edge on Polymarket appears to be intra-market (single condition and multi-outcome rebalancing), not cross-market.
2. Cross-market arbitrage exists, but finding it is mainly an information-extraction problem (turn text into constraints).
3. Any serious attempt needs an execution-aware risk model because the trade legs are non-atomic.
