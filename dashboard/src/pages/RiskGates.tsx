import { Panel } from '../components/Panel';
import { Section } from '../components/Section';

export function RiskGates() {
  return (
    <>
      <Section title="Risk Gates" subtitle="Phase 1 gates are enforced server-side. This page is a placeholder for gate introspection.">
        <Panel
          title="Gate Insight"
          body={<p>Not yet implemented. Gate decisions emit metrics events (risk/opportunity) for monitoring.</p>}
        />
      </Section>
    </>
  );
}
