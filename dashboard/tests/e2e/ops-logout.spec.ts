import { expect, test } from './fixtures';

test('shows an explicit error when server logout fails', async ({ page, dashboardServer }) => {
  await page.goto(`${dashboardServer.baseUrl}/ops/overview`);
  await expect(page.getByText('System Overview')).toBeVisible();

  await page.route('**/ops/session', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'logout_failed',
          message: 'logout failed'
        }
      })
    });
  });

  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('heading', { name: 'Operator sign in' })).toBeVisible();
  await expect(
    page.getByText('Logout failed. Local auth was cleared; the server session may still be active.')
  ).toBeVisible();
});
