import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { createUniformTakerFeeModel } from '../../src/domain/feeModel.js';

describe('portfolio anomaly detector and scanner pair evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('../../src/services/llm/AgentLlm.js');
  });

  it('emits ops alerts for validated portfolio anomalies and logs invalid fallbacks', async () => {
    const callAgentJson = vi
      .fn()
      .mockResolvedValueOnce({
        call: { status: 'success' },
        parsed: { anomaly: true },
        validated: {
          success: true,
          data: {
            anomaly: true,
            severity: 'high',
            reason: 'venue mismatch',
            confidence: 0.91
          }
        },
        missingOutput: false,
        violations: []
      })
      .mockResolvedValueOnce({
        call: { status: 'error' },
        parsed: null,
        validated: { success: false },
        missingOutput: true,
        violations: ['missing_output_text']
      })
      .mockResolvedValueOnce({
        call: { status: 'success' },
        parsed: { anomaly: false },
        validated: {
          success: true,
          data: {
            anomaly: false,
            severity: 'low',
            reason: null,
            confidence: 0.2
          }
        },
        missingOutput: false,
        violations: []
      });
    const logAgentDecision = vi.fn();
    const withAgent = vi.fn(() => ({ agent: 'PortfolioAgent' }));
    vi.doMock('../../src/services/llm/AgentLlm.js', () => ({
      callAgentJson,
      logAgentDecision,
      withAgent
    }));

    const { analyzePortfolioAnomaly } = await import(
      '../../src/agents/portfolio/PortfolioAnomalyDetector.js'
    );

    const messageBus = { emit: vi.fn() };
    const onIncident = vi.fn();
    const llm = {
      config: { agents: { PortfolioAgent: { model: 'portfolio-model', mode: 'advisory' } } }
    };
    const snapshot = {
      totalCapital: 1_000,
      availableCapital: 900,
      dailyPnL: -10,
      marketExposure: { 'market-1': 100 },
      openInventoryAgeMs: 500
    };

    await analyzePortfolioAnomaly({
      snapshot,
      positionsCount: 2,
      pendingExpectedFills: 1,
      venueIssues: [{ type: 'missing_position' }],
      nowMs: 1_000,
      llm: llm as never,
      messageBus: messageBus as never,
      onIncident
    });

    expect(messageBus.emit).toHaveBeenCalledWith(
      'ops:alert',
      expect.objectContaining({
        type: 'llm_portfolio_anomaly',
        severity: 'high',
        reason: 'venue mismatch',
        confidence: 0.91,
        timestamp: 1_000
      })
    );
    expect(onIncident).toHaveBeenCalledOnce();
    expect(logAgentDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        applied: true,
        output: expect.objectContaining({ anomaly: true, reason: 'venue mismatch' })
      })
    );

    await analyzePortfolioAnomaly({
      snapshot,
      positionsCount: 0,
      pendingExpectedFills: 0,
      nowMs: 2_000,
      llm: llm as never,
      messageBus: messageBus as never
    });

    expect(logAgentDecision).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        applied: false,
        output: expect.objectContaining({
          anomaly: false,
          reason: 'missing_output_text',
          confidence: 0
        }),
        clamp: expect.objectContaining({ violations: ['missing_output_text'] })
      })
    );

    await analyzePortfolioAnomaly({
      snapshot,
      positionsCount: 1,
      pendingExpectedFills: 0,
      nowMs: 3_000,
      llm: llm as never,
      messageBus: messageBus as never,
      onIncident
    });

    expect(onIncident).toHaveBeenCalledOnce();
    expect(logAgentDecision).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        applied: false,
        output: expect.objectContaining({
          anomaly: false,
          reason: null,
          confidence: 0.2
        })
      })
    );
  });

  it('returns near-zero rejections once and prefers stronger ev opportunities when signaled', async () => {
    const { evaluateScannerPair, REJECTION_EMISSION_COOLDOWN_MS } = await import(
      '../../src/agents/scanner/ScannerPairEvaluator.js'
    );

    const pair = {
      marketId: 'market-1',
      yesTokenId: 'yes-1',
      noTokenId: 'no-1'
    };
    const baseBook = {
      bids: [{ price: 0.4, size: 200 }],
      asks: [{ price: 0.45, size: 200 }],
      tickSize: 0.01,
      minOrderSize: 1,
      lastUpdateMs: 1_000,
      stableSinceMs: 500
    };
    const yesBook = {
      ...baseBook,
      tokenId: 'yes-1',
      bestBid: { price: 0.4, size: 200 },
      bestAsk: { price: 0.45, size: 200 }
    };
    const noBook = {
      ...baseBook,
      tokenId: 'no-1',
      bestBid: { price: 0.4, size: 200 },
      bestAsk: { price: 0.45, size: 200 }
    };
    const metrics = { record: vi.fn() };
    const gateRejectionEmissionState = new Map();
    const evSignalEmissionState = new Map();
    const lastEvOpportunityAt = new Map<string, number>();

    const rejection = evaluateScannerPair({
      pair,
      yesBook: { ...yesBook, lastUpdateMs: 0, stableSinceMs: 0 },
      noBook: { ...noBook, lastUpdateMs: 0, stableSinceMs: 0 },
      policy: { ...DEFAULT_TRADE_POLICY, signalMode: 'near_zero' },
      nowMs: 20_000,
      nearZeroFeeModel: createUniformTakerFeeModel(0),
      metrics: metrics as never,
      gateRejectionEmissionState,
      evSignalEmissionState,
      lastEvOpportunityAt,
      getInsight: () => null
    });

    expect(rejection).toBeNull();
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gate_rejection',
        data: expect.objectContaining({ marketId: 'market-1' })
      })
    );

    evaluateScannerPair({
      pair,
      yesBook: { ...yesBook, lastUpdateMs: 0, stableSinceMs: 0 },
      noBook: { ...noBook, lastUpdateMs: 0, stableSinceMs: 0 },
      policy: { ...DEFAULT_TRADE_POLICY, signalMode: 'near_zero' },
      nowMs: 20_000 + REJECTION_EMISSION_COOLDOWN_MS - 1,
      nearZeroFeeModel: createUniformTakerFeeModel(0),
      metrics: metrics as never,
      gateRejectionEmissionState,
      evSignalEmissionState,
      lastEvOpportunityAt,
      getInsight: () => null
    });
    expect(metrics.record).toHaveBeenCalledTimes(1);

    const evOpportunity = evaluateScannerPair({
      pair,
      yesBook,
      noBook,
      policy: {
        ...DEFAULT_TRADE_POLICY,
        signalMode: 'both',
        minDepthLevels: 1,
        requireFreshBook: false,
        evMaxEdge: 1,
        evModelMode: 'llm_only',
        evCooldownSeconds: 0,
        evConfidenceMin: 0.1,
        evModelConfidenceFloor: 0.1
      },
      nowMs: 30_000,
      nearZeroFeeModel: createUniformTakerFeeModel(0),
      metrics: metrics as never,
      gateRejectionEmissionState: new Map(),
      evSignalEmissionState: new Map(),
      lastEvOpportunityAt,
      getInsight: () => ({
        market_id: 'market-1',
        signal: 'high_confidence',
        value: 0.9,
        ttl_ms: 60_000,
        confidence: 0.9
      })
    });

    expect(evOpportunity).toMatchObject({
      type: 'ev',
      side: 'yes',
      marketId: 'market-1'
    });
    expect(lastEvOpportunityAt.get('market-1')).toBe(30_000);
    expect(metrics.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ev_signal',
        data: expect.objectContaining({ marketId: 'market-1', reason: 'ev_selected' })
      })
    );
  });
});
