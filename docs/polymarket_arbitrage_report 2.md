# Analysis of Arbitrage in Polymarket Prediction Markets

![Paper cover](4D0FE46D-05F0-4892-BF16-091317C9E6E8.jpeg)

## Context

Polymarket is a prediction market on the Polygon blockchain where participants trade conditional tokens that pay a fixed amount ($1 USDC) if an outcome is true at resolution.  In theory the sum of prices for all mutually exclusive conditions in a market (or across markets describing the same event) should equal 1 because only one outcome can be true.  Mispricing occurs when the collective prices deviate from 1; buying the under‑priced positions or selling the over‑priced ones can lock in a profit regardless of the event’s outcome.

In late 2024 and early 2025 multiple posts on X/Twitter highlighted extraordinary returns from exploiting short‑term mispricings on Polymarket.  A pseudonymous trader known as **RN1** reportedly turned **$1,000 into $2 million** by performing tens of thousands of trades; analysis by Carver and gemchanger suggested these returns were due to a fully automated statistical‑arbitrage loop that continuously scanned related markets and hedged mis‑priced legs【813765603287446†screenshot】.  Other posts described delta‑neutral bots that enter both “Up” and “Down” positions in short 15‑minute Bitcoin markets whenever the combined cost is under $1, earning a small but nearly risk‑free spread【613117912780206†screenshot】.  These microstructure strategies rely on speed and accurate hedging; the comments noted that edges are thin, volumes are small, and fill risks and latency make manual replication difficult【976824385930385†L120-L146】.  Against this backdrop, researchers set out to empirically quantify how often arbitrage appears on Polymarket and whether it is exploited.

## Types of arbitrage

### Market Rebalancing (intra‑market) and single‑condition arbitrage

Within a single market, arbitrage arises when the sum of the prices of all mutually exclusive conditions (or the “YES” and “NO” positions for a single outcome) deviates from 1.  If the prices of “YES” and “NO” tokens sum to less than 1, an arbitrageur can buy both legs and lock in a profit equal to the difference (a “long” arbitrage).  Conversely, if the sum exceeds 1, an arbitrageur can create both positions via **splits** and sell the overpriced leg to profit (a “short” arbitrage).  The profit per dollar is simply \(1 - \text{sum of prices}\) for long trades or \(\text{sum of prices} - 1\) for short trades【998139646967944†L576-L639】.

### Combinatorial (inter‑market) arbitrage

![Combinatorial arbitrage example](D6372A6D-29B5-49E9-B864-350877CA4DEC.jpeg)

Combinatorial arbitrage occurs when two markets about the same underlying event are semantically dependent, allowing a portfolio of bets across both markets such that at least one bet will win.  For example, one market may ask *“Who will win the state?”* while another asks *“What will the winning margin be?”*  The markets share dependent subsets of outcomes; mispricing arises when the total valuation of one subset is lower (or higher) than its complement【998139646967944†L653-L726】.  Arbitrageurs can then buy “YES” positions for the cheaper subset and hedge by buying “YES” positions in complementary conditions, guaranteeing at least one winning leg.  The profit is the absolute difference in the total valuations of the dependent subsets【998139646967944†L653-L726】.

### Microstructure arbitrage (short‑duration markets)

The posts from RN1, Carver and other Polymarket traders reveal another class of arbitrage not explicitly defined in the academic paper but crucial in practice: **microstructure arbitrage**.  In these strategies the trader monitors very short‑duration markets (15‑minute crypto or sports markets) where price relationships oscillate rapidly and liquidity provision lags.  A bot enters both sides of a market when the combined cost of “Up” and “Down” positions falls below 1, or buys one leg when prices diverge and waits for mean reversion.  The key is reacting faster than other participants and hedging quickly; profits per trade are small but accumulate with high frequency【613117912780206†screenshot】.  This approach is essentially a high‑frequency implementation of market rebalancing at minute‑level horizons.

## Methodology of the empirical study (arXiv:2508.03474)

The paper **“Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets”** analysed one year of Polymarket data (April 1 2024 – April 1 2025) to answer three questions: (1) under what conditions does arbitrage exist; (2) does it actually occur on Polymarket; and (3) who exploits these opportunities【998139646967944†L30-L53】.  The authors compiled metadata for 8659 single‑condition markets and 1578 “NegRisk” markets (with multiple conditions) totalling 17 218 conditions【998139646967944†L789-L792】.  They grouped markets into topics (Politics, Economy, Technology, Crypto, Twitter, Culture, Sports) using text embeddings and reduced their search space to markets sharing an end date and topic【998139646967944†L789-L840】.

### Detecting dependencies with a large language model

Identifying combinatorial arbitrage requires knowing which markets describe the same event.  To detect semantic dependencies, the researchers used an LLM (DeepSeek‑R1 Distill‑Qwen‑32B) and designed prompts that enumerate all possible resolutions of a market’s conditions.  By iteratively asserting that a specific condition is true and checking whether the remaining conditions can logically co‑exist, the model constructs a table of valid outcome combinations.  They apply this both to single markets and to pairs of markets; in the latter case the combined outcome space becomes large, so they reduce markets with more than four conditions by grouping infrequent conditions into a catch‑all category【998139646967944†L918-L990】.  The LLM succeeded in returning valid outcome tables for 124 of 128 tested markets (81.45 % fully satisfying their criteria)【998139646967944†L918-L990】.  Figure 4 from the paper illustrates this reasoning pipeline (see below).

![LLM‑based dependency detection](F0443718-C9D2-435A-96D5-0AD1AD2406E8.jpeg)

### Analyzing historical bids

The study downloaded historical order‑book events via the Polygon RPC and parsed 86 million bids.  For each user wallet they grouped trades within 950 blocks (about one hour) to reconstruct potential arbitrage opportunities【998139646967944†L1248-L1304】.  They imposed a minimal profit threshold of five cents per dollar to focus on meaningful opportunities and ignored orders below $2, because each trade on Polymarket carries some execution risk【998139646967944†L1120-L1145】.

## Findings

### Prevalence of arbitrage opportunities

* **Single‑condition arbitrage:** Of 17 218 conditions, 7051 had at least one arbitrage opportunity; 4 423 of these came from single‑condition markets and 2 628 from multi‑condition markets【998139646967944†L1133-L1140】.  All detected opportunities were “long” (sum of “YES” and “NO” prices < 1).  Most conditions exhibited only a handful of opportunities; crypto markets had the largest outliers【998139646967944†L1150-L1154】.  Median profit per dollar was around 60 cents, well above the 2‑cent threshold, pointing to significant inefficiency【998139646967944†L1153-L1157】.

* **Market rebalancing arbitrage within NegRisk markets:** 662 of 1578 multi‑condition markets had arbitrage opportunities【998139646967944†L1206-L1215】.  Within markets there were both long and short opportunities, though long trades offered higher average returns.  Sports markets dominated the number of opportunities but tended to have lower maximum profits per dollar; politics markets had outlier opportunities tied to the 2024 US election【998139646967944†L1231-L1240】.  Assuming a trader could capture just 1 % of available liquidity, the study estimated millions of dollars in potential profit【998139646967944†L1196-L1204】.

* **Combinatorial arbitrage across markets:** Only 13 pairs of markets (primarily related to the US presidential election) were found to be dependent.  Arbitrage opportunities across these pairs were rare and typically occurred during low‑liquidity periods; the average maximum profit was about $100 per opportunity, implying total token volume under 2 000 USDC【998139646967944†L1250-L1273】.  Of the 13 pairs, three had hundreds of opportunities while others had very few or none【998139646967944†L1258-L1263】.

### Exploitation of opportunities

* **Single‑condition arbitrage:** Users captured a meaningful fraction of single‑condition opportunities.  The study estimated profits of about **$5.9 million** from buying discounted “YES”+“NO” pairs and **$4.68 million** from selling overpriced pairs, totalling roughly **$10.6 million**【998139646967944†L1387-L1390】.

* **Market rebalancing across conditions:** Traders profited roughly **$28.3 million** by buying “NO” positions and **$11.7 million** by buying “YES,” while selling opportunities were much smaller (about **$0.6 million** for selling “YES” and **$4 k** for selling “NO”)【998139646967944†L1451-L1456】.  Buying “NO” was by far the most common and lucrative strategy【998139646967944†L1451-L1454】.

* **Combinatorial arbitrage across markets:** Only five of the eleven dependent pairs showed evidence of exploitation; the total amounts were modest: the largest pair yielded **$60 236.71**, while others produced between **$629** and **$18 472**【998139646967944†L1473-L1478】.  Low liquidity and high complexity likely deterred exploitation.

* **Top arbitrageurs:**  The paper lists the top ten arbitrage addresses; the most profitable wallet earned **$2 009 631.76** across 4 049 trades, while the tenth ranked wallet earned **$383 569.94** over 2 720 trades【998139646967944†L1491-L1530】.  The distribution of profits relative to transaction count (Figure 12) suggests that some high‑earning accounts executed thousands of trades and displayed bot‑like behaviour【998139646967944†L1451-L1454】.  The authors estimated total extracted profit from all strategies as **$39.6 million**, aligning with the $40 million figure reported in news articles【998139646967944†L1536-L1544】.

### Discussion and limitations

The paper notes that the volume of arbitrage on Polymarket is small compared with fully on‑chain DeFi protocols, where trades are atomic and fees/MEV are major drivers【998139646967944†L1548-L1553】.  However, the persistence of mispricing despite large trading volumes reveals inefficiencies.  The authors attribute many opportunities to inconsistent deadlines across conditions, thin liquidity, and asynchronous order‑book matches.  Their LLM‑based dependency detection worked for small market pairs but could not handle markets with many conditions; scaling the method to more complex markets and exploring “weaker” dependencies (where events influence each other but do not guarantee outcomes) remain open problems【998139646967944†L1556-L1583】.

## Synthesis with microstructure arbitrage and practical considerations

The empirical study confirms what traders like RN1 and gemchanger observed on the ground.  **Microstructure arbitrage** on Polymarket is essentially a special case of single‑condition or market rebalancing arbitrage executed at very short time scales.  The mispricings exploited in 15‑minute Bitcoin or sports markets occur because order books are thin and liquidity providers adjust slowly; as a result, the prices of “Up” and “Down” contracts can drift away from 50 cents each.  High‑speed bots can buy both contracts for a combined cost of around 90–95 cents and lock in 5–10 cents profit【613117912780206†screenshot】.  Carver’s thread noted that one bot generated over **$520 000** in a month using a pure statistical arbitrage loop【813765603287446†screenshot】.  The LLM‑based study found that across the entire year, the largest single‑condition trade produced **$58 983.36** profit by purchasing “YES” and “NO” tokens at around 2 cents each【998139646967944†L1393-L1399】, illustrating how extreme mispricings can occasionally occur.

The synergy between empirical analysis and anecdotal reports underscores several practical points:

1. **Speed and automation are crucial.**  The majority of profits were captured by a handful of wallets executing thousands of trades, implying automated bots【998139646967944†L1491-L1530】.  Manual execution would struggle to catch fleeting opportunities, and comments on Twitter threads stressed that “humans can’t compete at that scale or speed”【813765603287446†screenshot】.
2. **Liquidity and slippage limit scalability.**  Most arbitrage opportunities exist when liquidity is thin; the LLM study found many profitable trades in sports and politics markets, but maximum profits were often capped at a few hundred dollars【998139646967944†L1250-L1273】.  Twitter commenters warned that the 15‑minute Bitcoin markets only handle a few thousand dollars per round【976824385930385†L120-L123】, so large positions could move prices and erode the edge.
3. **Fill risk matters.**  Non‑atomic order books mean that one leg of a trade can execute without the hedge.  The academic study considered only completed trades; Twitter developers highlighted the danger of being left with an unhedged position if the hedge leg does not fill【976824385930385†L138-L146】.
4. **Infrastructure and technical stack.**  Successful bots likely use a low‑latency programming language (Rust, Go, or Node) and maintain persistent WebSocket connections to Polymarket’s order book.  They monitor multiple markets simultaneously, calculate implied probabilities, and submit limit or market orders when spreads break.  To minimise latency, some traders deploy servers geographically close to the Polygon RPC endpoints and may route orders through aggregators such as Almanac or custom routers【976824385930385†L219-L248】.  The Smart Ape post emphasised tunable parameters (e.g., threshold for combined cost, window after round start) and the ability to limit risk by capping trade size【281953998999635†L46-L74】.
5. **Regulatory and ethical considerations.**  Microstructure arbitrage on prediction markets shares similarities with high‑frequency trading and MEV extraction in DeFi.  It raises questions about fairness and whether bots extracting risk‑free profit improve market efficiency or exploit uninformed participants.  Some commenters viewed arbitrage as “free money” or “microstructure abuse”【88676574564734†L126-L137】.  The study’s authors call for future work on designing markets that reduce mispricing without discouraging participation【998139646967944†L1548-L1564】.

## Conclusion

Polymarket’s design as a decentralized prediction market should, in theory, enforce probabilistic consistency across conditions, yet real‑world frictions create abundant arbitrage opportunities.  The paper **“Unravelling the Probabilistic Forest”** provides the first systematic measurement of these inefficiencies, showing that more than 7 000 conditions and 600 multi‑condition markets offered mispricing of at least five cents per dollar in one year.  Traders captured roughly **$40 million** in profit, mostly via buying undervalued “YES” or “NO” tokens in single conditions or across conditions, with a small portion from combinatorial trades【998139646967944†L1451-L1454】.  This empirical evidence aligns with anecdotal accounts of bot‑driven microstructure arbitrage on Polymarket and demonstrates that while prediction markets can aggregate information, they also harbour “free money” glitches that sophisticated traders exploit.

For individuals considering replicating these strategies, the data emphasises the need for automated systems, rapid execution, careful hedging, and a willingness to operate at small profit margins.  As more bots enter the space and mispricings are publicised, the edge is likely to shrink, making it harder to emulate early success stories like RN1.  Future research may explore how market design and LLM tools can improve price consistency and reduce arbitrage opportunities while maintaining vibrant trading and information aggregation.
