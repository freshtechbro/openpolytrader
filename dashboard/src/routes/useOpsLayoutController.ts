import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OpsConfigSnapshot } from '../../../src/api/contracts.js';
import type { TopNavStreamState } from '../components/TopNav';
import { useEventStream, type StreamEvent } from '../hooks/useEventStream';
import {
  clearOpsAuthToken,
  clearOpsSession,
  createOpsSession,
  getOpsSession,
  getOpsStreamUrl,
  isOpsUnauthorizedError,
  opsFetchJson,
  setOpsAuthToken
} from '../lib/opsClient';
import { INCIDENTS_LIMIT, SLO_REFRESH_MS, STREAM_OFFLINE_DEBOUNCE_MS } from '../lib/dashboardConfig';
import type {
  AllowlistEntry,
  HealthReport,
  MetricsSnapshot,
  SloAggregates
} from '../pages/Overview';
import {
  LOGOUT_FAILURE_MESSAGE,
  type TradingMode
} from './opsLayoutUtils';
import type { SessionState } from './OpsAuthView';
import {
  asAllowlist,
  asIncidents,
  asTradingMode,
  createSessionState,
  getStreamState,
  reconcileIntentMetadata,
  shouldRefreshMetrics,
  syncLatencyIntent,
  syncOrderIntent,
  toLiveDecision
} from './opsLayoutControllerSupport';

interface LoginState {
  submitting: boolean;
  error: string | null;
}

const LOGIN_HOST_MISMATCH_MESSAGE =
  'Session was not established. Ensure the dashboard and API use the same host (localhost vs 127.0.0.1) and retry.';

export function useOpsLayoutController() {
  const [session, setSession] = useState<SessionState>({
    checking: true,
    authenticated: false,
    authRequired: true,
    error: null
  });
  const [loginToken, setLoginToken] = useState('');
  const [loginState, setLoginState] = useState<LoginState>({
    submitting: false,
    error: null
  });
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [slo, setSlo] = useState<SloAggregates | null>(null);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [incidents, setIncidents] = useState<OpsIncident[]>([]);
  const [finalIntents, setFinalIntents] = useState<FinalIntent[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [tradingMode, setTradingMode] = useState<TradingMode | null>(null);
  const [tradingEnabled, setTradingEnabled] = useState<boolean | null>(null);
  const [allowlistBootstrapSettled, setAllowlistBootstrapSettled] = useState(false);
  const [streamOfflineDebounced, setStreamOfflineDebounced] = useState(false);
  const allowlistRef = useRef<AllowlistEntry[]>([]);

  const resetUnauthenticatedSession = useCallback((error: string | null) => {
    clearOpsAuthToken();
    setSession({
      checking: false,
      authenticated: false,
      authRequired: true,
      error
    });
    setAllowlistBootstrapSettled(false);
    setStreamOfflineDebounced(false);
    setFinalIntents([]);
    setIncidents([]);
  }, []);

  const handleUnauthorized = useCallback(() => {
    resetUnauthenticatedSession(null);
  }, [resetUnauthenticatedSession]);

  const runProtectedRequest = useCallback(
    async <T,>(request: () => Promise<T>, onSuccess: (data: T) => void) => {
      try {
        onSuccess(await request());
      } catch (error) {
        if (isOpsUnauthorizedError(error)) {
          handleUnauthorized();
        }
      }
    },
    [handleUnauthorized]
  );

  const refreshSession = useCallback(async () => {
    setSession((prev) => ({ ...prev, checking: true, error: null }));
    try {
      const response = await getOpsSession({ prefill: true });
      const prefillToken = response.prefillToken?.trim() ?? '';
      if (prefillToken) {
        setOpsAuthToken(prefillToken);
      } else {
        clearOpsAuthToken();
      }
      setLoginToken((prev) => (prev.trim() ? prev : prefillToken));

      if (!response.authenticated && response.authRequired && prefillToken) {
        const verified = await getOpsSession();
        if (verified.authenticated) {
          setLoginToken('');
          setSession(createSessionState(true, verified.authRequired));
          return;
        }
      }

      setSession(createSessionState(response.authenticated, response.authRequired));
    } catch (error) {
      resetUnauthenticatedSession(error instanceof Error ? error.message : 'Session check failed');
    }
  }, [resetUnauthenticatedSession]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const fetchAllowlist = useCallback(async () => {
    try {
      setAllowlist(asAllowlist(await opsFetchJson('/markets')));
    } catch (error) {
      if (isOpsUnauthorizedError(error)) {
        handleUnauthorized();
      }
      setAllowlist([]);
    } finally {
      setAllowlistBootstrapSettled(true);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    allowlistRef.current = allowlist;
  }, [allowlist]);

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      const latencyIntent = toLiveDecision(event, '', '');
      if (latencyIntent) {
        setFinalIntents((prev) => syncLatencyIntent(prev, latencyIntent, allowlistRef.current));
      }

      if (event.type === 'order') {
        setFinalIntents((prev) => syncOrderIntent(prev, event, allowlistRef.current));
      }

      if (event.type === 'health') {
        setHealth(event.data as HealthReport);
      }
      if (event.type === 'incident') {
        setIncidents((prev) => [event.data as OpsIncident, ...prev].slice(0, INCIDENTS_LIMIT));
      }
      if (event.type === 'allowlist_updated') {
        void fetchAllowlist();
      }
      if (event.type === 'trading_mode_changed') {
        const mode = asTradingMode(getStreamState(event)?.mode);
        if (mode) {
          setTradingMode(mode);
        }
      }
      if (event.type === 'trading_enabled_changed') {
        const enabled = getStreamState(event)?.enabled;
        if (typeof enabled === 'boolean') {
          setTradingEnabled(enabled);
        }
      }
      if (shouldRefreshMetrics(event)) {
        void runProtectedRequest(() => opsFetchJson<MetricsSnapshot>('/metrics'), setMetrics);
      }
    },
    [fetchAllowlist, runProtectedRequest]
  );

  const [streamEvents] = useEventStream(session.authenticated ? getOpsStreamUrl() : null, handleStreamEvent);

  useEffect(() => {
    if (!session.authenticated) {
      setAllowlistBootstrapSettled(false);
    }
  }, [session.authenticated]);

  useEffect(() => {
    if (!session.authenticated) {
      setStreamOfflineDebounced(false);
      return;
    }
    if (streamEvents.connected) {
      setStreamOfflineDebounced(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setStreamOfflineDebounced(true);
    }, STREAM_OFFLINE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [session.authenticated, streamEvents.connected]);

  const topNavStreamState = useMemo<TopNavStreamState>(() => {
    if (!session.authenticated || !allowlistBootstrapSettled) return 'connecting';
    if (streamEvents.connected) return 'live';
    return streamOfflineDebounced ? 'offline' : 'connecting';
  }, [allowlistBootstrapSettled, session.authenticated, streamEvents.connected, streamOfflineDebounced]);

  useEffect(() => {
    if (!session.authenticated) return;

    void runProtectedRequest(() => opsFetchJson<HealthReport>('/health'), setHealth);
    void runProtectedRequest(() => opsFetchJson<MetricsSnapshot>('/metrics'), setMetrics);
    void runProtectedRequest(() => opsFetchJson<SloAggregates>('/slo'), setSlo);
    void fetchAllowlist();
    void runProtectedRequest(() => opsFetchJson('/incidents'), (data) =>
      setIncidents(asIncidents(data).slice(0, INCIDENTS_LIMIT))
    );
    void runProtectedRequest(() => opsFetchJson<OpsConfigSnapshot>('/config'), (data) => {
      setTradingMode(asTradingMode(data.tradingMode));
      setTradingEnabled(typeof data.tradingEnabled === 'boolean' ? data.tradingEnabled : null);
    });
  }, [fetchAllowlist, runProtectedRequest, session.authenticated]);

  useEffect(() => {
    if (!session.authenticated) return;

    setFinalIntents((prev) => reconcileIntentMetadata(prev, allowlist));
  }, [allowlist, session.authenticated]);

  useEffect(() => {
    if (!session.authenticated) return;

    const timer = setInterval(() => {
      void runProtectedRequest(() => opsFetchJson<SloAggregates>('/slo'), setSlo);
    }, SLO_REFRESH_MS);

    return () => clearInterval(timer);
  }, [runProtectedRequest, session.authenticated]);

  const handleLoginSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginState({ submitting: true, error: null });
    try {
      const token = loginToken.trim();
      setOpsAuthToken(token);
      await createOpsSession(token);
      const verified = await getOpsSession();
      if (!verified.authenticated) {
        clearOpsAuthToken();
        setSession(createSessionState(false, true));
        setLoginState({
          submitting: false,
          error: LOGIN_HOST_MISMATCH_MESSAGE
        });
        return;
      }

      setLoginToken('');
      setSession(createSessionState(verified.authenticated, verified.authRequired));
      setLoginState({ submitting: false, error: null });
    } catch (error) {
      clearOpsAuthToken();
      setLoginState({
        submitting: false,
        error: error instanceof Error ? error.message : 'Login failed'
      });
    }
  };

  const handleLogout = async () => {
    try {
      await clearOpsSession();
      resetUnauthenticatedSession(null);
    } catch {
      resetUnauthenticatedSession(LOGOUT_FAILURE_MESSAGE);
    }
  };

  return {
    session,
    loginToken,
    loginState,
    health,
    metrics,
    slo,
    allowlist,
    incidents,
    finalIntents,
    expanded,
    tradingMode,
    tradingEnabled,
    topNavStreamState,
    setLoginToken,
    setTradingMode,
    setTradingEnabled,
    toggleExpanded: () => setExpanded((prev) => !prev),
    handleUnauthorized,
    handleLoginSubmit,
    handleLogout,
    refreshSession
  };
}
