import { describe, expect, it } from 'vitest';

import { clipUnitInterval, projectToSimplex } from '../../src/agents/projection/fw/simplex.js';

describe('fw runtime contracts', () => {
  it('projects vectors onto the simplex with normalized non-negative weights', () => {
    expect(projectToSimplex([])).toEqual([]);
    expect(projectToSimplex([42])).toEqual([1]);

    const projected = projectToSimplex([2, -1, Number.NaN, 0.5]);

    expect(projected).toHaveLength(4);
    expect(projected.every((value) => value >= 0)).toBe(true);
    expect(projected.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it('clips values into the unit interval', () => {
    expect(clipUnitInterval([-1, 0.25, 2, Number.NaN])).toEqual([0, 0.25, 1, 0]);
  });

  it('keeps fw types as a type-only runtime module', async () => {
    const runtimeModule = await import('../../src/agents/projection/fw/types.js');

    expect(Object.keys(runtimeModule)).toEqual([]);
  });
});
