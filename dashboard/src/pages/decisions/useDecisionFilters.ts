import { useMemo, useState } from 'react';

import { asMs } from './decisionTypes';

export function useDecisionFilters() {
  const [agent, setAgent] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [limit, setLimit] = useState('200');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (agent.trim()) params.set('agent', agent.trim());
    if (subjectId.trim()) params.set('subjectId', subjectId.trim());
    if (limit.trim()) params.set('limit', limit.trim());
    const sinceMs = asMs(since);
    const untilMs = asMs(until);
    if (sinceMs !== null) params.set('sinceMs', String(sinceMs));
    if (untilMs !== null) params.set('untilMs', String(untilMs));
    const raw = params.toString();
    return raw ? `?${raw}` : '';
  }, [agent, subjectId, limit, since, until]);

  return {
    agent,
    limit,
    query,
    refreshKey,
    since,
    subjectId,
    until,
    onAgentChange: setAgent,
    onClear: () => {
      setAgent('');
      setSubjectId('');
      setLimit('200');
      setSince('');
      setUntil('');
      setRefreshKey((prev) => prev + 1);
    },
    onLimitChange: setLimit,
    onRefresh: () => setRefreshKey((prev) => prev + 1),
    onSinceChange: setSince,
    onSubjectIdChange: setSubjectId,
    onUntilChange: setUntil
  };
}
