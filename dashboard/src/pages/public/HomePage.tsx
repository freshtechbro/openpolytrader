import { PageContainer } from '../../components/PageContainer';
import { Hero } from '../../components/public/Hero';
import { PipelineGrid } from '../../components/public/PipelineGrid';
import { RiskPillars } from '../../components/public/RiskPillars';
import { TrustStrip } from '../../components/public/TrustStrip';

export function HomePage() {
  return (
    <PageContainer className="page-container--landing">
      <Hero
        eyebrow="Near-zero-risk arbitrage automation"
        title="Operate a disciplined trading pipeline, not a blind bot."
        lead="OpenPolyTrader combines event-sourced orchestration, explicit risk gates, and ops-grade visibility into one practical control plane."
        actions={[
          { to: '/get-started', label: 'Get started' },
          { to: '/ops/overview', label: 'Open ops', variant: 'ghost' }
        ]}
      />
      <TrustStrip />
      <PipelineGrid />
      <RiskPillars />
    </PageContainer>
  );
}
