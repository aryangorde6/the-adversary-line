'use strict';

const L = require('./lib');

const SUITES = [
  require('./suite-runtime'),
  require('./suite-auth'),
  require('./suite-idempotency'),
  require('./suite-availability'),
  require('./suite-booking'),
require('./suite-combinations'),
require('./suite-static'),
require('./suite-moves'),
  require('./suite-transfer'),
  require('./suite-concurrency'),
  require('./suite-wording'),
  require('./suite-typing'),
];

async function main() {
  await L.start();
  for (const suite of SUITES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await suite.run();
    } catch (error) {
      L.state.failures.push(`${suite.name || 'suite'} aborted: ${error && error.message ? error.message : error}`);
    }
  }
  await L.stop();
  const { checks, passed, failures } = L.report();
  for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
  process.stdout.write(`\nchecks=${checks} passed=${passed} failed=${failures.length}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main();
