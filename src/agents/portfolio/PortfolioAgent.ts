import type {
  ExpectedFill,
  FillReconciliationOptions,
  FillUpdate,
  ObservedFill,
  PortfolioSnapshot,
  Position,
  ReconciliationIssue,
  ReconciliationResult,
  VenueReconciliationIssue,
  VenueReconciliationResult
} from '../../domain/portfolio.js';
import type { IncidentTracker } from '../../services/IncidentTracker.js';
import type { VenueOpenOrder, VenuePosition } from '../../domain/venue.js';
import { messageBus } from '../../core/MessageBus.js';
import type { EventStore } from '../../core/EventStore.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { LLMConfig as AppLLMConfig } from '../../config/llm.js';
import { PortfolioAnomalySchema } from '../../domain/llm.js';
import { logLLMDecision } from '../../services/llm/LLMDecisionLogger.js';
import type { LLMCallResult, LLMRequest } from '../../services/llm/types.js';
import { safeParseJSON } from '../../utils/serialization.js';

export interface PortfolioAgentOptions {
  tokenToMarketId?: Record<string, string>;
  metrics?: MetricsStore;
  eventStore?: EventStore;
  llm?: {
    config: AppLLMConfig;
    client: { call: (agent: 'PortfolioAgent', request: LLMRequest) => Promise<LLMCallResult> };
    promptVersion: string;
    policyHashes: { tradePolicyHash: string; riskConfigHash: string };
  };
}

export class PortfolioAgent {
  private positions = new Map<string, Position>();
  private dailyPnL = 0;
  private positionUpdatedAt = new Map<string, number>();
  private expectedFills = new Map<string, ExpectedFill>();
  private tokenToMarketId: Map<string, string>;
  private metrics?: MetricsStore;
  private store?: EventStore;
  private llm?: NonNullable<PortfolioAgentOptions['llm']>;

  constructor(
    private totalCapital: number,
    private incidentTracker?: IncidentTracker,
    options?: PortfolioAgentOptions
  ) {
    this.tokenToMarketId = new Map(Object.entries(options?.tokenToMarketId ?? {}));
    this.metrics = options?.metrics;
    this.store = options?.eventStore;
    this.llm = options?.llm;
  }

  expectFill(fill: ExpectedFill): void {
    this.expectedFills.set(expectedFillKey(fill.opportunityId, fill.tokenId), fill);
  }

  private resolveExpectedFill(actual: ObservedFill): ExpectedFillResolution {
    const directKey =
      actual.opportunityId ? expectedFillKey(actual.opportunityId, actual.tokenId) : null;
    if (directKey) {
      const direct = this.expectedFills.get(directKey);
      if (direct) return { expected: direct, key: directKey };
    }

    const candidates = resolveExpectedFillCandidates(this.expectedFills.entries(), actual);
    if (candidates.length === 1) {
      return { expected: candidates[0].expected, key: candidates[0].key };
    }
    if (candidates.length > 1) {
      candidates.sort((a, b) => b.expected.timestamp - a.expected.timestamp);
      return {
        expected: candidates[0].expected,
        key: candidates[0].key,
        ambiguous: candidates.length
      };
    }
    return null;
  }

  private recordFillMismatchIncident(
    actual: ObservedFill,
    expected: ExpectedFill | undefined,
    issues: ReconciliationIssue[]
  ): void {
    const marketId = actual.marketId;
    if (!this.incidentTracker || !marketId) return;

    this.incidentTracker.record({
      marketId,
      reason: 'fill_mismatch',
      timestamp: Date.now(),
      opportunityId: expected?.opportunityId ?? actual.opportunityId,
      detail: {
        issues,
        expected: expected ? expectedToDetail(expected) : undefined,
        actual: actualToDetail(actual)
      }
    });
  }

  applyFillWithReconciliation(
    actual: ObservedFill,
    options?: Partial<FillReconciliationOptions>
  ): ReconciliationResult {
    const resolved = this.resolveExpectedFill(actual);
    const issues: ReconciliationIssue[] = [];

    if (!resolved) {
      issues.push({
        type: 'unexpected_fill',
        tokenId: actual.tokenId,
        opportunityId: actual.opportunityId,
        actual: actualToDetail(actual)
      });
      this.applyFill(actual);
      this.recordFillMismatchIncident(actual, undefined, issues);
      return { ok: false, issues };
    }

    const { expected, key, ambiguous } = resolved;
    if (ambiguous) {
      issues.push({
        type: 'ambiguous_expected_fill',
        tokenId: actual.tokenId,
        opportunityId: actual.opportunityId,
        expected: { candidateCount: ambiguous }
      });
    }

    const sizeTolerance = Math.max(options?.sizeTolerance ?? 0, 0);
    const priceTolerance = Math.max(options?.priceTolerance ?? 0, 0);

    if (Math.abs(actual.size - expected.expectedSize) > sizeTolerance) {
      issues.push({
        type: 'size_mismatch',
        tokenId: actual.tokenId,
        opportunityId: expected.opportunityId,
        expected: expectedToDetail(expected),
        actual: actualToDetail(actual)
      });
    }

    if (!isPriceWithinTolerance(expected, actual, priceTolerance)) {
      issues.push({
        type: 'price_mismatch',
        tokenId: actual.tokenId,
        opportunityId: expected.opportunityId,
        expected: expectedToDetail(expected),
        actual: actualToDetail(actual)
      });
    }

    this.expectedFills.delete(key);
    this.applyFill(actual);

    if (issues.length > 0) {
      this.recordFillMismatchIncident(actual, expected, issues);
      return { ok: false, expected, issues };
    }

    return { ok: true, expected, issues };
  }

  checkStalePending(maxAgeMs: number): ExpectedFill[] {
    const bounded = Math.max(maxAgeMs, 0);
    const nowMs = Date.now();
    const stale: ExpectedFill[] = [];

    for (const fill of this.expectedFills.values()) {
      if (nowMs - fill.timestamp > bounded) {
        stale.push(fill);
      }
    }

    return stale;
  }

  applyFill(fill: FillUpdate): void {
    const nowMs = Date.now();
    const position = this.positions.get(fill.tokenId);
    const marketId = fill.marketId ?? this.tokenToMarketId.get(fill.tokenId);
    const signedSize = fill.side === 'BUY' ? fill.size : -fill.size;
    const existingSize = position?.size ?? 0;
    const newSize = existingSize + signedSize;

    if (!position) {
      const created: Position = {
        tokenId: fill.tokenId,
        marketId,
        size: signedSize,
        averagePrice: fill.price,
        side: fill.side
      };

      if (created.size !== 0) {
        this.positions.set(fill.tokenId, created);
        this.positionUpdatedAt.set(fill.tokenId, nowMs);
      }
    } else {
      if (marketId && !position.marketId) {
        position.marketId = marketId;
      }
      const totalNotional = position.averagePrice * existingSize + fill.price * signedSize;
      position.size = newSize;
      position.averagePrice = newSize === 0 ? 0 : totalNotional / newSize;
      position.side = newSize >= 0 ? 'BUY' : 'SELL';

      if (position.size === 0) {
        this.positions.delete(fill.tokenId);
        this.positionUpdatedAt.delete(fill.tokenId);
        return;
      }

      this.positionUpdatedAt.set(fill.tokenId, nowMs);
    }
  }

  applyPnL(delta: number): void {
    this.dailyPnL += delta;
  }

  clearMarketExposure(marketId: string): void {
    for (const [tokenId, position] of this.positions.entries()) {
      if (position.marketId === marketId) {
        this.positions.delete(tokenId);
        this.positionUpdatedAt.delete(tokenId);
      }
    }
  }

  reduceMarketExposure(marketId: string, amount: number): void {
    const delta = Math.max(amount, 0);
    if (delta <= 0) return;

    const positions = Array.from(this.positions.values()).filter(
      (position) => position.marketId === marketId && position.size !== 0
    );

    const total = positions.reduce(
      (sum, position) => sum + Math.abs(position.size) * position.averagePrice,
      0
    );

    if (total <= 0) return;

    const target = Math.max(total - delta, 0);
    const scale = target / total;
    const nowMs = Date.now();

    for (const position of positions) {
      const scaledSize = position.size * scale;
      position.size = Math.abs(scaledSize) < 1e-12 ? 0 : scaledSize;
      if (position.size === 0) position.averagePrice = 0;
      this.positionUpdatedAt.set(position.tokenId, nowMs);
    }
  }

  applyUnwind(params: {
    marketId: string;
    tokenId: string;
    entryPrice: number;
    unwindPrice: number;
    size: number;
  }): void {
    const buyFill: FillUpdate = {
      tokenId: params.tokenId,
      marketId: params.marketId,
      side: 'BUY',
      size: params.size,
      price: params.entryPrice
    };
    const sellFill: FillUpdate = {
      tokenId: params.tokenId,
      marketId: params.marketId,
      side: 'SELL',
      size: params.size,
      price: params.unwindPrice
    };

    this.applyFill(buyFill);
    this.applyFill(sellFill);
    this.applyPnL((params.unwindPrice - params.entryPrice) * params.size);
  }

  snapshot(): PortfolioSnapshot {
    const nowMs = Date.now();
    const deployed = Array.from(this.positions.values()).reduce(
      (sum, position) => sum + Math.abs(position.size) * position.averagePrice,
      0
    );

    const marketExposure: Record<string, number> = {};
    for (const position of this.positions.values()) {
      if (!position.marketId || position.size === 0) continue;
      marketExposure[position.marketId] =
        (marketExposure[position.marketId] ?? 0) +
        Math.abs(position.size) * position.averagePrice;
    }

    const positionsByMarket = new Map<string, Position[]>();
    for (const position of this.positions.values()) {
      if (position.size === 0) continue;
      const marketKey = position.marketId?.trim() ? position.marketId : 'unknown';
      const bucket = positionsByMarket.get(marketKey) ?? [];
      bucket.push(position);
      positionsByMarket.set(marketKey, bucket);
    }

    const openTokenIds = new Set<string>();
    for (const [marketId, positions] of positionsByMarket.entries()) {
      if (marketId === 'unknown') {
        for (const position of positions) openTokenIds.add(position.tokenId);
        continue;
      }

      if (positions.length < 2) {
        for (const position of positions) openTokenIds.add(position.tokenId);
        continue;
      }

      const reference = positions[0].size;
      const referenceSign = Math.sign(reference);
      const completeSet = positions.every((position) => {
        if (Math.sign(position.size) !== referenceSign) return false;
        return Math.abs(position.size - reference) <= 1e-12;
      });

      if (!completeSet) {
        for (const position of positions) openTokenIds.add(position.tokenId);
      }
    }

    let oldestOpenPositionMs: number | null = null;
    for (const tokenId of openTokenIds) {
      const updatedAt = this.positionUpdatedAt.get(tokenId) ?? nowMs;
      if (oldestOpenPositionMs === null || updatedAt < oldestOpenPositionMs) {
        oldestOpenPositionMs = updatedAt;
      }
    }
    const openInventoryAgeMs =
      oldestOpenPositionMs === null ? 0 : Math.max(0, nowMs - oldestOpenPositionMs);

    return {
      totalCapital: this.totalCapital,
      availableCapital: Math.max(this.totalCapital - deployed, 0),
      dailyPnL: this.dailyPnL,
      marketExposure,
      openInventoryAgeMs
    };
  }

  reconcileWithVenue(input: {
    openOrders?: VenueOpenOrder[];
    internalOpenOrders?: Array<{ orderId: string; marketId?: string; tokenId?: string }>;
    positions?: VenuePosition[];
    positionSizeTolerance?: number;
    nowMs?: number;
  }): VenueReconciliationResult {
    const nowMs = input.nowMs ?? Date.now();
    const tolerance = Math.max(input.positionSizeTolerance ?? 0, 0);
    const issues: VenueReconciliationIssue[] = [];

    const venueOrders = new Map<string, VenueOpenOrder>();
    for (const order of input.openOrders ?? []) {
      if (!order.orderId) continue;
      venueOrders.set(order.orderId, order);
    }

    const internalOrders = new Map<string, { marketId?: string; tokenId?: string }>();
    for (const order of input.internalOpenOrders ?? []) {
      if (!order.orderId) continue;
      internalOrders.set(order.orderId, { marketId: order.marketId, tokenId: order.tokenId });
    }

    for (const [orderId, meta] of internalOrders.entries()) {
      if (!venueOrders.has(orderId)) {
        issues.push({
          type: 'missing_open_order',
          orderId,
          marketId: meta.marketId,
          tokenId: meta.tokenId,
          expected: { orderId }
        });
      }
    }

    for (const [orderId, order] of venueOrders.entries()) {
      if (!internalOrders.has(orderId)) {
        issues.push({
          type: 'extra_open_order',
          orderId,
          marketId: order.marketId,
          tokenId: order.tokenId,
          actual: { orderId, marketId: order.marketId, tokenId: order.tokenId, status: order.status }
        });
      }
    }

    const venuePositions = new Map<string, VenuePosition>();
    for (const position of input.positions ?? []) {
      if (!position.tokenId) continue;
      venuePositions.set(position.tokenId, position);
    }

    for (const position of this.positions.values()) {
      if (!position.tokenId || Math.abs(position.size) <= tolerance) continue;
      const venue = venuePositions.get(position.tokenId);
      if (!venue) {
        issues.push({
          type: 'missing_position',
          marketId: position.marketId,
          tokenId: position.tokenId,
          expected: {
            tokenId: position.tokenId,
            marketId: position.marketId,
            size: position.size,
            averagePrice: position.averagePrice
          }
        });
        continue;
      }

      if (Math.abs(position.size - venue.size) > tolerance) {
        issues.push({
          type: 'position_size_mismatch',
          marketId: position.marketId ?? venue.marketId,
          tokenId: position.tokenId,
          expected: {
            tokenId: position.tokenId,
            marketId: position.marketId,
            size: position.size,
            averagePrice: position.averagePrice
          },
          actual: {
            tokenId: venue.tokenId,
            marketId: venue.marketId,
            size: venue.size,
            avgPrice: venue.avgPrice
          }
        });
      }
    }

    for (const position of venuePositions.values()) {
      if (!position.tokenId || Math.abs(position.size) <= tolerance) continue;
      if (this.positions.has(position.tokenId)) continue;

      issues.push({
        type: 'extra_position',
        marketId: position.marketId,
        tokenId: position.tokenId,
        actual: {
          tokenId: position.tokenId,
          marketId: position.marketId,
          size: position.size,
          avgPrice: position.avgPrice
        }
      });
    }

    if (issues.length > 0 && this.incidentTracker) {
      const grouped = new Map<string, VenueReconciliationIssue[]>();
      for (const issue of issues) {
        const key = issue.marketId?.trim() ? issue.marketId : 'unknown';
        const bucket = grouped.get(key) ?? [];
        bucket.push(issue);
        grouped.set(key, bucket);
      }

      for (const [marketId, marketIssues] of grouped.entries()) {
        this.incidentTracker.record({
          marketId,
          reason: 'recon_drift',
          timestamp: nowMs,
          recoveryAction: marketId === 'unknown' ? 'alert_only' : undefined,
          detail: { issues: marketIssues }
        });
      }
    }

    return { ok: issues.length === 0, checkedAtMs: nowMs, issues };
  }

  async analyzeAnomalies(input: { venueIssues?: VenueReconciliationIssue[]; nowMs?: number } = {}): Promise<void> {
    const llm = this.llm;
    if (!llm || !llm.config.enabled) return;
    if (llm.config.agents.PortfolioAgent.mode === 'disabled') return;

    const nowMs = input.nowMs ?? Date.now();
    const snapshot = this.snapshot();
    const venueIssuesCount = Array.isArray(input.venueIssues) ? input.venueIssues.length : 0;

    const promptEnvelope = {
      task: 'detect_anomaly',
      inputs: {
        snapshot: {
          total_capital: snapshot.totalCapital,
          available_capital: snapshot.availableCapital,
          daily_pnl: snapshot.dailyPnL,
          open_inventory_age_ms: snapshot.openInventoryAgeMs ?? 0,
          market_exposure: snapshot.marketExposure,
          positions_count: this.positions.size,
          pending_expected_fills: this.expectedFills.size,
          venue_issues_count: venueIssuesCount
        }
      },
      output: { anomaly: false, severity: 'low|medium|high', reason: null, confidence: 0.0 }
    };

    const request: LLMRequest = {
      endpoint: 'chat.completions',
      model: llm.config.agents.PortfolioAgent.model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'developer',
          content:
            'Return JSON only, with shape: {"anomaly":boolean,"severity":"low"|"medium"|"high","reason":string|null,"confidence":number}. Use only the inputs. Only flag anomaly=true when evidence is strong; otherwise set anomaly=false and reason=null. Confidence must be between 0 and 1. No prose.'
        },
        { role: 'user', content: JSON.stringify(promptEnvelope) }
      ]
    };

    const call = await llm.client.call('PortfolioAgent', request);
    const hasOutputText = Boolean(call.outputText);
    const parsed = hasOutputText ? safeParseJSON(call.outputText) : null;
    const validated = hasOutputText
      ? PortfolioAnomalySchema.safeParse(parsed)
      : ({ success: false } as const);
    const missingOutput = !hasOutputText;
    const finalDecision = validated.success
      ? validated.data
      : {
          anomaly: false,
          severity: 'low',
          reason: missingOutput ? 'missing_output_text' : 'invalid_output',
          confidence: 0
        };
    const violations = missingOutput ? ['missing_output_text'] : validated.success ? [] : ['invalid_output'];

    if (validated.success && validated.data.anomaly) {
      const alert = {
        type: 'llm_portfolio_anomaly',
        severity: validated.data.severity ?? 'low',
        reason: validated.data.reason,
        confidence: validated.data.confidence,
        timestamp: nowMs
      };
      messageBus.emit('ops:alert', alert);
      this.metrics?.record({ type: 'incident', timestamp: nowMs, data: alert });
    }

    logLLMDecision({
      agent: 'PortfolioAgent',
      mode: llm.config.agents.PortfolioAgent.mode,
      task: 'detect_anomaly',
      subject: 'system:portfolio',
      baseline: promptEnvelope.inputs,
      output: finalDecision,
      confidence: finalDecision.confidence,
      applied: validated.success ? validated.data.anomaly : false,
      clamp: { raw: parsed, final: finalDecision, violations },
      nowMs,
      call,
      request,
      promptEnvelopeForHash: promptEnvelope,
      contextForHash: promptEnvelope.inputs,
      promptVersion: llm.promptVersion,
      policyHashes: llm.policyHashes,
      providerFallback: {
        providerId: llm.config.agents.PortfolioAgent.provider,
        baseUrl: llm.config.providers[llm.config.agents.PortfolioAgent.provider].baseUrl,
        endpoint: request.endpoint,
        model: request.model
      },
      store: this.store
    });
  }
}

function expectedFillKey(opportunityId: string, tokenId: string): string {
  return `${opportunityId}:${tokenId}`;
}

function actualToDetail(actual: ObservedFill): Record<string, unknown> {
  return {
    tokenId: actual.tokenId,
    marketId: actual.marketId,
    opportunityId: actual.opportunityId,
    side: actual.side,
    size: actual.size,
    price: actual.price,
    timestamp: actual.timestamp
  };
}

function expectedToDetail(expected: ExpectedFill): Record<string, unknown> {
  return {
    opportunityId: expected.opportunityId,
    tokenId: expected.tokenId,
    expectedSize: expected.expectedSize,
    expectedPrice: expected.expectedPrice,
    timestamp: expected.timestamp
  };
}

function isPriceWithinTolerance(
  expected: ExpectedFill,
  actual: ObservedFill,
  tolerance: number
): boolean {
  const expectedPrice = expected.expectedPrice;
  if (!Number.isFinite(expectedPrice) || !Number.isFinite(actual.price)) return false;

  if (actual.side === 'BUY') {
    return actual.price <= expectedPrice + tolerance;
  }

  return actual.price >= expectedPrice - tolerance;
}

function isSameExpectedFillCandidate(expected: ExpectedFill, actual: ObservedFill): boolean {
  if (expected.tokenId !== actual.tokenId) return false;
  if (actual.opportunityId && expected.opportunityId !== actual.opportunityId) return false;
  return true;
}

function resolveExpectedFillCandidates(
  expectedFills: Iterable<[string, ExpectedFill]>,
  actual: ObservedFill
): Array<{ key: string; expected: ExpectedFill }> {
  const candidates: Array<{ key: string; expected: ExpectedFill }> = [];
  for (const [key, expected] of expectedFills) {
    if (isSameExpectedFillCandidate(expected, actual)) {
      candidates.push({ key, expected });
    }
  }
  return candidates;
}

type ExpectedFillResolution =
  | { expected: ExpectedFill; key: string; ambiguous?: undefined }
  | { expected: ExpectedFill; key: string; ambiguous: number }
  | null;
