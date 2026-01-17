import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TradePolicy } from './policy.js';
import type { RiskConfig } from './risk.js';

export type RiskProfileId = 'near_zero' | 'moderate' | 'high' | 'extra_high';

export interface RiskProfileFile {
  policy?: Partial<TradePolicy>;
  risk?: Partial<RiskConfig>;
}

export interface LoadedRiskProfile {
  id: RiskProfileId;
  source: string;
  policy: Partial<TradePolicy>;
  risk: Partial<RiskConfig>;
}

export interface ActiveRiskProfileSelection {
  id: RiskProfileId;
  source?: string;
  updatedAt?: string;
}

export const RISK_PROFILE_IDS: RiskProfileId[] = [
  'near_zero',
  'moderate',
  'high',
  'extra_high'
];

export function isRiskProfileId(value: string): value is RiskProfileId {
  return RISK_PROFILE_IDS.includes(value as RiskProfileId);
}

function isTestRuntime(): boolean {
  return process.argv.some((arg) => arg.includes('vitest'));
}

function findProjectRoot(startDir: string): string | null {
  let current = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(current, 'settings', 'risk-gates');
    if (existsSync(candidate)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveProjectRootFromModuleUrl(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const discovered = findProjectRoot(moduleDir);
  if (discovered) return discovered;
  return resolve(moduleDir, '..', '..');
}

function resolveRiskGatesDirCandidates(): string[] {
  const primary = resolve(process.cwd(), 'settings', 'risk-gates');
  if (isTestRuntime()) return [primary];
  const secondary = resolve(resolveProjectRootFromModuleUrl(), 'settings', 'risk-gates');
  return primary === secondary ? [primary] : [primary, secondary];
}

export function resolveRiskProfilePathCandidates(
  profile: RiskProfileId,
  overridePath?: string
): string[] {
  if (overridePath) {
    if (isAbsolute(overridePath)) {
      return [normalizeRiskProfileOverridePath(profile, resolve(overridePath))];
    }
    const cwdCandidate = resolve(process.cwd(), overridePath);
    const rootCandidate = resolve(resolveProjectRootFromModuleUrl(), overridePath);
    if (cwdCandidate === rootCandidate) {
      return [normalizeRiskProfileOverridePath(profile, cwdCandidate)];
    }
    return [
      normalizeRiskProfileOverridePath(profile, cwdCandidate),
      normalizeRiskProfileOverridePath(profile, rootCandidate)
    ];
  }
  return resolveRiskGatesDirCandidates().map((dir) => resolve(dir, `${profile}.json`));
}

export function resolveRiskProfilePath(profile: RiskProfileId, overridePath?: string): string {
  const candidates = resolveRiskProfilePathCandidates(profile, overridePath);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveActiveRiskProfileOverridePath(overridePath: string): string {
  if (isAbsolute(overridePath)) return resolve(overridePath);
  const cwdCandidate = resolve(process.cwd(), overridePath);
  const rootCandidate = resolve(resolveProjectRootFromModuleUrl(), overridePath);
  if (existsSync(cwdCandidate)) return cwdCandidate;
  if (existsSync(rootCandidate)) return rootCandidate;
  return cwdCandidate;
}

function resolveActiveRiskProfileWritePath(overridePath?: string): string {
  if (overridePath) {
    return resolveActiveRiskProfileOverridePath(overridePath);
  }
  if (isTestRuntime()) {
    return resolve(process.cwd(), 'settings', 'risk-gates', 'active.json');
  }
  return resolve(resolveProjectRootFromModuleUrl(), 'settings', 'risk-gates', 'active.json');
}

export function resolveActiveRiskProfilePath(overridePath?: string): string {
  return resolveActiveRiskProfileWritePath(overridePath);
}

function resolveActiveRiskProfilePathCandidates(overridePath?: string): string[] {
  const candidates: string[] = [];
  if (overridePath) {
    candidates.push(resolveActiveRiskProfileOverridePath(overridePath));
  }
  const primary = resolve(process.cwd(), 'settings', 'risk-gates', 'active.json');
  if (isTestRuntime()) {
    if (!candidates.includes(primary)) candidates.push(primary);
    return candidates;
  }
  const secondary = resolve(resolveProjectRootFromModuleUrl(), 'settings', 'risk-gates', 'active.json');
  for (const candidate of [primary, secondary]) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export function loadActiveRiskProfile(overridePath?: string): ActiveRiskProfileSelection | null {
  const candidates = resolveActiveRiskProfilePathCandidates(overridePath);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return null;

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid active risk profile JSON: ${path}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid active risk profile: ${path} (expected object)`);
  }

  const selection = parsed as Record<string, unknown>;
  const id = selection.id;
  if (typeof id !== 'string' || !isRiskProfileId(id)) {
    throw new Error(`Invalid active risk profile: ${path} (unknown id)`);
  }
  const source = selection.source;
  if (source !== undefined && typeof source !== 'string') {
    throw new Error(`Invalid active risk profile: ${path} (source must be a string)`);
  }
  const updatedAt = selection.updatedAt;
  if (updatedAt !== undefined && typeof updatedAt !== 'string') {
    throw new Error(`Invalid active risk profile: ${path} (updatedAt must be a string)`);
  }

  return { id, source, updatedAt };
}

export function persistActiveRiskProfile(
  selection: Omit<ActiveRiskProfileSelection, 'updatedAt'>,
  overridePath?: string
): ActiveRiskProfileSelection {
  const path = resolveActiveRiskProfileWritePath(overridePath);
  const projectRoot = resolveProjectRootFromModuleUrl();

  let source = selection.source;
  if (source) {
    const absSource = isAbsolute(source) ? source : resolve(process.cwd(), source);
    if (absSource === projectRoot || absSource.startsWith(`${projectRoot}${sep}`)) {
      source = relative(projectRoot, absSource);
    }
  }

  const payload: ActiveRiskProfileSelection = {
    id: selection.id,
    source,
    updatedAt: new Date().toISOString()
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function loadRiskProfile(
  profile: RiskProfileId,
  overridePath?: string
): LoadedRiskProfile | null {
  const path = resolveRiskProfilePath(profile, overridePath);
  if (!existsSync(path)) {
    if (overridePath) {
      throw new Error(`Risk profile path not found: ${path}`);
    }
    return null;
  }
  if (statSync(path).isDirectory()) {
    throw new Error(`Risk profile path is a directory: ${path}`);
  }

  const raw = readFileSync(path, 'utf8');
  const parsed = parseRiskProfile(raw, path);

  return {
    id: profile,
    source: path,
    policy: parsed.policy ?? {},
    risk: parsed.risk ?? {}
  };
}

function parseRiskProfile(raw: string, path: string): RiskProfileFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid risk profile JSON: ${path}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid risk profile: ${path} (expected object)`);
  }

  const record = parsed;
  const policy = record.policy;
  if (policy !== undefined && !isPlainObject(policy)) {
    throw new Error(`Invalid risk profile: ${path} (policy must be an object)`);
  }

  const risk = record.risk;
  if (risk !== undefined && !isPlainObject(risk)) {
    throw new Error(`Invalid risk profile: ${path} (risk must be an object)`);
  }

  return {
    policy: policy === undefined ? undefined : (policy as Partial<TradePolicy>),
    risk: risk === undefined ? undefined : (risk as Partial<RiskConfig>)
  };
}

function normalizeRiskProfileOverridePath(profile: RiskProfileId, candidate: string): string {
  if (!existsSync(candidate)) return candidate;
  try {
    if (statSync(candidate).isDirectory()) {
      return resolve(candidate, `${profile}.json`);
    }
  } catch {
    return candidate;
  }
  return candidate;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
