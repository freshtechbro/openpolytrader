import { test, expect } from '@playwright/test';

test('dashboard loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('OpenPolyTrader Ops')).toBeVisible();
  await expect(page.getByText('System Overview')).toBeVisible();

  await page.getByRole('button', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { name: 'Incidents', level: 2 })).toBeVisible();
});
