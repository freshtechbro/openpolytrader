import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MetricsTable } from '../components/MetricsTable';
import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { useEventStream, StreamEvent } from '../hooks/useEventStream';
import { opsFetchJson, OPS_STREAM_URL } from '../lib/opsClient';

interface StoredDecision {
  id: string;
  subjectId: string;
  timestamp: number;
  agent: string;
  decision: unknown;
  reasoning: unknown;
}

type DecisionsResponse = StoredDecision[] | { error?: string; message?: string };

type DecisionSource = 'persisted' | 'live';

interface DecisionRow extends StoredDecision {
  key: string;
  source: DecisionSource;
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(value);
  }
}

function stringifyPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return error instanceof Error ? error.message : String(value);
  }
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(maxLen - 1, 0))}…`;
}

function asMs(value: string): number | null {
  if (value.trim().length === 0) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function getDecisionTask(decision: unknown): string {
  if (!decision || typeof decision !== 'object') return '';
  const record = decision as { task?: unknown };
  return typeof record.task === 'string' ? record.task : '';
}

function getDecisionKey(row: { agent: string; subjectId: string; timestamp: number; decision: unknown }): string {
  const task = getDecisionTask(row.decision);
  return `${row.agent}::${row.subjectId}::${row.timestamp}::${task}`;
}

function toDecisionRow(row: StoredDecision, source: DecisionSource): DecisionRow {
  return {
    ...row,
    key: getDecisionKey(row),
    source
  };
}

function mergeDecisions(existing: DecisionRow[], incoming: DecisionRow[], limit: number): DecisionRow[] {
  const merged = new Map<string, DecisionRow>();
  for (const row of existing) merged.set(row.key, row);

  for (const row of incoming) {
    const prev = merged.get(row.key);
    if (!prev || (prev.source === 'live' && row.source === 'persisted')) {
      merged.set(row.key, row);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function Decisions() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [agent, setAgent] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [limit, setLimit] = useState('200');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [newDecisionKeys, setNewDecisionKeys] = useState<Set<string>>(new Set());
  const decisionsRef = useRef<DecisionRow[]>([]);

  useEffect(() => {
    decisionsRef.current = decisions;
  }, [decisions]);

  const handleLiveDecision = useCallback((event: StreamEvent) => {
    if (!liveEnabled) return;
    if (event.type !== 'llm_decision') return;

    const payload = event.data as { decision?: unknown; reasoning?: unknown };
    if (!payload.decision) return;

    const decisionData = payload.decision as Record<string, unknown>;
    const newDecision: DecisionRow = toDecisionRow({
      id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      subjectId: String(decisionData.subject ?? ''),
      timestamp: event.timestamp,
      agent: String(decisionData.agent ?? 'unknown'),
      decision: payload.decision,
      reasoning: payload.reasoning ?? {}
    }, 'live');

    if (agent.trim() && !newDecision.agent.toLowerCase().includes(agent.toLowerCase())) return;
    if (subjectId.trim() && !newDecision.subjectId.includes(subjectId.trim())) return;

    const maxRows = parseInt(limit) || 200;
    setDecisions((prev) => mergeDecisions(prev, [newDecision], maxRows));
    setNewDecisionKeys((prev) => new Set([...prev, newDecision.key]));

    setTimeout(() => {
      setNewDecisionKeys((prev) => {
        const next = new Set(prev);
        next.delete(newDecision.key);
        return next;
      });
    }, 3000);
  }, [liveEnabled, agent, subjectId, limit]);

  const [{ connected }] = useEventStream(OPS_STREAM_URL, handleLiveDecision);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (agent.trim().length > 0) params.set('agent', agent.trim());
    if (subjectId.trim().length > 0) params.set('subjectId', subjectId.trim());
    if (limit.trim().length > 0) params.set('limit', limit.trim());
    const sinceMs = asMs(since);
    const untilMs = asMs(until);
    if (sinceMs !== null) params.set('sinceMs', String(sinceMs));
    if (untilMs !== null) params.set('untilMs', String(untilMs));
    const raw = params.toString();
    return raw.length > 0 ? `?${raw}` : '';
  }, [agent, subjectId, limit, since, until]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      try {
        const response = await opsFetchJson<DecisionsResponse>(`/decisions${query}`);
        if (!mounted) return;

        if (!Array.isArray(response)) {
          throw new Error(response.message ?? response.error ?? 'Failed to load decisions');
        }

        const maxRows = parseInt(limit) || 200;
        const persistedRows = response.map((row) => toDecisionRow(row, 'persisted'));
        setDecisions((prev) => mergeDecisions(prev, persistedRows, maxRows));
        setSelectedKey((prev) => (prev && persistedRows.some((row) => row.key === prev) ? prev : null));
        setError(null);
      } catch (err) {
        if (!mounted) return;
        setDecisions([]);
        setError(err instanceof Error ? err.message : 'Failed to load decisions');
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    };

    void load();
    return () => {
      mounted = false;
    };
  }, [query, refreshKey]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(null), 1500);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return decisions.find((row) => row.key === selectedKey) ?? null;
  }, [decisions, selectedKey]);

  const rows = useMemo(() => {
    return decisions.map((decision) => {
      const decisionJson = truncate(stringifyCompact(decision.decision), 180);
      const reasoningJson = truncate(stringifyCompact(decision.reasoning), 180);
      const isNew = newDecisionKeys.has(decision.key);
      const rowStyle = isNew
        ? { background: 'rgba(34, 197, 94, 0.15)', transition: 'background 0.5s ease-out' }
        : {};
      return {
        key: decision.key,
        style: rowStyle,
        cells: [
          new Date(decision.timestamp).toLocaleString(),
          decision.agent,
          decision.subjectId,
          decision.source === 'persisted' ? 'Persisted' : 'Live',
          decisionJson,
          reasoningJson,
          <button key={decision.key} type="button" onClick={() => setSelectedKey(decision.key)} disabled={loading}>
            View
          </button>
        ]
      };
    });
  }, [decisions, newDecisionKeys, loading]);

  return (
    <Section title="Decisions" subtitle="Read-only audit trail of persisted LLM decisions.">
      <Panel
        title="Filters"
        body={
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>Agent</span>
              <input
                id="decisions-agent"
                name="agent"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                placeholder="risk | execution | ops | ..."
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Subject ID</span>
              <input
                id="decisions-subjectId"
                name="subjectId"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                placeholder="opportunity id"
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Limit</span>
              <input
                id="decisions-limit"
                name="limit"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                inputMode="numeric"
                placeholder="200"
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Since</span>
              <input
                id="decisions-since"
                name="since"
                type="datetime-local"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
            </label>

            <label style={{ display: 'grid', gap: 6 }}>
              <span>Until</span>
              <input
                id="decisions-until"
                name="until"
                type="datetime-local"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>

            <div style={{ display: 'flex', alignItems: 'end', gap: 12 }}>
              <button type="button" onClick={() => setRefreshKey((prev) => prev + 1)} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAgent('');
                  setSubjectId('');
                  setLimit('200');
                  setSince('');
                  setUntil('');
                  setRefreshKey((prev) => prev + 1);
                }}
                disabled={loading}
              >
                Clear
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={liveEnabled}
                  onChange={(e) => setLiveEnabled(e.target.checked)}
                  style={{ width: 18, height: 18 }}
                />
                <span>Live Updates</span>
              </label>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  background: connected && liveEnabled ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  color: connected && liveEnabled ? '#22c55e' : '#ef4444'
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: connected && liveEnabled ? '#22c55e' : '#ef4444',
                    animation: connected && liveEnabled ? 'pulse 2s infinite' : 'none'
                  }}
                />
                {connected && liveEnabled ? 'Streaming' : liveEnabled ? 'Disconnected' : 'Paused'}
              </span>
              {newDecisionKeys.size > 0 && (
                <span style={{ fontSize: 12, opacity: 0.8 }}>
                  {newDecisionKeys.size} new
                </span>
              )}
            </div>
          </div>
        }
      />

      <Panel
        title="Recent decisions"
        body={
          error ? (
            <p style={{ color: 'var(--color-error)' }}>{error}</p>
          ) : (
            <MetricsTable columns={['Time', 'Agent', 'Subject', 'Source', 'Decision', 'Reasoning', '']} rows={rows} />
          )
        }
      />

      <Panel
        title="Decision detail"
        body={
          !selected ? (
            <p style={{ opacity: 0.75 }}>Select a row to inspect the raw JSON.</p>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <strong>{selected.agent}</strong>
                <span style={{ opacity: 0.75 }}>|</span>
                <span>{new Date(selected.timestamp).toLocaleString()}</span>
                <span style={{ opacity: 0.75 }}>|</span>
                <span style={{ fontFamily: 'monospace' }}>{selected.subjectId}</span>
                <span style={{ opacity: 0.75 }}>|</span>
                <span>{selected.source === 'persisted' ? 'Persisted' : 'Live'}</span>
                <span style={{ opacity: 0.75 }}>|</span>
                <span style={{ fontFamily: 'monospace' }}>{selected.id}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {copyStatus ? <span style={{ opacity: 0.8 }}>{copyStatus}</span> : null}
                  <button type="button" onClick={() => setSelectedKey(null)}>
                    Close
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong>Decision</strong>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyToClipboard(stringifyPretty(selected.decision));
                          setCopyStatus('Copied decision JSON');
                        } catch (err) {
                          setCopyStatus(err instanceof Error ? err.message : 'Copy failed');
                        }
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 8,
                      background: 'rgba(0,0,0,0.25)',
                      maxHeight: 320,
                      overflow: 'auto',
                      fontSize: 12
                    }}
                  >
                    {stringifyPretty(selected.decision)}
                  </pre>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong>Reasoning</strong>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyToClipboard(stringifyPretty(selected.reasoning));
                          setCopyStatus('Copied reasoning JSON');
                        } catch (err) {
                          setCopyStatus(err instanceof Error ? err.message : 'Copy failed');
                        }
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      borderRadius: 8,
                      background: 'rgba(0,0,0,0.25)',
                      maxHeight: 320,
                      overflow: 'auto',
                      fontSize: 12
                    }}
                  >
                    {stringifyPretty(selected.reasoning)}
                  </pre>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await copyToClipboard(
                        stringifyPretty({
                          id: selected.id,
                          subjectId: selected.subjectId,
                          timestamp: selected.timestamp,
                          agent: selected.agent,
                          decision: selected.decision,
                          reasoning: selected.reasoning
                        })
                      );
                      setCopyStatus('Copied full record');
                    } catch (err) {
                      setCopyStatus(err instanceof Error ? err.message : 'Copy failed');
                    }
                  }}
                >
                  Copy full record
                </button>
              </div>
            </div>
          )
        }
      />
    </Section>
  );
}
