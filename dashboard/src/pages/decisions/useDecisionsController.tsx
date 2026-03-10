import { useEffect, useMemo, useState } from 'react';

import {
  buildDecisionRows,
  createCloseDecisionHandler,
  createLiveDecisionHandler,
  findSelectedDecision,
  loadPersistedDecisionsIntoState,
} from './decisionControllerHelpers';
import type { DecisionRow } from './decisionTypes';
import { useDecisionFilters } from './useDecisionFilters';
import { useDecisionLiveUpdates } from './useDecisionLiveUpdates';

export function useDecisionsController() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const filters = useDecisionFilters();
  const liveUpdates = useDecisionLiveUpdates({
    agent: filters.agent,
    subjectId: filters.subjectId,
    limit: filters.limit,
    onDecision: createLiveDecisionHandler(setDecisions)
  });

  useEffect(() => {
    let mounted = true;
    const requestController = new AbortController();
    void loadPersistedDecisionsIntoState({
      query: filters.query,
      limit: filters.limit,
      signal: requestController.signal,
      isMounted: () => mounted,
      setLoading,
      setDecisions,
      setSelectedKey,
      setNewDecisionKeys: liveUpdates.setNewDecisionKeys,
      setError
    });
    return () => {
      mounted = false;
      requestController.abort();
    };
  }, [filters.limit, filters.query, filters.refreshKey, liveUpdates.setNewDecisionKeys]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(null), 1500);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const selected = useMemo(() => {
    return findSelectedDecision(decisions, selectedKey);
  }, [decisions, selectedKey]);

  const rows = useMemo(() => {
    return buildDecisionRows({
      decisions,
      newDecisionKeys: liveUpdates.newDecisionKeys,
      loading,
      onSelect: setSelectedKey
    });
  }, [decisions, liveUpdates.newDecisionKeys, loading]);

  return {
    agent: filters.agent,
    connected: liveUpdates.connected,
    copyStatus,
    error,
    limit: filters.limit,
    liveEnabled: liveUpdates.liveEnabled,
    loading,
    newDecisionCount: liveUpdates.newDecisionCount,
    rows,
    selected,
    since: filters.since,
    subjectId: filters.subjectId,
    until: filters.until,
    onAgentChange: filters.onAgentChange,
    onClear: filters.onClear,
    onCopyStatusChange: setCopyStatus,
    onCloseDetail: createCloseDecisionHandler(setSelectedKey),
    onLimitChange: filters.onLimitChange,
    onLiveEnabledChange: liveUpdates.onLiveEnabledChange,
    onRefresh: filters.onRefresh,
    onSinceChange: filters.onSinceChange,
    onSubjectIdChange: filters.onSubjectIdChange,
    onUntilChange: filters.onUntilChange
  };
}
