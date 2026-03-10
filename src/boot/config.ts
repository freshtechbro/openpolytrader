import type { Env } from '../config/env.js';
import { DEFAULT_TRADE_POLICY, type TradePolicy } from '../config/policy.js';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '../config/risk.js';
import {
  loadActiveRiskProfile,
  loadRiskProfile,
  type RiskProfileId
} from '../config/riskProfile.js';
import { ConfigStore } from '../config/store.js';
import { validateP0Config } from '../config/validate.js';

interface ActiveRiskProfileState {
  id: RiskProfileId;
  source: string;
}

interface RuntimePolicyState {
  policyConfig: TradePolicy;
  riskConfig: RiskConfig;
  configStore: ConfigStore;
  activeRiskProfile: ActiveRiskProfileState;
}

interface BookRefreshSettings {
  maxBookStalenessMs: number;
  bookRefreshIntervalMs: number;
  bookRefreshStaleMs: number;
  bookIdleCutoffMs: number;
  catalogRefreshMs: number;
}

export const DEFAULT_DEPENDENCY_RELATION_CATALOG_PATH = 'data/dependency-relations.json';

export function loadRuntimePolicyState(input: {
  env: Env;
  envProfile: RiskProfileId | null;
  envProfilePath?: string;
  riskProfileActivePath?: string;
}): RuntimePolicyState {
  let persistedProfile: ReturnType<typeof loadActiveRiskProfile> = null;
  try {
    persistedProfile = loadActiveRiskProfile(input.riskProfileActivePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to load active risk profile: ${message}`);
  }

  let profileId: RiskProfileId = input.envProfile ?? persistedProfile?.id ?? 'extra_high';
  let profilePath = input.envProfile ? input.envProfilePath : persistedProfile?.source;
  let loadedProfile: ReturnType<typeof loadRiskProfile> = null;

  try {
    loadedProfile = loadRiskProfile(profileId, profilePath);
  } catch (error) {
    if (input.envProfile || input.envProfilePath) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to load risk profile; falling back to defaults: ${message}`);
    loadedProfile = loadRiskProfile(profileId);
    if (loadedProfile) {
      profilePath = undefined;
    }
  }

  if (!loadedProfile) {
    if (profileId !== 'near_zero') {
      console.warn(`Risk profile missing for ${profileId}; falling back to near_zero`);
    }
    profileId = 'near_zero';
    profilePath = undefined;
    loadedProfile = loadRiskProfile(profileId);
  }

  const policyConfig = { ...DEFAULT_TRADE_POLICY, ...(loadedProfile?.policy ?? {}) };
  const riskConfig = { ...DEFAULT_RISK_CONFIG, ...(loadedProfile?.risk ?? {}) };
  validateP0Config(policyConfig, riskConfig);

  return {
    policyConfig,
    riskConfig,
    configStore: new ConfigStore(policyConfig, riskConfig),
    activeRiskProfile: {
      id: profileId,
      source: loadedProfile?.source ?? profilePath ?? 'defaults'
    }
  };
}

export function deriveBookRefreshSettings(
  policy: TradePolicy,
  env: Pick<Env, 'OPS_BOOK_REFRESH_INTERVAL_MS' | 'OPS_BOOK_REFRESH_STALE_MS'>
): BookRefreshSettings {
  const maxBookStalenessMs = Math.max(policy.maxBookStalenessMs, 0);
  const refreshIntervalOverride = Math.max(env.OPS_BOOK_REFRESH_INTERVAL_MS, 0);
  const refreshStaleOverride = Math.max(env.OPS_BOOK_REFRESH_STALE_MS, 0);
  const bookRefreshIntervalMs =
    refreshIntervalOverride > 0 ? refreshIntervalOverride : Math.max(maxBookStalenessMs, 10000);
  const bookRefreshStaleMs =
    refreshStaleOverride > 0
      ? maxBookStalenessMs > 0
        ? Math.min(refreshStaleOverride, maxBookStalenessMs)
        : refreshStaleOverride
      : maxBookStalenessMs;
  return {
    maxBookStalenessMs,
    bookRefreshIntervalMs,
    bookRefreshStaleMs,
    bookIdleCutoffMs: Math.max(maxBookStalenessMs * 6, 60000),
    catalogRefreshMs: Math.min(Math.max(maxBookStalenessMs * 6, 60000), 300000)
  };
}

export function parseDomainList(value?: string): string[] {
  if (!value) return [];
  const entries = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(entries));
}
