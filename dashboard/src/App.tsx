import { useEffect, useState } from 'react';

import { TopNav } from './components/TopNav';
import { useEventStream } from './hooks/useEventStream';
import { OPS_STREAM_URL, opsFetch } from './lib/opsClient';
import { INCIDENTS_LIMIT, SLO_REFRESH_MS } from './lib/dashboardConfig';

import { Overview, type AllowlistEntry, type HealthReport, type MetricsSnapshot, type SloAggregates } from './pages/Overview';
import { Markets } from './pages/Markets';
import { Incidents } from './pages/Incidents';
import { Positions } from './pages/Positions';
import { RiskGates } from './pages/RiskGates';

type Page = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk-gates';
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

  const [streamEvents] = useEventStream(OPS_STREAM_URL, (event) => {
    if (event.type === 'health') {
      setHealth(event.data);
    }
    if (event.type === 'incident') {
      setIncidents((prev) => [event.data, ...prev].slice(0, INCIDENTS_LIMIT));
    }
    if (event.type === 'info' || event.type === 'risk' || event.type === 'order' || event.type === 'fill') {
      void opsFetch('/metrics')
        .then(async (res) => setMetrics(await res.json()))
        .catch(() => {});
    }
  });

  useEffect(() => {
    void opsFetch('/health')
      .then(async (res) => setHealth(await res.json()))
      .catch(() => {});
    void opsFetch('/metrics')
      .then(async (res) => setMetrics(await res.json()))
      .catch(() => {});
    void opsFetch('/slo')
      .then(async (res) => setSlo(await res.json()))
      .catch(() => {});
    void opsFetch('/allowlist')
      .then(async (res) => setAllowlist(await res.json()))
      .catch(() => {});
    void opsFetch('/incidents')
      .then(async (res) => {
        const data = await res.json();
        if (Array.isArray(data)) {
          setIncidents(data.slice(0, INCIDENTS_LIMIT));
          return;
        }
        setIncidents([]);
      })
      .catch(() => {});
    void opsFetch('/config')
      .then(async (res) => {
        const data = await res.json();
        if (data && !data.error) {
          setTradingMode(data.tradingMode ?? null);
          setTradingEnabled(data.tradingEnabled ?? null);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void opsFetch('/slo')
        .then(async (res) => setSlo(await res.json()))
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
      </main>
    </div>
  );
}
