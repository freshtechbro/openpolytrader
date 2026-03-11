import { isNearZeroRiskMode, type TradePolicy } from './policy.js';
import type { RiskConfig } from './risk.js';
import { assertSectionValues, getConfigSection } from './schema.js';

export function validateP0Config(policy: TradePolicy, risk: RiskConfig): void {
  const policySection = getConfigSection('policy');
  const riskSection = getConfigSection('risk');
  if (!policySection || !riskSection) {
    throw new Error('Invalid config: schema not loaded');
  }

  assertSectionValues(policySection, policy as unknown as Record<string, unknown>);
  assertSectionValues(riskSection, risk as unknown as Record<string, unknown>);

  if (policy.edgeRequired <= 0 || policy.edgeRequired >= policy.maxEdge) {
    throw new Error(
      `Invalid config: edgeRequired=${policy.edgeRequired} (must be > 0 and < maxEdge ${policy.maxEdge})`
    );
  }

  if (policy.orderbookFreshnessMs !== policy.maxBookStalenessMs) {
    throw new Error(
      `Invalid config: orderbookFreshnessMs (${policy.orderbookFreshnessMs}) must match maxBookStalenessMs (${policy.maxBookStalenessMs})`
    );
  }

  if (isNearZeroRiskMode(policy) && policy.fillTimeoutMs <= 0) {
    throw new Error('Invalid config: fillTimeoutMs must be > 0 in near_zero_risk mode');
  }

  validateEvPolicy(policy);
  validateFwPolicy(policy);
}

function validateEvPolicy(policy: TradePolicy): void {
  if (policy.evEdgeRequired <= 0) {
    throw new Error(`Invalid config: evEdgeRequired=${policy.evEdgeRequired} (must be > 0)`);
  }
  if (policy.evMaxEdge <= 0 || policy.evEdgeRequired >= policy.evMaxEdge) {
    throw new Error(
      `Invalid config: evMaxEdge=${policy.evMaxEdge} (must be > 0 and > evEdgeRequired ${policy.evEdgeRequired})`
    );
  }
  if (policy.evConfidenceMinFloor < 0 || policy.evConfidenceMinFloor > policy.evConfidenceMin) {
    throw new Error(
      `Invalid config: evConfidenceMinFloor=${policy.evConfidenceMinFloor} (must be >= 0 and <= evConfidenceMin ${policy.evConfidenceMin})`
    );
  }

  if (policy.evMaxPerMarketNotional > 0 && policy.evMaxPortfolioNotional > 0) {
    if (policy.evMaxPerMarketNotional > policy.evMaxPortfolioNotional) {
      throw new Error(
        `Invalid config: evMaxPerMarketNotional (${policy.evMaxPerMarketNotional}) cannot exceed evMaxPortfolioNotional (${policy.evMaxPortfolioNotional})`
      );
    }
  }

  if (policy.evWebSearchHighPriorityContentBudget < policy.evWebSearchDefaultContentBudget) {
    throw new Error(
      `Invalid config: evWebSearchHighPriorityContentBudget (${policy.evWebSearchHighPriorityContentBudget}) cannot be lower than evWebSearchDefaultContentBudget (${policy.evWebSearchDefaultContentBudget})`
    );
  }

  if (policy.evWebSearchExaInlineContentsMaxResults > policy.evWebSearchMaxResults) {
    throw new Error(
      `Invalid config: evWebSearchExaInlineContentsMaxResults (${policy.evWebSearchExaInlineContentsMaxResults}) cannot exceed evWebSearchMaxResults (${policy.evWebSearchMaxResults})`
    );
  }

  if (policy.evWebSearchProviderPolicy === 'exa_only' && !policy.evWebSearchExaEnabled) {
    throw new Error('Invalid config: evWebSearchProviderPolicy=exa_only requires evWebSearchExaEnabled');
  }

  if (policy.evWebSearchProviderPolicy === 'serper_only' && !policy.evWebSearchSerperEnabled) {
    throw new Error('Invalid config: evWebSearchProviderPolicy=serper_only requires evWebSearchSerperEnabled');
  }

  if (policy.evWebSearchProviderPolicy === 'serper_exa') {
    if (!policy.evWebSearchSerperEnabled || !policy.evWebSearchExaEnabled || !policy.evWebSearchExaFallbackEnabled) {
      throw new Error(
        'Invalid config: evWebSearchProviderPolicy=serper_exa requires evWebSearchSerperEnabled, evWebSearchExaEnabled, and evWebSearchExaFallbackEnabled'
      );
    }
  }

  if (policy.evWebSearchProviderPolicy === 'gdelt_serper_exa') {
    if (!policy.evWebSearchGdeltEnabled) {
      throw new Error('Invalid config: evWebSearchProviderPolicy=gdelt_serper_exa requires evWebSearchGdeltEnabled');
    }
    if (!policy.evWebSearchSerperEnabled) {
      throw new Error('Invalid config: evWebSearchProviderPolicy=gdelt_serper_exa requires evWebSearchSerperEnabled');
    }
    if (!policy.evWebSearchExaEnabled || !policy.evWebSearchExaFallbackEnabled) {
      throw new Error(
        'Invalid config: evWebSearchProviderPolicy=gdelt_serper_exa requires evWebSearchExaEnabled and evWebSearchExaFallbackEnabled'
      );
    }
  }
}

function validateFwPolicy(policy: TradePolicy): void {
  if (policy.fwMaxPerMarketNotional > 0 && policy.fwMaxPortfolioNotional > 0) {
    if (policy.fwMaxPerMarketNotional > policy.fwMaxPortfolioNotional) {
      throw new Error(
        `Invalid config: fwMaxPerMarketNotional (${policy.fwMaxPerMarketNotional}) cannot exceed fwMaxPortfolioNotional (${policy.fwMaxPortfolioNotional})`
      );
    }
  }

  if (policy.fwDependencyMode !== 'hybrid' && policy.fwDependencyHybridMerge !== 'consensus') {
    throw new Error(
      'Invalid config: fwDependencyHybridMerge is only meaningful in hybrid mode and must be consensus otherwise'
    );
  }

  if (policy.fwDependencyCacheGraceMs > policy.fwDependencyCacheTtlMs) {
    throw new Error(
      `Invalid config: fwDependencyCacheGraceMs (${policy.fwDependencyCacheGraceMs}) cannot exceed fwDependencyCacheTtlMs (${policy.fwDependencyCacheTtlMs})`
    );
  }

  if (policy.fwContractionInitialEpsilon <= policy.fwContractionMinEpsilon) {
    throw new Error(
      `Invalid config: fwContractionInitialEpsilon (${policy.fwContractionInitialEpsilon}) must be > fwContractionMinEpsilon (${policy.fwContractionMinEpsilon})`
    );
  }

  if (policy.fwBasketMinMarkets > policy.fwBasketMaxMarkets) {
    throw new Error(
      `Invalid config: fwBasketMinMarkets (${policy.fwBasketMinMarkets}) cannot exceed fwBasketMaxMarkets (${policy.fwBasketMaxMarkets})`
    );
  }

  if (policy.fwSelectionTopK < 0) {
    throw new Error(
      `Invalid config: fwSelectionTopK (${policy.fwSelectionTopK}) must be >= 0`
    );
  }

  if (policy.fwRelationCandidatesPerMarketMax > policy.fwRelationCandidatesTotalMax) {
    throw new Error(
      `Invalid config: fwRelationCandidatesPerMarketMax (${policy.fwRelationCandidatesPerMarketMax}) cannot exceed fwRelationCandidatesTotalMax (${policy.fwRelationCandidatesTotalMax})`
    );
  }
}
