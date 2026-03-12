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

function nestedNodes(node: ElementLike): unknown[] {
  const propChildren = [...childNodes(node.props.children), ...propNodes(node.props)];
  if (typeof node.type !== 'function') {
    return propChildren;
  }

  try {
    return Array.from(new Set([...propChildren, ...childNodes(node.type(node.props))]));
  } catch {
    return propChildren;
  }
}

function findAll(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike[] {
  if (!isElementLike(node)) return [];
  const matches = predicate(node) ? [node] : [];
  const nested = nestedNodes(node);
  return Array.from(new Set(nested.reduce<ElementLike[]>(
    (all, child) => all.concat(findAll(child, predicate)),
    matches
  )));
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
  return nestedNodes(node).map(textContent).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('RiskConfigSettingsSection', () => {
  it('renders schema-backed fields, expand/save controls, and forwards field updates', async () => {
    const onToggleSectionExpansion = vi.fn();
    const onFieldChange = vi.fn();
    const onSave = vi.fn();

    const { RiskConfigSettingsSection } = await import('../../dashboard/src/pages/risk-gates/RiskConfigSettingsSection');
    const element = RiskConfigSettingsSection({
      section: {
        schema: {
          sections: [
            {
              key: 'policy',
              label: 'Policy',
              description: 'Trade thresholds.',
              fields: Array.from({ length: 14 }, (_, index) => ({
                key: index === 0 ? 'fwRequireConverged' : `policyField${index}`,
                label: index === 0 ? 'FW Require Converged' : `Policy Field ${index}`,
                description: `Description ${index}`,
                type: index === 0 ? 'boolean' : index === 1 ? 'enum' : 'number',
                options: index === 1 ? ['shadow', 'live'] : [],
                integer: false,
                step: 0.5,
                unit: index === 2 ? 'bps' : undefined
              }))
            }
          ]
        },
        draft: {
          policy: {
            fwRequireConverged: true,
            policyField1: 'shadow',
            policyField2: 1.5
          },
          risk: {}
        },
        expandedSections: { policy: false, risk: false },
        saveState: {
          policy: { saving: false, savedAt: 1_700_000_000_000 },
          risk: { saving: false }
        },
        onToggleSectionExpansion,
        onFieldChange,
        onSave
      }
    });

    expect(findOne(element, (entry) => entry.props.title === 'Config Settings')).toBeDefined();
    expect(findOne(element, (entry) => entry.props.title === 'Policy')).toBeDefined();

    const expandButton = findOne(
      element,
      (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Show all 14 fields'
    );
    const saveButton = findOne(
      element,
      (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Save changes'
    );
    const inputs = findAll(element, (entry) => entry.type === 'input');
    const selects = findAll(element, (entry) => entry.type === 'select');
    expect(selects.length).toBeGreaterThanOrEqual(1);
    const select = selects[0]!;

    expandButton.props.onClick();
    saveButton.props.onClick();
    inputs[0]!.props.onChange({ target: { checked: false } });
    select.props.onChange({ target: { value: 'live' } });
    inputs[1]!.props.onChange({ target: { value: '2.5' } });

    expect(onToggleSectionExpansion).toHaveBeenCalledWith('policy');
    expect(onSave).toHaveBeenCalledWith('policy');
    expect(onFieldChange).toHaveBeenCalledWith(
      'policy',
      expect.objectContaining({ key: 'fwRequireConverged' }),
      false
    );
    expect(onFieldChange).toHaveBeenCalledWith('policy', expect.objectContaining({ key: 'policyField1' }), 'live');
    expect(onFieldChange).toHaveBeenCalledWith('policy', expect.objectContaining({ key: 'policyField2' }), 2.5);
    expect(textContent(element)).toContain('Saved');
    expect(textContent(element)).toContain('Showing 10 of 14 fields');
  });

  it('shows the fallback when config schema is unavailable', async () => {
    const { RiskConfigSettingsSection } = await import('../../dashboard/src/pages/risk-gates/RiskConfigSettingsSection');
    const element = RiskConfigSettingsSection({
      section: {
        schema: null,
        draft: null,
        expandedSections: { policy: false, risk: false },
        saveState: { policy: { saving: false }, risk: { saving: false } },
        onToggleSectionExpansion: vi.fn(),
        onFieldChange: vi.fn(),
        onSave: vi.fn()
      }
    });

    expect(textContent(element)).toContain('Config schema not available.');
  });
});

describe('RiskInfraSection', () => {
  it('renders the collapsed summary and expanded infra details', async () => {
    const onToggleInfra = vi.fn();
    const { RiskInfraSection } = await import('../../dashboard/src/pages/risk-gates/RiskInfraSection');

    const summary = RiskInfraSection({
      section: {
        loadError: null,
        infra: null,
        showInfra: false,
        onToggleInfra
      }
    });

    expect(findOne(summary, (entry) => entry.props.title === 'Infra Summary')).toBeDefined();
    findOne(summary, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Show infra details').props.onClick();
    expect(onToggleInfra).toHaveBeenCalledOnce();

    const expanded = RiskInfraSection({
      section: {
        loadError: null,
        infra: {
          ops: {
            streamHeartbeatMs: 1000,
            healthIntervalMs: 5000,
            reconciliationIntervalMs: 6000,
            reconciliationAfterIncidentDelayMs: 7000,
            reconciliationPositionSizeTolerance: 0.25,
            incidentsLimit: 50,
            incidentsMaxEvents: 500,
            metricsMaxEvents: 1000
          },
          polymarket: {
            clobBaseUrl: 'https://clob.example',
            clobTimeoutMs: 2000,
            clobRateLimitPerSecond: 10,
            clobRateLimitWindowMs: 1000,
            clobActiveOrdersPath: '/orders',
            dataApiBaseUrl: 'https://data.example',
            dataApiTimeoutMs: 2500,
            wsUrl: 'wss://market.example',
            userWsUrl: 'wss://user.example',
            wsHeartbeatMs: 5000,
            wsReconnectBaseMs: 250,
            wsReconnectMaxMs: 4000,
            wsReconnectJitterPct: 0.2,
            positionsUserConfigured: true
          },
          rpc: {
            rateLimitWindowMs: 1000,
            waitConfirmations: 2,
            waitTimeoutMs: 30000,
            providers: {
              alchemy: {
                rpcBaseUrl: 'https://alchemy.example',
                wsBaseUrl: 'wss://alchemy.example',
                rps: 20,
                apiKeyConfigured: true
              },
              quicknode: {
                rpcBaseUrlConfigured: true,
                rps: 15
              },
              chainstack: {
                rpcBaseUrl: 'https://chainstack.example',
                wsBaseUrl: 'wss://chainstack.example',
                rps: 12
              },
              ankr: {
                rpcBaseUrl: 'https://ankr.example',
                rpsPhase1: 8,
                rpsPhase2: 16
              },
              privateNode: {
                rpcBaseUrl: 'https://private.example',
                wsBaseUrl: 'wss://private.example',
                rps: 30
              }
            }
          }
        },
        showInfra: true,
        onToggleInfra: vi.fn()
      }
    });

    expect(findOne(expanded, (entry) => entry.props.title === 'Ops / Streams')).toBeDefined();
    expect(findOne(expanded, (entry) => entry.props.title === 'Polymarket')).toBeDefined();
    expect(findOne(expanded, (entry) => entry.props.title === 'RPC')).toBeDefined();
    expect(textContent(expanded)).toContain('https://clob.example');
    expect(textContent(expanded)).toContain('https://alchemy.example');
  });

  it('surfaces load errors inside the expanded infra panels', async () => {
    const { RiskInfraSection } = await import('../../dashboard/src/pages/risk-gates/RiskInfraSection');
    const element = RiskInfraSection({
      section: {
        loadError: 'Infra fetch failed',
        infra: null,
        showInfra: true,
        onToggleInfra: vi.fn()
      }
    });

    expect(textContent(element)).toContain('Infra fetch failed');
  });
});
