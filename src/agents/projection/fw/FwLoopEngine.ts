import { randomUUID } from 'node:crypto';

import { solveActiveSetHull } from './hullSolver.js';
import {
  contractTowardInterior,
  dot,
  evaluateFwGradient,
  evaluateFwObjective,
  l2Distance
} from './objective.js';
import { clipUnitInterval } from './simplex.js';
import type {
  FwLoopDiagnostics,
  FwLoopRequest,
  FwLoopResult,
  FwObjectiveContext,
  FwVertex
} from './types.js';

const FEASIBLE_STATUSES = new Set(['optimal', 'feasible']);

export class FwLoopEngine {
  async run(request: FwLoopRequest): Promise<FwLoopResult> {
    const startMs = Date.now();
    const dimension = request.variableOrder.length;
    const loopId = request.loopId || randomUUID();
    const interior = normalizeInteriorPoint(request.interiorPoint, dimension);
    const policy = request.policy;
    const context: FwObjectiveContext = {
      edgeCoefficients: request.edgeCoefficients.slice(0, dimension),
      interiorPoint: interior,
      regularization: 1
    };

    const emptyDiagnostics: FwLoopDiagnostics = {
      loopId,
      iterationCount: 0,
      activeSetSize: 0,
      contractionSteps: 0,
      terminalGapAbs: Number.POSITIVE_INFINITY,
      terminalGapRel: Number.POSITIVE_INFINITY,
      terminalReason: 'oracle_unavailable',
      converged: false,
      runtimeMs: 0,
      iterations: []
    };

    const initialOracle = await request.oracleSolve({
      loopId,
      iteration: 0,
      objectiveCoefficients: request.edgeCoefficients.slice(0, dimension),
      warmStart: request.edgeCoefficients
        .slice(0, dimension)
        .map((coefficient) => (Number.isFinite(coefficient) && coefficient > 0 ? 1 : 0))
    });

    if (!isFeasible(initialOracle.status) || !initialOracle.assignment) {
      return {
        iterate: null,
        diagnostics: {
          ...emptyDiagnostics,
          runtimeMs: Date.now() - startMs
        },
        reason: initialOracle.error ?? `oracle_${initialOracle.status}`
      };
    }

    const activeSet: FwVertex[] = [
      assignmentToVertex(
        request.variableOrder,
        initialOracle.assignment,
        initialOracle.objectiveValue
      )
    ];
    let weights = [1];
    let point = activeSet[0].point.slice();
    let objective = evaluateFwObjective(point, context);
    let best = { point: point.slice(), objective, weights: weights.slice() };
    let epsilon = policy.contractionInitialEpsilon;
    let contractionSteps = 0;
    let stallCount = 0;
    let terminalReason: FwLoopDiagnostics['terminalReason'] = 'max_iterations';
    let terminalGapAbs = Number.POSITIVE_INFINITY;
    let terminalGapRel = Number.POSITIVE_INFINITY;
    const iterations: FwLoopDiagnostics['iterations'] = [];

    const maxIterations = Math.max(1, policy.maxIterations);
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const runtimeMs = Date.now() - startMs;
      if (runtimeMs > policy.maxLoopRuntimeMs) {
        terminalReason = 'runtime_budget';
        break;
      }

      const gradient = evaluateFwGradient(point, context);
      const oracle = await request.oracleSolve({
        loopId,
        iteration,
        objectiveCoefficients: gradient.map((value) => -value),
        warmStart: point
      });

      if (!isFeasible(oracle.status) || !oracle.assignment) {
        terminalReason = 'oracle_unavailable';
        break;
      }

      const vertex = assignmentToVertex(
        request.variableOrder,
        oracle.assignment,
        oracle.objectiveValue
      );
      const contractedPoint = clipUnitInterval(
        contractTowardInterior(vertex.point, interior, epsilon)
      );
      const contractedVertex: FwVertex = {
        key: `${vertex.key}:eps:${epsilon.toFixed(6)}`,
        point: contractedPoint,
        assignment: vertex.assignment,
        objectiveValue: oracle.objectiveValue
      };

      if (!activeSet.some((candidate) => l2Distance(candidate.point, contractedVertex.point) <= 1e-9)) {
        activeSet.push(contractedVertex);
      }

      while (activeSet.length > policy.activeSetMaxVertices) {
        const removableIndex = pickRemovableVertexIndex(weights, activeSet.length);
        activeSet.splice(removableIndex, 1);
        weights = projectWeights(weights, activeSet.length);
      }

      const hull = solveActiveSetHull({
        activeSet,
        context,
        initialWeights: projectWeights(weights, activeSet.length),
        maxIterations: policy.hullSolveMaxIterations,
        tolerance: policy.hullSolveTolerance
      });

      const previousPoint = point;
      const previousObjective = objective;
      point = clipUnitInterval(hull.point);
      weights = hull.weights;
      objective = evaluateFwObjective(point, context);
      const descent = previousObjective - objective;
      const iterateShift = l2Distance(previousPoint, point);

      const gapAbs = Math.max(0, dot(gradient, previousPoint.map((value, index) => value - contractedPoint[index])));
      const gapRel = gapAbs / Math.max(Math.abs(previousObjective), 1e-9);
      terminalGapAbs = gapAbs;
      terminalGapRel = gapRel;

      iterations.push({
        iteration,
        objective,
        gapAbs,
        gapRel,
        activeSetSize: activeSet.length,
        contractionEpsilon: epsilon,
        runtimeMs: Date.now() - startMs
      });

      if (objective < best.objective) {
        best = { point: point.slice(), objective, weights: weights.slice() };
      }

      if (
        gapAbs <= policy.gapAbsTolerance ||
        gapRel <= policy.gapRelTolerance ||
        iterateShift <= policy.hullSolveTolerance
      ) {
        terminalReason = 'gap_converged';
        break;
      }

      if (descent <= policy.gapAbsTolerance * 0.25) {
        stallCount += 1;
      } else {
        stallCount = 0;
      }

      if (stallCount >= policy.stallIterationLimit) {
        const nextEpsilon = Math.max(policy.contractionMinEpsilon, epsilon * policy.contractionDecay);
        if (nextEpsilon <= policy.contractionMinEpsilon + 1e-12) {
          terminalReason = 'contraction_floor';
          break;
        }
        epsilon = nextEpsilon;
        contractionSteps += 1;
        stallCount = 0;
      }

      if (iteration === maxIterations) {
        terminalReason = 'max_iterations';
      }
    }

    const runtimeMs = Date.now() - startMs;
    const diagnostics: FwLoopDiagnostics = {
      loopId,
      iterationCount: iterations.length,
      activeSetSize: activeSet.length,
      contractionSteps,
      terminalGapAbs,
      terminalGapRel,
      terminalReason,
      converged: terminalReason === 'gap_converged',
      runtimeMs,
      iterations
    };

    return {
      iterate: {
        point: best.point,
        objective: best.objective,
        weights: best.weights,
        activeSet
      },
      diagnostics
    };
  }
}

function assignmentToVertex(
  variableOrder: string[],
  assignment: Record<string, number>,
  objectiveValue?: number
): FwVertex {
  const point = variableOrder.map((variable) => {
    const value = assignment[variable];
    if (!Number.isFinite(value)) return 0;
    return value >= 0.5 ? 1 : 0;
  });
  const key = point.map((value) => (value >= 0.5 ? '1' : '0')).join('');
  return {
    key,
    point,
    assignment,
    objectiveValue
  };
}

function normalizeInteriorPoint(interiorPoint: number[] | undefined, size: number): number[] {
  if (!interiorPoint || interiorPoint.length !== size) {
    return Array.from({ length: size }, () => 0.5);
  }
  return interiorPoint.map((value) => {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
  });
}

function isFeasible(status: string): boolean {
  return FEASIBLE_STATUSES.has(status);
}

function projectWeights(weights: number[], size: number): number[] {
  if (size <= 0) return [];
  if (weights.length !== size) {
    return Array.from({ length: size }, () => 1 / size);
  }
  const sum = weights.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  if (sum <= 0) return Array.from({ length: size }, () => 1 / size);
  return weights.map((value) => (Number.isFinite(value) ? value : 0) / sum);
}

function pickRemovableVertexIndex(weights: number[], activeSetSize: number): number {
  if (activeSetSize <= 1) return 0;
  const normalized = projectWeights(weights, activeSetSize);
  let minWeight = Number.POSITIVE_INFINITY;
  let index = 0;
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] < minWeight) {
      minWeight = normalized[i];
      index = i;
    }
  }
  return index;
}
