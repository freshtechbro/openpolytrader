import { useCallback, useEffect, useState } from 'react';

import { TopNav } from './components/TopNav';
import { useEventStream } from './hooks/useEventStream';
import { OPS_STREAM_URL, opsFetch, opsFetchJson } from './lib/opsClient';
import { INCIDENTS_LIMIT, SLO_REFRESH_MS } from './lib/dashboardConfig';

import {
  Overview,
  type AllowlistEntry,
  type FinalIntent,
  type HealthReport,
  type IntentStrategy,
  type MetricsSnapshot,
  type SloAggregates
} from './pages/Overview';
import { Markets } from './pages/Markets';
import { Incidents } from './pages/Incidents';
import { Positions } from './pages/Positions';
import { RiskGates } from './pages/RiskGates';
import { Decisions } from './pages/Decisions';

type Page = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk-gates' | 'decisions';
type TradingMode = 'off' | 'shadow' | 'paper' | 'live';
const MAX_INTENTS = 120;

function upsertIntent(intents: FinalIntent[], nextIntent: FinalIntent): FinalIntent[] {
  const others = intents.filter((intent) => intent.opportunityId !== nextIntent.opportunityId);
  return [nextIntent, ...others].sort((a, b) => b.gatedAt - a.gatedAt).slice(0, MAX_INTENTS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function inferMarketId(opportunityId?: string, marketId?: string): string | undefined {
  if (marketId) return marketId;
  if (!opportunityId) return undefined;
  const prefix = opportunityId.split(':')[0];
  if (/^0x[0-9a-f]{32,}$/i.test(prefix)) return prefix;
  const match = opportunityId.match(/0x[0-9a-f]{32,}/i);
  return match?.[0];
}

function getMarketQuestion(allowlist: AllowlistEntry[], marketId?: string): string | undefined {
  if (!marketId) return undefined;
  const entry = allowlist.find((item) => item.key === marketId);
  if (!entry || typeof entry.question !== 'string') return undefined;
  const trimmed = entry.question.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIntentStrategy(value: unknown): IntentStrategy | undefined {
  if (value === 'near_zero' || value === 'ev' || value === 'unknown') return value;
  return undefined;
}

function inferIntentStrategy(opportunityId?: string, strategy?: IntentStrategy): IntentStrategy {
  if (strategy && strategy !== 'unknown') return strategy;
  if (!opportunityId) return strategy ?? 'unknown';
  const parts = opportunityId.split(':');
  if (parts[1] === 'yes' || parts[1] === 'no') return 'ev';
  if (Number.isFinite(Number(parts[1])) && Number.isFinite(Number(parts[2]))) return 'near_zero';
  return strategy ?? 'unknown';
}

export function App() {
  const [page, setPage] = useState<Page>('overview');

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [slo, setSlo] = useState<SloAggregates | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [finalIntents, setFinalIntents] = useState<FinalIntent[]>([]);
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
    if (event.type === 'latency') {
      const data = asRecord(event.data);
      if (data && data.stage === 'gated') {
        const opportunityId = asString(data.opportunityId);
        if (opportunityId) {
          const marketId = inferMarketId(opportunityId, asString(data.marketId));
          const strategy = inferIntentStrategy(opportunityId, normalizeIntentStrategy(data.strategy));
          setFinalIntents((prev) => {
            const existing = prev.find((intent) => intent.opportunityId === opportunityId);
            const resolvedMarketId = marketId ?? existing?.marketId;
            const marketQuestion = getMarketQuestion(allowlist, resolvedMarketId) ?? existing?.marketQuestion;
            return upsertIntent(prev, {
              opportunityId,
              marketId: resolvedMarketId,
              marketQuestion,
              strategy,
              gatedAt: event.timestamp,
              executedAt: existing?.executedAt,
              orderStatus: existing?.orderStatus,
              orderReason: existing?.orderReason
            });
          });
        }
      }
    }

    if (event.type === 'order') {
      const data = asRecord(event.data);
      if (data) {
        const state = asRecord(data.state);
        const opportunityId = asString(data.opportunityId) ?? asString(state?.opportunityId);
        if (opportunityId) {
          const marketId = inferMarketId(
            opportunityId,
            asString(data.marketId) ?? asString(state?.marketId)
          );
          const strategy = inferIntentStrategy(
            opportunityId,
            normalizeIntentStrategy(data.strategy) ?? normalizeIntentStrategy(state?.strategy)
          );
          const orderStatus = asString(data.status);
          const orderReason = asString(data.reason);
          setFinalIntents((prev) => {
            const existing = prev.find((intent) => intent.opportunityId === opportunityId);
            const resolvedMarketId = marketId ?? existing?.marketId;
            const marketQuestion = getMarketQuestion(allowlist, resolvedMarketId) ?? existing?.marketQuestion;
            return upsertIntent(prev, {
              opportunityId,
              marketId: resolvedMarketId,
              marketQuestion,
              strategy,
              gatedAt: existing?.gatedAt ?? event.timestamp,
              executedAt: orderStatus === 'submitted' ? event.timestamp : existing?.executedAt,
              orderStatus: orderStatus ?? existing?.orderStatus,
              orderReason: orderReason ?? existing?.orderReason
            });
          });
        }
      }
    }

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
    if (allowlist.length === 0) return;
    setFinalIntents((prev) => {
      let changed = false;
      const next = prev.map((intent) => {
        const resolvedMarketId = inferMarketId(intent.opportunityId, intent.marketId);
        const marketQuestion = getMarketQuestion(allowlist, resolvedMarketId);
        const strategy = inferIntentStrategy(intent.opportunityId, intent.strategy);
        if (
          !marketQuestion &&
          strategy === intent.strategy &&
          resolvedMarketId === intent.marketId
        ) {
          return intent;
        }
        const nextQuestion = marketQuestion ?? intent.marketQuestion;
        if (nextQuestion === intent.marketQuestion && strategy === intent.strategy && resolvedMarketId === intent.marketId) {
          return intent;
        }
        changed = true;
        return {
          ...intent,
          marketId: resolvedMarketId,
          marketQuestion: nextQuestion,
          strategy
        };
      });
      return changed ? next : prev;
    });
  }, [allowlist, finalIntents]);

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
            intents={finalIntents}
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
