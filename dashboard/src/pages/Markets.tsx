import { useCallback, useEffect, useMemo, useState } from 'react';

import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable, type TableRow } from '../components/MetricsTable';
import { useEventStream, StreamEvent } from '../hooks/useEventStream';
import { getOpsStreamUrl, opsFetchJson } from '../lib/opsClient';
import { STREAM_OFFLINE_DEBOUNCE_MS } from '../lib/dashboardConfig';

import type { AllowlistEntry } from './Overview';

interface EnrichedMarketEntry extends AllowlistEntry {
  question: string | null;
  description: string | null;
}

const MARKETS_PREVIEW_LIMIT = 30;

type MarketsStreamBadgeState = 'connecting' | 'live' | 'offline';

const STREAM_BADGE_META: Record<
  MarketsStreamBadgeState,
  { label: string; background: string; color: string; dot: string }
> = {
  connecting: {
    label: 'Connecting',
    background: 'var(--bg-muted)',
    color: 'var(--ink-light)',
    dot: 'var(--ink-light)'
  },
  live: {
    label: 'Live',
    background: 'var(--signal-soft)',
    color: 'var(--signal)',
    dot: 'var(--signal)'
  },
  offline: {
    label: 'Offline',
    background: 'var(--alert-soft)',
    color: 'var(--alert)',
    dot: 'var(--alert)'
  }
};

export function Markets({ allowlist: initialAllowlist }: { allowlist: AllowlistEntry[] }) {
  const [markets, setMarkets] = useState<EnrichedMarketEntry[]>(
    initialAllowlist.map((e) => ({
      ...e,
      question: e.question ?? null,
      description: e.description ?? null
    }))
  );
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [hasInitialFetchSettled, setHasInitialFetchSettled] = useState(false);
  const [streamOfflineDebounced, setStreamOfflineDebounced] = useState(false);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await opsFetchJson<EnrichedMarketEntry[]>('/markets');
      setMarkets(data);
      setLastUpdate(new Date());
    } catch {
      // Keep existing market rows when refresh fails.
    } finally {
      setLoading(false);
      setHasInitialFetchSettled(true);
    }
  }, []);

  useEffect(() => {
    void fetchMarkets();
  }, [fetchMarkets]);

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'allowlist_updated') {
      void fetchMarkets();
    }
  }, [fetchMarkets]);

  const [{ connected }] = useEventStream(getOpsStreamUrl(), handleStreamEvent);

  useEffect(() => {
    if (connected) {
      setStreamOfflineDebounced(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setStreamOfflineDebounced(true);
    }, STREAM_OFFLINE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [connected]);

  const streamBadgeState = useMemo<MarketsStreamBadgeState>(() => {
    if (!hasInitialFetchSettled) return 'connecting';
    if (connected) return 'live';
    return streamOfflineDebounced ? 'offline' : 'connecting';
  }, [hasInitialFetchSettled, connected, streamOfflineDebounced]);
  const streamBadgeMeta = STREAM_BADGE_META[streamBadgeState];

  const visibleMarkets = useMemo(
    () => (showAllMarkets ? markets : markets.slice(0, MARKETS_PREVIEW_LIMIT)),
    [markets, showAllMarkets]
  );
  const marketRows = useMemo<TableRow[]>(() => {
    return visibleMarkets.map((entry) => {
      const marketLabel = `${entry.key.slice(0, 12)}…`;
      const question = entry.question ?? '(loading...)';
      const status = entry.entry.status;
      const until = entry.entry.until ? new Date(entry.entry.until).toLocaleString() : '-';
      const reason = entry.entry.reason ?? '-';
      return {
        key: entry.key,
        cellClassNames: [
          'market-cell',
          'market-cell',
          'market-cell',
          'market-cell',
          'market-cell'
        ],
        cells: [
          <span className="market-cell-content market-cell-content--id" title={entry.key}>{marketLabel}</span>,
          <span className="market-cell-content market-cell-content--question" title={question}>{question}</span>,
          <span className="market-cell-content" title={status}>{status}</span>,
          <span className="market-cell-content market-cell-content--time" title={until}>{until}</span>,
          <span className="market-cell-content market-cell-content--reason" title={reason}>{reason}</span>
        ]
      };
    });
  }, [visibleMarkets]);

  return (
    <>
      <Section
        title="Markets"
        subtitle="Current allowlist/quarantine view. Phase 1 markets are sourced from the market catalog."
      >
        <Panel
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>Allowlist</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 8px',
                  borderRadius: 10,
                  fontSize: 11,
                  fontWeight: 600,
                  background: streamBadgeMeta.background,
                  color: streamBadgeMeta.color
                }}
                aria-live="polite"
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: streamBadgeMeta.dot
                  }}
                />
                {streamBadgeMeta.label}
              </span>
              {lastUpdate && (
                <span style={{ fontSize: 11, opacity: 0.6 }} aria-live="polite">
                  Updated {lastUpdate.toLocaleTimeString()}
                </span>
              )}
              {markets.length > MARKETS_PREVIEW_LIMIT ? (
                <button
                  type="button"
                  onClick={() => setShowAllMarkets((prev) => !prev)}
                  style={{ fontSize: 12, padding: '4px 8px' }}
                >
                  {showAllMarkets ? 'Show less' : 'Show all'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={fetchMarkets}
                disabled={loading}
                style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 8px' }}
              >
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          }
          body={
            <>
              <MetricsTable
                className="markets-table"
                ariaLabel="Markets table"
                columnClassNames={[
                  'markets-col-id',
                  'markets-col-question',
                  'markets-col-status',
                  'markets-col-until',
                  'markets-col-reason'
                ]}
                columns={['Market', 'Question', 'Status', 'Until', 'Reason']}
                rows={marketRows}
              />
              {markets.length > MARKETS_PREVIEW_LIMIT ? (
                <div className="table-meta">
                  <span>
                    Showing {visibleMarkets.length} of {markets.length}
                  </span>
                </div>
              ) : null}
            </>
          }
        />
      </Section>
    </>
  );
}
