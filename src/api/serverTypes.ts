import type { TradePolicy } from '../config/policy.js';
import type { RiskConfig } from '../config/risk.js';
import type { RiskProfileId } from '../config/riskProfile.js';
import type { TradingMode } from '../config/env.js';
import type { TradingState } from '../core/TradingStateManager.js';
import type { SyntheticOpportunityOptions, SyntheticOpportunityResult } from '../core/Supervisor.js';
import type { MarketStatusEntry } from '../domain/allowlist.js';
import type { InfraConfigSnapshot } from '../config/infra.js';
import type { MetricEvent, MetricEventType } from '../telemetry/metrics.js';
import type { OpsPortfolioSnapshot } from './contracts.js';

type OpsAllowlistEntry = { key: string; entry: MarketStatusEntry };
type OpsPortfolioState = Omit<OpsPortfolioSnapshot, 'openInventoryAgeMs'> & { openInventoryAgeMs?: number };

export interface OpsMarketInfo {
  question?: string | null;
  description?: string | null;
  condition_id?: string;
}

export interface OpsHealthCheckResult {
  ok: boolean;
  info?: string;
  latencyMs?: number;
  error?: string;
}

export interface OpsHealthReport {
  status: 'healthy' | 'degraded';
  checks: Record<string, OpsHealthCheckResult>;
  lastCheckMs: number | null;
  uptimeMs: number;
}

export interface OpsMetricsPort {
  snapshot(): {
    counts: Record<MetricEventType, number>;
    lastEventAt: number | null;
  };
  recent(type: MetricEventType | undefined, limit: number): MetricEvent[];
  record(event: MetricEvent): void;
  on(event: 'event', handler: (event: MetricEvent) => void): void;
  off(event: 'event', handler: (event: MetricEvent) => void): void;
}

export interface OpsAllowlistPort {
  list(): OpsAllowlistEntry[];
  allow(marketId: string): void;
  getStatus(marketId: string): MarketStatusEntry | null;
}

export interface OpsHealthPort {
  getReport(): OpsHealthReport;
  runOnce(): Promise<OpsHealthReport>;
}

export interface OpsDecisionStorePort {
  listDecisions(input: {
    agent?: string;
    subjectId?: string;
    sinceMs?: number;
    untilMs?: number;
    limit: number;
  }): Array<{
    id: string;
    subjectId: string;
    timestamp: number;
    agent: string;
    decision: unknown;
    reasoning: unknown;
  }>;
  queryMetricsByTypes(types: MetricEventType[], windowMs: number, nowMs?: number): MetricEvent[];
}

export interface OpsPortfolioPort {
  snapshot(): OpsPortfolioState;
  analyzeAnomalies(): Promise<void>;
}

export interface OpsLearningPort {
  synthesizeNow(): Promise<void>;
}

export interface OpsConfigStorePort {
  snapshot(): {
    policy: TradePolicy;
    risk: RiskConfig;
  };
  updatePolicy(update: Partial<TradePolicy>): TradePolicy;
  updateRisk(update: Partial<RiskConfig>): RiskConfig;
  getPolicy(): TradePolicy;
  getRisk(): RiskConfig;
}

export interface OpsTradingStatePort {
  readonly state: TradingState;
  setMode(mode: TradingMode, changedBy?: 'env' | 'api'): boolean;
  setEnabled(enabled: boolean, changedBy?: 'env' | 'api'): boolean;
}

export interface OpsMarketInfoPort {
  getMarket(marketId: string): Promise<OpsMarketInfo | null>;
}

export interface OpsServerDeps {
  metrics: OpsMetricsPort;
  allowlist: OpsAllowlistPort;
  opsAgent: OpsHealthPort;
  eventStore?: OpsDecisionStorePort;
  portfolioAgent?: OpsPortfolioPort;
  learningAgent?: OpsLearningPort;
  configStore?: OpsConfigStorePort;
  tradingMode?: TradingMode;
  tradingEnabled?: boolean;
  tradingStateManager?: OpsTradingStatePort;
  infraConfig?: InfraConfigSnapshot;
  clobClient?: OpsMarketInfoPort;
  syntheticOpportunity?: (options: SyntheticOpportunityOptions) => Promise<SyntheticOpportunityResult>;
  debugMarketDataOutlier?: (tokenId: string) => Promise<{ ok: boolean; error?: string }>;
  riskProfile?: { id: RiskProfileId; source: string };
  applyRiskProfile?: (
    profile: RiskProfileId,
    overridePath?: string
  ) => {
    profile: { id: RiskProfileId; source: string };
    policy: TradePolicy;
    risk: RiskConfig;
    persisted: boolean;
  };
  applyConfigUpdate?: (policy: TradePolicy, risk: RiskConfig) => void;
}
