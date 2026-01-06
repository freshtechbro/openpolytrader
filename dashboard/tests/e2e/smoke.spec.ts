import { test, expect } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

test('dashboard loads', async ({ page }) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const distIndex = resolve(here, '../../dist/index.html');
  await page.goto(pathToFileURL(distIndex).toString());
  await expect(page.getByText('OpenPolyTrader Ops')).toBeVisible();
  await expect(page.getByText('System Overview')).toBeVisible();

  await page.getByRole('button', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { name: 'Incidents', level: 2 })).toBeVisible();
});
