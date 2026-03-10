import type {
  OpsConfigSnapshot,
  OpsConfigValue,
  OpsInfraConfigSnapshot,
  OpsRiskProfilesSnapshot
} from '../../../../src/api/contracts.js';
import type { RiskProfileId } from '../../../../src/config/riskProfile.js';
import type { ConfigField, ConfigSchema, ConfigSectionKey } from '../../../../src/config/schemaTypes.js';

export type ConfigValue = OpsConfigValue;
export type RiskGateSchema = ConfigSchema;
export type RiskGateDraft = OpsConfigSnapshot;
export type RiskGateInfra = OpsInfraConfigSnapshot;
export type RiskGateProfiles = OpsRiskProfilesSnapshot;
export type RiskGateField = ConfigField;
export type RiskGateSectionKey = ConfigSectionKey;

export interface ProfileState {
  saving: boolean;
  error?: string;
  warning?: string;
  savedAt?: number;
}

export type SaveState = Record<RiskGateSectionKey, { saving: boolean; error?: string; savedAt?: number }>;

export const DEFAULT_VISIBLE_FIELDS = 10;

export const RISK_PROFILES: Array<{ id: RiskProfileId; label: string }> = [
  { id: 'near_zero', label: 'Near Zero Risk (default)' },
  { id: 'moderate', label: 'Moderate Risk' },
  { id: 'high', label: 'High Risk' },
  { id: 'extra_high', label: 'Extra High Risk' }
];

export function riskProfileLabel(id: RiskProfileId): string {
  return RISK_PROFILES.find((profile) => profile.id === id)?.label ?? id;
}
