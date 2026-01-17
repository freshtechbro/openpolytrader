import { useCallback, useEffect, useState } from 'react';

import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable } from '../components/MetricsTable';
import { useEventStream, StreamEvent } from '../hooks/useEventStream';
import { opsFetchJson, OPS_STREAM_URL } from '../lib/opsClient';

import type { AllowlistEntry } from './Overview';

interface EnrichedMarketEntry extends AllowlistEntry {
  question: string | null;
  description: string | null;
}

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
                <span style={{ fontSize: 11, opacity: 0.6 }}>
                  Updated {lastUpdate.toLocaleTimeString()}
                </span>
              )}
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
            <MetricsTable
              columns={['Market', 'Question', 'Status', 'Until', 'Reason']}
              rows={markets.map((entry: EnrichedMarketEntry) => [
                entry.key.slice(0, 12) + '…',
                entry.question ?? '(loading...)',
                entry.entry.status,
                entry.entry.until ? new Date(entry.entry.until).toLocaleString() : '-',
                entry.entry.reason ?? '-'
              ])}
            />
          }
        />
      </Section>
    </>
  );
}
