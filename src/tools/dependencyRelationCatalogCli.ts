import { writeCliFailureDetail } from '../utils/cliFailure.js';
import { main } from './dependencyRelationCatalog.js';

main(process.argv).catch((error) => {
  writeCliFailureDetail('dependencyRelationCatalog failed', error);
  process.exitCode = 1;
  return;
});
