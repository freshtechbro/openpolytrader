import { Panel } from '../components/Panel';
import { Section } from '../components/Section';
import { MetricsTable } from '../components/MetricsTable';

import type { AllowlistEntry } from './Overview';

export function Markets({ allowlist }: { allowlist: AllowlistEntry[] }) {
  return (
    <>
      <Section
        title="Markets"
        subtitle="Current allowlist/quarantine view. Phase 1 markets are sourced from the market catalog."
      >
        <Panel
          title="Allowlist"
          body={
            <MetricsTable
              columns={['Market', 'Status', 'Until', 'Reason']}
              rows={allowlist.map((entry) => [
                entry.key,
                entry.entry.status,
                entry.entry.until ? new Date(entry.entry.until).toLocaleString() : '-',
                entry.entry.reason ?? '-'
              ])}
            />
          }
        />
      </Section>
    </>
  );
}
