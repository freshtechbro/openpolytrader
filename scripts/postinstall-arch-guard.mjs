#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const platform = process.platform;
const arch = process.arch;
const isSupportedDarwinArch =
  platform === 'darwin' && (arch === 'x64' || arch === 'arm64');

if (!isSupportedDarwinArch) {
  console.log(`[postinstall] skipping esbuild guard for ${platform}/${arch}`);
  process.exit(0);
}

const root = process.cwd();

const run = (label, args) => {
  console.log(`[postinstall] ${label}`);
  const result = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    const exitCode = result.status ?? 1;
    throw new Error(`postinstall arch guard failed: ${label} (exit ${exitCode})`);
  }
};

run('rebuilding root esbuild', ['rebuild', 'esbuild']);

const dashboardPackagePath = resolve(root, 'dashboard', 'package.json');
const dashboardNodeModulesPath = resolve(root, 'dashboard', 'node_modules');

if (existsSync(dashboardPackagePath) && existsSync(dashboardNodeModulesPath)) {
  run('rebuilding dashboard esbuild', ['--prefix', 'dashboard', 'rebuild', 'esbuild']);
} else {
  console.log('[postinstall] dashboard dependencies not installed; skipping dashboard esbuild rebuild');
}
