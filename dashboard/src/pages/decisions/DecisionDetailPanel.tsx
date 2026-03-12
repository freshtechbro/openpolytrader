import type { RefObject } from 'react';
import {
  copyToClipboard,
  stringifyPretty,
  type DecisionRow
} from './decisionTypes';

export function DecisionDetailPanel(props: {
  detailsRef: RefObject<HTMLDivElement | null>;
  selected: DecisionRow | null;
  copyStatus: string | null;
  onClose: () => void;
  onCopyStatusChange: (value: string) => void;
}) {
  const { detailsRef, selected, copyStatus, onClose, onCopyStatusChange } = props;

  return (
    <div ref={detailsRef} id="decision-detail" className="decisions-detail-anchor">
      {!selected ? (
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
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 12
            }}
          >
            <DecisionJsonBlock
              title="Decision"
              value={selected.decision}
              successLabel="Copied decision JSON"
              onCopyStatusChange={onCopyStatusChange}
            />
            <DecisionJsonBlock
              title="Reasoning"
              value={selected.reasoning}
              successLabel="Copied reasoning JSON"
              onCopyStatusChange={onCopyStatusChange}
            />
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
                  onCopyStatusChange('Copied full record');
                } catch (error) {
                  onCopyStatusChange(error instanceof Error ? error.message : 'Copy failed');
                }
              }}
            >
              Copy full record
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionJsonBlock(props: {
  title: string;
  value: unknown;
  successLabel: string;
  onCopyStatusChange: (value: string) => void;
}) {
  const { title, value, successLabel, onCopyStatusChange } = props;

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>{title}</strong>
        <button
          type="button"
          onClick={async () => {
            try {
              await copyToClipboard(stringifyPretty(value));
              onCopyStatusChange(successLabel);
            } catch (error) {
              onCopyStatusChange(error instanceof Error ? error.message : 'Copy failed');
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
        {stringifyPretty(value)}
      </pre>
    </div>
  );
}
