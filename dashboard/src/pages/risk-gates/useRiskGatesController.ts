import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  OpsConfigSectionUpdateResponse,
  OpsConfigSnapshot,
  OpsRiskProfileApplyResponse
} from '../../../../src/api/contracts.js';
import { opsFetchJson } from '../../lib/opsClient';
import type { RiskConfigSettingsSectionModel } from './RiskConfigSettingsSection';
import type { RiskInfraSectionModel } from './RiskInfraSection';
import type { RiskProfilePanelModel, TradingModePanelModel } from './RiskProfilePanels';
import {
  RISK_PROFILES,
  riskProfileLabel,
  type ConfigValue,
  type ProfileState,
  type RiskGateField,
  type RiskGateInfra,
  type RiskGateProfiles,
  type RiskGateSchema,
  type RiskGateSectionKey,
  type SaveState
} from './shared';

const INITIAL_PROFILE_STATE: ProfileState = { saving: false };
const INITIAL_SAVE_STATE: SaveState = {
  policy: { saving: false },
  risk: { saving: false }
};
const INITIAL_EXPANDED_SECTIONS: Record<RiskGateSectionKey, boolean> = {
  policy: false,
  risk: false
};

type ExpandedSectionsState = Record<RiskGateSectionKey, boolean>;
type SetState<T> = Dispatch<SetStateAction<T>>;
type RiskGatesSnapshot = Awaited<ReturnType<typeof loadRiskGatesSnapshot>>;

function shouldIncludeSectionValue(currentValue: ConfigValue, nextValue: ConfigValue) {
  return nextValue !== '' && currentValue !== nextValue;
}

function toggleBooleanValue(value: boolean) {
  return !value;
}

function toggleExpandedSectionsState(
  sectionKey: RiskGateSectionKey,
  expandedSections: ExpandedSectionsState
): ExpandedSectionsState {
  return {
    ...expandedSections,
    [sectionKey]: !expandedSections[sectionKey]
  };
}

function updateDraftStateField(
  sectionKey: RiskGateSectionKey,
  fieldKey: RiskGateField['key'],
  value: ConfigValue,
  config: OpsConfigSnapshot | null
) {
  return config
    ? {
        ...config,
        [sectionKey]: {
          ...config[sectionKey],
          [fieldKey]: value
        }
      }
    : config;
}

function buildSectionUpdate(
  current: Record<string, ConfigValue>,
  next: Record<string, ConfigValue>
): Record<string, ConfigValue> {
  const update: Record<string, ConfigValue> = {};

  for (const [key, value] of Object.entries(next)) {
    if (shouldIncludeSectionValue(current[key], value)) {
      update[key] = value;
    }
  }

  return update;
}

function updateConfigSection(
  config: OpsConfigSnapshot,
  sectionKey: RiskGateSectionKey,
  sectionValue: OpsConfigSnapshot[RiskGateSectionKey]
): OpsConfigSnapshot {
  return {
    ...config,
    [sectionKey]: sectionValue
  };
}

async function loadRiskGatesSnapshot() {
  const [schema, config, infra, riskProfiles] = await Promise.all([
    opsFetchJson<RiskGateSchema>('/config/schema'),
    opsFetchJson<OpsConfigSnapshot>('/config'),
    opsFetchJson<RiskGateInfra>('/config/infra'),
    opsFetchJson<RiskGateProfiles>('/config/risk-profiles')
  ]);

  return { schema, config, infra, riskProfiles };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function markSectionSaved(setSaveState: SetState<SaveState>, sectionKey: RiskGateSectionKey) {
  setSaveState((prev) => ({
    ...prev,
    [sectionKey]: { saving: false, savedAt: Date.now() }
  }));
}

function markSectionSaveError(setSaveState: SetState<SaveState>, sectionKey: RiskGateSectionKey, error: unknown) {
  setSaveState((prev) => ({
    ...prev,
    [sectionKey]: {
      saving: false,
      error: getErrorMessage(error, 'Failed to save')
    }
  }));
}

function syncProfileDraftFromSnapshot(
  snapshot: RiskGatesSnapshot,
  profileDraftDirtyRef: MutableRefObject<boolean>,
  setProfileDraft: SetState<string>
) {
  const activeProfile = snapshot.riskProfiles.activeProfile ?? snapshot.config.riskProfile;
  if (activeProfile && !profileDraftDirtyRef.current) {
    setProfileDraft(activeProfile);
  }
}

function buildProfileAppliedConfig(config: OpsConfigSnapshot, response: OpsRiskProfileApplyResponse): OpsConfigSnapshot {
  return {
    ...config,
    policy: response.policy ?? config.policy,
    risk: response.risk ?? config.risk,
    riskProfile: response.profile?.id ?? config.riskProfile,
    riskProfileSource: response.profile?.source ?? config.riskProfileSource
  };
}

function updateRiskProfilesAfterApply(response: OpsRiskProfileApplyResponse, setRiskProfiles: SetState<RiskGateProfiles | null>) {
  setRiskProfiles((prev) =>
    prev && response.profile
      ? {
          ...prev,
          activeProfile: response.profile.id,
          activeProfileSource: response.profile.source
        }
      : prev
  );
}

function updateProfileDraftAfterApply(
  response: OpsRiskProfileApplyResponse,
  profileDraftDirtyRef: MutableRefObject<boolean>,
  setProfileDraft: SetState<string>
) {
  if (!response.profile?.id) return;
  profileDraftDirtyRef.current = false;
  setProfileDraft(response.profile.id);
}

function updateSectionSnapshot(
  response: OpsConfigSectionUpdateResponse,
  sectionKey: RiskGateSectionKey,
  config: OpsConfigSnapshot,
  setConfig: SetState<OpsConfigSnapshot | null>,
  setDraft: SetState<OpsConfigSnapshot | null>
) {
  const updatedSection = response[sectionKey];
  if (!updatedSection) {
    return;
  }
  const nextConfig = updateConfigSection(config, sectionKey, updatedSection);
  setConfig(nextConfig);
  setDraft(nextConfig);
}

function buildAppliedProfileState(response: OpsRiskProfileApplyResponse): ProfileState {
  return {
    saving: false,
    savedAt: Date.now(),
    warning:
      response.persisted === false
        ? 'Profile applied but could not be persisted (will reset on restart).'
        : undefined
  };
}

function useRiskGatesSnapshot(profileDraftDirtyRef: MutableRefObject<boolean>) {
  const mountedRef = useRef(true);
  const [schema, setSchema] = useState<RiskGateSchema | null>(null);
  const [config, setConfig] = useState<OpsConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<OpsConfigSnapshot | null>(null);
  const [infra, setInfra] = useState<RiskGateInfra | null>(null);
  const [riskProfiles, setRiskProfiles] = useState<RiskGateProfiles | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState((RISK_PROFILES[0]?.id ?? 'near_zero'));

  useEffect(() => {
    mountedRef.current = true;
    void loadRiskGatesSnapshot()
      .then((snapshot) => {
        if (!mountedRef.current) return;
        setSchema(snapshot.schema);
        setConfig(snapshot.config);
        setDraft(snapshot.config);
        setInfra(snapshot.infra);
        setRiskProfiles(snapshot.riskProfiles);
        setLoadError(null);
        syncProfileDraftFromSnapshot(snapshot, profileDraftDirtyRef, setProfileDraft);
      })
      .catch((error) => {
        if (!mountedRef.current) return;
        setLoadError(getErrorMessage(error, 'Failed to load config'));
      });

    return () => {
      mountedRef.current = false;
    };
  }, [profileDraftDirtyRef]);

  return {
    schema,
    setSchema,
    config,
    setConfig,
    draft,
    setDraft,
    infra,
    setInfra,
    riskProfiles,
    setRiskProfiles,
    loadError,
    setLoadError,
    profileDraft,
    setProfileDraft
  };
}

export function useRiskGatesController() {
  const profileDraftDirtyRef = useRef(false);
  const {
    schema,
    config,
    setConfig,
    draft,
    setDraft,
    infra,
    riskProfiles,
    setRiskProfiles,
    loadError,
    profileDraft,
    setProfileDraft
  } = useRiskGatesSnapshot(profileDraftDirtyRef);
  const [profileState, setProfileState] = useState<ProfileState>(INITIAL_PROFILE_STATE);
  const [saveState, setSaveState] = useState<SaveState>(INITIAL_SAVE_STATE);
  const [showInfra, setShowInfra] = useState(false);
  const [expandedSections, setExpandedSections] = useState(INITIAL_EXPANDED_SECTIONS);

  function toggleInfra() {
    setShowInfra(toggleBooleanValue);
  }

  function toggleSectionExpansion(sectionKey: RiskGateSectionKey) {
    setExpandedSections((sections) => toggleExpandedSectionsState(sectionKey, sections));
  }

  function handleFieldChange(sectionKey: RiskGateSectionKey, field: RiskGateField, value: ConfigValue) {
    setDraft((current) => updateDraftStateField(sectionKey, field.key, value, current));
  }

  async function handleSave(sectionKey: RiskGateSectionKey) {
    if (!config || !draft) return;
    const update = buildSectionUpdate(config[sectionKey], draft[sectionKey]);
    if (Object.keys(update).length === 0) {
      markSectionSaved(setSaveState, sectionKey);
      return;
    }

    setSaveState((prev) => ({ ...prev, [sectionKey]: { saving: true } }));

    try {
      const response = await opsFetchJson<OpsConfigSectionUpdateResponse>(`/config/${sectionKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
      });
      updateSectionSnapshot(response, sectionKey, config, setConfig, setDraft);
      markSectionSaved(setSaveState, sectionKey);
    } catch (error) {
      markSectionSaveError(setSaveState, sectionKey, error);
    }
  }

  function handleProfileDraftChange(value: string) {
    profileDraftDirtyRef.current = true;
    setProfileDraft(value);
  }

  async function handleProfileApply() {
    if (!config) return;
    setProfileState({ saving: true });

    try {
      const response = await opsFetchJson<OpsRiskProfileApplyResponse>('/config/risk-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileDraft })
      });
      const nextConfig = buildProfileAppliedConfig(config, response);
      setConfig(nextConfig);
      setDraft(nextConfig);
      updateProfileDraftAfterApply(response, profileDraftDirtyRef, setProfileDraft);
      updateRiskProfilesAfterApply(response, setRiskProfiles);
      setProfileState(buildAppliedProfileState(response));
    } catch (error) {
      setProfileState({
        saving: false,
        error: getErrorMessage(error, 'Failed to apply profile')
      });
    }
  }

  const profileSection: RiskProfilePanelModel = {
    loadError,
    activeProfile: riskProfiles?.activeProfile ?? config?.riskProfile ?? 'near_zero',
    activeProfileSource: riskProfiles?.activeProfileSource ?? config?.riskProfileSource ?? 'defaults',
    availableProfiles: riskProfiles?.availableProfiles ?? RISK_PROFILES.map((profile) => profile.id),
    profileDraft,
    profileState,
    getRiskProfileLabel: riskProfileLabel,
    onProfileDraftChange: handleProfileDraftChange,
    onApplyProfile: handleProfileApply
  };
  const tradingSection: TradingModePanelModel = {
    loadError,
    tradingEnabled: config?.tradingEnabled,
    tradingMode: config?.tradingMode
  };
  const infraSection: RiskInfraSectionModel = {
    loadError,
    infra,
    showInfra,
    onToggleInfra: toggleInfra
  };
  const settingsSection: RiskConfigSettingsSectionModel = {
    schema,
    draft,
    expandedSections,
    saveState,
    onToggleSectionExpansion: toggleSectionExpansion,
    onFieldChange: handleFieldChange,
    onSave: handleSave
  };

  return {
    schema,
    draft,
    infra,
    loadError,
    expandedSections,
    saveState,
    showInfra,
    profileDraft,
    profileState,
    tradingEnabled: config?.tradingEnabled,
    tradingMode: config?.tradingMode,
    activeProfile: riskProfiles?.activeProfile ?? config?.riskProfile ?? 'near_zero',
    activeProfileSource: riskProfiles?.activeProfileSource ?? config?.riskProfileSource ?? 'defaults',
    availableProfiles: riskProfiles?.availableProfiles ?? RISK_PROFILES.map((profile) => profile.id),
    profileSection,
    tradingSection,
    infraSection,
    settingsSection,
    toggleInfra,
    toggleSectionExpansion,
    handleFieldChange,
    handleSave,
    handleProfileDraftChange,
    handleProfileApply
  };
}
