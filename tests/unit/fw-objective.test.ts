import { describe, expect, it } from 'vitest';

import {
  contractTowardInterior,
  dot,
  evaluateFwGradient,
  evaluateFwObjective,
  l2Distance
} from '../../src/agents/projection/fw/objective.js';

describe('FW objective utilities', () => {
  it('evaluates objective and gradient with finite outputs', () => {
    const context = {
      edgeCoefficients: [0.04, 0.02],
      interiorPoint: [0.5, 0.5],
      regularization: 1
    };
    const point = [0.8, 0.1];
    const objective = evaluateFwObjective(point, context);
    const gradient = evaluateFwGradient(point, context);

    expect(Number.isFinite(objective)).toBe(true);
    expect(gradient).toHaveLength(2);
    expect(gradient.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('contracts a vertex toward the interior point', () => {
    const contracted = contractTowardInterior([1, 0], [0.5, 0.5], 0.2);
    expect(contracted[0]).toBeCloseTo(0.9, 6);
    expect(contracted[1]).toBeCloseTo(0.1, 6);
  });

  it('computes dot and l2 distance', () => {
    expect(dot([1, 2, 3], [2, 0, 1])).toBe(5);
    expect(l2Distance([1, 1], [1, 1])).toBe(0);
    expect(l2Distance([1, 0], [0, 1])).toBeCloseTo(Math.sqrt(2), 6);
  });
});
