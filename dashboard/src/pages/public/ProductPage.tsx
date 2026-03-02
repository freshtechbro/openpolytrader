import { Link } from 'react-router-dom';

import { PageContainer } from '../../components/PageContainer';
import { PageHero } from '../../components/public/PageHero';
import { SectionBlock } from '../../components/public/SectionBlock';

export function ProductPage() {
  return (
    <PageContainer className="page-container--content">
      <PageHero
        eyebrow="Product"
        title="A focused execution stack for Polymarket operations."
        lead="The platform separates signal, risk, execution, and portfolio concerns so each layer is observable and testable."
      />
      <SectionBlock
        title="What is included"
        description="One backend runtime plus one dashboard surface for operations and configuration."
      >
        <ul className="content-list">
          <li>Fastify ops API for health, config, incidents, decisions, and SSE.</li>
          <li>Event-sourced telemetry and metrics snapshots for auditability.</li>
          <li>Schema-driven runtime configuration for policy and risk knobs.</li>
          <li>Operator dashboard routes under `/ops/*`.</li>
        </ul>
      </SectionBlock>
      <SectionBlock
        title="Operational focus"
        description="Designed for low-latency monitoring and explicit control over trade modes."
      >
        <p>
          The system favors deterministic behavior over aggressive throughput. Operators can inspect live incidents,
          mode state, risk profiles, and decision logs from a single surface.
        </p>
      </SectionBlock>
      <SectionBlock title="Next stop">
        <p>
          Read the <Link to="/architecture">architecture summary</Link> or move directly to{' '}
          <Link to="/get-started">setup steps</Link>.
        </p>
      </SectionBlock>
    </PageContainer>
  );
}
