import { test, expect } from '@playwright/test';

import { startDashboardServer, type DashboardTestServer } from './server';

let serverHandle: DashboardTestServer;

test.beforeAll(async () => {
  serverHandle = await startDashboardServer();
});

test.afterAll(async () => {
  await serverHandle.close();
});

test('dashboard loads', async ({ page }) => {
  await page.goto(serverHandle.baseUrl);
  await expect(page.getByText('OpenPolyTrader Ops')).toBeVisible();
  await expect(page.getByText('System Overview')).toBeVisible();

  await page.getByRole('button', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { name: 'Incidents', level: 2 })).toBeVisible();
});
