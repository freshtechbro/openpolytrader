import { useCallback, useEffect, useMemo, useState } from 'react';

import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable, type TableRow } from '../components/MetricsTable';
import { useEventStream, StreamEvent } from '../hooks/useEventStream';
import { opsFetchJson, OPS_STREAM_URL } from '../lib/opsClient';

import type { AllowlistEntry } from './Overview';

interface EnrichedMarketEntry extends AllowlistEntry {
  question: string | null;
  description: string | null;
}

const MARKETS_PREVIEW_LIMIT = 30;

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

  useEffect(() => {
    fetchMarkets();
  }, []);

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await opsFetchJson<EnrichedMarketEntry[]>('/markets');
      setMarkets(data);
      setLastUpdate(new Date());
    } catch {
      setLoading(false);
      return;
    }
    setLoading(false);
  }, []);

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'allowlist_updated') {
      fetchMarkets();
    }
  }, [fetchMarkets]);

  const [{ connected }] = useEventStream(OPS_STREAM_URL, handleStreamEvent);
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
                  background: connected ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: connected ? '#22c55e' : '#ef4444'
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: connected ? '#22c55e' : '#ef4444'
                  }}
                />
                {connected ? 'Live' : 'Offline'}
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
