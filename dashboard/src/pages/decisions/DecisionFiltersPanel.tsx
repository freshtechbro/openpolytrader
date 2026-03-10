export function DecisionFiltersPanel(props: {
  agent: string;
  subjectId: string;
  limit: string;
  since: string;
  until: string;
  loading: boolean;
  liveEnabled: boolean;
  connected: boolean;
  newDecisionCount: number;
  onAgentChange: (value: string) => void;
  onSubjectIdChange: (value: string) => void;
  onLimitChange: (value: string) => void;
  onSinceChange: (value: string) => void;
  onUntilChange: (value: string) => void;
  onRefresh: () => void;
  onClear: () => void;
  onLiveEnabledChange: (value: boolean) => void;
}) {
  const {
    agent,
    subjectId,
    limit,
    since,
    until,
    loading,
    liveEnabled,
    connected,
    newDecisionCount,
    onAgentChange,
    onSubjectIdChange,
    onLimitChange,
    onSinceChange,
    onUntilChange,
    onRefresh,
    onClear,
    onLiveEnabledChange
  } = props;

  return (
    <div className="decisions-filters">
      <label className="decisions-filter-field">
        <span>Agent</span>
        <input
          id="decisions-agent"
          name="agent"
          value={agent}
          onChange={(event) => onAgentChange(event.target.value)}
          placeholder="risk | execution | ops | ..."
        />
      </label>

      <label className="decisions-filter-field">
        <span>Subject ID</span>
        <input
          id="decisions-subjectId"
          name="subjectId"
          value={subjectId}
          onChange={(event) => onSubjectIdChange(event.target.value)}
          placeholder="opportunity id"
        />
      </label>

      <label className="decisions-filter-field">
        <span>Limit</span>
        <input
          id="decisions-limit"
          name="limit"
          value={limit}
          onChange={(event) => onLimitChange(event.target.value)}
          inputMode="numeric"
          placeholder="200"
        />
      </label>

      <label className="decisions-filter-field decisions-filter-field--date">
        <span>Since</span>
        <input
          id="decisions-since"
          name="since"
          type="datetime-local"
          value={since}
          onChange={(event) => onSinceChange(event.target.value)}
        />
      </label>

      <label className="decisions-filter-field decisions-filter-field--date">
        <span>Until</span>
        <input
          id="decisions-until"
          name="until"
          type="datetime-local"
          value={until}
          onChange={(event) => onUntilChange(event.target.value)}
        />
      </label>

      <div className="decisions-filter-actions">
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button type="button" onClick={onClear} disabled={loading}>
          Clear
        </button>
      </div>

      <div className="decisions-filter-live">
        <label className="decisions-filter-live-toggle">
          <input
            type="checkbox"
            checked={liveEnabled}
            onChange={(event) => onLiveEnabledChange(event.target.checked)}
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
            background:
              connected && liveEnabled
                ? 'rgba(34, 197, 94, 0.2)'
                : 'rgba(239, 68, 68, 0.2)',
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
        {newDecisionCount > 0 ? (
          <span style={{ fontSize: 12, opacity: 0.8 }}>{newDecisionCount} new</span>
        ) : null}
      </div>
    </div>
  );
}
