import { afterEach, describe, expect, it, vi } from 'vitest';

interface ElementLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isElementLike(value: unknown): value is ElementLike {
  return Boolean(value && typeof value === 'object' && 'type' in value && 'props' in value);
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
  if (!isElementLike(node)) return '';
  return [...childNodes(node.props.children), ...propNodes(node.props)].map(textContent).join('');
}

describe('dashboard ops shell and layout content', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock('../../dashboard/src/lib/opsClient');
  });

  it('renders shell navigation and wires trading mode and enabled handlers', async () => {
    const opsFetchJson = vi.fn();
    const isOpsUnauthorizedError = vi.fn((error: unknown) => error === 'unauthorized');
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      opsFetchJson,
      isOpsUnauthorizedError
    }));

    const { TopNav } = await import('../../dashboard/src/components/TopNav');
    const { OPS_PATHS } = await import('../../dashboard/src/routes/opsLayoutUtils');
    const { OpsShellView } = await import('../../dashboard/src/routes/OpsShellView');

    const onTradingModeChange = vi.fn();
    const onTradingEnabledChange = vi.fn();
    const onUnauthorized = vi.fn();
    const onLogout = vi.fn();

    const element = OpsShellView({
      children: 'Child content',
      status: 'healthy',
      streamState: { connected: true, stale: false },
      tradingMode: 'paper',
      tradingEnabled: true,
      onTradingModeChange,
      onTradingEnabledChange,
      onUnauthorized,
      onLogout
    });

    expect(textContent(element)).toContain('Child content');
    for (const item of OPS_PATHS) {
      expect(
        findOne(
          element,
          (entry) => entry.props.to === item.to && textContent(entry.props.children) === item.label
        )
      ).toBeDefined();
    }
    expect(findOne(element, (entry) => entry.props.to === '/' && textContent(entry.props.children) === 'Landing')).toBeDefined();
    expect(findOne(element, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Sign out')).toBeDefined();

    const topNav = findOne(element, (entry) => entry.type === TopNav);
    opsFetchJson.mockResolvedValueOnce({ state: { mode: 'live' } });
    await (topNav.props.onModeChange as (mode: 'live') => Promise<void>)('live');
    expect(opsFetchJson).toHaveBeenNthCalledWith(
      1,
      '/config/trading-mode?confirm=true',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'live' })
      })
    );
    expect(onTradingModeChange).toHaveBeenCalledWith('live');

    opsFetchJson.mockResolvedValueOnce({ state: { enabled: false } });
    await (topNav.props.onEnabledChange as (enabled: boolean) => Promise<void>)(false);
    expect(opsFetchJson).toHaveBeenNthCalledWith(
      2,
      '/config/trading-mode',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: false })
      })
    );
    expect(onTradingEnabledChange).toHaveBeenCalledWith(false);

    opsFetchJson.mockRejectedValueOnce('unauthorized');
    await (topNav.props.onModeChange as (mode: 'paper') => Promise<void>)('paper');
    expect(onUnauthorized).toHaveBeenCalledOnce();

    findOne(element, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Sign out').props
      .onClick?.({} as never);
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('selects the correct routed page component for each ops page', async () => {
    const { Decisions } = await import('../../dashboard/src/pages/Decisions');
    const { Incidents } = await import('../../dashboard/src/pages/Incidents');
    const { Markets } = await import('../../dashboard/src/pages/Markets');
    const { Overview } = await import('../../dashboard/src/pages/Overview');
    const { Positions } = await import('../../dashboard/src/pages/Positions');
    const { RiskGates } = await import('../../dashboard/src/pages/RiskGates');
    const { OpsLayoutContent } = await import('../../dashboard/src/routes/OpsLayoutContent');

    const sharedProps = {
      allowlist: [{ key: 'market-1', question: 'Question 1' }],
      health: { overall: 'healthy' },
      incidents: [{ id: 'incident-1' }],
      intents: [{ opportunityId: 'opp-1', gatedAt: 1 }],
      metrics: { counts: { decisions: 1 }, lastEventAt: 1 },
      onToggleExpanded: vi.fn(),
      slo: { uptimeRatio: 1 },
      expanded: false
    } as never;

    expect(OpsLayoutContent({ ...sharedProps, currentPage: 'markets' }).type).toBe(Markets);
    expect(OpsLayoutContent({ ...sharedProps, currentPage: 'incidents' }).type).toBe(Incidents);
    expect(OpsLayoutContent({ ...sharedProps, currentPage: 'positions' }).type).toBe(Positions);
    expect(OpsLayoutContent({ ...sharedProps, currentPage: 'risk' }).type).toBe(RiskGates);
    expect(OpsLayoutContent({ ...sharedProps, currentPage: 'decisions' }).type).toBe(Decisions);

    const overviewElement = OpsLayoutContent({ ...sharedProps, currentPage: 'overview' });
    expect(overviewElement.type).toBe(Overview);
    expect(overviewElement.props.health).toEqual(sharedProps.health);
    expect(overviewElement.props.metrics).toEqual(sharedProps.metrics);
    expect(overviewElement.props.onToggleExpanded).toBe(sharedProps.onToggleExpanded);
  }, 30000);
});
