import { expect, test } from '@playwright/test';

import { startDashboardServer, type DashboardTestServer } from './server';

let serverHandle: DashboardTestServer;

test.beforeAll(async () => {
  serverHandle = await startDashboardServer();
});

test.afterAll(async () => {
  await serverHandle.close();
});

test('decisions filters apply and clear correctly', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 920 });
  const rows = page.locator('.decisions-table tbody tr');

  await page.goto(`${serverHandle.baseUrl}/ops/decisions`);
  await expect(page.getByRole('heading', { name: 'Decisions', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('th.decisions-col-time')).toBeVisible();
  await expect(page.locator('th.decisions-col-agent')).toBeVisible();
  await expect(page.locator('.decisions-table tbody td.decisions-col-time').first()).toBeVisible();
  await expect(page.locator('.decisions-table tbody td.decisions-col-agent').first()).toBeVisible();

  const controlsDoNotOverlap = await page.evaluate(() => {
    const ids = ['#decisions-since', '#decisions-until', '.decisions-filter-actions button:first-child', '.decisions-filter-actions button:last-child'];
    const boxes = ids
      .map((selector) => document.querySelector(selector))
      .filter((node): node is Element => Boolean(node))
      .map((node) => node.getBoundingClientRect());
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const left = Math.max(boxes[i].left, boxes[j].left);
        const right = Math.min(boxes[i].right, boxes[j].right);
        const top = Math.max(boxes[i].top, boxes[j].top);
        const bottom = Math.min(boxes[i].bottom, boxes[j].bottom);
        const overlap = right - left > 1 && bottom - top > 1;
        if (overlap) return false;
      }
    }
    return true;
  });
  expect(controlsDoNotOverlap).toBe(true);

  await page.fill('#decisions-agent', 'execution');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.decisions-table tbody')).toContainText('execution');

  await page.fill('#decisions-subjectId', 'market-2');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.decisions-table tbody')).toContainText('market-2');

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#decisions-agent')).toHaveValue('');
  await expect(page.locator('#decisions-subjectId')).toHaveValue('');
  await expect(page.locator('#decisions-limit')).toHaveValue('200');
  await expect(page.locator('#decisions-since')).toHaveValue('');
  await expect(page.locator('#decisions-until')).toHaveValue('');

  await page.fill('#decisions-limit', '1');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(rows).toHaveCount(1);

  await page.fill('#decisions-since', '2099-01-01T00:00');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#decisions-since')).toHaveValue('2099-01-01T00:00');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.decisions-table tbody')).toContainText('No data yet');

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(3);

  await page.fill('#decisions-until', '2000-01-01T00:00');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.locator('#decisions-until')).toHaveValue('2000-01-01T00:00');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.decisions-table tbody')).toContainText('No data yet');

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(3);
});
