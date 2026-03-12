import { Panel } from '../../components/Panel';
import { Section } from '../../components/Section';
import type { RiskGateInfra } from './shared';

export interface RiskInfraSectionModel {
  loadError: string | null;
  infra: RiskGateInfra | null;
  showInfra: boolean;
  onToggleInfra: () => void;
}

export function RiskInfraSection(props: { section: RiskInfraSectionModel }) {
  const { loadError, infra, showInfra, onToggleInfra } = props.section;

  return (
    <Section title="Infra (env-only)" subtitle="Read-only connectivity knobs. Hidden by default to reduce visual noise.">
      <div className="risk-toolbar">
        <span className="risk-toolbar__hint">
          {showInfra ? 'Infra details are visible.' : 'Infra details are hidden.'}
        </span>
        <button type="button" className="link-button" onClick={onToggleInfra}>
          {showInfra ? 'Hide infra details' : 'Show infra details'}
        </button>
      </div>
      {showInfra ? <RiskInfraPanels loadError={loadError} infra={infra} /> : <RiskInfraSummaryPanel />}
    </Section>
  );
}

function RiskInfraSummaryPanel() {
  return (
    <Panel
      title="Infra Summary"
      body={
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
          Expand infra details only when debugging environment-level connectivity, rate limits, or RPC behavior.
        </p>
      }
    />
  );
}

function RiskInfraPanels(props: { loadError: string | null; infra: RiskGateInfra | null }) {
  const { loadError, infra } = props;

  return (
    <>
      <Panel
        title="Ops / Streams"
        body={
          loadError ? (
            <p style={{ color: 'var(--alert)' }}>{loadError}</p>
          ) : !infra ? (
            <p>Infra config not available.</p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div><p className="label">SSE Heartbeat</p><p className="value">{infra.ops.streamHeartbeatMs} ms</p></div>
              <div><p className="label">Ops Health Interval</p><p className="value">{infra.ops.healthIntervalMs} ms</p></div>
              <div><p className="label">Reconciliation Interval</p><p className="value">{infra.ops.reconciliationIntervalMs} ms</p></div>
              <div><p className="label">Reconciliation After Incident</p><p className="value">{infra.ops.reconciliationAfterIncidentDelayMs} ms</p></div>
              <div><p className="label">Reconciliation Size Tolerance</p><p className="value">{infra.ops.reconciliationPositionSizeTolerance}</p></div>
              <div><p className="label">Incidents Limit (API)</p><p className="value">{infra.ops.incidentsLimit}</p></div>
              <div><p className="label">Incidents Retention</p><p className="value">{infra.ops.incidentsMaxEvents}</p></div>
              <div><p className="label">Metrics Retention</p><p className="value">{infra.ops.metricsMaxEvents}</p></div>
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
              <div><p className="label">CLOB Base URL</p><p className="value">{infra.polymarket.clobBaseUrl}</p></div>
              <div><p className="label">CLOB Timeout</p><p className="value">{infra.polymarket.clobTimeoutMs} ms</p></div>
              <div><p className="label">CLOB Rate Limit</p><p className="value">{infra.polymarket.clobRateLimitPerSecond}/s ({infra.polymarket.clobRateLimitWindowMs} ms window)</p></div>
              <div><p className="label">CLOB Active Orders Path</p><p className="value">{infra.polymarket.clobActiveOrdersPath}</p></div>
              <div><p className="label">Data API Base URL</p><p className="value">{infra.polymarket.dataApiBaseUrl}</p></div>
              <div><p className="label">Data API Timeout</p><p className="value">{infra.polymarket.dataApiTimeoutMs} ms</p></div>
              <div><p className="label">Market WS URL</p><p className="value">{infra.polymarket.wsUrl}</p></div>
              <div><p className="label">User WS URL</p><p className="value">{infra.polymarket.userWsUrl}</p></div>
              <div><p className="label">WS Heartbeat</p><p className="value">{infra.polymarket.wsHeartbeatMs} ms</p></div>
              <div><p className="label">WS Reconnect</p><p className="value">base {infra.polymarket.wsReconnectBaseMs} ms, max {infra.polymarket.wsReconnectMaxMs} ms, jitter {infra.polymarket.wsReconnectJitterPct}</p></div>
              <div><p className="label">Positions User Configured</p><p className="value">{infra.polymarket.positionsUserConfigured ? 'true' : 'false'}</p></div>
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
              <div><p className="label">RPC Rate Limit Window</p><p className="value">{infra.rpc.rateLimitWindowMs} ms</p></div>
              <div><p className="label">RPC Wait Defaults</p><p className="value">confirmations {infra.rpc.waitConfirmations}, timeout {infra.rpc.waitTimeoutMs} ms</p></div>
              <div><p className="label">Alchemy</p><p className="value">{infra.rpc.providers.alchemy.rpcBaseUrl} (ws {infra.rpc.providers.alchemy.wsBaseUrl}) — rps {infra.rpc.providers.alchemy.rps}, apiKeyConfigured {infra.rpc.providers.alchemy.apiKeyConfigured ? 'true' : 'false'}</p></div>
              <div><p className="label">QuickNode</p><p className="value">configured {infra.rpc.providers.quicknode.rpcBaseUrlConfigured ? 'true' : 'false'} — rps {infra.rpc.providers.quicknode.rps}</p></div>
              <div><p className="label">Chainstack</p><p className="value">{infra.rpc.providers.chainstack.rpcBaseUrl} (ws {infra.rpc.providers.chainstack.wsBaseUrl}) — rps {infra.rpc.providers.chainstack.rps}</p></div>
              <div><p className="label">Ankr</p><p className="value">{infra.rpc.providers.ankr.rpcBaseUrl} — rps phase1 {infra.rpc.providers.ankr.rpsPhase1}, phase2 {infra.rpc.providers.ankr.rpsPhase2}</p></div>
              <div><p className="label">Private Node</p><p className="value">{infra.rpc.providers.privateNode.rpcBaseUrl} (ws {infra.rpc.providers.privateNode.wsBaseUrl}) — rps {infra.rpc.providers.privateNode.rps}</p></div>
            </div>
          )
        }
      />
    </>
  );
}
