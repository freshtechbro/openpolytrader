import { Link } from 'react-router-dom';

import { PageContainer } from '../../components/PageContainer';
import { PageHero } from '../../components/public/PageHero';
import { SectionBlock } from '../../components/public/SectionBlock';

export function RiskSafetyPage() {
  return (
    <PageContainer className="page-container--content">
      <PageHero
        eyebrow="Risk & Safety"
        title="Risk gates are first-class runtime controls."
        lead="Execution is blocked unless opportunity quality, market freshness, and policy constraints all pass."
      />
      <SectionBlock title="Core safety rules">
        <ul className="content-list">
          <li>No autonomous inventory-seeking behavior by default.</li>
          <li>Single-shot execution with no stale-book retries.</li>
          <li>Market quarantine and cooldown to contain repeated failures.</li>
          <li>Explicit live-mode confirmation gate.</li>
        </ul>
      </SectionBlock>
      <SectionBlock
        title="Runtime controls"
        description="Policy and risk settings are schema-driven and editable through the ops API."
      >
        <p>
          Operators can apply risk profiles, update thresholds, and inspect infra snapshots without changing code.
          Safety-sensitive controls remain auditable in event and decision streams.
        </p>
      </SectionBlock>
      <SectionBlock title="Read deeper">
        <p>
          Open <a href="/docs/Operations/security.md">operations security notes</a> and{' '}
          <a href="/docs/Operations/config-knobs.md">runtime knob inventory</a>.
        </p>
        <p>
          Then continue to <Link to="/ops/risk">ops risk controls</Link>.
        </p>
      </SectionBlock>
    </PageContainer>
  );
}
