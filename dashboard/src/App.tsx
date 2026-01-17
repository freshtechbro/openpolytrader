import { useCallback, useEffect, useState } from 'react';

import { TopNav } from './components/TopNav';
import { useEventStream } from './hooks/useEventStream';
import { OPS_STREAM_URL, opsFetch, opsFetchJson } from './lib/opsClient';
import { INCIDENTS_LIMIT, SLO_REFRESH_MS } from './lib/dashboardConfig';

import { Overview, type AllowlistEntry, type HealthReport, type MetricsSnapshot, type SloAggregates } from './pages/Overview';
import { Markets } from './pages/Markets';
import { Incidents } from './pages/Incidents';
import { Positions } from './pages/Positions';
import { RiskGates } from './pages/RiskGates';
import { Decisions } from './pages/Decisions';

type Page = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk-gates' | 'decisions';
type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

export function App() {
  const [page, setPage] = useState<Page>('overview');

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [slo, setSlo] = useState<SloAggregates | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [tradingMode, setTradingMode] = useState<TradingMode | null>(null);
  const [tradingEnabled, setTradingEnabled] = useState<boolean | null>(null);

  const fetchAllowlist = useCallback(async () => {
    try {
      const data = await opsFetchJson<unknown>('/markets');
      if (Array.isArray(data)) {
        setAllowlist(data as AllowlistEntry[]);
        return;
      }
      setAllowlist([]);
    } catch {
      setAllowlist([]);
    }
  }, []);

  const [streamEvents] = useEventStream(OPS_STREAM_URL, (event) => {
    if (event.type === 'health') {
      setHealth(event.data);
    }
    if (event.type === 'incident') {
      setIncidents((prev) => [event.data, ...prev].slice(0, INCIDENTS_LIMIT));
    }
    if (event.type === 'allowlist_updated') {
      void fetchAllowlist();
    }
    if (event.type === 'info' || event.type === 'risk' || event.type === 'order' || event.type === 'fill') {
      void opsFetchJson<MetricsSnapshot>('/metrics')
        .then((data) => setMetrics(data))
        .catch(() => {});
    }
  });

  useEffect(() => {
    void opsFetchJson<HealthReport>('/health')
      .then((data) => setHealth(data))
      .catch(() => {});
    void opsFetchJson<MetricsSnapshot>('/metrics')
      .then((data) => setMetrics(data))
      .catch(() => {});
    void opsFetchJson<SloAggregates>('/slo')
      .then((data) => setSlo(data))
      .catch(() => {});
    void fetchAllowlist();
    void opsFetchJson<unknown>('/incidents')
      .then((data) => setIncidents(Array.isArray(data) ? data.slice(0, INCIDENTS_LIMIT) : []))
      .catch(() => {});
    void opsFetchJson<unknown>('/config')
      .then((data) => {
        if (data && typeof data === 'object' && !('error' in data)) {
          const record = data as Record<string, unknown>;
          setTradingMode(typeof record.tradingMode === 'string' ? (record.tradingMode as TradingMode) : null);
          setTradingEnabled(typeof record.tradingEnabled === 'boolean' ? record.tradingEnabled : null);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void opsFetchJson<SloAggregates>('/slo')
        .then((data) => setSlo(data))
        .catch(() => {});
    }, SLO_REFRESH_MS);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="app">
      <TopNav
        title="OpenPolyTrader Ops"
        subtitle="Near-risk-free monitoring console"
        status={health?.status ?? 'degraded'}
        streamConnected={streamEvents.connected}
        tradingMode={tradingMode}
        tradingEnabled={tradingEnabled}
        onModeChange={async (mode) => {
          const confirm = mode === 'live' ? '?confirm=true' : '';
          const res = await opsFetch(`/config/trading-mode${confirm}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
          });
          if (res.ok) {
            setTradingMode(mode);
          }
        }}
        onEnabledChange={async (enabled) => {
          const res = await opsFetch('/config/trading-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          if (res.ok) {
            setTradingEnabled(enabled);
          }
        }}
      />

      <main>
        <nav aria-label="Dashboard navigation" style={{ display: 'flex', gap: 12, padding: '0 24px' }}>
          <button type="button" onClick={() => setPage('overview')} aria-current={page === 'overview'}>
            Overview
          </button>
          <button type="button" onClick={() => setPage('markets')} aria-current={page === 'markets'}>
            Markets
          </button>
          <button type="button" onClick={() => setPage('incidents')} aria-current={page === 'incidents'}>
            Incidents
          </button>
          <button type="button" onClick={() => setPage('positions')} aria-current={page === 'positions'}>
            Positions
          </button>
          <button type="button" onClick={() => setPage('risk-gates')} aria-current={page === 'risk-gates'}>
            Risk Gates
          </button>
          <button type="button" onClick={() => setPage('decisions')} aria-current={page === 'decisions'}>
            Decisions
          </button>
        </nav>

        {page === 'overview' ? (
          <Overview
            health={health}
            metrics={metrics}
            slo={slo}
            allowlist={allowlist}
            incidents={incidents}
            expanded={expanded}
            onToggleExpanded={() => setExpanded((prev) => !prev)}
          />
        ) : null}

        {page === 'markets' ? <Markets allowlist={allowlist} /> : null}
        {page === 'incidents' ? <Incidents incidents={incidents} /> : null}
        {page === 'positions' ? <Positions /> : null}
        {page === 'risk-gates' ? <RiskGates /> : null}
        {page === 'decisions' ? <Decisions /> : null}
      </main>
    </div>
  );
}
