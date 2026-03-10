import { describe, expect, it } from 'vitest';

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

describe('dashboard route/risk helper modules', () => {
  it('resolves ops paths, infers intent metadata, and exposes risk profile labels', async () => {
    const {
      DEFAULT_OPS_PAGE,
      LOGOUT_FAILURE_MESSAGE,
      OPS_PATHS,
      asRecord,
      asString,
      canonicalOpsPath,
      getMarketQuestion,
      inferIntentStrategy,
      inferMarketId,
      normalizeIntentStrategy,
      resolveOpsPage,
      upsertIntent
    } = await import('../../dashboard/src/routes/opsLayoutUtils');
    const { DEFAULT_VISIBLE_FIELDS, RISK_PROFILES, riskProfileLabel } = await import('../../dashboard/src/pages/risk-gates/shared');

    expect(DEFAULT_OPS_PAGE).toBe('overview');
    expect(OPS_PATHS).toHaveLength(6);
    expect(LOGOUT_FAILURE_MESSAGE).toContain('Logout failed');
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asString('  hi  ')).toBe('  hi  ');
    expect(inferMarketId('0xabc123456789012345678901234567890123456:yes:0.45:1700')).toBe(
      '0xabc123456789012345678901234567890123456'
    );
    expect(getMarketQuestion([{ key: 'market-1', question: ' Question 1 ' } as never], 'market-1')).toBe('Question 1');
    expect(normalizeIntentStrategy('ev_single_side')).toBe('ev');
    expect(inferIntentStrategy('market:fw:0.1:0.1:1700')).toBe('fw_projection');
    expect(resolveOpsPage('/ops/risk-gates')).toBe('risk');
    expect(canonicalOpsPath('/ops/unknown')).toBe('/ops/overview');
    expect(
      upsertIntent(
        [{ opportunityId: 'opp-1', gatedAt: 10 } as never],
        { opportunityId: 'opp-1', gatedAt: 20 } as never
      )
    ).toEqual([{ opportunityId: 'opp-1', gatedAt: 20 }]);
    expect(DEFAULT_VISIBLE_FIELDS).toBe(10);
    expect(RISK_PROFILES).toHaveLength(4);
    expect(riskProfileLabel('high')).toContain('High Risk');
  });

  it('renders the auth and risk profile panels with the expected controls', async () => {
    const { OpsAuthView } = await import('../../dashboard/src/routes/OpsAuthView');
    const { RiskProfilePanel, TradingModePanel } = await import('../../dashboard/src/pages/risk-gates/RiskProfilePanels');

    const authElement = OpsAuthView({
      session: { checking: false, authenticated: false, authRequired: true, error: 'Session expired' },
      loginToken: 'token-123',
      loginSubmitting: false,
      loginError: 'Bad token',
      onLoginTokenChange: () => undefined,
      onLoginSubmit: () => undefined,
      onRetry: () => undefined
    });

    expect(textContent(authElement)).toContain('Operator sign in');
    expect(textContent(authElement)).toContain('Session expired');
    expect(textContent(authElement)).toContain('Bad token');
    expect(findOne(authElement, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Next')).toBeDefined();

    const profileElement = RiskProfilePanel({
      section: {
        loadError: null,
        activeProfile: 'high',
        activeProfileSource: 'persisted',
        availableProfiles: ['near_zero', 'high'],
        profileDraft: 'near_zero',
        profileState: { saving: false, savedAt: 1_700_000_000_000 },
        getRiskProfileLabel: (id) => id.toUpperCase(),
        onProfileDraftChange: () => undefined,
        onApplyProfile: () => undefined
      }
    });

    expect(textContent(profileElement)).toContain('Risk Profile');
    expect(textContent(profileElement)).toContain('high (persisted)');
    expect(findAll(profileElement, (entry) => entry.type === 'option')).toHaveLength(2);
    expect(findOne(profileElement, (entry) => entry.type === 'button' && textContent(entry.props.children) === 'Apply profile')).toBeDefined();

    const tradingElement = TradingModePanel({
      section: {
        loadError: null,
        tradingEnabled: true,
        tradingMode: 'paper'
      }
    });

    expect(textContent(tradingElement)).toContain('Trading Mode');
    expect(textContent(tradingElement)).toContain('true');
    expect(textContent(tradingElement)).toContain('paper');
  });
});
