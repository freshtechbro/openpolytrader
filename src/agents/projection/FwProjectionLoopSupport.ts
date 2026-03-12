import { randomUUID } from 'node:crypto';

import type { TradePolicy } from '../../config/policy.js';
import type { DependencyEdge } from '../../domain/dependency.js';
import type { MetricsStore } from '../../telemetry/metrics.js';
import type { IpOracleRequest } from '../../services/ip-oracle/IpOracleClient.js';
import type { FwLoopDiagnostics, FwLoopPolicy, FwLoopResult } from './fw/types.js';

interface ConstraintRowMarketEntry {
  marketId: string;
}

export function buildConstraintRows(
  entries: ConstraintRowMarketEntry[],
  dependencyEdges: DependencyEdge[]
): IpOracleRequest['constraints']['rows'] {
  const marketIndexById = new Map(entries.map((entry, index) => [entry.marketId, index]));
  const rows: IpOracleRequest['constraints']['rows'] = [];

  for (const edge of dependencyEdges) {
    const leftIndex = marketIndexById.get(edge.marketA);
    const rightIndex = marketIndexById.get(edge.marketB);
    if (leftIndex === undefined || rightIndex === undefined || leftIndex === rightIndex) continue;

    const coefficients = zeroRow(entries.length);
    let op: '<=' | '>=' | '=' | null = null;
    let rhs = 0;
    switch (edge.relationType) {
      case 'mutual_exclusive':
      case 'partition':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = 1;
        op = '<=';
        rhs = 1;
        break;
      case 'implies':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = -1;
        op = '<=';
        rhs = 0;
        break;
      case 'complementary':
        coefficients[leftIndex] = 1;
        coefficients[rightIndex] = -1;
        op = '=';
        rhs = 0;
        break;
      default:
        break;
    }
    if (op) rows.push({ coefficients, op, rhs });
  }

  return rows;
}

export function toLoopPolicy(policy: TradePolicy): FwLoopPolicy {
  return {
    maxIterations: policy.fwMaxIterations,
    maxLoopRuntimeMs: policy.fwMaxLoopRuntimeMs,
    gapAbsTolerance: policy.fwGapAbsTolerance,
    gapRelTolerance: policy.fwGapRelTolerance,
    contractionInitialEpsilon: policy.fwContractionInitialEpsilon,
    contractionDecay: policy.fwContractionDecay,
    contractionMinEpsilon: policy.fwContractionMinEpsilon,
    stallIterationLimit: policy.fwStallIterationLimit,
    activeSetMaxVertices: policy.fwActiveSetMaxVertices,
    hullSolveMaxIterations: policy.fwHullSolveMaxIterations,
    hullSolveTolerance: policy.fwHullSolveTolerance
  };
}

export function buildOracleRequest(input: {
  loopId: string;
  iteration: number;
  variables: string[];
  objectiveCoefficients: number[];
  rows: IpOracleRequest['constraints']['rows'];
  timeLimitMs: number;
  warmStart?: number[];
}): IpOracleRequest {
  const warmStart =
    input.warmStart && input.warmStart.length === input.variables.length
      ? {
          variables: input.variables,
          values: input.warmStart.map((value) => (Number.isFinite(value) && value >= 0.5 ? 1 : 0))
        }
      : undefined;

  return {
    requestId: randomUUID(),
    loopId: input.loopId,
    iteration: input.iteration,
    timeLimitMs: input.timeLimitMs,
    objective: {
      variables: input.variables,
      coefficients: input.objectiveCoefficients,
      sense: 'max'
    },
    constraints: {
      type: 'linear_binary',
      rows: input.rows
    },
    warmStartHint: warmStart
  };
}

export function mapNonConvergedReason(diagnostics: FwLoopDiagnostics): string {
  switch (diagnostics.terminalReason) {
    case 'runtime_budget':
      return 'projection_runtime_budget';
    case 'max_iterations':
      return 'projection_max_iterations';
    case 'contraction_floor':
      return 'projection_contraction_floor';
    default:
      return 'projection_not_converged';
  }
}

export function canProceedWithApproximateLoopIterate(loop: FwLoopResult): boolean {
  return !!loop.iterate && loop.iterate.point.some((value) => value > 0);
}

export function emitLoopDiagnostics(
  metrics: MetricsStore | undefined,
  diagnostics: FwLoopDiagnostics,
  nowMs: number,
  markets: number
): void {
  if (!metrics) return;
  metrics.record({
    type: 'fw_iteration',
    timestamp: nowMs,
    data: {
      loopId: diagnostics.loopId,
      iterationCount: diagnostics.iterationCount,
      activeSetSize: diagnostics.activeSetSize,
      contractionSteps: diagnostics.contractionSteps,
      runtimeMs: diagnostics.runtimeMs,
      terminalReason: diagnostics.terminalReason,
      converged: diagnostics.converged,
      markets
    }
  });
  metrics.record({
    type: 'fw_gap',
    timestamp: nowMs,
    data: {
      loopId: diagnostics.loopId,
      gapAbs: diagnostics.terminalGapAbs,
      gapRel: diagnostics.terminalGapRel,
      markets
    }
  });
}

function zeroRow(size: number): number[] {
  return Array.from({ length: size }, () => 0);
}
