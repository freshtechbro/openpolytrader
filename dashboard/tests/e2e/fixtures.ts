import { expect, test as base } from '@playwright/test';

import { startDashboardServer, type DashboardTestServer } from './server';

type DashboardFixtures = {
  dashboardServer: DashboardTestServer;
};

export const test = base.extend<DashboardFixtures>({
  dashboardServer: [
    async ({}, use) => {
      const server = await startDashboardServer();
      try {
        await use(server);
      } finally {
        await server.close();
      }
    },
    { scope: 'worker' }
  ]
});

export { expect };
