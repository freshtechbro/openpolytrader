import type { TradingMode } from '../config/env.js';
import type { InfraConfigSnapshot } from '../config/infra.js';
import type { RiskProfileId } from '../config/riskProfile.js';
import type { ConfigSchema } from '../config/schemaTypes.js';
import type { MarketStatusEntry } from '../domain/allowlist.js';

export type OpsConfigValue = boolean | number | string;
export type OpsConfigSectionValues = Record<string, OpsConfigValue>;
export const OPS_TRADING_MODES = ['off', 'shadow', 'paper', 'live'] as const satisfies readonly TradingMode[];

export function parseTradingMode(value: unknown): TradingMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  for (const mode of OPS_TRADING_MODES) {
    if (mode === normalized) return mode;
  }
  return null;
}

export interface OpsErrorPayload {
  code: string;
  message?: string;
  details?: unknown;
}

export interface OpsErrorResponse {
  error: OpsErrorPayload;
}

export interface OpsConfigSnapshot {
  policy: OpsConfigSectionValues;
  risk: OpsConfigSectionValues;
  riskProfile: RiskProfileId;
  riskProfileSource: string;
  tradingMode?: TradingMode;
  tradingEnabled?: boolean;
  tradingStateChangedAt?: string;
  tradingStateChangedBy?: 'env' | 'api';
}

export interface OpsRiskProfilesSnapshot {
  activeProfile: RiskProfileId;
  activeProfileSource: string;
  availableProfiles: RiskProfileId[];
}

export type OpsConfigSchemaResponse = ConfigSchema;
export type OpsInfraConfigSnapshot = InfraConfigSnapshot;

export interface OpsConfigSectionUpdateResponse {
  policy?: OpsConfigSectionValues;
  risk?: OpsConfigSectionValues;
}

export interface OpsRiskProfileApplyResponse {
  profile: { id: RiskProfileId; source: string };
  policy: OpsConfigSectionValues;
  risk: OpsConfigSectionValues;
  persisted: boolean;
}

export interface OpsTradingStateResponse {
  state: {
    enabled: boolean;
    mode: TradingMode;
    changedAt: string;
    changedBy: 'env' | 'api';
  };
}

export interface OpsAllowlistResumeResponse {
  marketId: string;
  status: MarketStatusEntry | null;
}

export interface OpsPortfolioSnapshot {
  totalCapital: number;
  availableCapital: number;
  dailyPnL: number;
  marketExposure: Record<string, number>;
  openInventoryAgeMs: number;
}
