import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';

import { TopNav } from '../components/TopNav';
import { useEventStream } from '../hooks/useEventStream';
import {
  OPS_STREAM_URL,
  clearOpsSession,
  createOpsSession,
  getOpsSession,
  isOpsUnauthorizedError,
  opsFetch,
  opsFetchJson
} from '../lib/opsClient';
import { INCIDENTS_LIMIT, SLO_REFRESH_MS } from '../lib/dashboardConfig';
import {
  Overview,
  type AllowlistEntry,
  type FinalIntent,
  type HealthReport,
  type IntentStrategy,
  type MetricsSnapshot,
  type SloAggregates
} from '../pages/Overview';
import { Markets } from '../pages/Markets';
import { Incidents } from '../pages/Incidents';
import { Positions } from '../pages/Positions';
import { RiskGates } from '../pages/RiskGates';
import { Decisions } from '../pages/Decisions';

type OpsPage = 'overview' | 'markets' | 'incidents' | 'positions' | 'risk' | 'decisions';
type TradingMode = 'off' | 'shadow' | 'paper' | 'live';

const MAX_INTENTS = 120;
const DEFAULT_OPS_PAGE: OpsPage = 'overview';

const OPS_PATHS: Array<{ page: OpsPage; to: string; label: string }> = [
  { page: 'overview', to: '/ops/overview', label: 'Overview' },
  { page: 'markets', to: '/ops/markets', label: 'Markets' },
  { page: 'incidents', to: '/ops/incidents', label: 'Incidents' },
  { page: 'positions', to: '/ops/positions', label: 'Positions' },
  { page: 'risk', to: '/ops/risk', label: 'Risk' },
  { page: 'decisions', to: '/ops/decisions', label: 'Decisions' }
];

interface SessionState {
  checking: boolean;
  authenticated: boolean;
  authRequired: boolean;
  error: string | null;
}

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

function resolveOpsPage(pathname: string): OpsPage {
  const segments = pathname.split('/').filter(Boolean);
  const value = segments[1] ?? DEFAULT_OPS_PAGE;
  if (value === 'risk-gates') return 'risk';
  if (value === 'overview' || value === 'markets' || value === 'incidents' || value === 'positions' || value === 'risk' || value === 'decisions') {
    return value;
  }
  return DEFAULT_OPS_PAGE;
}

function canonicalOpsPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '/ops/overview';
  const page = resolveOpsPage(pathname);
  return `/ops/${page}`;
}

export function OpsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState>({
    checking: true,
    authenticated: false,
    authRequired: true,
    error: null
  });
  const [loginToken, setLoginToken] = useState('');
  const [loginState, setLoginState] = useState<{ submitting: boolean; error: string | null }>({
    submitting: false,
    error: null
  });

  const [health, setHealth] = useState<HealthReport | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [slo, setSlo] = useState<SloAggregates | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [finalIntents, setFinalIntents] = useState<FinalIntent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [tradingMode, setTradingMode] = useState<TradingMode | null>(null);
  const [tradingEnabled, setTradingEnabled] = useState<boolean | null>(null);

  const allowlistRef = useRef<AllowlistEntry[]>([]);

  const currentPage = resolveOpsPage(location.pathname);

  const handleUnauthorized = useCallback(() => {
    setSession({
      checking: false,
      authenticated: false,
      authRequired: true,
      error: null
    });
    setFinalIntents([]);
    setIncidents([]);
  }, []);

  const refreshSession = useCallback(async () => {
    setSession((prev) => ({ ...prev, checking: true, error: null }));
    try {
      const response = await getOpsSession({ prefill: true });
      setLoginToken((prev) => (prev.trim().length > 0 ? prev : response.prefillToken ?? ''));
      setSession({
        checking: false,
        authenticated: response.authenticated,
        authRequired: response.authRequired,
        error: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Session check failed';
      setSession({
        checking: false,
        authenticated: false,
        authRequired: true,
        error: message
      });
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    const target = canonicalOpsPath(location.pathname);
    if (target !== location.pathname) {
      navigate(target, { replace: true });
    }
  }, [location.pathname, navigate]);

  const fetchAllowlist = useCallback(async () => {
    try {
      const data = await opsFetchJson<unknown>('/markets');
      if (Array.isArray(data)) {
        setAllowlist(data as AllowlistEntry[]);
        return;
      }
      setAllowlist([]);
    } catch (error) {
      if (isOpsUnauthorizedError(error)) {
        handleUnauthorized();
      }
      setAllowlist([]);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    allowlistRef.current = allowlist;
  }, [allowlist]);

  const handleStreamEvent = useCallback(
    (event: { type: string; data: unknown; timestamp: number }) => {
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
              const marketQuestion =
                getMarketQuestion(allowlistRef.current, resolvedMarketId) ?? existing?.marketQuestion;
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
              const marketQuestion =
                getMarketQuestion(allowlistRef.current, resolvedMarketId) ?? existing?.marketQuestion;
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
        setHealth(event.data as HealthReport);
      }
      if (event.type === 'incident') {
        setIncidents((prev) => [event.data, ...prev].slice(0, INCIDENTS_LIMIT));
      }
      if (event.type === 'allowlist_updated') {
        void fetchAllowlist();
      }
      if (event.type === 'trading_mode_changed') {
        const state = asRecord(asRecord(event.data)?.state);
        const mode = asString(state?.mode);
        if (mode === 'off' || mode === 'shadow' || mode === 'paper' || mode === 'live') {
          setTradingMode(mode);
        }
      }
      if (event.type === 'trading_enabled_changed') {
        const state = asRecord(asRecord(event.data)?.state);
        if (typeof state?.enabled === 'boolean') {
          setTradingEnabled(state.enabled);
        }
      }
      if (event.type === 'info' || event.type === 'risk' || event.type === 'order' || event.type === 'fill') {
        void opsFetchJson<MetricsSnapshot>('/metrics')
          .then((data) => setMetrics(data))
          .catch((error) => {
            if (isOpsUnauthorizedError(error)) {
              handleUnauthorized();
            }
          });
      }
    },
    [fetchAllowlist, handleUnauthorized]
  );

  const [streamEvents] = useEventStream(session.authenticated ? OPS_STREAM_URL : null, handleStreamEvent);

  useEffect(() => {
    if (!session.authenticated) return;

    void opsFetchJson<HealthReport>('/health')
      .then((data) => setHealth(data))
      .catch((error) => {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      });
    void opsFetchJson<MetricsSnapshot>('/metrics')
      .then((data) => setMetrics(data))
      .catch((error) => {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      });
    void opsFetchJson<SloAggregates>('/slo')
      .then((data) => setSlo(data))
      .catch((error) => {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      });
    void fetchAllowlist();
    void opsFetchJson<unknown>('/incidents')
      .then((data) => setIncidents(Array.isArray(data) ? data.slice(0, INCIDENTS_LIMIT) : []))
      .catch((error) => {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      });
    void opsFetchJson<unknown>('/config')
      .then((data) => {
        if (data && typeof data === 'object' && !('error' in data)) {
          const record = data as Record<string, unknown>;
          setTradingMode(typeof record.tradingMode === 'string' ? (record.tradingMode as TradingMode) : null);
          setTradingEnabled(typeof record.tradingEnabled === 'boolean' ? record.tradingEnabled : null);
        }
      })
      .catch((error) => {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      });
  }, [fetchAllowlist, handleUnauthorized, session.authenticated]);

  useEffect(() => {
    if (!session.authenticated) return;

    setFinalIntents((prev) => {
      let changed = false;
      const next = prev.map((intent) => {
        const resolvedMarketId = inferMarketId(intent.opportunityId, intent.marketId);
        const marketQuestion = getMarketQuestion(allowlist, resolvedMarketId);
        const strategy = inferIntentStrategy(intent.opportunityId, intent.strategy);
        if (!marketQuestion && strategy === intent.strategy && resolvedMarketId === intent.marketId) {
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
  }, [allowlist, session.authenticated]);

  useEffect(() => {
    if (!session.authenticated) return;

    const timer = setInterval(() => {
      void opsFetchJson<SloAggregates>('/slo')
        .then((data) => setSlo(data))
        .catch((error) => {
          if (isOpsUnauthorizedError(error)) {
            handleUnauthorized();
          }
        });
    }, SLO_REFRESH_MS);

    return () => clearInterval(timer);
  }, [handleUnauthorized, session.authenticated]);

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginState({ submitting: true, error: null });
    try {
      await createOpsSession(loginToken.trim());
      const verified = await getOpsSession();
      if (!verified.authenticated) {
        setSession({
          checking: false,
          authenticated: false,
          authRequired: true,
          error: null
        });
        setLoginState({
          submitting: false,
          error: 'Session was not established. Ensure the dashboard and API use the same host (localhost vs 127.0.0.1) and retry.'
        });
        return;
      }

      setLoginToken('');
      setSession({
        checking: false,
        authenticated: verified.authenticated,
        authRequired: verified.authRequired,
        error: null
      });
      setLoginState({ submitting: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      setLoginState({ submitting: false, error: message });
    }
  };

  const handleLogout = async () => {
    await clearOpsSession().catch(() => {});
    setSession({
      checking: false,
      authenticated: false,
      authRequired: true,
      error: null
    });
    setFinalIntents([]);
    setIncidents([]);
  };

  const content = useMemo(() => {
    if (currentPage === 'markets') return <Markets allowlist={allowlist} />;
    if (currentPage === 'incidents') return <Incidents incidents={incidents} />;
    if (currentPage === 'positions') return <Positions />;
    if (currentPage === 'risk') return <RiskGates />;
    if (currentPage === 'decisions') return <Decisions />;
    return (
      <Overview
        health={health}
        metrics={metrics}
        slo={slo}
        intents={finalIntents}
        incidents={incidents}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((prev) => !prev)}
      />
    );
  }, [allowlist, currentPage, expanded, finalIntents, health, incidents, metrics, slo]);

  if (session.checking) {
    return (
      <div className="app app--ops">
        <main className="ops-auth">
          <section className="ops-auth__card">
            <p className="hero__eyebrow">Ops Session</p>
            <h1>Checking operator session…</h1>
            <p className="hero__lead">Verifying runtime auth state before loading live feeds.</p>
          </section>
        </main>
      </div>
    );
  }

  if (!session.authenticated) {
    return (
      <div className="app app--ops">
        <main className="ops-auth">
          <section className="ops-auth__card">
            <p className="hero__eyebrow">Authenticated Surface</p>
            <h1>Operator sign in</h1>
            <p className="hero__lead">
              Enter your ops token to start a runtime session. The token is never embedded in the dashboard bundle.
            </p>
            {session.error ? <p className="ops-auth__error">{session.error}</p> : null}
            {session.authRequired ? (
              <form className="ops-auth__form" onSubmit={handleLoginSubmit}>
                <label htmlFor="ops-token">Ops token</label>
                <input
                  id="ops-token"
                  name="ops-token"
                  type="password"
                  autoComplete="off"
                  value={loginToken}
                  onChange={(event) => setLoginToken(event.target.value)}
                  required
                />
                <button type="submit" disabled={loginState.submitting || loginToken.trim().length === 0}>
                  {loginState.submitting ? 'Signing in…' : 'Next'}
                </button>
                {loginState.error ? <p className="ops-auth__error">{loginState.error}</p> : null}
              </form>
            ) : (
              <button type="button" onClick={() => void refreshSession()}>
                Retry
              </button>
            )}
            <p className="ops-auth__links">
              <NavLink to="/">Back to landing</NavLink>
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app app--ops">
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
          if (res.status === 401) {
            handleUnauthorized();
            return;
          }
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
          if (res.status === 401) {
            handleUnauthorized();
            return;
          }
          if (res.ok) {
            setTradingEnabled(enabled);
          }
        }}
      />
      <div className="ops-shell">
        <aside className="ops-shell__nav">
          <nav aria-label="Ops navigation" className="ops-nav">
            {OPS_PATHS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => (isActive ? 'ops-nav__link ops-nav__link--active' : 'ops-nav__link')}
                end
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ops-shell__actions">
            <Link to="/" className="ops-shell__landing-link">
              Landing
            </Link>
            <button type="button" className="ops-shell__logout" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="ops-shell__main">{content}</main>
      </div>
    </div>
  );
}
