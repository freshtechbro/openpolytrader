# Adaptive Frank-Wolfe & Bregman-Projection Arbitrage for Prediction Markets

## Overview

Combinatorial prediction-market market makers often use cost-function based automated market makers (AMMs) such as the logarithmic market scoring rule to quote prices. In a combinatorial market the possible outcome space is exponential in the number of events, so naive pricing is #P-hard.

The seminal work *Arbitrage-Free Combinatorial Market Making via Integer Programming* (Kroer et al., 2016) introduced the Frank-Wolfe market maker (FWMM): a market maker that removes arbitrage by projecting the current state onto the set of arbitrage-free prices via a Bregman projection. The projection is computed using the fully-corrective Frank-Wolfe algorithm with an integer-programming (IP) oracle.

The algorithm has recently resurfaced in crypto-prediction markets: a 2025 empirical study of Polymarket by IMDEA Networks found that sophisticated arbitrageurs used similar optimization loops to extract approximately US$40 million in risk-free profits, leaving retail traders largely supplying liquidity.

This report explores the adaptive Frank-Wolfe with Bregman projection methodology, examines recent implementations and research, assesses benefits and risks, and outlines a detailed technical specification for incorporating the methodology into a prediction-market arbitrage bot.

---

## Current Research and Implementations

### Fully Corrective Frank-Wolfe & Bregman Projection (Kroer et al., 2016)

**Algorithmic idea.** FWMM alternates between processing trades using an AMM and removing arbitrage by projecting the market state onto the set of arbitrage-free price vectors. Arbitrage removal has two components:

1. **LCMM step:** A fast linear-constraints market maker (LCMM) adjusts prices for trivially detected arbitrage using linear constraints. These trades have guaranteed non-negative profit.
2. **ProjectFW (Algorithm 2):** A more expensive procedure that computes a Bregman projection of the state onto the arbitrage-free polytope using a fully-corrective Frank-Wolfe (FW) algorithm.

**ProjectFW inputs and loop.** ProjectFW takes as inputs the cost function, current state `θ`, partial outcome `σ`, and IP constraints `(A, b)`. It:

- Maintains an active set of vertices `Z_t`.
- Solves a convex minimization over the convex hull of the active set.
- Calls an IP solver to find a descent vertex `z_t` that minimizes the linearization of the Bregman objective.
- Computes the Frank-Wolfe gap `g(μ_t)`.
- Adaptively shrinks a contraction parameter `ε` if the IP solver fails to find a suitable descent vertex.

The algorithm stops when the gap is small relative to the objective or when the Bregman divergence falls below a small threshold. The pseudocode in the original work specifies the adaptive contraction update and stopping conditions.

#### Key properties

The authors prove that moving the market state from `θ` to `θ̂ = ∇R̄(μ̂)` generates guaranteed profit at least `D(μ̂ || θ) - g(μ̂)`. Therefore, it is safe to update the market if the Bregman divergence exceeds the FW gap; otherwise, the algorithm leaves the state unchanged, preserving non-negative profit.

Unlike standard Frank-Wolfe, fully-corrective FW re-optimizes weights over all discovered vertices at each iteration, improving convergence and sparsity. The authors also introduce an adaptive contraction to handle integrality constraints; if the IP solver cannot find a descent vertex, the feasible region is contracted towards an interior point `u` and the algorithm restarts.

#### Implementation notes and related open-source building blocks

Kroer et al. implemented ProjectFW with a commercial IP solver (Gurobi) and used accelerated projected gradient for the convex minimization step. On NCAA basketball markets (2010) with `2^63` outcomes, the algorithm removed all arbitrage after only a few iterations. The IP subproblem dominates running time and may need to be interrupted when new trades arrive.

While the paper provides pseudocode (not a public codebase), it inspired open-source projects including:

- **matteomedioli/Frank-Wolfe-Implementation (Python):** a simple Frank-Wolfe implementation using CPLEX or OR-Tools for the linear subproblem (clarity prioritized over efficiency).
- **walidk/BregmanProjection (Python):** implements Bregman projections with omega potentials, including approximate projections via bisection and exact exponential projections with complexity `O(d log d)`. (Not prediction-market specific, but useful building blocks for probability-simplex projections.)

---

### Empirical Study: IMDEA Networks (2025)

Researchers at IMDEA Networks analyzed 86 million Polymarket transactions (April 2024 to April 2025) and identified two types of arbitrage:

- **Market rebalancing:** within a single market.
- **Combinatorial arbitrage:** across dependent markets.

They found that sophisticated users executed both types, extracting approximately US$40 million in profit. Their paper uses heuristics and large language models to detect dependent conditions and reduces the search space via timeliness and topical similarity. The study underscores the need for automated arbitrage strategies to keep markets efficient.

---

### News and Market Commentary

A January 2026 article on QuantBitrage notes that IMDEA's study found automated arbitrage bots extracting approximately US$40 million from Polymarket between April 2024 and April 2025. It explains that arbitrage arises when buying both YES and NO positions costs less than $1 combined, guaranteeing a profit. Individual traders documented returns of 0.5% to 3% per trade and some institutional market makers earned more than US$20 million in the past year. The article highlights the importance of low-latency API access, automated matching algorithms, and sub-millisecond execution for profitable arbitrage and notes challenges such as liquidity constraints on smaller markets and regulatory risk.

A news report from Ainvest (Aug 2025) similarly summarizes the IMDEA study, stating that hundreds of Polymarket users exploited mispriced wagers to generate risk-free profits totaling almost US$40 million. The top three wallets placed over 10,200 bets and profited US$4.2 million. The article emphasizes the need for regulatory oversight and notes that Polymarket plans to re-enter the US market with a federally registered exchange.

---

### Other Literature

Combinatorial Information Market Design (Chen & Pennock et al.) and subsequent works analyze the computational complexity of cost-based market making. They show that arbitrage-free pricing in combinatorial markets is NP-hard or #P-hard and propose approximate methods. While these papers predate the fully-corrective FW approach, they motivate the need for advanced optimization techniques.

Accelerated and generalized Frank-Wolfe algorithms (e.g., Krishnan et al., 2015; Jaggi, 2013) provide the theoretical foundation for the fully-corrective variant used in ProjectFW. They show that fully-corrective FW can achieve linear or sublinear convergence rates and provide guidance on adaptive step sizes and contraction.

---

## Pros, Cons, Risks and Mitigations

### Advantages

- **Guaranteed arbitrage removal and profit:** ProjectFW ensures each arbitrage-removal trade yields non-negative profit. The Bregman projection only updates the market when the divergence exceeds the FW gap, guaranteeing safe profit accumulation over time.
- **Exact arbitrage-free prices:** Projects the state onto the convex hull of valid payoff vectors, ensuring prices satisfy combinatorial constraints and removing exploitable mispricing.
- **Fully-corrective updates improve convergence:** Re-optimizing weights over all discovered vertices typically reduces iterations compared to standard FW and yields sparse, interpretable positions.
- **Adaptive contraction supports convergence:** Shrinking the feasible region when the IP solver stalls ensures the algorithm eventually finds a descent vertex and converges.
- **Bounded loss:** Arbitrage-removal trades strictly improve the loss bound of the underlying cost function, reducing maximum loss.
- **Applicability to on-chain markets:** Outputs (positions to buy/sell) can be executed atomically on a central limit order book (CLOB) and the method has been adopted by high-frequency bots on Polymarket as described in online threads.

### Drawbacks

- **High computational cost:** Each fully-corrective FW iteration requires solving a potentially large IP to find a descent vertex. For complex combinatorial markets, this may be infeasible without strong solvers and hardware.
- **Latency and race conditions:** Opportunities may vanish before execution. On-chain block times and propagation add latency, and competing bots can front-run/back-run trades.
- **Slippage and price impact:** Buying YES and NO can move prices and reduce profit, or create loss if divergence estimates are inaccurate. Slippage limits and depth checks are needed.
- **Model assumptions and incomplete resolutions:** ProjectFW assumes a partial outcome `σ`. On-chain resolutions can be delayed or disputed; incorrect assumptions can create false arbitrage.
- **Regulatory and market risk:** Prediction markets face regulatory uncertainty; bots must comply with local laws and platform terms.
- **Implementation complexity:** Requires optimization, IP, blockchain integration, risk management, and monitoring; off-the-shelf implementations are scarce.

### Risks and mitigations (table)

| Risk | Description | Mitigation strategies |
|---|---|---|
| Computation and timeouts | IP solver may fail or take too long, causing missed opportunities. | Use efficient IP solvers (Gurobi, OR-Tools) with warm-starts; parallelize search; limit iterations; adaptively shrink contraction parameter as in ProjectFW; implement early stopping with guaranteed profit. |
| Market latency and front-running | Variable block times; adversaries can front-run trades. | Use priority channels (MEV-protected transactions), estimate gas fees, monitor mempool, use limit orders with slippage control, break trades into smaller chunks. |
| Slippage and price impact | Large positions may move the order book, reducing profit. | Enforce slippage tolerance checks, query order book depth, adjust trade size, accumulate gradually. |
| Incorrect assumptions about partial outcome `σ` | Prematurely resolving events can cause incorrect arbitrage calculations. | Integrate with oracle resolution status, only settle when finalized, add safety margin in divergence threshold. |
| Regulatory and compliance risk | Bots may be regulated or banned in some jurisdictions. | Consult legal counsel, restrict to permitted markets, add jurisdiction checks in executor. |
| Software bugs and smart-contract risk | Implementation bugs or contract vulnerabilities could cause losses. | Rigorous testing and formal verification, audited libraries, anomaly monitoring with pause/kill switch. |

---

## Technical Specification

This section proposes a design for implementing adaptive Frank-Wolfe and Bregman-projection arbitrage in a production-ready prediction-market bot. The design aims to be modular, extensible, and robust.

### Architecture overview

**Data interface:** Listens to on-chain order books and trades via websockets/API and maintains an up-to-date local snapshot (best bids/asks, liquidity, partially resolved outcomes). Fetches oracle resolutions for settled events.

**Market state representation:** Encapsulates the current state `θ` (vector of cost parameters/prices), partial outcome `σ` (set of resolved events), and combinatorial constraints `(A, b)` defining allowable payoff vectors. Provides methods to compute:

- Cost function `C_σ(θ)`
- Gradient (prices)
- Convex regularizer `R̄`
- Bregman divergence `D_σ(μ || θ)`
- Sampling valid payoff vectors via the IP solver

**Optimizer module:** Implements FullyCorrectiveFW (ProjectFW):

- **Initialization:** compute an interior point `u` and initial active vertex set `Z_0` (InitFW / Algorithm 3), using the IP solver to generate payoff vectors where each outcome `i` is set to 0 or 1 unless already resolved.
- **Adaptive iteration:** maintain contraction parameter `ε_t`; at each iteration:
  - contract active set towards `u`
  - solve convex minimization over `conv(Z')` using accelerated projected gradient
  - call IP solver to find descent vertex `z_t`
  - compute FW gap `g(μ_t)`
  - update best iterate `t*` by maximizing `F(μ_τ) - g(μ_τ)`
  - stop when `g(μ_t) <= (1 - α) F(μ_t)` or `F(μ_t) <= ε_D`
  - return `θ̂ = ∇R̄(μ_{t*})` with profit guarantee `α D_σ(μ* || θ)`
  - adapt `ε_t` if the descent direction fails

**Trade execution module:** Converts the target state `μ̂` into trades on the CLOB. The difference between current holdings and `μ̂` indicates quantities to buy/sell (YES and NO). Must:

- Calculate trade sizes and direction; ensure `YES + NO = 1` after trades.
- Query order book to estimate slippage; split orders if needed.
- Place limit orders via the Polymarket CLOB API or direct smart-contract calls with gas and slippage parameters.
- Monitor execution and update `θ` accordingly.

**Risk management and controls:** Enforce position limits, slippage tolerance, gas/network cost checks (avoid trades when costs exceed expected profit), throttle trade frequency, and pause trading on anomalies (price spikes, oracle issues).

**Monitoring and analytics:** Log trades, profits, FW gaps, divergence values, and solver times. Provide dashboards and alerts for profit dips or solver failures.

---

### Pseudocode outline

```python
class MarketState:
    def __init__(self, theta, sigma, A, b, cost_fn):
        self.theta = theta  # vector of cost parameters
        self.sigma = sigma  # set of resolved events
        self.A = A          # IP constraint matrix
        self.b = b          # IP constraint bounds
        self.active_vertices = []  # Z_t
        self.interior_point = None
        self.cost_fn = cost_fn     # C_sigma and its conjugate R_bar

    def initialize_fw(self):
        # perform InitFW (Algorithm 3)
        # compute interior point u and initial active set Z0 using IP solver
        pass

    def bregman_objective(self, mu):
        # F(mu) = R_bar_sigma(mu) - theta · mu + C_sigma(theta)
        pass

    def gradient(self, mu):
        # ∇F(mu) = theta_t - theta
        pass


class FullyCorrectiveFW:
    def __init__(self, market_state, alpha=0.9, eps0=1e-3, eps_D=1e-6):
        self.ms = market_state
        self.alpha = alpha
        self.eps = eps0
        self.eps_D = eps_D

    def run(self):
        self.ms.initialize_fw()
        best_iter = None
        for t in range(MAX_ITERS):
            # contract active set towards interior point
            Z_contracted = [
                (1 - self.eps) * z + self.eps * self.ms.interior_point
                for z in self.ms.active_vertices
            ]

            # solve convex minimization over conv(Z_contracted) -> mu_t
            mu_t = solve_convex_min(self.ms, Z_contracted)
            theta_t = self.ms.gradient(mu_t)

            # call IP solver to get descent vertex
            z_t = solve_ip(theta_t - self.ms.theta, self.ms.A, self.ms.b)
            self.ms.active_vertices.append(z_t)

            # compute FW gap
            g_t = (theta_t - self.ms.theta).dot(mu_t - z_t)
            F_t = self.ms.bregman_objective(mu_t)

            # update best iterate
            if best_iter is None or F_t - g_t > best_iter[2]:
                best_iter = (mu_t, theta_t, F_t - g_t, g_t)

            # stopping condition
            if g_t <= (1 - self.alpha) * F_t or F_t <= self.eps_D:
                mu_star, theta_star, _, gap = best_iter
                if gap <= F_t:
                    return theta_star, "profit", self.alpha * (F_t - g_t)
                else:
                    return self.ms.theta, "no_change", 0

            # adapt contraction if necessary
            gu = (theta_t - self.ms.theta).dot(mu_t - self.ms.interior_point)
            if gu < 0 and g_t / (-4 * gu) < self.eps:
                self.eps = min(g_t / (-4 * gu), self.eps / 2)

        return self.ms.theta, "timeout", 0
```

This pseudocode matches Algorithm 2 and shows how to integrate the IP solver and adaptive contraction. Production code should handle solver exceptions, allow early termination on new trades, and integrate with asynchronous event loops.

---

### Technology stack and libraries

- **Programming language:** Python for rapid development, with performance-critical parts (convex optimization and IP solver calls) optionally in C/C++ or Julia.
- **IP solver:** Gurobi (commercial, typically faster) or OR-Tools (open-source, typically slower). The referenced simple Frank-Wolfe implementation uses either CPLEX or OR-Tools.
- **Convex optimization:** CVXPY with OSQP or SCS for accelerated projected gradient; or a custom Nesterov-style accelerated gradient implementation (low dimension `|Z_t|`). Ensure correct gradient evaluation.
- **Blockchain integration:** Connect to the Polymarket CLOB via Web3 API or direct HTTP endpoints for order placement. Use async websocket clients for real-time order book updates.
- **Data storage:** Time-series DB (InfluxDB) or SQL to record trades, states, and metrics.
- **Monitoring:** Prometheus/Grafana for metrics and Slack/Telegram bots for alerts.

---

### Operational considerations

Concurrency: The optimizer should run concurrently with market data ingestion and trade execution. Use an event-driven architecture (e.g., `asyncio`) and interrupt ProjectFW if a new trade arrives before the current projection completes.

Parameter tuning: Choose approximation ratio `α` (e.g., 0.9) and contraction initial `ε_0` based on profit guarantee and computational budget. The IMDEA report suggests bots extract 0.5% to 3% per trade; tune `α` accordingly.

Warm-starts: After each arbitrage removal, warm-start using the previous active set and interior point to reduce iterations.

Stateful caching: Cache IP solver solutions and reuse when similar price vectors appear; maintain a library of common descent vertices.

Security: Use hardware wallets or secure key management for signing transactions; implement rate limiting and anomaly detection.

---

## Conclusion

Adaptive fully-corrective Frank-Wolfe optimization combined with Bregman projection offers a principled way to eliminate arbitrage in combinatorial prediction markets with a non-negative profit guarantee. The approach is academically validated and reported to be used by sophisticated Polymarket bots. However, production deployment requires careful management of computational complexity, latency, risk, and regulatory constraints. A modular architecture that separates market data, optimization, execution, and controls can turn the methodology into a robust arbitrage bot and can help keep prediction markets efficient while generating returns for the operator.

---

## References (as listed in the PDF)

- 1606.02825.pdf: https://arxiv.org/pdf/1606.02825.pdf
- Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets: https://arxiv.org/html/2508.03474v1
- GitHub: matteomedioli/Frank-Wolfe-Implementation: https://github.com/matteomedioli/Frank-Wolfe-Implementation
- GitHub: walidk/BregmanProjection (README): https://github.com/walidk/BregmanProjection/blob/master/README.md
- The $40 Million Arbitrage Gold Rush: How Bots Are Mining Profits from Prediction Markets (QuantBitrage): https://quantbitrage.com/article/prediction-markets-arbitrage
- Polymarket users lose millions to 'bot-like' bettors in mispriced bets study (Ainvest): https://www.ainvest.com/news/polymarket-users-lose-millions-bot-bettors-mispriced-bets-study-2508/
