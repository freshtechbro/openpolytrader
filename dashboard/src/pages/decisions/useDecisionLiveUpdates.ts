import { useState } from 'react';

import { getOpsStreamUrl } from '../../lib/opsClient';
import { useEventStream, type StreamEvent } from '../../hooks/useEventStream';
import { toDecisionRow, type DecisionRow } from './decisionTypes';

function createLiveDecision(event: StreamEvent): DecisionRow | null {
  if (event.type !== 'llm_decision' || !event.data || typeof event.data !== 'object') return null;
  const payload = event.data as { decision?: unknown; reasoning?: unknown };
  if (!payload.decision) return null;

  const decisionData =
    payload.decision && typeof payload.decision === 'object'
      ? (payload.decision as Record<string, unknown>)
      : {};

  return toDecisionRow(
    {
      id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      subjectId: String(decisionData.subject ?? ''),
      timestamp: event.timestamp,
      agent: String(decisionData.agent ?? 'unknown'),
      decision: payload.decision,
      reasoning: payload.reasoning ?? {}
    },
    'live'
  );
}

export function useDecisionLiveUpdates(input: {
  agent: string;
  subjectId: string;
  limit: string;
  onDecision: (decision: DecisionRow, maxRows: number) => void;
}) {
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [newDecisionKeys, setNewDecisionKeys] = useState<Set<string>>(new Set());

  const handleLiveDecision = (event: StreamEvent) => {
    if (!liveEnabled) return;

    const newDecision = createLiveDecision(event);
    if (!newDecision) return;
    if (input.agent.trim() && !newDecision.agent.toLowerCase().includes(input.agent.toLowerCase())) return;
    if (input.subjectId.trim() && !newDecision.subjectId.includes(input.subjectId.trim())) return;

    const maxRows = parseInt(input.limit, 10) || 200;
    input.onDecision(newDecision, maxRows);
    setNewDecisionKeys((prev) => new Set([...prev, newDecision.key]));

    setTimeout(() => {
      setNewDecisionKeys((prev) => {
        const next = new Set(prev);
        next.delete(newDecision.key);
        return next;
      });
    }, 3000);
  };

  const [{ connected }] = useEventStream(getOpsStreamUrl(), handleLiveDecision);

  return {
    connected,
    liveEnabled,
    newDecisionCount: newDecisionKeys.size,
    newDecisionKeys,
    onLiveEnabledChange: setLiveEnabled,
    setNewDecisionKeys,
  };
}
