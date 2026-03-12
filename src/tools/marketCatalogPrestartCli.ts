import { writeCliFailureDetail } from '../utils/cliFailure.js';
import { runMarketCatalogPrestart } from './marketCatalogPrestart.js';

runMarketCatalogPrestart().catch((error) => {
  writeCliFailureDetail('marketCatalogPrestart failed', error);
  process.exitCode = 1;
  return;
});
