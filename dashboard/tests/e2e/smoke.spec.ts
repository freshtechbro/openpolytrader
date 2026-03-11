import { expect, test } from './fixtures';

test('dashboard loads', async ({ page, dashboardServer }) => {
  await page.goto(dashboardServer.baseUrl);
  await expect(page.getByRole('heading', { name: 'Operate a disciplined trading pipeline, not a blind bot.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open OpenPolyTrader GitHub repository' })).toBeVisible();
  await page.locator('a.ops-cta').click();
  await expect(page.getByText('OpenPolyTrader Ops')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open OpenPolyTrader GitHub repository' })).toBeVisible();
  await expect(page.getByText('System Overview')).toBeVisible();

  await page.getByRole('link', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { name: 'Incidents', level: 2 })).toBeVisible();
});
