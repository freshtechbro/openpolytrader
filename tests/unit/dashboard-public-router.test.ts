import { describe, expect, it } from 'vitest';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isElementLike(value: unknown): value is ElementLike {
  if (!value || typeof value !== 'object') return false;
  return 'type' in value && 'props' in value;
}

function childNodes(value: unknown): unknown[] {
  if (value === undefined || value === null || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

function propNodes(props: Record<string, unknown> & { children?: unknown }): unknown[] {
  return Object.entries(props)
    .filter(([key]) => key !== 'children')
    .flatMap(([, value]) => childNodes(value));
}

function findAll(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike[] {
  if (!isElementLike(node)) return [];
  const matches = predicate(node) ? [node] : [];
  const nested = [...childNodes(node.props.children), ...propNodes(node.props)];
  return nested.reduce<ElementLike[]>((all, child) => all.concat(findAll(child, predicate)), matches);
}

function findOne(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike {
  const matches = findAll(node, predicate);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isElementLike(node)) return textContent(node.props.children);
  return '';
}

describe('dashboard public pages and router', () => {
  it('renders the architecture page with the expected source-document links', async () => {
    const { ArchitecturePage } = await import('../../dashboard/src/pages/public/ArchitecturePage');
    const element = ArchitecturePage();

    expect(findOne(element, (entry) => entry.props.eyebrow === 'Architecture')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Pipeline')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'State and telemetry')).toBeDefined();
    expect(findAll(element, (entry) => entry.props.href === '/docs/ARCHITECTURE.md')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.href === '/docs/API.md')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.href === '/docs/Development/architecture-decisions.md')).toHaveLength(1);
  }, 15000);

  it('renders the get-started page with setup commands and ops handoff link', async () => {
    const { GetStartedPage } = await import('../../dashboard/src/pages/public/GetStartedPage');
    const element = GetStartedPage();

    expect(findOne(element, (entry) => entry.props.eyebrow === 'Get Started')).toBeDefined();
    expect(textContent(findOne(element, (entry) => entry.props.className === 'code-block'))).toContain('npm run dev:ops');
    expect(findAll(element, (entry) => entry.props.to === '/ops/overview')).toHaveLength(1);
    expect(textContent(element)).toContain('TRADING_MODE=paper');
    expect(textContent(element)).toContain('OPS_API_TOKEN=replace-with-secure-token');
  }, 15000);

  it('renders the landing home page with the expected hero actions', async () => {
    const { HomePage } = await import('../../dashboard/src/pages/public/HomePage');
    const element = HomePage();
    const hero = findOne(element, (entry) => entry.props.eyebrow === 'Near-zero-risk arbitrage automation');

    expect(hero.props.actions).toEqual([
      { to: '/get-started', label: 'Get started' },
      { to: '/ops/overview', label: 'Open ops', variant: 'ghost' }
    ]);
    expect(findOne(element, (entry) => entry.props.className === 'page-container--landing')).toBeDefined();
  });

  it('renders the product page with architecture and setup navigation links', async () => {
    const { ProductPage } = await import('../../dashboard/src/pages/public/ProductPage');
    const element = ProductPage();

    expect(findOne(element, (entry) => entry.props.eyebrow === 'Product')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Operational focus')).toBeDefined();
    expect(findAll(element, (entry) => entry.props.to === '/architecture')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.to === '/get-started')).toHaveLength(1);
  });

  it('renders the risk and safety page with docs and ops-risk links', async () => {
    const { RiskSafetyPage } = await import('../../dashboard/src/pages/public/RiskSafetyPage');
    const element = RiskSafetyPage();

    expect(findOne(element, (entry) => entry.props.eyebrow === 'Risk & Safety')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Core safety rules')).toBeDefined();
    expect(findAll(element, (entry) => entry.props.href === '/docs/Operations/security.md')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.href === '/docs/Operations/config-knobs.md')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.to === '/ops/risk')).toHaveLength(1);
  });

  it('defines the canonical public, ops, and fallback routes', async () => {
    const { AppRouter } = await import('../../dashboard/src/routes/AppRouter');
    const element = AppRouter();
    const routes = findAll(element, (entry) => 'path' in entry.props);

    expect(findAll(element, (entry) => entry.props.path === '/')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '/product')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '/risk-safety')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '/architecture')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '/get-started')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '/ops/*')).toHaveLength(1);
    expect(findAll(element, (entry) => entry.props.path === '*')).toHaveLength(1);
    expect(routes).toHaveLength(7);

    const fallback = findOne(element, (entry) => entry.props.path === '*');
    expect(isElementLike(fallback.props.element)).toBe(true);
    expect((fallback.props.element as ElementLike).props).toMatchObject({ to: '/', replace: true });
  }, 30000);
});
