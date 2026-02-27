import { Link } from 'react-router-dom';

import { PageContainer } from '../../components/PageContainer';
import { PageHero } from '../../components/public/PageHero';
import { SectionBlock } from '../../components/public/SectionBlock';

export function GetStartedPage() {
  return (
    <PageContainer className="page-container--content">
      <PageHero
        eyebrow="Get Started"
        title="Run local paper mode first."
        lead="Install dependencies, set safe defaults, start backend plus dashboard, and sign in to `/ops/*` with your ops token."
      />
      <SectionBlock title="Quick setup">
        <pre className="code-block">
{`npm install
npm --prefix dashboard install
cp .env.example .env
cp dashboard/.env.example dashboard/.env
npm run dev:ops`}
        </pre>
      </SectionBlock>
      <SectionBlock title="Required local values">
        <ul className="content-list">
          <li>`TRADING_MODE=paper`</li>
          <li>`TRADING_ENABLED=true`</li>
          <li>`OPS_API_TOKEN=replace-with-secure-token`</li>
          <li>`VITE_OPS_BASE_URL` pointing to your ops API origin</li>
        </ul>
      </SectionBlock>
      <SectionBlock title="Verify">
        <ul className="content-list">
          <li>`GET /health` returns healthy with bearer auth.</li>
          <li>Landing routes load under `/`.</li>
          <li>`/ops/overview` prompts for runtime token and then loads.</li>
        </ul>
        <p>
          Continue to <Link to="/ops/overview">ops overview</Link> after session sign-in.
        </p>
      </SectionBlock>
    </PageContainer>
  );
}
