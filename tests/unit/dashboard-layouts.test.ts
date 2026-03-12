import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const requireFromDashboard = createRequire(
  new URL('../../dashboard/src/routes/PublicLayout.tsx', import.meta.url)
);
const { createElement } = requireFromDashboard('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromDashboard('react-dom/server') as typeof import('react-dom/server');
const { MemoryRouter } = requireFromDashboard('react-router-dom') as typeof import('react-router-dom');

describe('dashboard layouts', () => {
  it('renders the public layout with the canonical landing navigation', async () => {
    const { PublicLayout } = await import('../../dashboard/src/routes/PublicLayout');
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: ['/product'] }, createElement(PublicLayout))
    );

    expect(markup).toContain('OpenPolyTrader');
    expect(markup).toContain('href="/"');
    expect(markup).toContain('href="/product"');
    expect(markup).toContain('href="/risk-safety"');
    expect(markup).toContain('href="/architecture"');
    expect(markup).toContain('href="/get-started"');
    expect(markup).toContain('href="/ops/overview"');
    expect(markup).toContain('Landing navigation');
  });

  it(
    'renders the ops layout loading shell before the session refresh completes',
    { timeout: 15_000 },
    async () => {
    const { OpsLayout } = await import('../../dashboard/src/routes/OpsLayout');
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: ['/ops/overview'] }, createElement(OpsLayout))
    );

    expect(markup).toContain('Ops Session');
    expect(markup).toContain('Checking operator session');
    expect(markup).toContain('Verifying runtime auth state before loading live feeds.');
    }
  );
});
