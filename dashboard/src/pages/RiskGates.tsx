import { useEffect, useMemo, useState } from 'react';

import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { opsFetchJson } from '../lib/opsClient';

type ConfigSectionKey = 'policy' | 'risk';
type ConfigValue = number | boolean | string;

interface ConfigFieldBase {
  key: string;
  label: string;
  description?: string;
}

interface NumberField extends ConfigFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  integer?: boolean;
}

interface BooleanField extends ConfigFieldBase {
  type: 'boolean';
}

interface EnumField extends ConfigFieldBase {
  type: 'enum';
  options: string[];
}

type ConfigField = NumberField | BooleanField | EnumField;

interface ConfigSection {
  key: ConfigSectionKey;
  label: string;
  description?: string;
  fields: ConfigField[];
}

interface ConfigSchema {
  version: string;
  sections: ConfigSection[];
}

interface ConfigSnapshot {
  policy: Record<string, ConfigValue>;
  risk: Record<string, ConfigValue>;
  tradingMode?: string;
  tradingEnabled?: boolean;
}

interface InfraConfigSnapshot {
  ops: {
    healthIntervalMs: number;
    streamHeartbeatMs: number;
    incidentsLimit: number;
    reconciliationIntervalMs: number;
    reconciliationAfterIncidentDelayMs: number;
    reconciliationPositionSizeTolerance: number;
    metricsMaxEvents: number;
    incidentsMaxEvents: number;
  };
  polymarket: {
    clobBaseUrl: string;
    clobTimeoutMs: number;
    clobRateLimitPerSecond: number;
    clobRateLimitWindowMs: number;
    clobActiveOrdersPath: string;
    dataApiBaseUrl: string;
    dataApiTimeoutMs: number;
    wsUrl: string;
    userWsUrl: string;
    wsHeartbeatMs: number;
    wsReconnectBaseMs: number;
    wsReconnectMaxMs: number;
    wsReconnectJitterPct: number;
    positionsUserConfigured: boolean;
  };
  rpc: {
    rateLimitWindowMs: number;
    waitConfirmations: number;
    waitTimeoutMs: number;
    providers: {
      alchemy: { rpcBaseUrl: string; wsBaseUrl: string; apiKeyConfigured: boolean; rps: number };
      quicknode: { rpcBaseUrlConfigured: boolean; rps: number };
      chainstack: { rpcBaseUrl: string; wsBaseUrl: string; rps: number };
      ankr: { rpcBaseUrl: string; rpsPhase1: number; rpsPhase2: number };
      privateNode: { rpcBaseUrl: string; wsBaseUrl: string; rps: number };
    };
  };
}

export function RiskGates() {
  const [schema, setSchema] = useState<ConfigSchema | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [draft, setDraft] = useState<ConfigSnapshot | null>(null);
  const [infra, setInfra] = useState<InfraConfigSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<Record<ConfigSectionKey, { saving: boolean; error?: string; savedAt?: number }>>({
    policy: { saving: false },
    risk: { saving: false }
  });

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [schemaResponse, configResponse, infraResponse] = await Promise.all([
          opsFetchJson<ConfigSchema>('/config/schema'),
          opsFetchJson<ConfigSnapshot | { error?: string }>('/config'),
          opsFetchJson<InfraConfigSnapshot | { error?: string }>('/config/infra')
        ]);

        if (!mounted) return;
        if ('error' in configResponse && configResponse.error) {
          throw new Error(configResponse.error);
        }
        if ('error' in infraResponse && infraResponse.error) {
          throw new Error(infraResponse.error);
        }

        setSchema(schemaResponse);
        setConfig(configResponse as ConfigSnapshot);
        setDraft(configResponse as ConfigSnapshot);
        setInfra(infraResponse as InfraConfigSnapshot);
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        const message = error instanceof Error ? error.message : 'Failed to load config';
        setLoadError(message);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  const sections = useMemo(() => schema?.sections ?? [], [schema]);

  const handleFieldChange = (sectionKey: ConfigSectionKey, field: ConfigField, value: ConfigValue) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [sectionKey]: {
          ...prev[sectionKey],
          [field.key]: value
        }
      };
    });
  };

  const handleSave = async (sectionKey: ConfigSectionKey) => {
    if (!config || !draft) return;
    const current = config[sectionKey];
    const next = draft[sectionKey];
    const update: Record<string, ConfigValue> = {};

    for (const [key, value] of Object.entries(next)) {
      if (value === '') continue;
      if (current[key] !== value) {
        update[key] = value;
      }
    }

    if (Object.keys(update).length === 0) {
      setSaveState((prev) => ({
        ...prev,
        [sectionKey]: { saving: false, savedAt: Date.now() }
      }));
      return;
    }

    setSaveState((prev) => ({ ...prev, [sectionKey]: { saving: true } }));

    try {
      const response = await opsFetchJson<{ policy?: Record<string, ConfigValue>; risk?: Record<string, ConfigValue>; error?: string; message?: string }>(
        `/config/${sectionKey}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update)
        }
      );

      if (response.error) {
        throw new Error(response.message ?? response.error);
      }

      const updated = response[sectionKey];
      if (updated) {
        const nextConfig = {
          ...config,
          [sectionKey]: updated
        } as ConfigSnapshot;
        setConfig(nextConfig);
        setDraft(nextConfig);
      }

      setSaveState((prev) => ({
        ...prev,
        [sectionKey]: { saving: false, savedAt: Date.now() }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save';
      setSaveState((prev) => ({
        ...prev,
        [sectionKey]: { saving: false, error: message }
      }));
    }
  };

  return (
    <>
      <Section title="Risk Gates" subtitle="Phase 1 settings, trading mode, and gate controls.">
        <Panel
          title="Trading Mode"
          body={
            loadError ? (
              <p style={{ color: 'var(--alert)' }}>{loadError}</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p className="label">Trading Enabled</p>
                  <p className="value">{config?.tradingEnabled ? 'true' : 'false'}</p>
                </div>
                <div>
                  <p className="label">Trading Mode</p>
                  <p className="value">{config?.tradingMode ?? 'unknown'}</p>
                </div>
              </div>
            )
          }
        />
      </Section>

      <Section title="Infra (env-only)" subtitle="Operational and connectivity knobs sourced from environment variables (read-only).">
        <Panel
          title="Ops / Streams"
          body={
            loadError ? (
              <p style={{ color: 'var(--alert)' }}>{loadError}</p>
            ) : !infra ? (
              <p>Infra config not available.</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p className="label">SSE Heartbeat</p>
                  <p className="value">{infra.ops.streamHeartbeatMs} ms</p>
                </div>
                <div>
                  <p className="label">Ops Health Interval</p>
                  <p className="value">{infra.ops.healthIntervalMs} ms</p>
                </div>
                <div>
                  <p className="label">Reconciliation Interval</p>
                  <p className="value">{infra.ops.reconciliationIntervalMs} ms</p>
                </div>
                <div>
                  <p className="label">Reconciliation After Incident</p>
                  <p className="value">{infra.ops.reconciliationAfterIncidentDelayMs} ms</p>
                </div>
                <div>
                  <p className="label">Reconciliation Size Tolerance</p>
                  <p className="value">{infra.ops.reconciliationPositionSizeTolerance}</p>
                </div>
                <div>
                  <p className="label">Incidents Limit (API)</p>
                  <p className="value">{infra.ops.incidentsLimit}</p>
                </div>
                <div>
                  <p className="label">Incidents Retention</p>
                  <p className="value">{infra.ops.incidentsMaxEvents}</p>
                </div>
                <div>
                  <p className="label">Metrics Retention</p>
                  <p className="value">{infra.ops.metricsMaxEvents}</p>
                </div>
              </div>
            )
          }
        />
        <Panel
          title="Polymarket"
          body={
            loadError ? (
              <p style={{ color: 'var(--alert)' }}>{loadError}</p>
            ) : !infra ? (
              <p>Infra config not available.</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p className="label">CLOB Base URL</p>
                  <p className="value">{infra.polymarket.clobBaseUrl}</p>
                </div>
                <div>
                  <p className="label">CLOB Timeout</p>
                  <p className="value">{infra.polymarket.clobTimeoutMs} ms</p>
                </div>
                <div>
                  <p className="label">CLOB Rate Limit</p>
                  <p className="value">
                    {infra.polymarket.clobRateLimitPerSecond}/s ({infra.polymarket.clobRateLimitWindowMs} ms window)
                  </p>
                </div>
                <div>
                  <p className="label">CLOB Active Orders Path</p>
                  <p className="value">{infra.polymarket.clobActiveOrdersPath}</p>
                </div>
                <div>
                  <p className="label">Data API Base URL</p>
                  <p className="value">{infra.polymarket.dataApiBaseUrl}</p>
                </div>
                <div>
                  <p className="label">Data API Timeout</p>
                  <p className="value">{infra.polymarket.dataApiTimeoutMs} ms</p>
                </div>
                <div>
                  <p className="label">Market WS URL</p>
                  <p className="value">{infra.polymarket.wsUrl}</p>
                </div>
                <div>
                  <p className="label">User WS URL</p>
                  <p className="value">{infra.polymarket.userWsUrl}</p>
                </div>
                <div>
                  <p className="label">WS Heartbeat</p>
                  <p className="value">{infra.polymarket.wsHeartbeatMs} ms</p>
                </div>
                <div>
                  <p className="label">WS Reconnect</p>
                  <p className="value">
                    base {infra.polymarket.wsReconnectBaseMs} ms, max {infra.polymarket.wsReconnectMaxMs} ms, jitter{' '}
                    {infra.polymarket.wsReconnectJitterPct}
                  </p>
                </div>
                <div>
                  <p className="label">Positions User Configured</p>
                  <p className="value">{infra.polymarket.positionsUserConfigured ? 'true' : 'false'}</p>
                </div>
              </div>
            )
          }
        />
        <Panel
          title="RPC"
          body={
            loadError ? (
              <p style={{ color: 'var(--alert)' }}>{loadError}</p>
            ) : !infra ? (
              <p>Infra config not available.</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <p className="label">RPC Rate Limit Window</p>
                  <p className="value">{infra.rpc.rateLimitWindowMs} ms</p>
                </div>
                <div>
                  <p className="label">RPC Wait Defaults</p>
                  <p className="value">
                    confirmations {infra.rpc.waitConfirmations}, timeout {infra.rpc.waitTimeoutMs} ms
                  </p>
                </div>
                <div>
                  <p className="label">Alchemy</p>
                  <p className="value">
                    {infra.rpc.providers.alchemy.rpcBaseUrl} (ws {infra.rpc.providers.alchemy.wsBaseUrl}) — rps{' '}
                    {infra.rpc.providers.alchemy.rps}, apiKeyConfigured {infra.rpc.providers.alchemy.apiKeyConfigured ? 'true' : 'false'}
                  </p>
                </div>
                <div>
                  <p className="label">QuickNode</p>
                  <p className="value">
                    configured {infra.rpc.providers.quicknode.rpcBaseUrlConfigured ? 'true' : 'false'} — rps {infra.rpc.providers.quicknode.rps}
                  </p>
                </div>
                <div>
                  <p className="label">Chainstack</p>
                  <p className="value">
                    {infra.rpc.providers.chainstack.rpcBaseUrl} (ws {infra.rpc.providers.chainstack.wsBaseUrl}) — rps {infra.rpc.providers.chainstack.rps}
                  </p>
                </div>
                <div>
                  <p className="label">Ankr</p>
                  <p className="value">
                    {infra.rpc.providers.ankr.rpcBaseUrl} — rps phase1 {infra.rpc.providers.ankr.rpsPhase1}, phase2 {infra.rpc.providers.ankr.rpsPhase2}
                  </p>
                </div>
                <div>
                  <p className="label">Private Node</p>
                  <p className="value">
                    {infra.rpc.providers.privateNode.rpcBaseUrl} (ws {infra.rpc.providers.privateNode.wsBaseUrl}) — rps {infra.rpc.providers.privateNode.rps}
                  </p>
                </div>
              </div>
            )
          }
        />
      </Section>

      <Section title="Config Settings" subtitle="Edit policy and risk thresholds via the ops API.">
        {sections.length === 0 || !draft ? (
          <Panel title="Settings" body={<p>Config schema not available.</p>} />
        ) : (
          sections.map((section) => (
            <Panel
              key={section.key}
              title={section.label}
              body={
                <div style={{ display: 'grid', gap: 16 }}>
                  {section.description ? <p style={{ margin: 0 }}>{section.description}</p> : null}
                  <div style={{ display: 'grid', gap: 12 }}>
                    {section.fields.map((field) => {
                      const value = draft[section.key]?.[field.key];
                      return (
                        <div
                          key={field.key}
                          style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 1.4fr)', gap: 16, alignItems: 'center' }}
                        >
                          <div>
                            <p className="label">{field.label}</p>
                            {field.description ? (
                              <p style={{ margin: '4px 0 0', color: 'var(--ink-muted)', fontSize: '0.85rem' }}>
                                {field.description}
                              </p>
                            ) : null}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {field.type === 'boolean' ? (
                              <input
                                type="checkbox"
                                checked={Boolean(value)}
                                onChange={(event) => handleFieldChange(section.key, field, event.target.checked)}
                              />
                            ) : field.type === 'enum' ? (
                              <select
                                value={String(value ?? '')}
                                onChange={(event) => handleFieldChange(section.key, field, event.target.value)}
                              >
                                {field.options.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type="number"
                                value={value === '' || value === undefined || value === null ? '' : Number(value)}
                                min={field.min}
                                max={field.max}
                                step={field.step ?? (field.integer ? 1 : 0.01)}
                                onChange={(event) => {
                                  const raw = event.target.value;
                                  const nextValue = raw === '' ? '' : Number(raw);
                                  handleFieldChange(section.key, field, Number.isNaN(nextValue) ? value : nextValue);
                                }}
                                style={{ width: '100%' }}
                              />
                            )}
                            {field.type === 'number' && field.unit ? (
                              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>{field.unit}</span>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => handleSave(section.key)}
                      disabled={saveState[section.key]?.saving}
                    >
                      {saveState[section.key]?.saving ? 'Saving...' : 'Save changes'}
                    </button>
                    {saveState[section.key]?.error ? (
                      <span style={{ color: 'var(--alert)' }}>{saveState[section.key]?.error}</span>
                    ) : null}
                    {saveState[section.key]?.savedAt ? (
                      <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>
                        Saved {new Date(saveState[section.key].savedAt as number).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </div>
                </div>
              }
            />
          ))
        )}
      </Section>
    </>
  );
}
