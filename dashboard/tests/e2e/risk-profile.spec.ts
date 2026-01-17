import { test, expect } from '@playwright/test';

import { startDashboardServer, type DashboardTestServer } from './server';

let serverHandle: DashboardTestServer;

test.beforeAll(async () => {
  serverHandle = await startDashboardServer();
});

test.afterAll(async () => {
  await serverHandle.close();
});

test('risk profile dropdown applies selection', async ({ page }) => {
  await page.goto(serverHandle.baseUrl);
  await page.getByRole('button', { name: 'Risk Gates' }).click();
  await page.selectOption('#risk-profile-select', 'extra_high');
  await page.getByRole('button', { name: 'Apply profile' }).click();

  await expect.poll(() => serverHandle.getAppliedProfile()).toBe('extra_high');
  await expect(page.getByText(/Applied/)).toBeVisible();
});
