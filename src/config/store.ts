import type { TradePolicy } from './policy.js';
import type { RiskConfig } from './risk.js';
import { validateP0Config } from './validate.js';

export class ConfigStore {
  constructor(
    private policy: TradePolicy,
    private risk: RiskConfig
  ) {
    validateP0Config(policy, risk);
  }

  getPolicy(): TradePolicy {
    return this.policy;
  }

  getRisk(): RiskConfig {
    return this.risk;
  }

  snapshot(): { policy: TradePolicy; risk: RiskConfig } {
    return { policy: this.policy, risk: this.risk };
  }

  replace(policy: TradePolicy, risk: RiskConfig): { policy: TradePolicy; risk: RiskConfig } {
    validateP0Config(policy, risk);
    Object.assign(this.policy, policy);
    Object.assign(this.risk, risk);
    return this.snapshot();
  }

  updatePolicy(update: Partial<TradePolicy>): TradePolicy {
    const next = { ...this.policy, ...update };
    validateP0Config(next, this.risk);
    Object.assign(this.policy, next);
    return this.policy;
  }

  updateRisk(update: Partial<RiskConfig>): RiskConfig {
    const next = { ...this.risk, ...update };
    validateP0Config(this.policy, next);
    Object.assign(this.risk, next);
    return this.risk;
  }
}
