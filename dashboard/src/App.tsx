import { useEffect, useState } from 'react';

import { TopNav } from './components/TopNav';
import { useEventStream } from './hooks/useEventStream';

import { Overview, type AllowlistEntry, type HealthReport, type MetricsSnapshot } from './pages/Overview';
import { Markets } from './pages/Markets';
import { Incidents } from './pages/Incidents';
import { Positions } from './pages/Positions';
import { RiskGates } from './pages/RiskGates';

type Page = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk-gates';

const OPS_BASE = import.meta.env.VITE_OPS_BASE_URL ?? 'http://localhost:3000';
const OPS_TOKEN = (import.meta.env.VITE_OPS_API_TOKEN as string | undefined)?.trim();
const OPS_HEADERS = OPS_TOKEN ? { Authorization: `Bearer ${OPS_TOKEN}` } : undefined;
const OPS_STREAM_URL = OPS_TOKEN
  ? `${OPS_BASE}/stream?token=${encodeURIComponent(OPS_TOKEN)}`
  : `${OPS_BASE}/stream`;

function opsFetch(path: string) {
  return fetch(`${OPS_BASE}${path}`, OPS_HEADERS ? { headers: OPS_HEADERS } : undefined);
}

export function App() {
  const [page, setPage] = useState<Page>('overview');

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [expanded, setExpanded] = useState(false);

  const [streamEvents] = useEventStream(OPS_STREAM_URL, (event) => {
    if (event.type === 'health') {
      setHealth(event.data);
    }
    if (event.type === 'incident') {
      setIncidents((prev) => [event.data, ...prev].slice(0, 20));
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
    void opsFetch('/allowlist')
      .then(async (res) => setAllowlist(await res.json()))
      .catch(() => {});
    void opsFetch('/incidents')
      .then(async (res) => setIncidents(await res.json()))
      .catch(() => {});
  }, []);

  return (
    <div className="app">
      <TopNav
        title="OpenPolyTrader Ops"
        subtitle="Near-risk-free monitoring console"
        status={health?.status ?? 'degraded'}
        streamConnected={streamEvents.connected}
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
