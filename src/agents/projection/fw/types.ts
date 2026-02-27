export type FwLoopTerminalReason =
  | 'gap_converged'
  | 'runtime_budget'
  | 'max_iterations'
  | 'contraction_floor'
  | 'oracle_unavailable';

export interface FwVertex {
  key: string;
  point: number[];
  assignment: Record<string, number>;
  objectiveValue?: number;
}

export interface FwIterate {
  point: number[];
  objective: number;
  weights: number[];
  activeSet: FwVertex[];
}

export interface FwIterationDiagnostics {
  iteration: number;
  objective: number;
  gapAbs: number;
  gapRel: number;
  activeSetSize: number;
  contractionEpsilon: number;
  runtimeMs: number;
}

export interface FwLoopDiagnostics {
  loopId: string;
  iterationCount: number;
  activeSetSize: number;
  contractionSteps: number;
  terminalGapAbs: number;
  terminalGapRel: number;
  terminalReason: FwLoopTerminalReason;
  converged: boolean;
  runtimeMs: number;
  iterations: FwIterationDiagnostics[];
}

export interface FwObjectiveContext {
  edgeCoefficients: number[];
  interiorPoint: number[];
  regularization: number;
}

export interface FwOracleSolveResult {
  status: 'optimal' | 'feasible' | 'infeasible' | 'timeout' | 'error' | 'unknown';
  runtimeMs: number;
  assignment?: Record<string, number>;
  objectiveValue?: number;
  gap?: number;
  bestBound?: number;
  relativeGap?: number;
  error?: string | null;
}

export interface FwLoopPolicy {
  maxIterations: number;
  maxLoopRuntimeMs: number;
  gapAbsTolerance: number;
  gapRelTolerance: number;
  contractionInitialEpsilon: number;
  contractionDecay: number;
  contractionMinEpsilon: number;
  stallIterationLimit: number;
  activeSetMaxVertices: number;
  hullSolveMaxIterations: number;
  hullSolveTolerance: number;
}

export interface FwLoopRequest {
  loopId: string;
  variableOrder: string[];
  edgeCoefficients: number[];
  interiorPoint?: number[];
  policy: FwLoopPolicy;
  oracleSolve: (input: {
    loopId: string;
    iteration: number;
    objectiveCoefficients: number[];
    warmStart?: number[];
  }) => Promise<FwOracleSolveResult>;
}

export interface FwLoopResult {
  iterate: FwIterate | null;
  diagnostics: FwLoopDiagnostics;
  reason?: string;
}
