import type { Dispatch, SetStateAction } from 'react';

import { opsFetchJson } from '../../lib/opsClient';
import {
  isAbortError,
  mergeDecisions,
  stringifyCompact,
  toDecisionRow,
  truncate,
  type DecisionRow,
  type DecisionsResponse
} from './decisionTypes';

const DEFAULT_MAX_ROWS = 200;
const DECISION_CELL_CLASS_NAMES = Array.from({ length: 7 }, () => 'decisions-cell');
const NEW_DECISION_STYLE = {
  background: 'rgba(34, 197, 94, 0.15)',
  transition: 'background 0.5s ease-out'
} as const;

function getMaxRows(limit: string): number {
  return parseInt(limit, 10) || DEFAULT_MAX_ROWS;
}

function getPersistedDecisionError(response: unknown): string {
  if (response && typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }

    const errorMessage = (response as { error?: { message?: unknown } }).error?.message;
    if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
      return errorMessage;
    }
  }

  return 'Invalid persisted decisions response';
}

export function toPersistedRows(response: DecisionsResponse, limit: string): DecisionRow[] {
  if (!Array.isArray(response)) {
    throw new Error(getPersistedDecisionError(response));
  }
  return response.map((row) => toDecisionRow(row, 'persisted')).slice(0, getMaxRows(limit));
}

export function retainSelectedDecision(selectedKey: string | null, rows: DecisionRow[]): string | null {
  if (!selectedKey) return null;
  return rows.some((row) => row.key === selectedKey) ? selectedKey : null;
}

export function createDecisionTableRow(input: {
  decision: DecisionRow;
  isNew: boolean;
  loading: boolean;
  onSelect: (key: string) => void;
}) {
  const { decision, isNew, loading, onSelect } = input;
  const decisionJson = stringifyCompact(decision.decision);
  const reasoningJson = stringifyCompact(decision.reasoning);
  const timestampLabel = new Date(decision.timestamp).toLocaleString();

  return {
    key: decision.key,
    style: isNew ? NEW_DECISION_STYLE : {},
    cellClassNames: DECISION_CELL_CLASS_NAMES,
    cells: [
      <span className="decision-cell decision-cell--time" title={timestampLabel}>{timestampLabel}</span>,
      <span className="decision-cell decision-cell--agent" title={decision.agent}>{decision.agent}</span>,
      <span className="decision-cell decision-cell--subject" title={decision.subjectId}>{decision.subjectId}</span>,
      <span className="decision-cell decision-cell--source">{decision.source === 'persisted' ? 'Persisted' : 'Live'}</span>,
      <span className="decision-cell decision-cell--json" title={decisionJson}>{truncate(decisionJson, 220)}</span>,
      <span className="decision-cell decision-cell--json" title={reasoningJson}>{truncate(reasoningJson, 220)}</span>,
      <button
        key={decision.key}
        className="decisions-view-button"
        type="button"
        onClick={() => onSelect(decision.key)}
        disabled={loading}
        aria-label={`View details for decision ${decision.subjectId}`}
      >
        View
      </button>
    ]
  };
}

function mergeLiveDecisionRows(
  decisions: DecisionRow[],
  newDecision: DecisionRow,
  maxRows: number
): DecisionRow[] {
  return mergeDecisions(decisions, [newDecision], maxRows);
}

export function createLiveDecisionHandler(
  setDecisions: Dispatch<SetStateAction<DecisionRow[]>>
) {
  return (newDecision: DecisionRow, maxRows: number) => {
    setDecisions((decisions) => mergeLiveDecisionRows(decisions, newDecision, maxRows));
  };
}

async function loadPersistedDecisions(input: {
  query: string;
  limit: string;
  signal: AbortSignal;
}): Promise<DecisionRow[]> {
  const response = await opsFetchJson<DecisionsResponse>(`/decisions${input.query}`, {
    signal: input.signal
  });
  return toPersistedRows(response, input.limit);
}

export async function loadPersistedDecisionsIntoState(input: {
  query: string;
  limit: string;
  signal: AbortSignal;
  isMounted: () => boolean;
  setLoading: (loading: boolean) => void;
  setDecisions: (rows: DecisionRow[]) => void;
  setSelectedKey: (updater: (selectedKey: string | null) => string | null) => void;
  setNewDecisionKeys: (keys: Set<string>) => void;
  setError: (error: string | null) => void;
}) {
  input.setLoading(true);
  try {
    const persistedRows = await loadPersistedDecisions({
      query: input.query,
      limit: input.limit,
      signal: input.signal
    });
    if (!input.isMounted()) return;

    input.setDecisions(persistedRows);
    input.setSelectedKey((selectedKey) => retainSelectedDecision(selectedKey, persistedRows));
    input.setNewDecisionKeys(new Set());
    input.setError(null);
  } catch (error) {
    if (!input.isMounted() || isAbortError(error)) return;
    input.setDecisions([]);
    input.setError(error instanceof Error ? error.message : 'Failed to load decisions');
  } finally {
    if (input.isMounted()) {
      input.setLoading(false);
    }
  }
}

export function findSelectedDecision(
  decisions: DecisionRow[],
  selectedKey: string | null
): DecisionRow | null {
  if (!selectedKey) return null;
  return decisions.find((row) => row.key === selectedKey) ?? null;
}

export function buildDecisionRows(input: {
  decisions: DecisionRow[];
  newDecisionKeys: Set<string>;
  loading: boolean;
  onSelect: (key: string) => void;
}) {
  return input.decisions.map((decision) =>
    createDecisionTableRow({
      decision,
      isNew: input.newDecisionKeys.has(decision.key),
      loading: input.loading,
      onSelect: input.onSelect
    })
  );
}

function closeDecisionDetail(setSelectedKey: (key: string | null) => void) {
  setSelectedKey(null);
}

export function createCloseDecisionHandler(setSelectedKey: (key: string | null) => void) {
  return () => closeDecisionDetail(setSelectedKey);
}
