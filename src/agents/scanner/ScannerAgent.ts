import type { TradePolicy } from '../../config/policy.js';
import type { TradingMode } from '../../config/env.js';
import { MarketAllowlist } from '../../domain/allowlist.js';
import { evaluateGates } from '../../domain/gates.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity, opportunityId } from '../../domain/opportunity.js';
import type { MetricsStore } from '../../telemetry/metrics.js';

export interface ScannerAgentConfig {
  tradingMode?: TradingMode;
  metrics?: MetricsStore;
}

export class ScannerAgent {
  private tradingMode: TradingMode;
  private metrics?: MetricsStore;

  constructor(
    private policy: TradePolicy,
    private allowlist: MarketAllowlist,
    config?: ScannerAgentConfig
  ) {
    this.tradingMode = config?.tradingMode ?? 'off';
    this.metrics = config?.metrics;
  }

  scanPair(
    pair: MarketPair,
    orderbooks: Map<string, OrderBookState>,
    nowMs = Date.now()
  ): ArbitrageOpportunity | null {
    if (this.tradingMode === 'off') {
      return null;
    }

    if (!this.allowlist.isAllowed(pair.marketId, nowMs)) {
      return null;
    }

    const yesBook = orderbooks.get(pair.yesTokenId);
    const noBook = orderbooks.get(pair.noTokenId);
    if (!yesBook || !noBook) {
      return null;
    }

    const gateDecision = evaluateGates({
      yesBook,
      noBook,
      policy: this.policy,
      nowMs
    });

    if (!gateDecision.passed) {
      const gateOpportunityId = buildGateOpportunityId(pair, yesBook, noBook, nowMs);
      this.metrics?.record({
        type: 'gate_rejection',
        timestamp: nowMs,
        data: {
          opportunityId: gateOpportunityId,
          marketId: pair.marketId,
          reasons: gateDecision.reasons,
          gateDecision
        }
      });
      return null;
    }

    const bestYes = yesBook.bestAsk!;
    const bestNo = noBook.bestAsk!;
    const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);
    const tickSize = Math.max(yesBook.tickSize, noBook.tickSize);

    return {
      id: opportunityId(pair.marketId, bestYes.price, bestNo.price, nowMs),
      marketId: pair.marketId,
      yesTokenId: pair.yesTokenId,
      noTokenId: pair.noTokenId,
      yesPrice: bestYes.price,
      noPrice: bestNo.price,
      costPerSet: gateDecision.costPerSet,
      edge: gateDecision.edge,
      tickSize,
      maxSizeByDepth: gateDecision.maxSizeByDepth,
      minOrderSize,
      detectedAt: nowMs,
      gateReasons: gateDecision.reasons,
      pair
    };
  }
}

function buildGateOpportunityId(
  pair: MarketPair,
  yesBook: OrderBookState,
  noBook: OrderBookState,
  nowMs: number
): string {
  if (yesBook.bestAsk && noBook.bestAsk) {
    return opportunityId(pair.marketId, yesBook.bestAsk.price, noBook.bestAsk.price, nowMs);
  }
  return `${pair.marketId}:gate-rejection:${nowMs}`;
}
