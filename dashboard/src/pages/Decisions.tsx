import { useEffect, useRef } from 'react';

import { MetricsTable } from '../components/MetricsTable';
import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { DecisionDetailPanel } from './decisions/DecisionDetailPanel';
import { DecisionFiltersPanel } from './decisions/DecisionFiltersPanel';
import { useDecisionsController } from './decisions/useDecisionsController';
import type { DecisionRow } from './decisions/decisionTypes';

function scrollSelectedDecisionIntoView(
  selected: DecisionRow | null,
  detailsElement: HTMLDivElement | null
): void {
  if (!selected) return;
  detailsElement?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function Decisions() {
  const controller = useDecisionsController();
  const detailsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollSelectedDecisionIntoView(controller.selected, detailsRef.current);
  }, [controller.selected]);

  return (
    <Section title="Decisions" subtitle="Read-only audit trail of persisted LLM decisions.">
      <Panel
        title="Filters"
        body={
          <DecisionFiltersPanel
            agent={controller.agent}
            subjectId={controller.subjectId}
            limit={controller.limit}
            since={controller.since}
            until={controller.until}
            loading={controller.loading}
            liveEnabled={controller.liveEnabled}
            connected={controller.connected}
            newDecisionCount={controller.newDecisionCount}
            onAgentChange={controller.onAgentChange}
            onSubjectIdChange={controller.onSubjectIdChange}
            onLimitChange={controller.onLimitChange}
            onSinceChange={controller.onSinceChange}
            onUntilChange={controller.onUntilChange}
            onRefresh={controller.onRefresh}
            onClear={controller.onClear}
            onLiveEnabledChange={controller.onLiveEnabledChange}
          />
        }
      />

      <Panel
        title="Recent decisions"
        body={
          controller.error ? (
            <p style={{ color: 'var(--color-error)' }}>{controller.error}</p>
          ) : (
            <MetricsTable
              className="decisions-table"
              ariaLabel="Recent decisions table"
              columns={['Time', 'Agent', 'Subject', 'Source', 'Decision', 'Reasoning', 'View']}
              columnClassNames={[
                'decisions-col-time',
                'decisions-col-agent',
                'decisions-col-subject',
                'decisions-col-source',
                'decisions-col-decision',
                'decisions-col-reasoning',
                'decisions-col-action'
              ]}
              rows={controller.rows}
            />
          )
        }
      />

      <Panel
        title="Decision detail"
        body={
          <DecisionDetailPanel
            detailsRef={detailsRef}
            selected={controller.selected}
            copyStatus={controller.copyStatus}
            onClose={controller.onCloseDetail}
            onCopyStatusChange={controller.onCopyStatusChange}
          />
        }
      />
    </Section>
  );
}
