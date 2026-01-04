import { useMemo } from 'react';

import { MetricCard } from '../components/MetricCard';
import { StatusPill } from '../components/StatusPill';
import { Section } from '../components/Section';
import { MetricsTable } from '../components/MetricsTable';
import { Panel } from '../components/Panel';

export type HealthReport = {
  status: 'healthy' | 'degraded';
  checks: Record<string, { ok: boolean; latencyMs?: number; info?: string; error?: string }>;
  uptimeMs: number;
  lastCheckMs: number | null;
};

export type MetricsSnapshot = {
  counts: Record<string, number>;
  lastEventAt: number | null;
};

export type AllowlistEntry = {
  key: string;
  entry: { status: string; until?: number; reason?: string };
};

export interface OverviewProps {
  health: HealthReport | null;
  metrics: MetricsSnapshot | null;
  allowlist: AllowlistEntry[];
  incidents: any[];
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function Overview({ health, metrics, allowlist, incidents, expanded, onToggleExpanded }: OverviewProps) {
  const uptime = useMemo(() => formatUptime(health?.uptimeMs ?? 0), [health?.uptimeMs]);

  return (
    <>
      <section className="hero">
        <div className="hero__text">
          <p className="hero__eyebrow">System Overview</p>
          <h1>Control the edge with disciplined execution.</h1>
          <p className="hero__lead">
            Live system health, incident triage, and risk gate insight for near-risk-free arbitrage on
            Polymarket.
          </p>
        </div>
        <div className="hero__panel">
          <Panel
            title="Live Health"
            accent="signal"
            body={
              <div className="health">
                <div>
                  <p className="label">Status</p>
                  <StatusPill status={health?.status ?? 'degraded'} />
                </div>
                <div>
                  <p className="label">Uptime</p>
                  <p className="value">{uptime}</p>
                </div>
                <div>
                  <p className="label">Checks</p>
                  <p className="value">{Object.keys(health?.checks ?? {}).length}</p>
                </div>
              </div>
            }
          />
        </div>
      </section>

      <Section title="Risk Pulse" subtitle="Key throughput and resilience metrics.">
        <div className="grid">
          <MetricCard title="Incidents (last 1k)" value={metrics?.counts?.incident ?? 0} />
          <MetricCard title="Opportunities (last 1k)" value={metrics?.counts?.opportunity ?? 0} />
          <MetricCard title="Orders (last 1k)" value={metrics?.counts?.order ?? 0} />
          <MetricCard title="Fills (last 1k)" value={metrics?.counts?.fill ?? 0} />
        </div>
      </Section>

      <Section title="Allowlist & Quarantine" subtitle="Markets currently permitted to trade.">
        <Panel
          title="Allowlist"
          body={
            <MetricsTable
              columns={['Market', 'Status', 'Until', 'Reason']}
              rows={allowlist.map((entry) => [
                entry.key,
                entry.entry.status,
                entry.entry.until ? new Date(entry.entry.until).toLocaleString() : '-',
                entry.entry.reason ?? '-'
              ])}
            />
          }
        />
      </Section>

      <Section title="Recent Incidents" subtitle="Latest operational alerts.">
        <Panel
          title="Incidents"
          body={
            <>
              <MetricsTable
                columns={['Time', 'Check', 'Error']}
                rows={(expanded ? incidents : incidents.slice(0, 6)).map((incident) => [
                  incident?.timestamp ? new Date(incident.timestamp).toLocaleTimeString() : '-',
                  incident?.check ?? 'unknown',
                  incident?.result?.error ?? incident?.result?.info ?? 'n/a'
                ])}
              />
              <button type="button" className="link-button" onClick={onToggleExpanded}>
                {expanded ? 'Show less' : 'Show more'}
              </button>
            </>
          }
        />
      </Section>
    </>
  );
}

function formatUptime(ms: number): string {
  if (!ms || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}
