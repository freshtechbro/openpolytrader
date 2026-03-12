import type { RiskProfileId } from '../../../../src/config/riskProfile.js';
import { Panel } from '../../components/Panel';
import type { ProfileState } from './shared';

export interface RiskProfilePanelModel {
  loadError: string | null;
  activeProfile: RiskProfileId;
  activeProfileSource: string;
  availableProfiles: RiskProfileId[];
  profileDraft: RiskProfileId;
  profileState: ProfileState;
  getRiskProfileLabel: (id: RiskProfileId) => string;
  onProfileDraftChange: (value: RiskProfileId) => void;
  onApplyProfile: () => void;
}

export interface TradingModePanelModel {
  loadError: string | null;
  tradingEnabled?: boolean;
  tradingMode?: string;
}

export function RiskProfilePanel(props: { section: RiskProfilePanelModel }) {
  const {
    loadError,
    activeProfile,
    activeProfileSource,
    availableProfiles,
    profileDraft,
    profileState,
    getRiskProfileLabel,
    onProfileDraftChange,
    onApplyProfile
  } = props.section;

  return (
    <Panel
      title="Risk Profile"
      body={
        loadError ? (
          <p style={{ color: 'var(--alert)' }}>{loadError}</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <p className="label">Active Profile</p>
              <p className="value">
                {activeProfile} {activeProfileSource ? `(${activeProfileSource})` : ''}
              </p>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label className="label" htmlFor="risk-profile-select">
                Select Profile
              </label>
              <select
                id="risk-profile-select"
                value={profileDraft}
                onChange={(event) => onProfileDraftChange(event.target.value as RiskProfileId)}
              >
                {availableProfiles.map((profileId) => (
                  <option key={profileId} value={profileId}>
                    {getRiskProfileLabel(profileId)}
                  </option>
                ))}
              </select>
              <p style={{ margin: 0, color: 'var(--ink-muted)', fontSize: '0.85rem' }}>
                Applying a profile overwrites only the settings included in the preset; other values stay as-is.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="link-button" onClick={onApplyProfile} disabled={profileState.saving}>
                {profileState.saving ? 'Applying…' : 'Apply profile'}
              </button>
              {profileState.error ? <span style={{ color: 'var(--alert)' }}>{profileState.error}</span> : null}
              {profileState.warning ? (
                <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>{profileState.warning}</span>
              ) : null}
              {profileState.savedAt ? (
                <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>
                  Applied {new Date(profileState.savedAt).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </div>
        )
      }
    />
  );
}

export function TradingModePanel(props: { section: TradingModePanelModel }) {
  const { loadError, tradingEnabled, tradingMode } = props.section;

  return (
    <Panel
      title="Trading Mode"
      body={
        loadError ? (
          <p style={{ color: 'var(--alert)' }}>{loadError}</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <p className="label">Trading Enabled</p>
              <p className="value">{tradingEnabled ? 'true' : 'false'}</p>
            </div>
            <div>
              <p className="label">Trading Mode</p>
              <p className="value">{tradingMode ?? 'unknown'}</p>
            </div>
          </div>
        )
      }
    />
  );
}
