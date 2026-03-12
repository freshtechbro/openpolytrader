import { dot, evaluateFwGradient, evaluateFwObjective, l2Distance } from './objective.js';
import { projectToSimplex } from './simplex.js';
import type { FwObjectiveContext, FwVertex } from './types.js';

interface HullSolveInput {
  activeSet: FwVertex[];
  context: FwObjectiveContext;
  initialWeights?: number[];
  maxIterations: number;
  tolerance: number;
}

interface HullSolveResult {
  point: number[];
  weights: number[];
  objective: number;
  iterations: number;
  converged: boolean;
}

export function solveActiveSetHull(input: HullSolveInput): HullSolveResult {
  const vertices = input.activeSet;
  if (vertices.length === 0) {
    return {
      point: [],
      weights: [],
      objective: Number.POSITIVE_INFINITY,
      iterations: 0,
      converged: true
    };
  }
  if (vertices.length === 1) {
    const point = vertices[0].point.slice();
    return {
      point,
      weights: [1],
      objective: evaluateFwObjective(point, input.context),
      iterations: 0,
      converged: true
    };
  }

  const maxIterations = Math.max(1, Math.floor(input.maxIterations));
  const tolerance = Math.max(1e-12, input.tolerance);
  let weights = projectToSimplex(
    input.initialWeights && input.initialWeights.length === vertices.length
      ? input.initialWeights
      : Array.from({ length: vertices.length }, () => 1 / vertices.length)
  );
  let point = blend(vertices, weights);
  let objective = evaluateFwObjective(point, input.context);
  let converged = false;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const gradientX = evaluateFwGradient(point, input.context);
    const gradientW = vertices.map((vertex) => dot(gradientX, vertex.point));
    const stepSize = 2 / (iteration + 2);
    const candidateWeights = projectToSimplex(
      weights.map((weight, index) => weight - stepSize * gradientW[index])
    );
    const candidatePoint = blend(vertices, candidateWeights);
    const candidateObjective = evaluateFwObjective(candidatePoint, input.context);

    if (candidateObjective <= objective) {
      const delta = l2Distance(candidatePoint, point);
      weights = candidateWeights;
      point = candidatePoint;
      objective = candidateObjective;
      if (delta <= tolerance) {
        converged = true;
        return {
          point,
          weights,
          objective,
          iterations: iteration,
          converged
        };
      }
      continue;
    }

    const blendedWeights = projectToSimplex(
      weights.map((weight, index) => 0.5 * weight + 0.5 * candidateWeights[index])
    );
    const blendedPoint = blend(vertices, blendedWeights);
    const blendedObjective = evaluateFwObjective(blendedPoint, input.context);
    const delta = l2Distance(blendedPoint, point);
    weights = blendedWeights;
    point = blendedPoint;
    objective = blendedObjective;
    if (delta <= tolerance) {
      converged = true;
      return {
        point,
        weights,
        objective,
        iterations: iteration,
        converged
      };
    }
  }

  return {
    point,
    weights,
    objective,
    iterations: maxIterations,
    converged
  };
}

function blend(vertices: FwVertex[], weights: number[]): number[] {
  const dimension = vertices[0].point.length;
  const blended = Array.from({ length: dimension }, () => 0);
  for (let i = 0; i < vertices.length; i += 1) {
    const weight = weights[i] ?? 0;
    const point = vertices[i].point;
    for (let j = 0; j < dimension; j += 1) {
      blended[j] += weight * (point[j] ?? 0);
    }
  }
  return blended;
}
