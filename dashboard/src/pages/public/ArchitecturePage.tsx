import { PageContainer } from '../../components/PageContainer';
import { PageHero } from '../../components/public/PageHero';
import { SectionBlock } from '../../components/public/SectionBlock';

export function ArchitecturePage() {
  return (
    <PageContainer className="page-container--content">
      <PageHero
        eyebrow="Architecture"
        title="Agent pipeline with event-sourced operations."
        lead="Scanner, risk, execution, and portfolio agents are coordinated by a supervisor and emitted through an ops API."
      />
      <SectionBlock title="Pipeline">
        <ol className="content-list content-list--ordered">
          <li>Market data and signals generate candidate opportunities.</li>
          <li>Risk gate evaluation approves or rejects each opportunity.</li>
          <li>Execution places guarded orders and records lifecycle events.</li>
          <li>Portfolio reconciles outcomes and exposure.</li>
        </ol>
      </SectionBlock>
      <SectionBlock title="State and telemetry">
        <p>
          Events are persisted in SQLite-backed stores, then surfaced through `/metrics`, `/incidents`, `/slo`, and
          `/decisions`. The dashboard consumes these APIs directly for live operator visibility.
        </p>
      </SectionBlock>
      <SectionBlock title="Source maps">
        <ul className="content-list">
          <li>
            <a href="/docs/ARCHITECTURE.md">System architecture document</a>
          </li>
          <li>
            <a href="/docs/API.md">Ops API reference</a>
          </li>
          <li>
            <a href="/docs/Development/architecture-decisions.md">Architecture decisions</a>
          </li>
        </ul>
      </SectionBlock>
    </PageContainer>
  );
}
