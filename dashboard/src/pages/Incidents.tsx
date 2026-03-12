import { useMemo, useState } from 'react';

import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable, type TableRow } from '../components/MetricsTable';
import type { OpsIncident } from './Overview';

const INCIDENTS_PREVIEW_LIMIT = 25;

export function Incidents({ incidents }: { incidents: OpsIncident[] }) {
  const [showAllIncidents, setShowAllIncidents] = useState(false);
  const visibleIncidents = showAllIncidents ? incidents : incidents.slice(0, INCIDENTS_PREVIEW_LIMIT);
  const rows = useMemo<TableRow[]>(() => {
    return visibleIncidents.map((incident, index) => {
      const timestamp = incident?.timestamp ? new Date(incident.timestamp).toLocaleTimeString() : '-';
      const check = incident?.check ?? 'unknown';
      const error = incident?.result?.error ?? incident?.result?.info ?? 'n/a';
      return {
        key: `${String(incident?.timestamp ?? 'no-ts')}-${index}`,
        cellClassNames: ['incident-cell', 'incident-cell', 'incident-cell'],
        cells: [
          <span className="incident-cell-content incident-cell-content--time" title={timestamp}>{timestamp}</span>,
          <span className="incident-cell-content" title={check}>{check}</span>,
          <span className="incident-cell-content incident-cell-content--error" title={error}>{error}</span>
        ]
      };
    });
  }, [visibleIncidents]);

  return (
    <>
      <Section title="Incidents" subtitle="Operational alerts emitted by ops health checks.">
        <Panel
          title="Incidents"
          body={
            <>
              <MetricsTable
                className="incidents-table"
                ariaLabel="Incidents table"
                columnClassNames={['incidents-col-time', 'incidents-col-check', 'incidents-col-error']}
                columns={['Time', 'Check', 'Error']}
                rows={rows}
              />
              {incidents.length > INCIDENTS_PREVIEW_LIMIT ? (
                <div className="table-meta">
                  <span>
                    Showing {visibleIncidents.length} of {incidents.length}
                  </span>
                  <button type="button" className="link-button" onClick={() => setShowAllIncidents((prev) => !prev)}>
                    {showAllIncidents ? 'Show less' : 'Show all'}
                  </button>
                </div>
              ) : null}
            </>
          }
        />
      </Section>
    </>
  );
}
