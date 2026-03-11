import { expect, test } from './fixtures';

test('risk profile dropdown applies selection', async ({ page, dashboardServer }) => {
  await page.goto(`${dashboardServer.baseUrl}/ops/risk`);
  await page.selectOption('#risk-profile-select', 'extra_high');
  await page.getByRole('button', { name: 'Apply profile' }).click();

  await expect.poll(() => dashboardServer.getAppliedProfile()).toBe('extra_high');
  await expect(page.getByText(/Applied/)).toBeVisible();
});
