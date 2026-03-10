import { describe, expect, it } from 'vitest';

import { DEFAULT_TRADE_POLICY } from '../../src/config/policy.js';
import type { DependencyEdge } from '../../src/domain/dependency.js';
import type { FwLoopDiagnostics } from '../../src/agents/projection/fw/types.js';
import {
  buildConstraintRows,
  buildOracleRequest,
  canProceedWithApproximateLoopIterate,
  mapNonConvergedReason,
  toLoopPolicy
} from '../../src/agents/projection/FwProjectionAgentSupport.js';

describe('FwProjectionAgentSupport direct coverage', () => {
  it('builds constraint rows for deterministic dependency relations', () => {
    const entries = [
      { marketId: 'market-a' },
      { marketId: 'market-b' },
      { marketId: 'market-c' }
    ] as Array<{
      marketId: string;
    }>;
    const edges: DependencyEdge[] = [
      {
        marketA: 'market-a',
        marketB: 'market-b',
        relationType: 'mutual_exclusive',
        confidence: 1,
        source: 'deterministic',
        evidence: 'shared stem',
        extractedAtMs: 1
      },
      {
        marketA: 'market-b',
        marketB: 'market-c',
        relationType: 'implies',
        confidence: 0.8,
        source: 'catalog',
        evidence: 'catalog relation',
        extractedAtMs: 2
      }
    ];

    const rows = buildConstraintRows(entries as never, edges);

    expect(rows).toEqual([
      { coefficients: [1, 1, 0], op: '<=', rhs: 1 },
      { coefficients: [0, 1, -1], op: '<=', rhs: 0 }
    ]);
  });

  it('maps loop policy and oracle requests directly', () => {
    const loopPolicy = toLoopPolicy(DEFAULT_TRADE_POLICY);
    const request = buildOracleRequest({
      loopId: 'loop-1',
      iteration: 3,
      variables: ['a', 'b'],
      objectiveCoefficients: [0.4, 0.6],
      rows: [{ coefficients: [1, 1], op: '<=', rhs: 1 }],
      timeLimitMs: 250,
      warmStart: [0.9, 0.1]
    });

    expect(loopPolicy).toMatchObject({
      maxIterations: DEFAULT_TRADE_POLICY.fwMaxIterations,
      maxLoopRuntimeMs: DEFAULT_TRADE_POLICY.fwMaxLoopRuntimeMs
    });
    expect(request).toMatchObject({
      loopId: 'loop-1',
      iteration: 3,
      timeLimitMs: 250,
      objective: {
        variables: ['a', 'b'],
        coefficients: [0.4, 0.6],
        sense: 'max'
      },
      constraints: {
        type: 'linear_binary',
        rows: [{ coefficients: [1, 1], op: '<=', rhs: 1 }]
      },
      warmStartHint: {
        variables: ['a', 'b'],
        values: [1, 0]
      }
    });
  });

  it('maps non-converged loop reasons and approximate-iterate eligibility', () => {
    const diagnostics: FwLoopDiagnostics = {
      loopId: 'loop-1',
      iterationCount: 5,
      activeSetSize: 2,
      contractionSteps: 1,
      terminalGapAbs: 0.01,
      terminalGapRel: 0.02,
      terminalReason: 'runtime_budget',
      converged: false,
      runtimeMs: 50
    };

    expect(mapNonConvergedReason(diagnostics)).toBe('projection_runtime_budget');
    expect(
      canProceedWithApproximateLoopIterate({
        diagnostics,
        activeSet: [],
        iterate: { point: [0, 0.3], value: 0.3 }
      })
    ).toBe(true);
    expect(
      canProceedWithApproximateLoopIterate({
        diagnostics,
        activeSet: [],
        iterate: { point: [0, 0], value: 0 }
      })
    ).toBe(false);
  });
});
