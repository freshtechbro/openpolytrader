import type { TradePolicy } from '../../config/policy.js';
import { MarketAllowlist } from '../../domain/allowlist.js';
import { evaluateGates } from '../../domain/gates.js';
import { type MarketPair } from '../../domain/market.js';
import { type OrderBookState } from '../../domain/orderbook.js';
import { ArbitrageOpportunity, opportunityId } from '../../domain/opportunity.js';

export class ScannerAgent {
  constructor(
    private policy: TradePolicy,
    private allowlist: MarketAllowlist
  ) {}

  scanPair(
    pair: MarketPair,
    orderbooks: Map<string, OrderBookState>,
    nowMs = Date.now()
  ): ArbitrageOpportunity | null {
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
      return null;
    }

    const bestYes = yesBook.bestAsk!;
    const bestNo = noBook.bestAsk!;
    const minOrderSize = Math.max(yesBook.minOrderSize, noBook.minOrderSize);

    return {
      id: opportunityId(pair.marketId, bestYes.price, bestNo.price, nowMs),
      marketId: pair.marketId,
      yesTokenId: pair.yesTokenId,
      noTokenId: pair.noTokenId,
      yesPrice: bestYes.price,
      noPrice: bestNo.price,
      costPerSet: gateDecision.costPerSet,
      edge: gateDecision.edge,
      maxSizeByDepth: gateDecision.maxSizeByDepth,
      minOrderSize,
      detectedAt: nowMs,
      gateReasons: gateDecision.reasons,
      pair
    };
  }
}
