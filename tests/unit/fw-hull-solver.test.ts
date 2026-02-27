import { describe, expect, it } from 'vitest';

import { solveActiveSetHull } from '../../src/agents/projection/fw/hullSolver.js';

describe('FW hull solver', () => {
  it('returns simplex weights and a finite objective', () => {
    const result = solveActiveSetHull({
      activeSet: [
        { key: 'v1', point: [1, 0], assignment: { x1: 1, x2: 0 } },
        { key: 'v2', point: [0, 1], assignment: { x1: 0, x2: 1 } }
      ],
      context: {
        edgeCoefficients: [0.06, 0.01],
        interiorPoint: [0.5, 0.5],
        regularization: 1
      },
      maxIterations: 50,
      tolerance: 1e-6
    });

    const weightSum = result.weights.reduce((sum, value) => sum + value, 0);
    expect(result.weights).toHaveLength(2);
    expect(weightSum).toBeCloseTo(1, 6);
    expect(result.weights.every((value) => value >= 0)).toBe(true);
    expect(Number.isFinite(result.objective)).toBe(true);
  });

  it('handles single-vertex hull trivially', () => {
    const result = solveActiveSetHull({
      activeSet: [{ key: 'v1', point: [1], assignment: { x1: 1 } }],
      context: {
        edgeCoefficients: [0.05],
        interiorPoint: [0.5],
        regularization: 1
      },
      maxIterations: 10,
      tolerance: 1e-6
    });

    expect(result.weights).toEqual([1]);
    expect(result.point).toEqual([1]);
    expect(result.converged).toBe(true);
  });
});
