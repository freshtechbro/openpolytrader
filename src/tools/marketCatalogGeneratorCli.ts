import { main } from './marketCatalogGenerator.js';

main(process.argv).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

