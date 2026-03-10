import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubRepoLink } from '../../dashboard/src/components/GitHubRepoLink';
import { MetricCard } from '../../dashboard/src/components/MetricCard';
import { MetricsTable, type TableRow } from '../../dashboard/src/components/MetricsTable';
import { PageContainer } from '../../dashboard/src/components/PageContainer';
import { Panel } from '../../dashboard/src/components/Panel';
import { Section } from '../../dashboard/src/components/Section';
import { StatusPill } from '../../dashboard/src/components/StatusPill';
import { TopNav } from '../../dashboard/src/components/TopNav';
import { Hero } from '../../dashboard/src/components/public/Hero';
import { PageHero } from '../../dashboard/src/components/public/PageHero';
import { PipelineGrid } from '../../dashboard/src/components/public/PipelineGrid';
import { RiskPillars } from '../../dashboard/src/components/public/RiskPillars';
import { SectionBlock } from '../../dashboard/src/components/public/SectionBlock';
import { TrustStrip } from '../../dashboard/src/components/public/TrustStrip';
import { normalizeBaseUrl, normalizeString, parsePositiveInt } from '../../dashboard/src/lib/dashboardConfig';

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

function findAll(node: unknown, predicate: (entry: ElementLike) => boolean): ElementLike[] {
  if (!isElementLike(node)) return [];
  const matches = predicate(node) ? [node] : [];
  return childNodes(node.props.children).reduce<ElementLike[]>(
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
  if (isElementLike(node)) return textContent(node.props.children);
  return '';
}

function withWindowConfirm(confirmation: boolean) {
  Object.defineProperty(globalThis, 'window', {
    value: {
      confirm: vi.fn(() => confirmation)
    },
    configurable: true
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window');
});

describe('dashboard shared components', () => {
  it('renders the GitHub repo link with the configured destination', () => {
    const element = GitHubRepoLink({ className: 'extra-link' });

    expect(element.type).toBe('a');
    expect(element.props.className).toBe('github-repo-link extra-link');
    expect(element.props.href).toBe('https://github.com/freshtechbro/openpolytrader');
    expect(element.props.target).toBe('_blank');
    expect(element.props.rel).toBe('noopener noreferrer');
    expect(element.props['aria-label']).toBe('Open OpenPolyTrader GitHub repository');

    const icon = findOne(element, (entry) => entry.type === 'svg');
    expect(icon.props.role).toBe('img');
    expect(icon.props['aria-hidden']).toBe('true');
  });

  it('formats metric card values for display', () => {
    const element = MetricCard({ title: 'Orders placed', value: 1234 });
    const paragraphs = findAll(element, (entry) => entry.type === 'p');

    expect(element.props.className).toBe('metric-card');
    expect(paragraphs.map((entry) => textContent(entry.props.children))).toEqual(['Orders placed', '1,234']);
  });

  it('leaves string metric values untouched', () => {
    const element = MetricCard({ title: 'Mode', value: 'shadow' });

    expect(textContent(findAll(element, (entry) => entry.type === 'p')[1]!.props.children)).toBe('shadow');
  });

  it('renders a metrics table empty state', () => {
    const element = MetricsTable({ columns: ['Metric', 'Value'], rows: [], ariaLabel: 'Empty metrics' });
    const region = findOne(element, (entry) => entry.type === 'div');
    const emptyCell = findOne(element, (entry) => entry.type === 'td' && entry.props.className === 'table__empty');

    expect(region.props['aria-label']).toBe('Empty metrics');
    expect(emptyCell.props.colSpan).toBe(2);
    expect(textContent(emptyCell.props.children)).toBe('No data yet');
  });

  it('renders table rows with merged column and cell classes', () => {
    const rows: TableRow[] = [
      {
        key: 'signals',
        style: { opacity: 0.5 },
        cells: ['Signals', 12],
        cellClassNames: ['table__strong', undefined]
      }
    ];

    const element = MetricsTable({
      columns: ['Metric', 'Value'],
      rows,
      className: 'metrics-table',
      columnClassNames: ['column-metric', 'column-value']
    });

    const table = findOne(element, (entry) => entry.type === 'table');
    const row = findAll(element, (entry) => entry.type === 'tr')[1]!;
    const cells = findAll(row, (entry) => entry.type === 'td');

    expect(table.props.className).toBe('table metrics-table');
    expect(row.props.style).toEqual({ opacity: 0.5 });
    expect(cells.map((entry) => entry.props.className)).toEqual(['column-metric table__strong', 'column-value']);
    expect(cells.map((entry) => textContent(entry.props.children))).toEqual(['Signals', '12']);
  });

  it('renders array rows with generated keys and leaves empty class names undefined', () => {
    const element = MetricsTable({
      columns: ['Metric', 'Value'],
      rows: [['Health', 'Live']]
    });

    const row = findAll(element, (entry) => entry.type === 'tr')[1]!;
    const cells = findAll(row, (entry) => entry.type === 'td');

    expect(row.props.style).toBeUndefined();
    expect(cells.map((entry) => entry.props.className)).toEqual([undefined, undefined]);
    expect(cells.map((entry) => textContent(entry.props.children))).toEqual(['Health', 'Live']);
  });

  it('wraps page content in the shared page container class', () => {
    const element = PageContainer({ className: 'page-container--dense', children: 'Desk' });

    expect(element.type).toBe('main');
    expect(element.props.className).toBe('page-container page-container--dense');
    expect(textContent(element.props.children)).toBe('Desk');
  });

  it('uses the base page container class when no modifier is provided', () => {
    const element = PageContainer({ children: 'Fallback' });

    expect(element.props.className).toBe('page-container');
  });

  it('renders panel accents and labels from the accent prop', () => {
    const signalPanel = Panel({ title: 'Signals', body: 'Arb opportunities', accent: 'signal' });
    const alertPanel = Panel({ title: 'Alerts', body: 'Disconnected', accent: 'alert' });
    const neutralPanel = Panel({ title: 'Status', body: 'Stable' });

    expect(signalPanel.props.className).toBe('panel panel--signal');
    expect(textContent(findOne(signalPanel, (entry) => entry.props.className === 'panel__label').props.children)).toBe('Signal');
    expect(textContent(findOne(alertPanel, (entry) => entry.props.className === 'panel__label').props.children)).toBe('Alert');
    expect(textContent(findOne(neutralPanel, (entry) => entry.props.className === 'panel__label').props.children)).toBe('Neutral');
  });

  it('renders section headers with optional subtitle text', () => {
    const withSubtitle = Section({ title: 'Health', subtitle: 'Latest system state', children: 'Body' });
    const withoutSubtitle = Section({ title: 'Orders', children: 'Rows' });

    expect(textContent(findOne(withSubtitle, (entry) => entry.type === 'h2').props.children)).toBe('Health');
    expect(textContent(findOne(withSubtitle, (entry) => entry.type === 'p').props.children)).toBe('Latest system state');
    expect(findAll(withoutSubtitle, (entry) => entry.type === 'p')).toHaveLength(0);
  });

  it('renders both status pill states', () => {
    const healthy = StatusPill({ status: 'healthy' });
    const degraded = StatusPill({ status: 'degraded' });

    expect(healthy.props.className).toBe('status-pill status-pill--healthy');
    expect(textContent(healthy.props.children)).toBe('Healthy');
    expect(degraded.props.className).toBe('status-pill status-pill--degraded');
    expect(textContent(degraded.props.children)).toBe('Degraded');
  });

  it('renders top navigation status labels when controls are read-only', () => {
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'degraded',
      streamState: 'offline',
      tradingMode: null,
      tradingEnabled: false
    });

    const modeShell = findOne(element, (entry) => entry.props.className === 'trading-mode trading-mode--disabled');
    const modeValue = findOne(element, (entry) => entry.props.className === 'trading-mode__value');
    const enabled = findOne(element, (entry) => entry.props.className === 'trading-mode__enabled');
    const stream = findOne(element, (entry) => entry.props.className === 'stream stream--off');
    const statusComponent = findOne(
      element,
      (entry) => typeof entry.type === 'function' && entry.props.status === 'degraded'
    );

    expect(modeShell).toBeDefined();
    expect(textContent(modeValue.props.children)).toBe('Unknown');
    expect(textContent(enabled.props.children)).toBe('Disabled');
    expect(textContent(stream.props.children)).toBe('Stream offline');
    expect(statusComponent.props.status).toBe('degraded');
  });

  it('renders the off variant when mode is unknown but trading is enabled', () => {
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'live',
      tradingMode: null,
      tradingEnabled: true
    });

    const modeShell = findOne(element, (entry) => entry.props.className === 'trading-mode trading-mode--off');
    const enabled = findOne(element, (entry) => entry.props.className === 'trading-mode__enabled');
    const stream = findOne(element, (entry) => entry.props.className === 'stream stream--on');

    expect(modeShell).toBeDefined();
    expect(textContent(enabled.props.children)).toBe('Enabled');
    expect(textContent(stream.props.children)).toBe('Stream live');
  });

  it('falls back to unknown labels when runtime input is outside the supported mode set', () => {
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'connecting',
      tradingMode: 'unexpected' as never,
      tradingEnabled: null
    });

    const modeValue = findOne(element, (entry) => entry.props.className === 'trading-mode__value');

    expect(textContent(modeValue.props.children)).toBe('Unknown');
    expect(findAll(element, (entry) => entry.props.className === 'trading-mode__enabled')).toHaveLength(0);
  });

  it('blocks live mode changes when the confirmation dialog is rejected', () => {
    const onModeChange = vi.fn();
    withWindowConfirm(false);
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'live',
      tradingMode: 'shadow',
      tradingEnabled: true,
      onModeChange
    });

    const select = findOne(element, (entry) => entry.type === 'select');
    const event = { target: { value: 'live' } };
    const handleChange = select.props.onChange as ((event: never) => void) | undefined;

    expect(handleChange).toBeTypeOf('function');
    handleChange?.(event as never);

    expect((globalThis as { window: { confirm: ReturnType<typeof vi.fn> } }).window.confirm).toHaveBeenCalledOnce();
    expect(onModeChange).not.toHaveBeenCalled();
    expect(event.target.value).toBe('shadow');
  });

  it('falls back to shadow when a null mode cancels a live-mode confirmation', () => {
    const onModeChange = vi.fn();
    withWindowConfirm(false);
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'live',
      tradingMode: null,
      tradingEnabled: true,
      onModeChange
    });

    const select = findOne(element, (entry) => entry.type === 'select');
    const event = { target: { value: 'live' } };
    const handleChange = select.props.onChange as ((event: never) => void) | undefined;

    handleChange?.(event as never);

    expect(onModeChange).not.toHaveBeenCalled();
    expect(event.target.value).toBe('shadow');
  });

  it('confirms live mode changes and toggles trading state', () => {
    const onModeChange = vi.fn();
    const onEnabledChange = vi.fn();
    withWindowConfirm(true);
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'connecting',
      tradingMode: 'paper',
      tradingEnabled: true,
      onModeChange,
      onEnabledChange
    });

    const select = findOne(element, (entry) => entry.type === 'select');
    const toggle = findOne(element, (entry) => entry.type === 'button');
    const stream = findOne(element, (entry) => entry.props.className === 'stream stream--connecting');
    const handleChange = select.props.onChange as ((event: never) => void) | undefined;
    const handleToggle = toggle.props.onClick as (() => void) | undefined;

    handleChange?.({ target: { value: 'live' } } as never);
    handleToggle?.();

    expect(onModeChange).toHaveBeenCalledWith('live');
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(textContent(stream.props.children)).toBe('Stream connecting');
  });

  it('renders editable controls for null mode and disabled trading', () => {
    const onModeChange = vi.fn();
    const onEnabledChange = vi.fn();
    withWindowConfirm(false);
    const element = TopNav({
      title: 'OpenPolyTrader',
      subtitle: 'Desk',
      status: 'healthy',
      streamState: 'live',
      tradingMode: null,
      tradingEnabled: false,
      onModeChange,
      onEnabledChange
    });

    const select = findOne(element, (entry) => entry.type === 'select');
    const toggle = findOne(element, (entry) => entry.type === 'button');
    const handleChange = select.props.onChange as ((event: never) => void) | undefined;
    const event = { target: { value: 'paper' } };

    expect(select.props.value).toBe('shadow');
    expect(toggle.props.className).toBe('trading-mode__toggle trading-mode__toggle--off');
    expect(toggle.props['aria-label']).toBe('Enable trading');

    handleChange?.(event as never);
    expect(onModeChange).toHaveBeenCalledWith('paper');
  });

  it('renders public hero actions and execution-loop copy', () => {
    const element = Hero({
      eyebrow: 'Near-zero-risk automation',
      title: 'Trade with tighter control',
      lead: 'Monitor the full execution loop in one place.',
      actions: [
        { to: '/ops', label: 'Open ops', variant: 'primary' },
        { to: '/learn', label: 'Read docs', variant: 'ghost' }
      ]
    });

    const actionLinks = findAll(
      element,
      (entry) => typeof entry.props.to === 'string' && typeof entry.props.className === 'string'
    );
    const steps = findAll(element, (entry) => entry.type === 'li');

    expect(actionLinks.map((entry) => ({
      to: entry.props.to,
      className: entry.props.className,
      label: textContent(entry.props.children)
    }))).toEqual([
      { to: '/ops', className: 'button-link', label: 'Open ops' },
      { to: '/learn', className: 'button-link button-link--ghost', label: 'Read docs' }
    ]);
    expect(steps.map((entry) => textContent(entry.props.children))).toEqual([
      'Signal scores market state in real time.',
      'Risk gate checks edge, depth, and freshness.',
      'Execution submits single-shot, guarded orders.',
      'Portfolio reconciles fills and drift.'
    ]);
  });

  it('renders the compact page hero copy', () => {
    const element = PageHero({
      eyebrow: 'Operations',
      title: 'Control room',
      lead: 'Inspect health, incidents, and risk posture.'
    });

    expect(element.props.className).toBe('page-hero');
    expect(textContent(findOne(element, (entry) => entry.type === 'h1').props.children)).toBe('Control room');
    expect(textContent(findAll(element, (entry) => entry.type === 'p')[0]!.props.children)).toBe('Operations');
    expect(textContent(findAll(element, (entry) => entry.type === 'p')[1]!.props.children)).toBe(
      'Inspect health, incidents, and risk posture.'
    );
  });

  it('renders the landing pipeline grid stages', () => {
    const element = PipelineGrid();
    const cards = findAll(element, (entry) => entry.props.className === 'landing-grid__card');

    expect(textContent(findOne(element, (entry) => entry.type === 'h2').props.children)).toBe('Signal Grid pipeline');
    expect(cards).toHaveLength(5);
    expect(cards.map((entry) => textContent(entry.props.children))).toEqual([
      'SignalAggregates market and optional LLM advisory signals.',
      'ScannerBuilds candidates from live books and market catalog constraints.',
      'RiskApplies strict gate checks before any execution path opens.',
      'ExecutionSubmits guarded orders with deterministic timeout behavior.',
      'PortfolioReconciles exposure, fills, and runtime drift in near real time.'
    ]);
  });

  it('renders the risk pillars section', () => {
    const element = RiskPillars();
    const items = findAll(element, (entry) => entry.props.className === 'landing-pillars__item');

    expect(textContent(findOne(element, (entry) => entry.type === 'h2').props.children)).toBe('Risk-first operating model');
    expect(items).toHaveLength(4);
    expect(items.map((entry) => textContent(entry.props.children))).toEqual([
      'Explicit kill controlsTrading mode and enable flags are always visible in ops surfaces.',
      'Single-shot executionNo blind retries without fresh market state validation.',
      'Circuit and quarantineIncident thresholds isolate unstable markets before they cascade.',
      'Live telemetrySLO, incident, and decision streams are continuously inspectable.'
    ]);
  });

  it('renders section blocks with and without descriptions', () => {
    const described = SectionBlock({
      title: 'Overview',
      description: 'Runtime summary',
      children: 'Body'
    });
    const plain = SectionBlock({
      title: 'Details',
      children: 'Rows'
    });

    expect(textContent(findOne(described, (entry) => entry.type === 'h2').props.children)).toBe('Overview');
    expect(textContent(findOne(described, (entry) => entry.type === 'p').props.children)).toBe('Runtime summary');
    expect(findAll(plain, (entry) => entry.type === 'p')).toHaveLength(0);
  });

  it('renders the trust strip items and accessible label', () => {
    const element = TrustStrip();
    const items = findAll(element, (entry) => entry.props.className === 'trust-strip__item');

    expect(element.props['aria-label']).toBe('Trust signals');
    expect(items).toHaveLength(4);
    expect(items.map((entry) => textContent(entry.props.children))).toEqual([
      'Agent Pipeline8 specialized agents',
      'Risk DisciplineNear-zero by design',
      'State ModelEvent-sourced ledger',
      'Quality Bar>97% coverage target'
    ]);
  });

  it('normalizes dashboard config helpers for empty, invalid, and trimmed values', () => {
    expect(parsePositiveInt(undefined, 50)).toBe(50);
    expect(parsePositiveInt('42.8', 50)).toBe(42);
    expect(parsePositiveInt('0', 50)).toBe(50);
    expect(parsePositiveInt('nope', 50)).toBe(50);

    expect(normalizeString(undefined, 'fallback')).toBe('fallback');
    expect(normalizeString('   ', 'fallback')).toBe('fallback');
    expect(normalizeString('  live  ', 'fallback')).toBe('live');

    expect(normalizeBaseUrl(undefined, 'https://desk.local/')).toBe('https://desk.local');
    expect(normalizeBaseUrl('https://desk.local/', 'fallback')).toBe('https://desk.local');
    expect(normalizeBaseUrl('   ', 'fallback')).toBe('fallback');
    expect(normalizeBaseUrl('', '')).toBe('');
  });
});
