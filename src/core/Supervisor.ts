import { messageBus } from './MessageBus.js';
import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { MarketPair } from '../domain/market.js';
import { opportunityId, type ArbitrageOpportunity } from '../domain/opportunity.js';
import { depthAtTopLevels } from '../domain/orderbook.js';
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
import type { LLMConfig as AppLLMConfig } from '../config/llm.js';
import type { LLMCallResult, LLMAgentId, LLMRequest } from '../services/llm/types.js';
import type { ExecutionAdvisor } from '../agents/execution/ExecutionAdvisor.js';
import type { RiskAdvisor } from '../agents/risk/RiskAdvisor.js';

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
  clob: PolymarketClob;
  dataApi?: PolymarketDataApi;
  realtime: PolymarketRealtime;
  userRealtime?: PolymarketRealtime;
  allowlist: MarketAllowlist;
  metrics: MetricsStore;
  incidentTracker: IncidentTracker;
  portfolio: PortfolioAgent;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: LLMAgentId, request: LLMRequest, nowMs?: number) => Promise<LLMCallResult> };
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
  executionAdvisor?: ExecutionAdvisor;
  riskAdvisor?: RiskAdvisor;
}

export class Supervisor {
  private marketData: MarketDataAgent;
  private scanner: ScannerAgent;
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
        metrics: deps.metrics,
        eventStore: deps.eventStore,
        llm: deps.llm
          ? {
              config: deps.llm.config,
              client: { call: (agent, request) => deps.llm!.client.call(agent, request) },
              promptVersion: deps.llm.promptVersion,
              policyHashes: deps.llm.policyHashes
            }
          : undefined
      },
      deps.clob,
      deps.realtime
    );
    this.scanner = new ScannerAgent(config.policy, deps.allowlist, {
      tradingMode: config.tradingMode,
      metrics: deps.metrics,
      eventStore: deps.eventStore,
      llm: deps.llm
        ? {
            config: deps.llm.config,
            client: { call: (agent, request) => deps.llm!.client.call(agent, request) },
            promptVersion: deps.llm.promptVersion,
            policyHashes: deps.llm.policyHashes
          }
        : undefined
    });
    this.risk = new RiskAgent(config.riskConfig, {
      maxOpenInventorySeconds: config.policy.maxOpenInventorySeconds,
      fallbackTickSize: config.policy.fallbackTickSize,
      depthBufferMultiplier: config.policy.depthBufferMultiplier
    }, { advisor: deps.riskAdvisor });
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
      circuitBreakers: this.marketCircuitBreakers,
      executionAdvisor: deps.executionAdvisor,
      executionAdvisorMode: deps.llm?.config.agents.ExecutionAgent.mode ?? 'disabled'
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

    this.startBookRefresh();

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

    const results = await Promise.allSettled([
      this.marketData.start(),
      this.deps.userRealtime?.connect()
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
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

    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    if (this.bookRefreshInterval) {
      clearInterval(this.bookRefreshInterval);
      this.bookRefreshInterval = null;
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
        opportunities.push(opportunity);
      }
    }

    if (opportunities.length === 0) return;

    const ordered = await this.scanner.prioritizeOpportunities(opportunities, now);
    if (this.config.tradingMode !== 'shadow') {
      for (const opportunity of ordered) {
        messageBus.emit('opportunity:detected', { opportunity });
      }
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

    const maxConcurrentMarkets = this.config.maxConcurrentMarkets ?? 0;
    if (maxConcurrentMarkets > 0 && this.inFlightMarkets.size >= maxConcurrentMarkets) {
      this.deps.metrics.record({
        type: 'gate_rejection',
        timestamp: now,
        data: {
          opportunityId: payload.opportunity.id,
          marketId,
          reasons: ['max_concurrent_markets'],
          gateDecision: { passed: false, reasons: ['max_concurrent_markets'] }
        }
      });
      return;
    }

    const requiredCapital = Math.max(0, payload.size * payload.opportunity.costPerSet);
    const maxCapitalInFlight = this.config.maxCapitalInFlight ?? 0;
    if (maxCapitalInFlight > 0 && requiredCapital > 0 && this.capitalInFlight + requiredCapital > maxCapitalInFlight) {
      this.deps.metrics.record({
        type: 'gate_rejection',
        timestamp: now,
        data: {
          opportunityId: payload.opportunity.id,
          marketId,
          reasons: ['capital_in_flight'],
          gateDecision: { passed: false, reasons: ['capital_in_flight'] }
        }
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
    this.capitalInFlight += requiredCapital;
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

      const gateMs = Date.now();
      this.deps.metrics.recordLatency({
        stage: 'gated',
        opportunityId: payload.opportunity.id,
        marketId,
        timestampMs: gateMs,
        latencyMs: Math.max(0, gateMs - payload.opportunity.detectedAt),
        cumulativeMs: Math.max(0, gateMs - payload.opportunity.detectedAt)
      });

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
      this.capitalInFlight = Math.max(0, this.capitalInFlight - requiredCapital);
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
    this.risk.updateConfig(risk, {
      maxOpenInventorySeconds: policy.maxOpenInventorySeconds,
      fallbackTickSize: policy.fallbackTickSize,
      depthBufferMultiplier: policy.depthBufferMultiplier
    });
    this.execution.updatePolicy(policy);
    this.execution.updateRiskConfig(risk);
    this.marketCircuitBreakers.updateConfig({
      failureThreshold: risk.marketCircuitFailureThreshold,
      cooldownMs: risk.marketCooldownSeconds * 1000,
      halfOpenSuccesses: risk.marketCircuitHalfOpenSuccesses
    });
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
