import { runMarketCatalogPrestart } from './marketCatalogPrestart.js';

runMarketCatalogPrestart().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

