import { messageBus } from './MessageBus.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { MarketPair } from '../domain/market.js';
import type { ArbitrageOpportunity } from '../domain/opportunity.js';
import type { OrderBookState } from '../domain/orderbook.js';
import { evaluateGates } from '../domain/gates.js';
import { MarketDataAgent, type MarketUpdateEvent } from '../agents/market-data/MarketDataAgent.js';
import { ScannerAgent } from '../agents/scanner/ScannerAgent.js';
import { RiskAgent } from '../agents/risk/RiskAgent.js';
import { ExecutionAgent } from '../agents/execution/ExecutionAgent.js';
import { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricEvent, MetricsStore } from '../telemetry/metrics.js';
import type { VenueOpenOrder, VenuePosition } from '../domain/venue.js';
import type { PolymarketClob } from '../services/PolymarketClob.js';
import type { PolymarketDataApi } from '../services/PolymarketDataApi.js';
import type { PolymarketRealtime } from '../services/PolymarketRealtime.js';
import type { IncidentTracker } from '../services/IncidentTracker.js';
import type { TradingMode } from '../config/env.js';
import type { EventStore } from './EventStore.js';
import { CircuitBreakerRegistry } from './CircuitBreaker.js';

export interface SupervisorConfig {
  marketPairs: MarketPair[];
  policy: TradePolicy;
  riskConfig: RiskConfig;
  capital: number;
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  reconciliation?: {
    intervalMs: number;
    afterIncidentDelayMs: number;
    positionSizeTolerance: number;
    positionsUser?: string;
    positionsSizeThreshold: number;
    positionsLimit: number;
    positionsOffset: number;
  };
}

export interface SupervisorDeps {
  clob: PolymarketClob;
  dataApi?: PolymarketDataApi;
  realtime: PolymarketRealtime;
  userRealtime?: PolymarketRealtime;
  allowlist: MarketAllowlist;
  metrics: MetricsStore;
  incidentTracker: IncidentTracker;
  portfolio: PortfolioAgent;
  eventStore?: EventStore;
}

export class Supervisor {
  private marketData: MarketDataAgent;
  private scanner: ScannerAgent;
  private risk: RiskAgent;
  private execution: ExecutionAgent;
  private tokenToPairs = new Map<string, MarketPair[]>();
  private inFlightMarkets = new Set<string>();
  private marketCircuitBreakers: CircuitBreakerRegistry;
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private reconciliationAfterIncident: ReturnType<typeof setTimeout> | null = null;
  private reconciliationInFlight = false;
  private started = false;
  private metricIncidentHandler: ((event: MetricEvent) => void) | null = null;
  private marketUpdatedHandler: ((payload: unknown) => void) | null = null;
  private opportunityDetectedHandler: ((payload: unknown) => void) | null = null;
  private riskApprovedHandler: ((payload: unknown) => void) | null = null;

  constructor(
    private config: SupervisorConfig,
    private deps: SupervisorDeps
  ) {
    this.marketData = new MarketDataAgent(
      {
        tokenIds: collectTokenIds(config.marketPairs),
        policy: config.policy,
        metrics: deps.metrics
      },
      deps.clob,
      deps.realtime
    );
    this.scanner = new ScannerAgent(config.policy, deps.allowlist, {
      tradingMode: config.tradingMode,
      metrics: deps.metrics
    });
    this.risk = new RiskAgent(config.riskConfig, {
      maxOpenInventorySeconds: config.policy.maxOpenInventorySeconds,
      fallbackTickSize: config.policy.fallbackTickSize,
      depthBufferMultiplier: config.policy.depthBufferMultiplier
    });
    this.marketCircuitBreakers = new CircuitBreakerRegistry(
      {
        failureThreshold: config.riskConfig.marketCircuitFailureThreshold,
        cooldownMs: config.riskConfig.marketCooldownSeconds * 1000,
        halfOpenSuccesses: config.riskConfig.marketCircuitHalfOpenSuccesses
      },
      'market'
    );
    this.execution = new ExecutionAgent(config.policy, deps.clob, deps.incidentTracker, deps.metrics, {
      tradingEnabled: config.tradingEnabled,
      tradingMode: config.tradingMode,
      eventStore: deps.eventStore,
      riskConfig: config.riskConfig,
      portfolio: deps.portfolio,
      userRealtime: deps.userRealtime,
      circuitBreakers: this.marketCircuitBreakers
    });

    this.buildPairIndex();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.deps.eventStore) {
      const events = this.deps.eventStore.listSince(0);
      this.execution.restoreActiveExecutions(events);
    }

    if (this.config.reconciliation) {
      await this.runReconciliation('startup');
      this.metricIncidentHandler = (event) => {
        if (event.type !== 'incident') return;
        this.scheduleIncidentReconciliation();
      };
      this.deps.metrics.on('event', this.metricIncidentHandler);

      const intervalMs = this.config.reconciliation.intervalMs;
      if (intervalMs > 0) {
        this.reconciliationInterval = setInterval(() => {
          void this.runReconciliation('interval');
        }, intervalMs);
      }
    }

    this.marketUpdatedHandler = (event) => void this.handleMarketUpdated(event as MarketUpdateEvent);
    messageBus.on('market:updated', this.marketUpdatedHandler);

    this.opportunityDetectedHandler = (payload) =>
      void this.handleOpportunity(payload as { opportunity: ArbitrageOpportunity });
    messageBus.on('opportunity:detected', this.opportunityDetectedHandler);

    this.riskApprovedHandler = (payload) =>
      void this.handleRiskApproved(payload as { opportunity: ArbitrageOpportunity; size: number });
    messageBus.on('risk:approved', this.riskApprovedHandler);

    if (this.config.marketPairs.length === 0) {
      this.deps.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'no_market_pairs_configured' }
      });
    }

    await Promise.all([this.marketData.start(), this.deps.userRealtime?.connect()]);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    if (this.reconciliationAfterIncident) {
      clearTimeout(this.reconciliationAfterIncident);
      this.reconciliationAfterIncident = null;
    }

    if (this.metricIncidentHandler) {
      this.deps.metrics.off('event', this.metricIncidentHandler);
      this.metricIncidentHandler = null;
    }

    if (this.marketUpdatedHandler) {
      messageBus.off('market:updated', this.marketUpdatedHandler);
      this.marketUpdatedHandler = null;
    }
    if (this.opportunityDetectedHandler) {
      messageBus.off('opportunity:detected', this.opportunityDetectedHandler);
      this.opportunityDetectedHandler = null;
    }
    if (this.riskApprovedHandler) {
      messageBus.off('risk:approved', this.riskApprovedHandler);
      this.riskApprovedHandler = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.config.reconciliation) {
      await this.runReconciliation('shutdown');
    }
  }

  getOrderBooks(): OrderBookState[] {
    return Array.from(this.getOrderbookMap().values());
  }

  getCircuitBreakerOpenMarkets(): string[] {
    return this.marketCircuitBreakers.getOpenMarkets();
  }

  private scheduleIncidentReconciliation(): void {
    const settings = this.config.reconciliation;
    if (!settings) return;
    if (this.reconciliationAfterIncident) return;

    const delayMs = Math.max(settings.afterIncidentDelayMs, 0);
    this.reconciliationAfterIncident = setTimeout(() => {
      this.reconciliationAfterIncident = null;
      void this.runReconciliation('incident');
    }, delayMs);
  }

  private async runReconciliation(trigger: 'startup' | 'interval' | 'incident' | 'shutdown'): Promise<void> {
    const settings = this.config.reconciliation;
    if (!settings) return;

    if (this.reconciliationInFlight) return;
    this.reconciliationInFlight = true;

    const nowMs = Date.now();

    try {
      const internalOpenOrders = collectInternalOpenOrders(this.execution.getActiveExecutions());

      let openOrders: VenueOpenOrder[] = [];
      try {
        openOrders = await this.deps.clob.getActiveOrders();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.metrics.record({
          type: 'error',
          timestamp: nowMs,
          data: { message: 'reconciliation_open_orders_failed', trigger, error: message }
        });
      }

      let positions: VenuePosition[] = [];
      if (!this.deps.dataApi || !settings.positionsUser) {
        this.deps.metrics.record({
          type: 'info',
          timestamp: nowMs,
          data: { message: 'reconciliation_positions_skipped', trigger, configured: Boolean(settings.positionsUser) }
        });
      } else {
        try {
          positions = await this.deps.dataApi.getPositions({
            user: settings.positionsUser,
            sizeThreshold: settings.positionsSizeThreshold,
            limit: settings.positionsLimit,
            offset: settings.positionsOffset
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.metrics.record({
            type: 'error',
            timestamp: nowMs,
            data: { message: 'reconciliation_positions_failed', trigger, error: message }
          });
        }
      }

      this.deps.portfolio.reconcileWithVenue({
        openOrders,
        internalOpenOrders,
        positions,
        positionSizeTolerance: settings.positionSizeTolerance,
        nowMs
      });

      if (trigger === 'startup') {
        const internalOrderIds = new Set(internalOpenOrders.map((order) => order.orderId));
        const extras = openOrders.filter((order) => order.orderId && !internalOrderIds.has(order.orderId));

        for (const order of extras) {
          try {
            await this.deps.clob.cancelOrder(order.orderId);
            this.deps.metrics.record({
              type: 'info',
              timestamp: Date.now(),
              data: { message: 'startup_cancelled_orphan_order', orderId: order.orderId }
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.metrics.record({
              type: 'error',
              timestamp: Date.now(),
              data: { message: 'startup_cancel_orphan_order_failed', orderId: order.orderId, error: message }
            });
            this.deps.incidentTracker.record({
              marketId: order.marketId ?? 'unknown',
              reason: 'order_cancel_failed',
              timestamp: Date.now(),
              detail: { orderId: order.orderId, error: message }
            });
          }
        }
      }
    } finally {
      this.reconciliationInFlight = false;
    }
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
        if (this.config.tradingMode !== 'shadow') {
          messageBus.emit('opportunity:detected', { opportunity });
        }
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
        reason: decision.reason,
        positionSize: decision.positionSize,
        positionNotional: decision.positionNotional,
        worstCaseLoss: decision.worstCaseLoss,
        constraints: decision.constraints
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
    const now = Date.now();
    const marketId = payload.opportunity.marketId;

    if (this.marketCircuitBreakers.isOpen(marketId)) {
      this.deps.metrics.record({
        type: 'gate_rejection',
        timestamp: now,
        data: {
          opportunityId: payload.opportunity.id,
          marketId,
          reasons: ['circuit_breaker'],
          gateDecision: { passed: false, reasons: ['circuit_breaker'] }
        }
      });
      this.deps.incidentTracker.record({
        marketId,
        reason: 'circuit_breaker',
        timestamp: now,
        opportunityId: payload.opportunity.id,
        detail: { message: 'market circuit breaker open' }
      });
      return;
    }

    if (this.inFlightMarkets.has(marketId)) {
      this.deps.metrics.record({
        type: 'gate_rejection',
        timestamp: now,
        data: {
          opportunityId: payload.opportunity.id,
          marketId,
          reasons: ['market_in_flight'],
          gateDecision: { passed: false, reasons: ['market_in_flight'] }
        }
      });
      return;
    }

    this.inFlightMarkets.add(marketId);
    try {
      const yesBook = this.marketData.getOrderBook(payload.opportunity.yesTokenId);
      const noBook = this.marketData.getOrderBook(payload.opportunity.noTokenId);
      if (!yesBook || !noBook) {
        this.deps.metrics.record({
          type: 'gate_rejection',
          timestamp: now,
          data: {
            opportunityId: payload.opportunity.id,
            marketId: payload.opportunity.marketId,
            reasons: ['missing_orderbook'],
            gateDecision: { passed: false, reasons: ['missing_orderbook'] }
          }
        });
        return;
      }

      const gateDecision = evaluateGates({
        yesBook,
        noBook,
        policy: this.config.policy,
        nowMs: now,
        desiredSize: payload.size
      });

      if (!gateDecision.passed) {
        this.deps.metrics.record({
          type: 'gate_rejection',
          timestamp: now,
          data: {
            opportunityId: payload.opportunity.id,
            marketId,
            reasons: gateDecision.reasons,
            gateDecision
          }
        });
        return;
      }

      const result = await this.execution.executeArbitrage(payload.opportunity, payload.size, {
        yesBook,
        noBook,
        nowMs: now
      });

      const beforeState = this.marketCircuitBreakers.get(marketId).getState();
      if (result.status === 'submitted') {
        this.marketCircuitBreakers.recordSuccess(marketId);
      } else if (result.status === 'failed') {
        this.marketCircuitBreakers.recordFailure(marketId);
      }
      const afterState = this.marketCircuitBreakers.get(marketId).getState();
      if (beforeState !== 'open' && afterState === 'open') {
        this.deps.incidentTracker.record({
          marketId,
          reason: 'circuit_breaker',
          timestamp: Date.now(),
          opportunityId: payload.opportunity.id,
          detail: {
            message: 'market circuit breaker opened',
            failures: this.marketCircuitBreakers.get(marketId).getFailureCount()
          }
        });
      }

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
    } finally {
      this.inFlightMarkets.delete(marketId);
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

function collectInternalOpenOrders(
  states: Array<{ marketId: string; yesTokenId: string; noTokenId: string; yesOrder?: { orderID?: string }; noOrder?: { orderID?: string }; yesFilled: boolean; noFilled: boolean }>
): Array<{ orderId: string; marketId: string; tokenId: string }> {
  const result: Array<{ orderId: string; marketId: string; tokenId: string }> = [];

  for (const state of states) {
    const yesOrderId = extractAnyOrderId(state.yesOrder);
    if (yesOrderId && !state.yesFilled) {
      result.push({ orderId: yesOrderId, marketId: state.marketId, tokenId: state.yesTokenId });
    }
    const noOrderId = extractAnyOrderId(state.noOrder);
    if (noOrderId && !state.noFilled) {
      result.push({ orderId: noOrderId, marketId: state.marketId, tokenId: state.noTokenId });
    }
  }

  return result;
}

function extractAnyOrderId(order: unknown): string | undefined {
  const payload = order as { orderID?: string; orderId?: string; order_id?: string; id?: string };
  const value = payload?.orderID ?? payload?.orderId ?? payload?.order_id ?? payload?.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
