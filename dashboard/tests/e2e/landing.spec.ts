import { test, expect } from '@playwright/test';

import { startDashboardServer, type DashboardTestServer } from './server';

let serverHandle: DashboardTestServer;

test.beforeAll(async () => {
  serverHandle = await startDashboardServer();
});

test.afterAll(async () => {
  await serverHandle.close();
});

test('public routes render and link to ops', async ({ page }) => {
  await page.goto(serverHandle.baseUrl);
  await expect(page.getByRole('heading', { name: 'Operate a disciplined trading pipeline, not a blind bot.' })).toBeVisible();

  await page.getByRole('link', { name: 'Product' }).click();
  await expect(page.getByRole('heading', { name: 'A focused execution stack for Polymarket operations.' })).toBeVisible();

  await page.getByRole('link', { name: 'Risk' }).click();
  await expect(page.getByRole('heading', { name: 'Risk gates are first-class runtime controls.' })).toBeVisible();

  await page.getByRole('link', { name: 'Architecture' }).click();
  await expect(page.getByRole('heading', { name: 'Agent pipeline with event-sourced operations.' })).toBeVisible();

  await page.getByRole('link', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Run local paper mode first.' })).toBeVisible();

  await page.goto(`${serverHandle.baseUrl}/ops/overview`);
  await expect(page.getByText('OpenPolyTrader Ops')).toBeVisible();
});
