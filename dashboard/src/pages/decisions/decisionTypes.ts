export interface StoredDecision {
  id: string;
  subjectId: string;
  timestamp: number;
  agent: string;
  decision: unknown;
  reasoning: unknown;
}

export type DecisionsResponse = StoredDecision[];

export type DecisionSource = 'persisted' | 'live';

export interface DecisionRow extends StoredDecision {
  key: string;
  source: DecisionSource;
}

export function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(value);
  }
}

export function stringifyPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return error instanceof Error ? error.message : String(value);
  }
}

export function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(maxLen - 1, 0))}…`;
}

export function asMs(value: string): number | null {
  if (value.trim().length === 0) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function getDecisionTask(decision: unknown): string {
  if (!decision || typeof decision !== 'object') return '';
  const record = decision as { task?: unknown };
  return typeof record.task === 'string' ? record.task : '';
}

function getDecisionKey(row: {
  agent: string;
  subjectId: string;
  timestamp: number;
  decision: unknown;
}): string {
  const task = getDecisionTask(row.decision);
  return `${row.agent}::${row.subjectId}::${row.timestamp}::${task}`;
}

export function toDecisionRow(row: StoredDecision, source: DecisionSource): DecisionRow {
  return {
    ...row,
    key: getDecisionKey(row),
    source
  };
}

export function mergeDecisions(
  existing: DecisionRow[],
  incoming: DecisionRow[],
  limit: number
): DecisionRow[] {
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

export async function copyToClipboard(text: string): Promise<void> {
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
