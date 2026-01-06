import type { TradePolicy } from './policy.js';
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
}
