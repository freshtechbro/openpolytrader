import { describe, expect, it } from 'vitest';

import { FwLoopEngine } from '../../src/agents/projection/fw/FwLoopEngine.js';

describe('FwLoopEngine', () => {
  it('converges with a deterministic oracle', async () => {
    const engine = new FwLoopEngine();
    const variableOrder = ['x1', 'x2'];
    const result = await engine.run({
      loopId: 'loop-1',
      variableOrder,
      edgeCoefficients: [0.06, 0.01],
      policy: {
        maxIterations: 10,
        maxLoopRuntimeMs: 500,
        gapAbsTolerance: 1e-4,
        gapRelTolerance: 1e-3,
        contractionInitialEpsilon: 0.1,
        contractionDecay: 0.5,
        contractionMinEpsilon: 0.01,
        stallIterationLimit: 2,
        activeSetMaxVertices: 6,
        hullSolveMaxIterations: 20,
        hullSolveTolerance: 1e-5
      },
      oracleSolve: async ({ objectiveCoefficients }) => {
        const assignment = {
          x1: objectiveCoefficients[0] >= objectiveCoefficients[1] ? 1 : 0,
          x2: objectiveCoefficients[0] >= objectiveCoefficients[1] ? 0 : 1
        };
        return {
          status: 'feasible',
          runtimeMs: 1,
          assignment,
          objectiveValue: Math.max(objectiveCoefficients[0], objectiveCoefficients[1])
        };
      }
    });

    expect(result.iterate).not.toBeNull();
    expect(result.diagnostics.iterationCount).toBeGreaterThan(0);
    expect(result.diagnostics.converged).toBe(true);
    expect(result.diagnostics.terminalReason).toBe('gap_converged');
  });

  it('returns oracle_unavailable when initial oracle call is not feasible', async () => {
    const engine = new FwLoopEngine();
    const result = await engine.run({
      loopId: 'loop-2',
      variableOrder: ['x1'],
      edgeCoefficients: [0.04],
      policy: {
        maxIterations: 5,
        maxLoopRuntimeMs: 100,
        gapAbsTolerance: 1e-4,
        gapRelTolerance: 1e-3,
        contractionInitialEpsilon: 0.1,
        contractionDecay: 0.5,
        contractionMinEpsilon: 0.01,
        stallIterationLimit: 1,
        activeSetMaxVertices: 3,
        hullSolveMaxIterations: 10,
        hullSolveTolerance: 1e-6
      },
      oracleSolve: async () => ({
        status: 'timeout',
        runtimeMs: 5
      })
    });

    expect(result.iterate).toBeNull();
    expect(result.diagnostics.terminalReason).toBe('oracle_unavailable');
  });
});
