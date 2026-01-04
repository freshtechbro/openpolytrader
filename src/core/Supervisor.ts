import { messageBus } from './MessageBus.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { MarketPair } from '../domain/market.js';
import type { ArbitrageOpportunity } from '../domain/opportunity.js';
import type { OrderBookState } from '../domain/orderbook.js';
import { MarketDataAgent, type MarketUpdateEvent } from '../agents/market-data/MarketDataAgent.js';
import { ScannerAgent } from '../agents/scanner/ScannerAgent.js';
import { RiskAgent } from '../agents/risk/RiskAgent.js';
import { ExecutionAgent } from '../agents/execution/ExecutionAgent.js';
import { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricsStore } from '../telemetry/metrics.js';
import type { PolymarketClob } from '../services/PolymarketClob.js';
import type { PolymarketRealtime } from '../services/PolymarketRealtime.js';
import type { IncidentTracker } from '../services/IncidentTracker.js';

export interface SupervisorConfig {
  marketPairs: MarketPair[];
  policy: TradePolicy;
  riskConfig: RiskConfig;
  capital: number;
}

export interface SupervisorDeps {
  clob: PolymarketClob;
  realtime: PolymarketRealtime;
  allowlist: MarketAllowlist;
  metrics: MetricsStore;
  incidentTracker: IncidentTracker;
  portfolio: PortfolioAgent;
}

export class Supervisor {
  private marketData: MarketDataAgent;
  private scanner: ScannerAgent;
  private risk: RiskAgent;
  private execution: ExecutionAgent;
  private tokenToPairs = new Map<string, MarketPair[]>();

  constructor(
    private config: SupervisorConfig,
    private deps: SupervisorDeps
  ) {
    this.marketData = new MarketDataAgent(
      {
        tokenIds: collectTokenIds(config.marketPairs),
        policy: config.policy
      },
      deps.clob,
      deps.realtime
    );
    this.scanner = new ScannerAgent(config.policy, deps.allowlist);
    this.risk = new RiskAgent(config.riskConfig);
    this.execution = new ExecutionAgent(config.policy, deps.clob, deps.incidentTracker);

    this.buildPairIndex();
  }

  async start(): Promise<void> {
    messageBus.on('market:updated', (event) => {
      void this.handleMarketUpdated(event as MarketUpdateEvent);
    });

    messageBus.on('opportunity:detected', (payload) => {
      void this.handleOpportunity(payload as { opportunity: ArbitrageOpportunity });
    });

    messageBus.on('risk:approved', (payload) => {
      void this.handleRiskApproved(payload as { opportunity: ArbitrageOpportunity; size: number });
    });

    if (this.config.marketPairs.length === 0) {
      this.deps.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'no_market_pairs_configured' }
      });
    }

    await this.marketData.start();
  }

  private async handleMarketUpdated(event: MarketUpdateEvent): Promise<void> {
    const pairs = this.tokenToPairs.get(event.tokenId) ?? [];
    if (pairs.length === 0) {
      return;
    }

    const orderbooks = this.getOrderbookMap();
    const now = Date.now();

    for (const pair of pairs) {
      const opportunity = this.scanner.scanPair(pair, orderbooks, now);
      if (opportunity) {
        this.deps.metrics.record({
          type: 'opportunity',
          timestamp: now,
          data: {
            id: opportunity.id,
            marketId: opportunity.marketId,
            edge: opportunity.edge,
            maxSizeByDepth: opportunity.maxSizeByDepth
          }
        });
        messageBus.emit('opportunity:detected', { opportunity });
      }
    }
  }

  private async handleOpportunity(payload: { opportunity: ArbitrageOpportunity }): Promise<void> {
    const snapshot = this.deps.portfolio.snapshot();
    const decision = this.risk.evaluate(payload.opportunity, snapshot);
    const now = Date.now();

    this.deps.metrics.record({
      type: 'risk',
      timestamp: now,
      data: {
        marketId: payload.opportunity.marketId,
        approved: decision.approved,
        reason: decision.reason
      }
    });

    if (decision.approved && decision.positionSize) {
      messageBus.emit('risk:approved', {
        opportunity: payload.opportunity,
        size: decision.positionSize
      });
    }
  }

  private async handleRiskApproved(payload: { opportunity: ArbitrageOpportunity; size: number }): Promise<void> {
    try {
      const result = await this.execution.executeArbitrage(payload.opportunity, payload.size);
      this.deps.metrics.record({
        type: 'order',
        timestamp: Date.now(),
        data: result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message }
      });
    }
  }

  private buildPairIndex(): void {
    for (const pair of this.config.marketPairs) {
      const yes = this.tokenToPairs.get(pair.yesTokenId) ?? [];
      yes.push(pair);
      this.tokenToPairs.set(pair.yesTokenId, yes);

      const no = this.tokenToPairs.get(pair.noTokenId) ?? [];
      no.push(pair);
      this.tokenToPairs.set(pair.noTokenId, no);
    }
  }

  private getOrderbookMap(): Map<string, OrderBookState> {
    const map = new Map<string, OrderBookState>();
    for (const pair of this.config.marketPairs) {
      const yes = this.marketData.getOrderBook(pair.yesTokenId);
      const no = this.marketData.getOrderBook(pair.noTokenId);
      if (yes) map.set(pair.yesTokenId, yes);
      if (no) map.set(pair.noTokenId, no);
    }
    return map;
  }
}

function collectTokenIds(pairs: MarketPair[]): string[] {
  const set = new Set<string>();
  for (const pair of pairs) {
    set.add(pair.yesTokenId);
    set.add(pair.noTokenId);
  }
  return Array.from(set);
}
