import { describe, expect, it } from 'vitest';

import {
  ensureFwRelationCatalogStartupReady,
  isFwRelationModeEnabled
} from '../../src/agents/dependency/FwRelationCatalogStartupGuard.js';
import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import { MetricsStore } from '../../src/telemetry/metrics.js';

describe('FwRelationCatalogStartupGuard', () => {
  it('detects relation mode from candidate caps', () => {
    expect(isFwRelationModeEnabled(DEFAULT_TRADE_POLICY)).toBe(true);
    expect(
      isFwRelationModeEnabled({
        ...DEFAULT_TRADE_POLICY,
        fwRelationCandidatesPerMarketMax: 0
      })
    ).toBe(false);
    expect(
      isFwRelationModeEnabled({
        ...DEFAULT_TRADE_POLICY,
        fwRelationCandidatesTotalMax: 0
      })
    ).toBe(false);
  });

  it('skips guard when trading is disabled or mode is not paper', () => {
    const metrics = new MetricsStore(10);
    expect(() =>
      ensureFwRelationCatalogStartupReady({
        tradingEnabled: false,
        tradingMode: 'paper',
        policy: DEFAULT_TRADE_POLICY,
        relationCatalogPath: '/tmp/relations.json',
        relationCatalogEntries: 0,
        metrics
      })
    ).not.toThrow();
    expect(() =>
      ensureFwRelationCatalogStartupReady({
        tradingEnabled: true,
        tradingMode: 'shadow',
        policy: DEFAULT_TRADE_POLICY,
        relationCatalogPath: '/tmp/relations.json',
        relationCatalogEntries: 0,
        metrics
      })
    ).not.toThrow();
  });

  it('skips guard when relation mode is disabled', () => {
    const metrics = new MetricsStore(10);
    expect(() =>
      ensureFwRelationCatalogStartupReady({
        tradingEnabled: true,
        tradingMode: 'paper',
        policy: {
          ...DEFAULT_TRADE_POLICY,
          fwRelationCandidatesPerMarketMax: 0,
          fwRelationCandidatesTotalMax: 0
        },
        relationCatalogPath: '/tmp/relations.json',
        relationCatalogEntries: 0,
        metrics
      })
    ).not.toThrow();
  });

  it('throws and records incident when relation mode is enabled with empty catalog', () => {
    const metrics = new MetricsStore(10);
    expect(() =>
      ensureFwRelationCatalogStartupReady({
        tradingEnabled: true,
        tradingMode: 'paper',
        policy: DEFAULT_TRADE_POLICY,
        relationCatalogPath: '/tmp/relations.json',
        relationCatalogEntries: 0,
        metrics
      })
    ).toThrow('FW relation catalog is empty');

    const incidents = metrics.recent('incident', 10);
    expect(
      incidents.some(
        (event) =>
          event.data &&
          typeof event.data === 'object' &&
          (event.data as { reason?: string }).reason === 'fw_relation_catalog_empty_startup'
      )
    ).toBe(true);
  });

  it('passes when relation mode is enabled and catalog has entries', () => {
    const metrics = new MetricsStore(10);
    expect(() =>
      ensureFwRelationCatalogStartupReady({
        tradingEnabled: true,
        tradingMode: 'paper',
        policy: DEFAULT_TRADE_POLICY,
        relationCatalogPath: '/tmp/relations.json',
        relationCatalogEntries: 3,
        metrics
      })
    ).not.toThrow();
  });
});

