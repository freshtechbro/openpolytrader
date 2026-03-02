import type { TradePolicy } from '../../config/policy.js';
import type { MetricsStore } from '../../telemetry/metrics.js';

export interface FwRelationCatalogStartupGuardInput {
  tradingEnabled: boolean;
  tradingMode: string;
  policy: TradePolicy;
  relationCatalogPath: string;
  relationCatalogEntries: number;
  metrics: MetricsStore;
}

export function isFwRelationModeEnabled(policy: TradePolicy): boolean {
  return (
    policy.fwRelationCandidatesPerMarketMax > 0 &&
    policy.fwRelationCandidatesTotalMax > 0
  );
}

export function ensureFwRelationCatalogStartupReady(
  input: FwRelationCatalogStartupGuardInput
): void {
  if (!input.tradingEnabled || input.tradingMode !== 'paper') return;
  if (!isFwRelationModeEnabled(input.policy)) return;
  if (input.relationCatalogEntries > 0) return;

  input.metrics.record({
    type: 'incident',
    timestamp: Date.now(),
    data: {
      reason: 'fw_relation_catalog_empty_startup',
      detail: {
        path: input.relationCatalogPath,
        entries: input.relationCatalogEntries
      }
    }
  });

  throw new Error(
    `[boot] FW relation catalog is empty (${input.relationCatalogPath}). Run \`npm run catalog:relations:dev\` (or \`npm run catalog:relations\`) before paper-mode validation.`
  );
}

