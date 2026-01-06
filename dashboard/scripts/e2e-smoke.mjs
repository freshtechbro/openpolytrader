import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const distDir = resolve(here, '..', 'dist');
const indexPath = resolve(distDir, 'index.html');

if (!existsSync(indexPath)) {
  console.error(`Missing build output: ${indexPath}`);
  process.exit(1);
}

const indexHtml = readFileSync(indexPath, 'utf8');
const assetRefs = Array.from(indexHtml.matchAll(/(?:src|href)=\"([^\"]+)\"/g))
  .map((match) => match[1])
  .filter((ref) => typeof ref === 'string' && ref.includes('assets/'));

if (assetRefs.length === 0) {
  console.error('No asset references found in dist/index.html');
  process.exit(1);
}

for (const ref of assetRefs) {
  const normalized = ref.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const assetPath = resolve(distDir, normalized);
  if (!existsSync(assetPath)) {
    console.error(`Missing referenced asset: ${assetPath}`);
    process.exit(1);
  }
}

const jsAsset = assetRefs.find((ref) => ref.endsWith('.js'));
if (!jsAsset) {
  console.error('No JS bundle reference found in dist/index.html');
  process.exit(1);
}

const jsPath = resolve(distDir, jsAsset.replace(/^\.\/+/, '').replace(/^\/+/, ''));
const bundle = readFileSync(jsPath, 'utf8');

const requiredStrings = ['OpenPolyTrader Ops', 'System Overview', 'Incidents'];
for (const token of requiredStrings) {
  if (!bundle.includes(token)) {
    console.error(`Missing expected UI string in bundle: ${token}`);
    process.exit(1);
  }
}

console.log('dashboard e2e smoke: ok');

