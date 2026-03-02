import { useMemo, useState } from 'react';

import { MetricCard } from '../components/MetricCard';
import { StatusPill } from '../components/StatusPill';
import { Section } from '../components/Section';
import { MetricsTable, type TableRow } from '../components/MetricsTable';
import { Panel } from '../components/Panel';
import { INCIDENTS_PREVIEW_LIMIT } from '../lib/dashboardConfig';

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
  question?: string | null;
  description?: string | null;
};

export type SloAggregate = {
  window: '1h' | '24h';
  pairedFillRate: number;
  p95LatencyMs: number;
  p95AckLatencyMs: number;
  delayedAckRate: number;
  bookFreshnessViolations: number;
  samples?: Record<string, number>;
};

export type SloAggregates = {
  generatedAtMs?: number;
  aggregates?: SloAggregate[];
  error?: string;
};

export type IntentStrategy = 'near_zero' | 'ev' | 'fw_projection' | 'fw_basket' | 'unknown';

export interface FinalIntent {
  opportunityId: string;
  marketId?: string;
  marketQuestion?: string;
  strategy?: IntentStrategy;
  gatedAt: number;
  executedAt?: number;
  orderStatus?: string;
  orderReason?: string;
}

export interface OverviewProps {
  health: HealthReport | null;
  metrics: MetricsSnapshot | null;
  slo: SloAggregates | null;
  intents: FinalIntent[];
  incidents: any[];
  expanded: boolean;
  onToggleExpanded: () => void;
}

const INTENTS_PREVIEW_LIMIT = 8;

export function Overview({ health, metrics, slo, intents, incidents, expanded, onToggleExpanded }: OverviewProps) {
  const [showAllGated, setShowAllGated] = useState(false);
  const [showAllExecuted, setShowAllExecuted] = useState(false);
  const uptime = useMemo(() => formatUptime(health?.uptimeMs ?? 0), [health?.uptimeMs]);
  const sloRows = useMemo(() => {
    const aggregates = slo?.aggregates;
    if (!Array.isArray(aggregates) || aggregates.length === 0) return [];
    return aggregates.map((agg) => [
      agg.window,
      formatPercent(agg.pairedFillRate),
      formatMs(agg.p95LatencyMs),
      formatMs(agg.p95AckLatencyMs),
      formatPercent(agg.delayedAckRate),
      String(agg.bookFreshnessViolations ?? 0)
    ]);
  }, [slo]);
  const allIntentRows = useMemo((): TableRow[] => {
    return intents.map((intent) => {
      const status =
        intent.orderStatus === 'submitted'
          ? 'Executed'
          : intent.orderStatus
            ? `Order ${intent.orderStatus}`
            : 'Ready';
      const opportunity = intent.opportunityId;
      const market = intent.marketQuestion ?? 'Question unavailable';
      const strategy = formatIntentStrategy(intent.strategy);
      const outcome = intent.orderReason ?? (intent.orderStatus === 'submitted' ? 'order_submitted' : 'awaiting_order');
      const timeLabel = new Date(intent.gatedAt).toLocaleTimeString();
      return [
        <span className="intent-cell intent-cell--time" title={timeLabel}>{timeLabel}</span>,
        <span className="intent-cell intent-cell--id" title={opportunity}>{opportunity}</span>,
        <span className="intent-cell intent-cell--question" title={market}>{market}</span>,
        <span className="intent-cell intent-cell--strategy" title={strategy}>{strategy}</span>,
        <span className="intent-cell intent-cell--status">{status}</span>,
        <span className="intent-cell intent-cell--outcome" title={outcome}>{outcome}</span>
      ];
    }).map((cells, index) => ({
      key: `gated-${index}`,
      cellClassNames: ['intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col'],
      cells
    }));
  }, [intents]);
  const executedIntentRows = useMemo((): TableRow[] => {
    return intents
      .filter((intent) => intent.orderStatus === 'submitted')
      .map((intent, index) => {
        const timeLabel = intent.executedAt ? new Date(intent.executedAt).toLocaleTimeString() : new Date(intent.gatedAt).toLocaleTimeString();
        const opportunity = intent.opportunityId;
        const market = intent.marketQuestion ?? 'Question unavailable';
        const strategy = formatIntentStrategy(intent.strategy);
        const reason = intent.orderReason ?? 'order_submitted';
        return {
          key: `executed-${index}`,
          cellClassNames: ['intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col', 'intent-cell-col'],
          cells: [
            <span className="intent-cell intent-cell--time" title={timeLabel}>{timeLabel}</span>,
            <span className="intent-cell intent-cell--id" title={opportunity}>{opportunity}</span>,
            <span className="intent-cell intent-cell--question" title={market}>{market}</span>,
            <span className="intent-cell intent-cell--strategy" title={strategy}>{strategy}</span>,
            <span className="intent-cell intent-cell--status">{intent.orderStatus ?? 'submitted'}</span>,
            <span className="intent-cell intent-cell--outcome" title={reason}>{reason}</span>
          ]
        };
      });
  }, [intents]);
  const visibleGatedRows = showAllGated ? allIntentRows : allIntentRows.slice(0, INTENTS_PREVIEW_LIMIT);
  const visibleExecutedRows = showAllExecuted ? executedIntentRows : executedIntentRows.slice(0, INTENTS_PREVIEW_LIMIT);

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
          <MetricCard title="Incidents (recent)" value={metrics?.counts?.incident ?? 0} />
          <MetricCard title="Opportunities (recent)" value={metrics?.counts?.opportunity ?? 0} />
          <MetricCard title="Orders (recent)" value={metrics?.counts?.order ?? 0} />
          <MetricCard title="Fills (recent)" value={metrics?.counts?.fill ?? 0} />
        </div>
      </Section>

      <Section title="FW Telemetry" subtitle="Adaptive Frank-Wolfe dependency and oracle activity.">
        <div className="grid">
          <MetricCard title="FW Projections" value={metrics?.counts?.fw_projection ?? 0} />
          <MetricCard title="FW Dependencies" value={metrics?.counts?.fw_dependency ?? 0} />
          <MetricCard title="FW Oracle Calls" value={metrics?.counts?.fw_oracle ?? 0} />
          <MetricCard title="FW Iterations" value={metrics?.counts?.fw_iteration ?? 0} />
          <MetricCard title="FW Gap Events" value={metrics?.counts?.fw_gap ?? 0} />
          <MetricCard title="FW Baskets" value={metrics?.counts?.fw_basket ?? 0} />
          <MetricCard title="Gate Rejections" value={metrics?.counts?.gate_rejection ?? 0} />
        </div>
      </Section>

      <Section title="SLO Windows" subtitle="Rolling window aggregates backed by SQLite telemetry.">
        <Panel
          title="1h / 24h"
          body={
              <MetricsTable
              columns={[
                'Window',
                'Paired Fill Rate',
                'Decision Latency p95',
                'Ack Latency p95',
                'Delayed Ack Rate',
                'Book Freshness Violations'
              ]}
              rows={
                slo?.error
                  ? [[slo.error, '-', '-', '-', '-', '-']]
                  : sloRows.length > 0
                    ? sloRows
                    : [['n/a', 'n/a', 'n/a', 'n/a', 'n/a', '0']]
              }
            />
          }
        />
      </Section>

      <Section title="Final Intents" subtitle="Intents that passed risk gates and reached execution handoff.">
        <Panel
          title="All intents (gated)"
          body={
            <>
              <MetricsTable
                className="intents-table"
                ariaLabel="All gated intents"
                columnClassNames={[
                  'intents-col-time',
                  'intents-col-opportunity',
                  'intents-col-market',
                  'intents-col-strategy',
                  'intents-col-status',
                  'intents-col-outcome'
                ]}
                columns={['Time', 'Opportunity', 'Market', 'Strategy', 'Status', 'Outcome']}
                rows={
                  allIntentRows.length > 0
                    ? visibleGatedRows
                    : [[
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--outcome">No gated intents captured yet</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--outcome">Waiting for stream events</span>
                    ]]
                }
              />
              {allIntentRows.length > INTENTS_PREVIEW_LIMIT ? (
                <div className="table-meta">
                  <span>
                    Showing {visibleGatedRows.length} of {allIntentRows.length}
                  </span>
                  <button type="button" className="link-button" onClick={() => setShowAllGated((prev) => !prev)}>
                    {showAllGated ? 'Show less' : 'Show all'}
                  </button>
                </div>
              ) : null}
            </>
          }
        />
        <Panel
          title="Executed intents"
          body={
            <>
              <MetricsTable
                className="intents-table"
                ariaLabel="Executed intents"
                columnClassNames={[
                  'intents-col-time',
                  'intents-col-opportunity',
                  'intents-col-market',
                  'intents-col-strategy',
                  'intents-col-status',
                  'intents-col-outcome'
                ]}
                columns={['Time', 'Opportunity', 'Market', 'Strategy', 'Order Status', 'Reason']}
                rows={
                  executedIntentRows.length > 0
                    ? visibleExecutedRows
                    : [[
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--outcome">No executed intents yet</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--time">-</span>,
                      <span className="intent-cell intent-cell--outcome">Waiting for submitted orders</span>
                    ]]
                }
              />
              {executedIntentRows.length > INTENTS_PREVIEW_LIMIT ? (
                <div className="table-meta">
                  <span>
                    Showing {visibleExecutedRows.length} of {executedIntentRows.length}
                  </span>
                  <button type="button" className="link-button" onClick={() => setShowAllExecuted((prev) => !prev)}>
                    {showAllExecuted ? 'Show less' : 'Show all'}
                  </button>
                </div>
              ) : null}
            </>
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
                rows={(expanded ? incidents : incidents.slice(0, INCIDENTS_PREVIEW_LIMIT)).map((incident) => [
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

function formatPercent(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatMs(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(value)}ms`;
}

function formatIntentStrategy(strategy?: IntentStrategy): string {
  if (strategy === 'ev') return 'EV';
  if (strategy === 'near_zero') return 'Near Zero';
  if (strategy === 'fw_projection') return 'FW Projection';
  if (strategy === 'fw_basket') return 'FW Basket';
  return 'Unknown';
}
