import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable } from '../components/MetricsTable';

export function Incidents({ incidents }: { incidents: any[] }) {
  return (
    <>
      <Section title="Incidents" subtitle="Operational alerts emitted by ops health checks.">
        <Panel
          title="Incidents"
          body={
            <MetricsTable
              columns={['Time', 'Check', 'Error']}
              rows={incidents.map((incident) => [
                incident?.timestamp ? new Date(incident.timestamp).toLocaleTimeString() : '-',
                incident?.check ?? 'unknown',
                incident?.result?.error ?? incident?.result?.info ?? 'n/a'
              ])}
            />
          }
        />
      </Section>
    </>
  );
}
