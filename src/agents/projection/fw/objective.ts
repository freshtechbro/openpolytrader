import type { FwObjectiveContext } from './types.js';

export function evaluateFwObjective(point: number[], context: FwObjectiveContext): number {
  const regularization = sanitizeRegularization(context.regularization);
  const size = point.length;
  let penalty = 0;
  let reward = 0;
  for (let i = 0; i < size; i += 1) {
    const x = finite(point[i]);
    const u = finite(context.interiorPoint[i]);
    const c = finite(context.edgeCoefficients[i]);
    const delta = x - u;
    penalty += delta * delta;
    reward += c * x;
  }
  return 0.5 * regularization * penalty - reward;
}

export function evaluateFwGradient(point: number[], context: FwObjectiveContext): number[] {
  const regularization = sanitizeRegularization(context.regularization);
  return point.map((value, index) => {
    const x = finite(value);
    const u = finite(context.interiorPoint[index]);
    const c = finite(context.edgeCoefficients[index]);
    return regularization * (x - u) - c;
  });
}

export function dot(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    value += finite(left[i]) * finite(right[i]);
  }
  return value;
}

export function l2Distance(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let sumSquares = 0;
  for (let i = 0; i < size; i += 1) {
    const delta = finite(left[i]) - finite(right[i]);
    sumSquares += delta * delta;
  }
  return Math.sqrt(sumSquares);
}

export function contractTowardInterior(
  vertex: number[],
  interior: number[],
  epsilon: number
): number[] {
  const clamped = Math.max(0, Math.min(1, finite(epsilon)));
  return vertex.map((value, index) => {
    const v = finite(value);
    const u = finite(interior[index]);
    return (1 - clamped) * v + clamped * u;
  });
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function sanitizeRegularization(value: number): number {
  const finiteValue = finite(value);
  if (finiteValue <= 0) return 1;
  return finiteValue;
}
