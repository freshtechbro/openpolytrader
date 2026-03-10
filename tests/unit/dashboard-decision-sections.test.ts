import { afterEach, describe, expect, it, vi } from 'vitest';

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
  return nested.reduce<ElementLike[]>(
    (all, child) => all.concat(findAll(child, predicate)),
    matches
  );
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

function mockDashboardReact(stateValues: unknown[] = []) {
  let stateIndex = 0;
  const setters: Array<ReturnType<typeof vi.fn>> = [];

  const reactMock = {
    __esModule: true,
    default: {
      Fragment: 'fragment',
      StrictMode: 'strict-mode'
    },
    useState: vi.fn((initial: unknown) => {
      const setter = vi.fn();
      setters.push(setter);
      const value = stateIndex < stateValues.length ? stateValues[stateIndex] : initial;
      stateIndex += 1;
      return [value, setter];
    }),
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    }
  };

  vi.doMock('react', () => reactMock);
  vi.doMock('../../dashboard/node_modules/react/index.js', () => reactMock);

  return { setters };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('react');
  vi.unmock('../../dashboard/node_modules/react/index.js');
  vi.unmock('../../dashboard/src/hooks/useEventStream');
  vi.unmock('../../dashboard/src/lib/opsClient');
});

describe('decision detail and filter sections', () => {
  it('renders detail actions and copies the selected record', async () => {
    const clipboardWrite = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });

    const { DecisionDetailPanel } = await import('../../dashboard/src/pages/decisions/DecisionDetailPanel');
    const element = DecisionDetailPanel({
      detailsRef: { current: null },
      selected: {
        id: 'decision-1',
        key: 'decision-1',
        source: 'persisted',
        agent: 'RiskAgent',
        subjectId: 'subject-1',
        timestamp: 1_700_000_000_000,
        decision: { task: 'gate', ok: true },
        reasoning: { why: 'safe' }
      },
      copyStatus: null,
      onClose: vi.fn(),
      onCopyStatusChange: vi.fn()
    });

    const copyButton = findOne(
      element,
      (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Copy full record'
    );

    await copyButton.props.onClick();

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
  });

  it('renders filters and forwards field, toggle, and action events', async () => {
    const onAgentChange = vi.fn();
    const onSubjectIdChange = vi.fn();
    const onLimitChange = vi.fn();
    const onSinceChange = vi.fn();
    const onUntilChange = vi.fn();
    const onRefresh = vi.fn();
    const onClear = vi.fn();
    const onLiveEnabledChange = vi.fn();

    const { DecisionFiltersPanel } = await import('../../dashboard/src/pages/decisions/DecisionFiltersPanel');
    const element = DecisionFiltersPanel({
      agent: 'risk',
      subjectId: 'subject-1',
      limit: '100',
      since: '2026-03-08T10:00',
      until: '2026-03-08T11:00',
      loading: false,
      liveEnabled: true,
      connected: false,
      newDecisionCount: 3,
      onAgentChange,
      onSubjectIdChange,
      onLimitChange,
      onSinceChange,
      onUntilChange,
      onRefresh,
      onClear,
      onLiveEnabledChange
    });

    const inputs = findAll(element, (entry) => entry.type === 'input');
    expect(inputs).toHaveLength(6);

    inputs[0]!.props.onChange({ target: { value: 'ops' } });
    inputs[1]!.props.onChange({ target: { value: 'subject-2' } });
    inputs[2]!.props.onChange({ target: { value: '250' } });
    inputs[3]!.props.onChange({ target: { value: '2026-03-08T09:00' } });
    inputs[4]!.props.onChange({ target: { value: '2026-03-08T12:00' } });
    inputs[5]!.props.onChange({ target: { checked: false } });

    const buttons = findAll(element, (entry) => entry.type === 'button');
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();

    expect(onAgentChange).toHaveBeenCalledWith('ops');
    expect(onSubjectIdChange).toHaveBeenCalledWith('subject-2');
    expect(onLimitChange).toHaveBeenCalledWith('250');
    expect(onSinceChange).toHaveBeenCalledWith('2026-03-08T09:00');
    expect(onUntilChange).toHaveBeenCalledWith('2026-03-08T12:00');
    expect(onLiveEnabledChange).toHaveBeenCalledWith(false);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
    expect(textContent(element)).toContain('Disconnected');
    expect(textContent(element)).toContain('3 new');
  });
});

describe('decision type helpers', () => {
  it('converts timestamps, merges live/persisted rows, and uses clipboard when available', async () => {
    const clipboardWrite = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWrite } });

    const {
      asMs,
      copyToClipboard,
      mergeDecisions,
      stringifyCompact,
      stringifyPretty,
      toDecisionRow,
      truncate
    } = await import('../../dashboard/src/pages/decisions/decisionTypes');

    const live = toDecisionRow(
      {
        id: 'live-1',
        agent: 'RiskAgent',
        subjectId: 'subject-1',
        timestamp: 1_700_000_000_000,
        decision: { task: 'gate', ok: false },
        reasoning: { reason: 'waiting' }
      },
      'live'
    );
    const persisted = toDecisionRow(
      {
        id: 'persisted-1',
        agent: 'RiskAgent',
        subjectId: 'subject-1',
        timestamp: 1_700_000_000_000,
        decision: { task: 'gate', ok: true },
        reasoning: { reason: 'clear' }
      },
      'persisted'
    );

    expect(asMs('2026-03-08T10:00')).not.toBeNull();
    expect(asMs('bad-date')).toBeNull();
    expect(stringifyCompact({ ok: true })).toBe('{"ok":true}');
    expect(stringifyPretty({ ok: true })).toContain('\n');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(mergeDecisions([live], [persisted], 10)).toEqual([persisted]);

    await copyToClipboard('decision-json');
    expect(clipboardWrite).toHaveBeenCalledWith('decision-json');
  });
});

describe('decision controller helpers', () => {
  it('normalizes persisted rows, retains selected entries, and builds row models', async () => {
    const onSelect = vi.fn();
    const { createDecisionTableRow, retainSelectedDecision, toPersistedRows } = await import(
      '../../dashboard/src/pages/decisions/decisionControllerHelpers'
    );

    const rows = toPersistedRows(
      [
        {
          id: 'persisted-1',
          subjectId: 'subject-1',
          timestamp: 1_700_000_000_000,
          agent: 'RiskAgent',
          decision: { task: 'gate', ok: true },
          reasoning: { why: 'clear' }
        }
      ],
      '10'
    );

    expect(retainSelectedDecision(rows[0]!.key, rows)).toBe(rows[0]!.key);
    expect(retainSelectedDecision('missing', rows)).toBeNull();
    expect(() => toPersistedRows({ message: 'Decision store unavailable' }, '10')).toThrow(
      'Decision store unavailable'
    );

    const rowModel = createDecisionTableRow({
      decision: rows[0]!,
      isNew: true,
      loading: false,
      onSelect
    });
    const viewButton = rowModel.cells[6] as ElementLike;

    expect(rowModel.style).toMatchObject({ background: 'rgba(34, 197, 94, 0.15)' });
    viewButton.props.onClick();
    expect(onSelect).toHaveBeenCalledWith(rows[0]!.key);
  });
});

describe('useDecisionsController', () => {
  it('builds decision filter queries and resets extracted filter state', async () => {
    const { setters } = mockDashboardReact([
      'risk',
      'subject-1',
      '100',
      '2026-03-08T10:00',
      '2026-03-08T11:00',
      0
    ]);

    const { useDecisionFilters } = await import('../../dashboard/src/pages/decisions/useDecisionFilters');
    const filters = useDecisionFilters();

    const sinceMs = new Date('2026-03-08T10:00').getTime();
    const untilMs = new Date('2026-03-08T11:00').getTime();
    expect(filters.query).toBe(
      `?agent=risk&subjectId=subject-1&limit=100&sinceMs=${sinceMs}&untilMs=${untilMs}`
    );

    filters.onClear();

    expect(setters[0]).toHaveBeenCalledWith('');
    expect(setters[1]).toHaveBeenCalledWith('');
    expect(setters[2]).toHaveBeenCalledWith('200');
    expect(setters[3]).toHaveBeenCalledWith('');
    expect(setters[4]).toHaveBeenCalledWith('');
    expect(setters[5]).toHaveBeenCalledWith(expect.any(Function));
  });

  it('streams extracted live decision updates through the helper hook', async () => {
    vi.useFakeTimers();
    const { setters } = mockDashboardReact([true, new Set<string>()]);
    let streamHandler: ((event: unknown) => void) | undefined;
    const onDecision = vi.fn();

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: (_url: string, handler: (event: unknown) => void) => {
        streamHandler = handler;
        return [{ connected: true }];
      }
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      getOpsStreamUrl: () => '/stream'
    }));

    const { useDecisionLiveUpdates } = await import(
      '../../dashboard/src/pages/decisions/useDecisionLiveUpdates'
    );
    const live = useDecisionLiveUpdates({
      agent: 'risk',
      subjectId: 'subject-1',
      limit: '100',
      onDecision
    });

    expect(live.connected).toBe(true);
    streamHandler?.({
      type: 'llm_decision',
      timestamp: 1_700_000_000_000,
      data: {
        decision: { agent: 'RiskAgent', subject: 'subject-1', task: 'gate' },
        reasoning: { why: 'clear' }
      }
    });

    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'RiskAgent',
        subjectId: 'subject-1',
        source: 'live'
      }),
      100
    );
    expect(setters[1]).toHaveBeenCalledWith(expect.any(Function));

    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('fetches persisted decisions, exposes rows, and clears filters through setters', async () => {
    const { setters } = mockDashboardReact([
      [
        {
          id: 'persisted-1',
          key: 'RiskAgent::subject-1::1700000000000::gate',
          source: 'persisted',
          agent: 'RiskAgent',
          subjectId: 'subject-1',
          timestamp: 1_700_000_000_000,
          decision: { task: 'gate', ok: true },
          reasoning: { why: 'clear' }
        }
      ],
      false,
      null,
      null,
      null,
      'risk',
      'subject-1',
      '100',
      '2026-03-08T10:00',
      '2026-03-08T11:00',
      0,
      true,
      new Set<string>()
    ]);
    const opsFetchJson = vi.fn(async () => [
      {
        id: 'persisted-1',
        subjectId: 'subject-1',
        timestamp: 1_700_000_000_000,
        agent: 'RiskAgent',
        decision: { task: 'gate', ok: true },
        reasoning: { why: 'clear' }
      }
    ]);

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: () => [{ connected: true }]
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      getOpsStreamUrl: () => '/stream',
      opsFetchJson
    }));

    const { useDecisionsController } = await import('../../dashboard/src/pages/decisions/useDecisionsController');
    const controller = useDecisionsController();
    await Promise.resolve();
    await Promise.resolve();

    const sinceMs = new Date('2026-03-08T10:00').getTime();
    const untilMs = new Date('2026-03-08T11:00').getTime();

    expect(opsFetchJson).toHaveBeenCalledWith(
      `/decisions?agent=risk&subjectId=subject-1&limit=100&sinceMs=${sinceMs}&untilMs=${untilMs}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(controller.connected).toBe(true);
    expect(controller.rows).toHaveLength(1);
    expect(textContent(controller.rows[0]!.cells[1])).toContain('RiskAgent');

    controller.onClear();

    expect(setters[5]).toHaveBeenCalledWith('');
    expect(setters[6]).toHaveBeenCalledWith('');
    expect(setters[7]).toHaveBeenCalledWith('200');
    expect(setters[8]).toHaveBeenCalledWith('');
    expect(setters[9]).toHaveBeenCalledWith('');
    expect(setters[10]).toHaveBeenCalledWith(expect.any(Function));
  });

  it('clears decisions and surfaces the server error when persisted decision loading fails', async () => {
    const { setters } = mockDashboardReact([
      [],
      true,
      null,
      null,
      null,
      '',
      '',
      '200',
      '',
      '',
      0,
      true,
      new Set<string>()
    ]);
    const opsFetchJson = vi.fn(async () => ({ message: 'Decision store unavailable' }));

    vi.doMock('../../dashboard/src/hooks/useEventStream', () => ({
      useEventStream: () => [{ connected: false }]
    }));
    vi.doMock('../../dashboard/src/lib/opsClient', () => ({
      getOpsStreamUrl: () => '/stream',
      opsFetchJson
    }));

    const { useDecisionsController } = await import('../../dashboard/src/pages/decisions/useDecisionsController');
    useDecisionsController();
    await Promise.resolve();
    await Promise.resolve();

    expect(opsFetchJson).toHaveBeenCalledWith(
      '/decisions?limit=200',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(setters[0]).toHaveBeenCalledWith([]);
    expect(setters[2]).toHaveBeenCalledWith('Decision store unavailable');
    expect(setters[1]).toHaveBeenLastCalledWith(false);
  });
});
