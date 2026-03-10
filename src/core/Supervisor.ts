import type { MessageBus } from './MessageBus.js';
import type { MarketUpdateEvent, RuntimeEventMap } from './runtimeEvents.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import {
  extractDeterministicDependencyEdges,
  type DependencyEdge,
  type DependencyMarketInput
} from '../domain/dependency.js';
import type { MarketPair } from '../domain/market.js';
import { opportunityId, type ArbitrageOpportunity } from '../domain/opportunity.js';
import { depthAtTopLevels } from '../domain/orderbook.js';
import type { OrderBookState } from '../domain/orderbook.js';
import {
  evaluateEvGates,
  evaluateFwBasketGates,
  evaluateFwProjectionGates,
  evaluateGatesWithFees
} from '../domain/gates.js';
import { createUniformTakerFeeModel } from '../domain/feeModel.js';
import type { MarketDataAgent } from '../agents/market-data/MarketDataAgent.js';
import type { ScannerAgent } from '../agents/scanner/ScannerAgent.js';
import type { RiskAgent } from '../agents/risk/RiskAgent.js';
import type { ExecutionAgent } from '../agents/execution/ExecutionAgent.js';
import type { PortfolioAgent } from '../agents/portfolio/PortfolioAgent.js';
import type { MarketAllowlist } from '../domain/allowlist.js';
import type { MetricEvent, MetricsStore } from '../telemetry/metrics.js';
import type { VenueOpenOrder, VenuePosition } from '../domain/venue.js';
import type { PolymarketClob } from '../services/PolymarketClob.js';
import type { PolymarketDataApi } from '../services/PolymarketDataApi.js';
import type { PolymarketRealtime } from '../services/PolymarketRealtime.js';
import type { IncidentTracker } from '../services/IncidentTracker.js';
import type { TradingMode } from '../config/env.js';
import type { EventStore } from './EventStore.js';
import type { CircuitBreakerRegistry } from './CircuitBreaker.js';
import type { ExecutionAdvisor } from '../agents/execution/ExecutionAdvisor.js';
import type { RiskAdvisor } from '../agents/risk/RiskAdvisor.js';
import type { SignalAggregatorAgent } from '../agents/signal/SignalAggregatorAgent.js';
import type { FwProjectionAgent } from '../agents/projection/FwProjectionAgent.js';
import { normalizeReasonKey, shouldEmitScopedReason } from '../utils/eventDedupe.js';
import {
  buildRuntimeSupervisorAssembly,
  type SupervisorLLMContext
} from './supervisorAssembly.js';

const GATE_REJECTION_EMISSION_COOLDOWN_MS = 3000;
const FW_COHORT_MIN_MARKETS = 2;
const FW_COHORT_MIN_DENSITY = 0.25;
const FW_COHORT_FRESHNESS_WINDOW_MS = 120_000;

interface FwCohortComponent {
  marketIds: string[];
  edgeCount: number;
  density: number;
}

type SupervisorScanner = Pick<
  ScannerAgent,
  | 'scanPair'
  | 'scanFwPair'
  | 'scanFwUniverse'
  | 'prioritizeOpportunities'
  | 'updateTradingMode'
  | 'updatePolicy'
  | 'stop'
>;

const ORDER_ID_KEYS = ['orderID', 'orderId', 'order_id', 'id'] as const;

export interface SupervisorConfig {
  marketPairs: MarketPair[];
  policy: TradePolicy;
  riskConfig: RiskConfig;
  capital: number;
  tradingEnabled: boolean;
  tradingMode: TradingMode;
  maxConcurrentMarkets?: number;
  maxCapitalInFlight?: number;
  bookRefresh?: {
    intervalMs: number;
    maxStalenessMs: number;
  };
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

export interface SyntheticOpportunityOptions {
  marketId?: string;
  yesPrice?: number;
  noPrice?: number;
  costPerSet?: number;
  edge?: number;
  tickSize?: number;
  minOrderSize?: number;
  maxSizeByDepth?: number;
  execute?: boolean;
  executionMode?: TradingMode;
}

export interface SyntheticOpportunityResult {
  ok: boolean;
  marketId?: string;
  opportunityId?: string;
  message?: string;
  opportunity?: ArbitrageOpportunity;
  riskDecision?: { approved: boolean; reason: string; positionSize?: number | null };
  execution?: { attempted: boolean; mode: TradingMode; reason?: string };
  orderedIds?: string[];
}

export interface SupervisorDeps {
  messageBus: MessageBus<RuntimeEventMap>;
  clob: PolymarketClob;
  dataApi?: PolymarketDataApi;
  realtime: PolymarketRealtime;
  userRealtime?: PolymarketRealtime;
  allowlist: MarketAllowlist;
  metrics: MetricsStore;
  incidentTracker: IncidentTracker;
  portfolio: PortfolioAgent;
  eventStore?: EventStore;
  llm?: SupervisorLLMContext;
  executionAdvisor?: ExecutionAdvisor;
  riskAdvisor?: RiskAdvisor;
  signalAggregator?: SignalAggregatorAgent;
  fwProjectionAgent?: FwProjectionAgent;
}

export interface SupervisorAssembly {
  marketCircuitBreakers: CircuitBreakerRegistry;
  marketData: MarketDataAgent;
  scanner: SupervisorScanner;
  risk: RiskAgent;
  execution: ExecutionAgent;
}

export class Supervisor {
  private messageBus: MessageBus<RuntimeEventMap>;
  private marketData: MarketDataAgent;
  private scanner: SupervisorScanner;
  private risk: RiskAgent;
  private execution: ExecutionAgent;
  private tokenToPairs = new Map<string, MarketPair[]>();
  private inFlightMarkets = new Set<string>();
  private capitalInFlight = 0;
  private marketCircuitBreakers: CircuitBreakerRegistry;
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private reconciliationAfterIncident: ReturnType<typeof setTimeout> | null = null;
  private reconciliationInFlight = false;
  private bookRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private bookRefreshInFlight = false;
  private started = false;
  private nearZeroFeeModel = createUniformTakerFeeModel(0);
  private gateRejectionEmissionState = new Map<string, { reasonKey: string; timestampMs: number }>();
  private fwScanInFlight = false;
  private fwScanPending = false;
  private fwDeferredScanTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFwScanStartedAtMs = 0;
  private readonly fwScanMinIntervalMs = 250;
  private fwCohortComponents: FwCohortComponent[] = [];
  private fwMarketLastUpdateMs = new Map<string, number>();
  private metricIncidentHandler: ((event: MetricEvent) => void) | null = null;
  private marketUpdatedHandler: ((payload: RuntimeEventMap['market:updated']) => void) | null = null;
  private opportunityDetectedHandler: ((payload: RuntimeEventMap['opportunity:detected']) => void) | null = null;
  private riskApprovedHandler: ((payload: RuntimeEventMap['risk:approved']) => void) | null = null;

  constructor(
    private config: SupervisorConfig,
    private deps: SupervisorDeps,
    assembly?: SupervisorAssembly
  ) {
    this.messageBus = deps.messageBus;
    this.nearZeroFeeModel = createUniformTakerFeeModel(config.policy.nearZeroFeeBps);
    const resolvedAssembly = assembly ?? buildRuntimeSupervisorAssembly(config, deps);
    this.marketCircuitBreakers = resolvedAssembly.marketCircuitBreakers;
    this.marketData = resolvedAssembly.marketData;
    this.scanner = resolvedAssembly.scanner;
    this.risk = resolvedAssembly.risk;
    this.execution = resolvedAssembly.execution;

    this.buildPairIndex();
    this.rebuildFwCohorts();
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

    this.startBookRefresh();
    this.deps.signalAggregator?.start();

    this.marketUpdatedHandler = (event) => void this.handleMarketUpdated(event);
    this.messageBus.on('market:updated', this.marketUpdatedHandler);

    this.opportunityDetectedHandler = (payload) => void this.handleOpportunity(payload);
    this.messageBus.on('opportunity:detected', this.opportunityDetectedHandler);

    this.riskApprovedHandler = (payload) => void this.handleRiskApproved(payload);
    this.messageBus.on('risk:approved', this.riskApprovedHandler);

    if (this.config.marketPairs.length === 0) {
      this.deps.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'no_market_pairs_configured' }
      });
    }

    try {
      await this.marketData.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.metrics.record({
        type: 'error',
        timestamp: Date.now(),
        data: { message: 'startup_dependency_failed', detail: message }
      });
      this.stop();
      throw error;
    }

    if (this.deps.userRealtime) {
      try {
        await this.deps.userRealtime.connect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.metrics.record({
          type: 'error',
          timestamp: Date.now(),
          data: { message: 'startup_dependency_failed', detail: message }
        });
      }
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.scanner.stop();
    this.deps.signalAggregator?.stop();

    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    if (this.bookRefreshInterval) {
      clearInterval(this.bookRefreshInterval);
      this.bookRefreshInterval = null;
    }

    if (this.fwDeferredScanTimer) {
      clearTimeout(this.fwDeferredScanTimer);
      this.fwDeferredScanTimer = null;
    }
    this.fwScanPending = false;
    this.fwScanInFlight = false;

    if (this.reconciliationAfterIncident) {
      clearTimeout(this.reconciliationAfterIncident);
      this.reconciliationAfterIncident = null;
    }

    if (this.metricIncidentHandler) {
      this.deps.metrics.off('event', this.metricIncidentHandler);
      this.metricIncidentHandler = null;
    }

    if (this.marketUpdatedHandler) {
      this.messageBus.off('market:updated', this.marketUpdatedHandler);
      this.marketUpdatedHandler = null;
    }
    if (this.opportunityDetectedHandler) {
      this.messageBus.off('opportunity:detected', this.opportunityDetectedHandler);
      this.opportunityDetectedHandler = null;
    }
    if (this.riskApprovedHandler) {
      this.messageBus.off('risk:approved', this.riskApprovedHandler);
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

      const reconciliation = this.deps.portfolio.reconcileWithVenue({
        openOrders,
        internalOpenOrders,
        positions,
        positionSizeTolerance: settings.positionSizeTolerance,
        nowMs
      });

      try {
        await this.deps.portfolio.analyzeAnomalies({ venueIssues: reconciliation.issues, nowMs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.metrics.record({
          type: 'error',
          timestamp: nowMs,
          data: { message: 'llm_portfolio_anomaly_failed', trigger, error: message }
        });
      }

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
    const opportunities: ArbitrageOpportunity[] = [];

    for (const pair of pairs) {
      this.fwMarketLastUpdateMs.set(pair.marketId, now);
      const opportunity = this.scanner.scanPair(pair, orderbooks, now);
      if (opportunity) {
        this.recordOpportunity(now, opportunity);
        opportunities.push(opportunity);
      }
    }

    const fwOpportunities = await this.scanFwUniverseCoalesced(orderbooks, now);
    for (const fwOpportunity of fwOpportunities) {
      this.recordOpportunity(now, fwOpportunity);
      opportunities.push(fwOpportunity);
    }

    await this.emitOrderedOpportunities(opportunities, now);
  }

  private async scanFwUniverseCoalesced(
    orderbooks: Map<string, OrderBookState>,
    now: number
  ): Promise<ArbitrageOpportunity[]> {
    if (this.fwScanInFlight) {
      this.fwScanPending = true;
      return [];
    }

    const sinceLastStart = now - this.lastFwScanStartedAtMs;
    if (sinceLastStart < this.fwScanMinIntervalMs) {
      this.fwScanPending = true;
      this.scheduleDeferredFwScan(this.fwScanMinIntervalMs - sinceLastStart);
      return [];
    }

    this.lastFwScanStartedAtMs = now;
    this.fwScanInFlight = true;
    try {
      return await this.scanFwUniverse(orderbooks, now);
    } finally {
      this.fwScanInFlight = false;
      if (this.fwScanPending) {
        this.fwScanPending = false;
        this.scheduleDeferredFwScan(this.fwScanMinIntervalMs);
      }
    }
  }

  private scheduleDeferredFwScan(delayMs: number): void {
    if (this.fwDeferredScanTimer) return;
    this.fwDeferredScanTimer = setTimeout(() => {
      this.fwDeferredScanTimer = null;
      void this.runDeferredFwScan();
    }, Math.max(0, delayMs));
  }

  private async runDeferredFwScan(): Promise<void> {
    if (!this.started) return;
    const now = Date.now();
    const fwOpportunities = await this.scanFwUniverseCoalesced(
      this.getOrderbookMap(),
      now
    );
    for (const fwOpportunity of fwOpportunities) {
      this.recordOpportunity(now, fwOpportunity);
    }
    await this.emitOrderedOpportunities(fwOpportunities, now);
  }

  private async scanFwUniverse(
    orderbooks: Map<string, OrderBookState>,
    now: number
  ): Promise<ArbitrageOpportunity[]> {
    const selection = this.selectFwUniversePairs(now);
    const marketUniverse = selection.pairs.map((pair) => ({
      marketId: pair.marketId,
      yesTokenId: pair.yesTokenId,
      noTokenId: pair.noTokenId,
      question: pair.question,
      category: pair.category,
      tags: pair.tags
    }));
    this.deps.metrics.record({
      type: 'fw_dependency',
      timestamp: now,
      data: {
        event: 'universe_selected',
        mode: selection.mode,
        fallbackReason: selection.fallbackReason ?? null,
        selectedMarkets: selection.pairs.length,
        totalMarkets: this.config.marketPairs.length,
        cohortComponentCount: this.fwCohortComponents.length,
        selectedMarketIds: selection.pairs.map((pair) => pair.marketId)
      }
    });

    return this.scanner.scanFwUniverse(orderbooks, marketUniverse, now);
  }

  private recordOpportunity(now: number, opportunity: ArbitrageOpportunity): void {
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
  }

  private async emitOrderedOpportunities(opportunities: ArbitrageOpportunity[], now: number): Promise<void> {
    if (opportunities.length === 0) return;
    const ordered = await this.scanner.prioritizeOpportunities(opportunities, now);
    if (this.config.tradingMode === 'shadow') return;
    for (const opportunity of ordered) {
      this.messageBus.emit('opportunity:detected', { opportunity });
    }
  }

  private async handleOpportunity(payload: { opportunity: ArbitrageOpportunity }): Promise<void> {
    const snapshot = this.deps.portfolio.snapshot();
    const decision = await this.risk.evaluateWithAdvisor(payload.opportunity, snapshot);
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
      this.deps.metrics.recordLatency({
        stage: 'risk_approved',
        opportunityId: payload.opportunity.id,
        marketId: payload.opportunity.marketId,
        timestampMs: now,
        latencyMs: Math.max(0, now - payload.opportunity.detectedAt),
        cumulativeMs: Math.max(0, now - payload.opportunity.detectedAt)
      });
      this.messageBus.emit('risk:approved', {
        opportunity: payload.opportunity,
        size: decision.positionSize
      });
    }
  }

  private async handleRiskApproved(payload: { opportunity: ArbitrageOpportunity; size: number }): Promise<void> {
    const now = Date.now();
    const isBasket = payload.opportunity.type === 'fw_basket' && Array.isArray(payload.opportunity.fwBasket?.markets);
    const basketMarkets = isBasket
      ? payload.opportunity.fwBasket!.markets.map((market) => market.marketId)
      : [payload.opportunity.marketId];
    const marketId = basketMarkets[0] ?? payload.opportunity.marketId;

    const openCircuitMarket = basketMarkets.find((candidate) => this.marketCircuitBreakers.isOpen(candidate));
    if (openCircuitMarket) {
      this.recordGateRejection(now, payload.opportunity.id, marketId, ['circuit_breaker']);
      this.deps.incidentTracker.record({
        marketId: openCircuitMarket,
        reason: 'circuit_breaker',
        timestamp: now,
        opportunityId: payload.opportunity.id,
        detail: { message: 'market circuit breaker open' }
      });
      return;
    }

    const maxConcurrentMarkets = this.config.maxConcurrentMarkets ?? 0;
    const newReservations = basketMarkets.filter((candidate) => !this.inFlightMarkets.has(candidate));
    const projectedInFlight = this.inFlightMarkets.size + newReservations.length;
    if (maxConcurrentMarkets > 0 && projectedInFlight > maxConcurrentMarkets) {
      this.recordGateRejection(now, payload.opportunity.id, marketId, ['max_concurrent_markets']);
      return;
    }

    const requiredCapital = Math.max(
      0,
      isBasket
        ? payload.size *
            payload.opportunity.fwBasket!.markets.reduce((sum, market) => sum + market.costPerSet, 0)
        : payload.size * payload.opportunity.costPerSet
    );
    const maxCapitalInFlight = this.config.maxCapitalInFlight ?? 0;
    if (maxCapitalInFlight > 0 && requiredCapital > 0 && this.capitalInFlight + requiredCapital > maxCapitalInFlight) {
      this.recordGateRejection(now, payload.opportunity.id, marketId, ['capital_in_flight']);
      return;
    }

    if (basketMarkets.some((candidate) => this.inFlightMarkets.has(candidate))) {
      this.recordGateRejection(now, payload.opportunity.id, marketId, ['market_in_flight']);
      return;
    }

    for (const reservation of basketMarkets) {
      this.inFlightMarkets.add(reservation);
    }
    this.capitalInFlight += requiredCapital;
    try {
      const yesBook = this.marketData.getOrderBook(payload.opportunity.yesTokenId);
      const noBook = this.marketData.getOrderBook(payload.opportunity.noTokenId);
      if (!yesBook || !noBook) {
        this.recordGateRejection(now, payload.opportunity.id, marketId, ['missing_orderbook']);
        return;
      }

      const isEv = payload.opportunity.type === 'ev';
      const isFw = payload.opportunity.type === 'fw_projection';
      if (isEv && !payload.opportunity.side) {
        this.recordGateRejection(now, payload.opportunity.id, marketId, ['ev_missing_side']);
        return;
      }
      if (isFw && !payload.opportunity.fw) {
        this.recordGateRejection(now, payload.opportunity.id, marketId, ['fw_projection_missing']);
        return;
      }

      const gateDecision = isBasket
        ? evaluateFwBasketGates({
            policy: this.config.policy,
            nowMs: now,
            desiredSize: payload.size,
            projectionAgeMs: payload.opportunity.fw?.projectionAgeMs ?? 0,
            aggregateEdgeLowerBound: payload.opportunity.edge,
            markets: payload.opportunity.fwBasket!.markets,
            orderbooks: this.getOrderbookMap()
          })
        : isFw
          ? evaluateFwProjectionGates({
              yesBook,
              noBook,
              policy: this.config.policy,
              nowMs: now,
              desiredSize: payload.size,
              projection: payload.opportunity.fw!
            })
          : isEv
            ? evaluateEvGates({
              yesBook,
              noBook,
              policy: this.config.policy,
              nowMs: now,
              desiredSize: payload.size,
              side: payload.opportunity.side as 'yes' | 'no',
              evEdge:
                typeof payload.opportunity.evNet === 'number'
                  ? payload.opportunity.evNet
                  : typeof payload.opportunity.evRaw === 'number'
                    ? payload.opportunity.evRaw
                    : 0,
              confidence:
                typeof payload.opportunity.modelConfidence === 'number' ? payload.opportunity.modelConfidence : 0
              })
            : evaluateGatesWithFees({
              yesBook,
              noBook,
              policy: this.config.policy,
              nowMs: now,
              desiredSize: payload.size,
              venue: 'polymarket',
              feeModel: this.nearZeroFeeModel
              });

      if (!gateDecision.passed) {
        this.recordGateRejection(now, payload.opportunity.id, marketId, gateDecision.reasons, gateDecision);
        return;
      }

      const gateMs = Date.now();
      this.deps.metrics.recordLatency({
        stage: 'gated',
        opportunityId: payload.opportunity.id,
        marketId,
        timestampMs: gateMs,
        latencyMs: Math.max(0, gateMs - payload.opportunity.detectedAt),
        cumulativeMs: Math.max(0, gateMs - payload.opportunity.detectedAt)
      });

      const result = isBasket
        ? await this.execution.executeBasketArbitrage(payload.opportunity, payload.size, {
            nowMs: now
          })
        : payload.opportunity.type === 'ev'
          ? await this.execution.executeEvOpportunity(payload.opportunity, payload.size, {
              yesBook,
              noBook,
              nowMs: now
            })
          : await this.execution.executeArbitrage(payload.opportunity, payload.size, {
              yesBook,
              noBook,
              nowMs: now
            });

      for (const affectedMarket of basketMarkets) {
        const beforeState = this.marketCircuitBreakers.get(affectedMarket).refreshAndGetState();
        if (result.status === 'submitted') {
          this.marketCircuitBreakers.recordSuccess(affectedMarket);
        } else if (result.status === 'failed') {
          this.marketCircuitBreakers.recordFailure(affectedMarket);
        }
        const afterState = this.marketCircuitBreakers.get(affectedMarket).refreshAndGetState();
        if (beforeState !== 'open' && afterState === 'open') {
          this.deps.incidentTracker.record({
            marketId: affectedMarket,
            reason: 'circuit_breaker',
            timestamp: Date.now(),
            opportunityId: payload.opportunity.id,
            detail: {
              message: 'market circuit breaker opened',
              failures: this.marketCircuitBreakers.get(affectedMarket).getFailureCount()
            }
          });
        }
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
      for (const reservation of basketMarkets) {
        this.inFlightMarkets.delete(reservation);
      }
      this.capitalInFlight = Math.max(0, this.capitalInFlight - requiredCapital);
    }
  }

  private recordGateRejection(
    nowMs: number,
    opportunityId: string,
    marketId: string,
    reasons: string[],
    gateDecision?: { passed: boolean; reasons: string[] }
  ): void {
    const reasonKey = normalizeReasonKey(reasons);
    if (
      !shouldEmitScopedReason(
        this.gateRejectionEmissionState,
        marketId,
        reasonKey,
        nowMs,
        GATE_REJECTION_EMISSION_COOLDOWN_MS
      )
    ) {
      return;
    }

    this.deps.metrics.record({
      type: 'gate_rejection',
      timestamp: nowMs,
      data: {
        opportunityId,
        marketId,
        reasons,
        gateDecision: gateDecision ?? { passed: false, reasons }
      }
    });
  }

  private selectFwUniversePairs(nowMs: number): {
    pairs: MarketPair[];
    mode: 'broad_rotation' | 'dependency_cohort';
    fallbackReason?: string;
  } {
    const mode = this.config.policy.fwUniverseMode;
    if (mode !== 'dependency_cohort') {
      return { pairs: this.config.marketPairs, mode: 'broad_rotation' };
    }

    if (this.fwCohortComponents.length === 0) {
      return {
        pairs: this.config.marketPairs,
        mode,
        fallbackReason: 'sparse_dependency_graph'
      };
    }

    let best: FwCohortComponent | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const component of this.fwCohortComponents) {
      const freshness = averageFreshness(component.marketIds, this.fwMarketLastUpdateMs, nowMs);
      const score = component.density * 0.8 + freshness * 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = component;
      }
    }

    if (!best || best.density < FW_COHORT_MIN_DENSITY || best.marketIds.length < FW_COHORT_MIN_MARKETS) {
      return {
        pairs: this.config.marketPairs,
        mode,
        fallbackReason: 'cohort_below_density_floor'
      };
    }

    const selectedMarketIds = new Set(best.marketIds);
    const selectedPairs = this.config.marketPairs.filter((pair) => selectedMarketIds.has(pair.marketId));
    if (selectedPairs.length < FW_COHORT_MIN_MARKETS) {
      return {
        pairs: this.config.marketPairs,
        mode,
        fallbackReason: 'cohort_selection_empty'
      };
    }

    return { pairs: selectedPairs, mode };
  }

  private rebuildFwCohorts(): void {
    this.fwCohortComponents = buildDependencyCohortComponents(this.config.marketPairs);
    const allowedMarketIds = new Set(this.config.marketPairs.map((pair) => pair.marketId));
    for (const marketId of this.fwMarketLastUpdateMs.keys()) {
      if (!allowedMarketIds.has(marketId)) {
        this.fwMarketLastUpdateMs.delete(marketId);
      }
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

  updateTradingMode(mode: TradingMode): void {
    this.config.tradingMode = mode;
    this.scanner.updateTradingMode(mode);
    this.execution.updateTradingMode(mode);
  }

  updateTradingEnabled(enabled: boolean): void {
    this.config.tradingEnabled = enabled;
    this.execution.updateTradingEnabled(enabled);
  }

  updatePolicyAndRisk(policy: TradePolicy, risk: RiskConfig): void {
    this.config.policy = policy;
    this.config.riskConfig = risk;
    this.nearZeroFeeModel = createUniformTakerFeeModel(policy.nearZeroFeeBps);
    this.scanner.updatePolicy(policy);
    this.risk.updateConfig(risk, {
      maxOpenInventorySeconds: policy.maxOpenInventorySeconds,
      fallbackTickSize: policy.fallbackTickSize,
      depthBufferMultiplier: policy.depthBufferMultiplier,
      evMaxPerMarketNotional: policy.evMaxPerMarketNotional,
      evMaxPortfolioNotional: policy.evMaxPortfolioNotional,
      fwMaxPerMarketNotional: policy.fwMaxPerMarketNotional,
      fwMaxPortfolioNotional: policy.fwMaxPortfolioNotional
    });
    this.execution.updatePolicy(policy);
    this.execution.updateRiskConfig(risk);
    this.deps.signalAggregator?.updatePolicy(policy);
    this.marketCircuitBreakers.updateConfig({
      failureThreshold: risk.marketCircuitFailureThreshold,
      cooldownMs: risk.marketCooldownSeconds * 1000,
      halfOpenSuccesses: risk.marketCircuitHalfOpenSuccesses
    });
    this.rebuildFwCohorts();
  }

  updateBookRefresh(bookRefresh: { intervalMs: number; maxStalenessMs: number }): void {
    this.config.bookRefresh = bookRefresh;
    if (this.bookRefreshInterval) {
      clearInterval(this.bookRefreshInterval);
      this.bookRefreshInterval = null;
    }
    if (this.started) {
      this.startBookRefresh();
    }
  }

  private startBookRefresh(): void {
    const bookRefresh = this.config.bookRefresh;
    if (!bookRefresh || bookRefresh.intervalMs <= 0) return;
    const intervalMs = Math.max(bookRefresh.intervalMs, 0);
    const maxStalenessMs = Math.max(bookRefresh.maxStalenessMs, 0);
    this.bookRefreshInterval = setInterval(() => {
      if (this.bookRefreshInFlight) return;
      this.bookRefreshInFlight = true;
      void this.marketData.refreshStaleBooks(maxStalenessMs)
        .catch(() => {})
        .finally(() => {
          this.bookRefreshInFlight = false;
        });
    }, intervalMs);
  }

  async debugMarketDataOutlier(tokenId: string): Promise<{ ok: boolean; error?: string }> {
    return this.marketData.detectOutlierNow(tokenId);
  }

  async runSyntheticOpportunityTest(
    options: SyntheticOpportunityOptions = {}
  ): Promise<SyntheticOpportunityResult> {
    const pair = this.resolveSyntheticPair(options.marketId);
    if (!pair) {
      return { ok: false, message: 'market_pair_not_found' };
    }

    const now = Date.now();
    const yesBook = this.marketData.getOrderBook(pair.yesTokenId);
    const noBook = this.marketData.getOrderBook(pair.noTokenId);

    const yesPrice =
      coercePositive(options.yesPrice) ??
      coercePositive(yesBook?.bestAsk?.price) ??
      0.48;
    const noPrice =
      coercePositive(options.noPrice) ??
      coercePositive(noBook?.bestAsk?.price) ??
      0.49;

    const costPerSet =
      coercePositive(options.costPerSet) ??
      coercePositive(yesPrice + noPrice) ??
      0.97;

    const derivedEdge = 1 - costPerSet;
    const edge =
      typeof options.edge === 'number' && Number.isFinite(options.edge)
        ? options.edge
        : Number.isFinite(derivedEdge) && derivedEdge > 0
          ? derivedEdge
          : 0.02;

    const fallbackTickSize = this.config.policy.fallbackTickSize;
    const fallbackMinOrderSize = this.config.policy.fallbackMinOrderSize;

    const tickSize =
      coercePositive(options.tickSize) ??
      coercePositive(Math.max(yesBook?.tickSize ?? 0, noBook?.tickSize ?? 0)) ??
      fallbackTickSize;

    const minOrderSize =
      coercePositive(options.minOrderSize) ??
      coercePositive(Math.max(yesBook?.minOrderSize ?? 0, noBook?.minOrderSize ?? 0)) ??
      fallbackMinOrderSize;

    const yesDepth = yesBook ? depthAtTopLevels(yesBook.asks, 3) : 0;
    const noDepth = noBook ? depthAtTopLevels(noBook.asks, 3) : 0;
    const maxDepthFallback = Math.max(yesDepth, noDepth, 10);

    const maxSizeByDepth =
      coercePositive(options.maxSizeByDepth) ??
      (yesDepth > 0 && noDepth > 0 ? Math.min(yesDepth, noDepth) : maxDepthFallback);

    const opportunity: ArbitrageOpportunity = {
      id: opportunityId(pair.marketId, yesPrice, noPrice, now),
      marketId: pair.marketId,
      yesTokenId: pair.yesTokenId,
      noTokenId: pair.noTokenId,
      yesPrice,
      noPrice,
      costPerSet,
      edge,
      tickSize,
      maxSizeByDepth,
      minOrderSize,
      detectedAt: now,
      gateReasons: ['synthetic'],
      pair
    };

    const ordered = await this.scanner.prioritizeOpportunities([opportunity], now);
    const orderedIds = ordered.map((item) => item.id);
    const selected = ordered[0] ?? opportunity;

    const snapshot = this.deps.portfolio.snapshot();
    const decision = await this.risk.evaluateWithAdvisor(selected, snapshot);

    this.deps.metrics.record({
      type: 'risk',
      timestamp: now,
      data: {
        marketId: selected.marketId,
        approved: decision.approved,
        reason: decision.reason,
        positionSize: decision.positionSize,
        positionNotional: decision.positionNotional,
        worstCaseLoss: decision.worstCaseLoss,
        constraints: decision.constraints,
        synthetic: true
      }
    });

    if (decision.approved && decision.positionSize) {
      this.deps.metrics.recordLatency({
        stage: 'risk_approved',
        opportunityId: selected.id,
        marketId: selected.marketId,
        timestampMs: now,
        latencyMs: Math.max(0, now - selected.detectedAt),
        cumulativeMs: Math.max(0, now - selected.detectedAt)
      });
    }

    const execute = options.execute === true;
    let execution: SyntheticOpportunityResult['execution'] = {
      attempted: false,
      mode: this.config.tradingMode,
      reason: execute ? 'not_attempted' : 'execute_disabled'
    };

    if (execute && decision.approved && decision.positionSize) {
      const previousMode = this.config.tradingMode;
      const overrideMode = options.executionMode;

      if (overrideMode && overrideMode !== previousMode) {
        this.updateTradingMode(overrideMode);
      }

      try {
        if (this.config.tradingMode === 'live' && !overrideMode) {
          execution = {
            attempted: false,
            mode: this.config.tradingMode,
            reason: 'live_guard'
          };
        } else {
          await this.handleRiskApproved({ opportunity: selected, size: decision.positionSize });
          execution = { attempted: true, mode: this.config.tradingMode };
        }
      } finally {
        if (overrideMode && overrideMode !== previousMode) {
          this.updateTradingMode(previousMode);
        }
      }
    }

    this.deps.metrics.record({
      type: 'info',
      timestamp: now,
      data: {
        message: 'synthetic_opportunity_test',
        marketId: selected.marketId,
        opportunityId: selected.id,
        orderedIds,
        riskDecision: {
          approved: decision.approved,
          reason: decision.reason,
          positionSize: decision.positionSize ?? null
        },
        execution
      }
    });

    return {
      ok: true,
      marketId: selected.marketId,
      opportunityId: selected.id,
      opportunity: selected,
      orderedIds,
      riskDecision: {
        approved: decision.approved,
        reason: decision.reason,
        positionSize: decision.positionSize ?? null
      },
      execution
    };
  }

  updateMarketPairs(pairs: MarketPair[]): void {
    const previousIds = new Set(this.config.marketPairs.map((p) => p.marketId));
    const newIds = new Set(pairs.map((p) => p.marketId));

    const added = pairs.filter((p) => !previousIds.has(p.marketId));
    const removed = this.config.marketPairs.filter((p) => !newIds.has(p.marketId));

    if (added.length === 0 && removed.length === 0) {
      return;
    }

    this.config.marketPairs = pairs;
    this.rebuildPairIndex();

    const newTokenIds = collectTokenIds(pairs);
    this.marketData.updateSubscriptions(newTokenIds);
    this.deps.signalAggregator?.updateMarketPairs(pairs);

    this.deps.metrics.record({
      type: 'info',
      timestamp: Date.now(),
      data: {
        message: 'market_pairs_updated',
        added: added.length,
        removed: removed.length,
        total: pairs.length,
        addedIds: added.map((p) => p.marketId),
        removedIds: removed.map((p) => p.marketId)
      }
    });
  }

  private rebuildPairIndex(): void {
    this.tokenToPairs.clear();
    this.buildPairIndex();
    this.rebuildFwCohorts();
  }

  private resolveSyntheticPair(marketId?: string): MarketPair | null {
    if (marketId) {
      return this.config.marketPairs.find((pair) => pair.marketId === marketId) ?? null;
    }
    return this.config.marketPairs[0] ?? null;
  }
}

function coercePositive(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return null;
}

function collectTokenIds(pairs: MarketPair[]): string[] {
  const set = new Set<string>();
  for (const pair of pairs) {
    set.add(pair.yesTokenId);
    set.add(pair.noTokenId);
  }
  return Array.from(set);
}

function toDependencyInput(pair: MarketPair): DependencyMarketInput {
  return {
    marketId: pair.marketId,
    yesTokenId: pair.yesTokenId,
    noTokenId: pair.noTokenId,
    question: pair.question,
    category: pair.category,
    tags: pair.tags
  };
}

function buildDependencyAdjacency(edges: DependencyEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const left = adjacency.get(edge.marketA) ?? new Set<string>();
    left.add(edge.marketB);
    adjacency.set(edge.marketA, left);
    const right = adjacency.get(edge.marketB) ?? new Set<string>();
    right.add(edge.marketA);
    adjacency.set(edge.marketB, right);
  }
  return adjacency;
}

function collectDependencyComponent(
  startMarketId: string,
  adjacency: Map<string, Set<string>>,
  visited: Set<string>
): Set<string> {
  const queue = [startMarketId];
  const component = new Set<string>([startMarketId]);
  visited.add(startMarketId);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      component.add(neighbor);
      queue.push(neighbor);
    }
  }

  return component;
}

function countComponentEdges(component: Set<string>, edges: DependencyEdge[]): number {
  let edgeCount = 0;
  for (const edge of edges) {
    if (component.has(edge.marketA) && component.has(edge.marketB)) {
      edgeCount += 1;
    }
  }
  return edgeCount;
}

function toFwCohortComponent(
  component: Set<string>,
  edges: DependencyEdge[]
): FwCohortComponent | null {
  if (component.size < FW_COHORT_MIN_MARKETS) {
    return null;
  }
  const edgeCount = countComponentEdges(component, edges);
  const marketIds = Array.from(component).sort((left, right) => left.localeCompare(right));
  const possibleEdges = (marketIds.length * (marketIds.length - 1)) / 2;
  const density = possibleEdges > 0 ? edgeCount / possibleEdges : 0;
  return { marketIds, edgeCount, density };
}

function buildDependencyCohortComponents(pairs: MarketPair[]): FwCohortComponent[] {
  if (pairs.length < FW_COHORT_MIN_MARKETS) return [];
  const markets = pairs.map(toDependencyInput);
  const edges = extractDeterministicDependencyEdges(markets, Date.now(), {
    source: 'deterministic',
    evidencePrefix: 'cohort'
  }).filter((edge) => edge.marketA !== edge.marketB);
  if (edges.length === 0) return [];

  const adjacency = buildDependencyAdjacency(edges);

  const components: FwCohortComponent[] = [];
  const visited = new Set<string>();
  for (const marketId of adjacency.keys()) {
    if (visited.has(marketId)) {
      continue;
    }
    const cohort = toFwCohortComponent(collectDependencyComponent(marketId, adjacency, visited), edges);
    if (cohort) {
      components.push(cohort);
    }
  }

  return components.sort((left, right) => {
    if (right.density !== left.density) return right.density - left.density;
    if (right.edgeCount !== left.edgeCount) return right.edgeCount - left.edgeCount;
    if (right.marketIds.length !== left.marketIds.length) {
      return right.marketIds.length - left.marketIds.length;
    }
    return left.marketIds.join('|').localeCompare(right.marketIds.join('|'));
  });
}

function averageFreshness(
  marketIds: string[],
  marketLastUpdateMs: Map<string, number>,
  nowMs: number
): number {
  if (marketIds.length === 0) return 0;
  let sum = 0;
  for (const marketId of marketIds) {
    const lastUpdateMs = marketLastUpdateMs.get(marketId) ?? 0;
    const ageMs = Math.max(0, nowMs - lastUpdateMs);
    const freshness = Math.max(0, 1 - ageMs / FW_COHORT_FRESHNESS_WINDOW_MS);
    sum += freshness;
  }
  return sum / marketIds.length;
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
  if (!order || typeof order !== 'object') {
    return undefined;
  }
  const payload = order as Record<string, unknown>;
  for (const key of ORDER_ID_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
