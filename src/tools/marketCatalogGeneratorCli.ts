import { writeCliFailureDetail } from '../utils/cliFailure.js';
import { main } from './marketCatalogGenerator.js';

main(process.argv).catch((error) => {
  writeCliFailureDetail('marketCatalogGenerator failed', error);
  process.exitCode = 1;
  return;
});
