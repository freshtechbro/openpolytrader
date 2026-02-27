import { z } from 'zod';

export type ConfigSectionKey = 'policy' | 'risk';

export interface ConfigFieldBase {
  key: string;
  label: string;
  description?: string;
}

export interface NumberField extends ConfigFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
}

export interface BooleanField extends ConfigFieldBase {
  type: 'boolean';
}

export interface EnumField extends ConfigFieldBase {
  type: 'enum';
  options: string[];
}

export type ConfigField = NumberField | BooleanField | EnumField;

export interface ConfigSection {
  key: ConfigSectionKey;
  label: string;
  description?: string;
  fields: ConfigField[];
}

export interface ConfigSchema {
  version: string;
  sections: ConfigSection[];
}

const POLICY_FIELDS: ConfigField[] = [
  { key: 'edgeRequired', label: 'Edge Required', type: 'number', min: 0.0001, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'maxEdge', label: 'Max Edge', type: 'number', min: 0.0001, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'evMaxEdge', label: 'EV Max Edge', type: 'number', min: 0.0001, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'depthHeadroomFraction', label: 'Depth Headroom', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'maxSpread', label: 'Max Spread', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  {
    key: 'orderbookFreshnessMs',
    label: 'Orderbook Freshness',
    description: 'Alias of Max Book Staleness (must match).',
    type: 'number',
    min: 10,
    max: 15000,
    step: 10,
    unit: 'ms',
    integer: true
  },
  { key: 'topOfBookStabilityMs', label: 'Top Of Book Stability', type: 'number', min: 10, max: 10000, step: 10, unit: 'ms', integer: true },
  { key: 'maxOpenInventorySeconds', label: 'Max Open Inventory', type: 'number', min: 0, max: 600, step: 1, unit: 's', integer: true },
  { key: 'rejectDelayed', label: 'Reject Delayed', type: 'boolean' },
  { key: 'strategyMode', label: 'Strategy Mode', type: 'enum', options: ['near_zero_risk', 'standard'] },
  { key: 'signalMode', label: 'Signal Mode', type: 'enum', options: ['near_zero', 'ev', 'both'] },
  { key: 'requireFreshBook', label: 'Require Fresh Book', type: 'boolean' },
  { key: 'maxBookStalenessMs', label: 'Max Book Staleness', type: 'number', min: 100, max: 15000, step: 10, unit: 'ms', integer: true },
  { key: 'maxDecisionLatencyMs', label: 'Max Decision Latency', type: 'number', min: 50, max: 1000, step: 10, unit: 'ms', integer: true },
  { key: 'maxDelayedAckRate', label: 'Max Delayed Ack Rate', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'minPairedFillRate', label: 'Min Paired Fill Rate', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  {
    key: 'minEdgeTicks',
    label: 'Min Edge Ticks',
    description: '0 disables the min-tick edge requirement.',
    type: 'number',
    min: 0,
    max: 20,
    step: 1,
    unit: 'ticks',
    integer: true
  },
  {
    key: 'depthBufferMultiplier',
    label: 'Depth Buffer Multiplier',
    description: '0 disables the extra depth buffer requirement.',
    type: 'number',
    min: 0,
    max: 10,
    step: 0.1
  },
  { key: 'entrySlippageToleranceBps', label: 'Entry Slippage', type: 'number', min: 1, max: 200, step: 1, unit: 'bps', integer: true },
  { key: 'minDepthLevels', label: 'Min Depth Levels', type: 'number', min: 1, max: 10, step: 1, unit: 'levels', integer: true },
  { key: 'maxOrdersPerMinute', label: 'Max Orders Per Minute', type: 'number', min: 1, max: 10000, step: 1, unit: 'count', integer: true },
  { key: 'maxOrderToTradeRatio', label: 'Max Order To Trade Ratio', type: 'number', min: 1, max: 1000, step: 1, unit: 'ratio', integer: true },
  { key: 'orderVelocityWindowMs', label: 'Order Velocity Window', type: 'number', min: 1000, max: 3600000, step: 1000, unit: 'ms', integer: true },
  { key: 'orderToTradeWindowMs', label: 'Order To Trade Window', type: 'number', min: 1000, max: 86400000, step: 1000, unit: 'ms', integer: true },
  { key: 'priceBandBps', label: 'Price Band', type: 'number', min: 1, max: 10000, step: 1, unit: 'bps', integer: true },
  { key: 'maxLegSkewMs', label: 'Max Leg Skew', type: 'number', min: 1, max: 1000, step: 1, unit: 'ms', integer: true },
  { key: 'submitTimeoutMs', label: 'Submit Timeout', type: 'number', min: 0, max: 60000, step: 10, unit: 'ms', integer: true },
  { key: 'ackTimeoutMs', label: 'Ack Timeout', type: 'number', min: 0, max: 60000, step: 10, unit: 'ms', integer: true },
  {
    key: 'fillTimeoutMs',
    label: 'Fill Timeout',
    description: 'Near-zero risk requires > 0 to wait for user fills; 0 skips fill waiting.',
    type: 'number',
    min: 0,
    max: 120000,
    step: 10,
    unit: 'ms',
    integer: true
  },
  { key: 'cancelTimeoutMs', label: 'Cancel Timeout', type: 'number', min: 0, max: 60000, step: 10, unit: 'ms', integer: true },
  { key: 'fallbackTickSize', label: 'Fallback Tick Size', type: 'number', min: 0.0001, max: 1, step: 0.0001, unit: 'price' },
  { key: 'fallbackMinOrderSize', label: 'Fallback Min Order Size', type: 'number', min: 0.0001, max: 1000, step: 0.0001, unit: 'shares' },
  { key: 'nearZeroFeeBps', label: 'Near-Zero Fee', type: 'number', min: 0, max: 10000, step: 1, unit: 'bps', integer: true },
  { key: 'evEdgeRequired', label: 'EV Edge Required', type: 'number', min: 0, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'evFeeBps', label: 'EV Fee', type: 'number', min: 0, max: 10000, step: 1, unit: 'bps', integer: true },
  { key: 'evConfidenceMin', label: 'EV Confidence Min', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'evConfidenceMinFloor', label: 'EV Confidence Min Floor', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'evMaxPerMarketNotional', label: 'EV Max Per Market', type: 'number', min: 0, max: 100000, step: 1, unit: 'usd' },
  { key: 'evMaxPortfolioNotional', label: 'EV Max Portfolio', type: 'number', min: 0, max: 100000, step: 1, unit: 'usd' },
  { key: 'evCooldownSeconds', label: 'EV Cooldown', type: 'number', min: 0, max: 86400, step: 1, unit: 's', integer: true },
  { key: 'evModelMode', label: 'EV Model Mode', type: 'enum', options: ['baseline', 'hybrid', 'llm_only'] },
  { key: 'evModelRefreshMinutes', label: 'EV Model Refresh', type: 'number', min: 1, max: 1440, step: 1, unit: 'min', integer: true },
  { key: 'evCalibrationMethod', label: 'EV Calibration', type: 'enum', options: ['sigmoid', 'isotonic', 'temperature'] },
  { key: 'evModelConfidenceFloor', label: 'EV Model Confidence Floor', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'evWebSearchExaEnabled', label: 'EV Web Search Exa Enabled', type: 'boolean' },
  { key: 'evWebSearchFirecrawlEnabled', label: 'EV Web Search Firecrawl Enabled', type: 'boolean' },
  { key: 'evWebSearchPrimary', label: 'EV Web Search Primary', type: 'enum', options: ['exa', 'firecrawl'] },
  { key: 'evWebSearchLookbackDays', label: 'EV Web Search Lookback', type: 'number', min: 1, max: 365, step: 1, unit: 'days', integer: true },
  { key: 'evWebSearchMaxResults', label: 'EV Web Search Max Results', type: 'number', min: 1, max: 50, step: 1, unit: 'count', integer: true },
  { key: 'evWebSearchCacheTtlSeconds', label: 'EV Web Search Cache TTL', type: 'number', min: 60, max: 86400, step: 60, unit: 's', integer: true },
  { key: 'evWebSearchMaxConcurrency', label: 'EV Web Search Max Concurrency', type: 'number', min: 1, max: 20, step: 1, unit: 'count', integer: true },
  { key: 'evWebSearchFirecrawlMaxDepth', label: 'EV Firecrawl Max Depth', type: 'number', min: 1, max: 10, step: 1, unit: 'depth', integer: true },
  { key: 'evWebSearchFirecrawlMaxPages', label: 'EV Firecrawl Max Pages', type: 'number', min: 1, max: 100, step: 1, unit: 'pages', integer: true },
  { key: 'fwDependencyMode', label: 'FW Dependency Mode', type: 'enum', options: ['deterministic', 'llm', 'hybrid'] },
  { key: 'fwDependencyHybridMerge', label: 'FW Hybrid Merge', type: 'enum', options: ['consensus', 'union'] },
  { key: 'fwDependencyMinConfidence', label: 'FW Min Dependency Confidence', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'fwDependencyMaxEdgesPerMarket', label: 'FW Max Edges Per Market', type: 'number', min: 1, max: 100, step: 1, unit: 'count', integer: true },
  { key: 'fwOracleTimeLimitMs', label: 'FW Oracle Time Limit', type: 'number', min: 1, max: 10000, step: 1, unit: 'ms', integer: true },
  { key: 'fwOracleMaxConcurrency', label: 'FW Oracle Max Concurrency', type: 'number', min: 1, max: 32, step: 1, unit: 'count', integer: true },
  { key: 'fwMaxIterations', label: 'FW Max Iterations', type: 'number', min: 1, max: 200, step: 1, unit: 'count', integer: true },
  { key: 'fwMaxLoopRuntimeMs', label: 'FW Max Loop Runtime', type: 'number', min: 1, max: 60000, step: 1, unit: 'ms', integer: true },
  { key: 'fwGapAbsTolerance', label: 'FW Abs Gap Tolerance', type: 'number', min: 0.00000001, max: 1, step: 0.00000001, unit: 'fraction' },
  { key: 'fwGapRelTolerance', label: 'FW Rel Gap Tolerance', type: 'number', min: 0.00000001, max: 1, step: 0.00000001, unit: 'fraction' },
  { key: 'fwContractionInitialEpsilon', label: 'FW Contraction Initial Epsilon', type: 'number', min: 0.00000001, max: 1, step: 0.00000001, unit: 'fraction' },
  { key: 'fwContractionDecay', label: 'FW Contraction Decay', type: 'number', min: 0.00000001, max: 0.99999999, step: 0.00000001, unit: 'fraction' },
  { key: 'fwContractionMinEpsilon', label: 'FW Contraction Min Epsilon', type: 'number', min: 0.00000001, max: 1, step: 0.00000001, unit: 'fraction' },
  { key: 'fwStallIterationLimit', label: 'FW Stall Iteration Limit', type: 'number', min: 1, max: 100, step: 1, unit: 'count', integer: true },
  { key: 'fwActiveSetMaxVertices', label: 'FW Active Set Max Vertices', type: 'number', min: 2, max: 200, step: 1, unit: 'count', integer: true },
  { key: 'fwHullSolveMaxIterations', label: 'FW Hull Solve Max Iterations', type: 'number', min: 1, max: 1000, step: 1, unit: 'count', integer: true },
  { key: 'fwHullSolveTolerance', label: 'FW Hull Solve Tolerance', type: 'number', min: 0.00000001, max: 1, step: 0.00000001, unit: 'fraction' },
  { key: 'fwMaxProjectionAgeMs', label: 'FW Max Projection Age', type: 'number', min: 1, max: 60000, step: 1, unit: 'ms', integer: true },
  { key: 'fwSlippageToleranceBps', label: 'FW Slippage Tolerance', type: 'number', min: 0, max: 10000, step: 1, unit: 'bps', integer: true },
  { key: 'fwExecutionRiskBufferBps', label: 'FW Execution Risk Buffer', type: 'number', min: 0, max: 10000, step: 1, unit: 'bps', integer: true },
  { key: 'fwMinEdgeThreshold', label: 'FW Min Edge Threshold', type: 'number', min: 0.0001, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'fwSelectionWeightFloor', label: 'FW Selection Weight Floor', type: 'number', min: 0, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'fwSelectionTopK', label: 'FW Selection Top K', type: 'number', min: 0, max: 100, step: 1, unit: 'count', integer: true },
  { key: 'fwMaxPerMarketNotional', label: 'FW Max Per Market', type: 'number', min: 0, max: 100000, step: 1, unit: 'usd' },
  { key: 'fwMaxPortfolioNotional', label: 'FW Max Portfolio', type: 'number', min: 0, max: 100000, step: 1, unit: 'usd' },
  { key: 'fwBasketMinMarkets', label: 'FW Basket Min Markets', type: 'number', min: 1, max: 100, step: 1, unit: 'count', integer: true },
  { key: 'fwBasketMaxMarkets', label: 'FW Basket Max Markets', type: 'number', min: 1, max: 100, step: 1, unit: 'count', integer: true },
  { key: 'fwBasketExecutionMode', label: 'FW Basket Execution Mode', type: 'enum', options: ['batch_best_effort', 'sequential_failfast'] }
];

const RISK_FIELDS: ConfigField[] = [
  { key: 'targetTradeFraction', label: 'Target Trade Fraction', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'maxTradeFraction', label: 'Max Trade Fraction', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'maxAttemptLossFraction', label: 'Max Attempt Loss Fraction', type: 'number', min: 0, max: 1, step: 0.0001, unit: 'fraction' },
  { key: 'maxDailyDrawdownFraction', label: 'Max Daily Drawdown', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'maxMarketExposureFraction', label: 'Max Market Exposure', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'marketCooldownSeconds', label: 'Market Cooldown', type: 'number', min: 0, max: 86400, step: 1, unit: 's', integer: true },
  { key: 'marketCircuitFailureThreshold', label: 'Market Circuit Failures', type: 'number', min: 1, max: 50, step: 1, unit: 'count', integer: true },
  { key: 'marketCircuitHalfOpenSuccesses', label: 'Market Circuit Half-Open Successes', type: 'number', min: 1, max: 50, step: 1, unit: 'count', integer: true },
  { key: 'maxUnwindLossFraction', label: 'Max Unwind Loss Fraction', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' },
  { key: 'maxUnwindLossTicks', label: 'Max Unwind Loss Ticks', type: 'number', min: 1, max: 10, step: 1, unit: 'ticks', integer: true },
  { key: 'unwindSlippageToleranceBps', label: 'Unwind Slippage', type: 'number', min: 1, max: 2000, step: 1, unit: 'bps', integer: true },
  { key: 'maxPerTradeLossDollars', label: 'Max Per Trade Loss', type: 'number', min: 1, max: 1000, step: 1, unit: 'usd' },
  { key: 'dailyLossLimitFraction', label: 'Daily Loss Limit', type: 'number', min: 0, max: 1, step: 0.001, unit: 'fraction' }
];

export const CONFIG_SCHEMA: ConfigSchema = {
  version: '1.5.0',
  sections: [
    { key: 'policy', label: 'Trade Policy', fields: POLICY_FIELDS },
    { key: 'risk', label: 'Risk Controls', fields: RISK_FIELDS }
  ]
};

export function getConfigSection(key: ConfigSectionKey): ConfigSection | undefined {
  return CONFIG_SCHEMA.sections.find((section) => section.key === key);
}

export function buildUpdateSchema(fields: ConfigField[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    if (field.type === 'number') {
      let schema = z.number();
      if (field.integer) schema = schema.int();
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      shape[field.key] = schema;
      continue;
    }

    if (field.type === 'boolean') {
      shape[field.key] = z.boolean();
      continue;
    }

    if (field.type === 'enum') {
      if (field.options.length === 0) {
        throw new Error(`Enum field ${field.key} has no options`);
      }
      const options = [
        field.options[0],
        ...field.options.slice(1)
      ] as [string, ...string[]];
      shape[field.key] = z.enum(options);
    }
  }

  return z.object(shape);
}

export function assertSectionValues(section: ConfigSection, values: Record<string, unknown>): void {
  for (const field of section.fields) {
    const value = values[field.key];
    if (value === undefined || value === null) {
      throw new Error(`Invalid config: missing ${field.key}`);
    }

    if (field.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error(`Invalid config: ${field.key}=${value} (expected number)`);
      }
      if (field.integer && !Number.isInteger(value)) {
        throw new Error(`Invalid config: ${field.key}=${value} (expected integer)`);
      }
      if (field.min !== undefined && value < field.min) {
        throw new Error(`Invalid config: ${field.key}=${value} (min ${field.min})`);
      }
      if (field.max !== undefined && value > field.max) {
        throw new Error(`Invalid config: ${field.key}=${value} (max ${field.max})`);
      }
      continue;
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid config: ${field.key}=${value} (expected boolean)`);
      }
      continue;
    }

    if (field.type === 'enum') {
      if (typeof value !== 'string' || !field.options.includes(value)) {
        throw new Error(
          `Invalid config: ${field.key}=${value} (expected ${field.options.join(', ')})`
        );
      }
    }
  }
}
