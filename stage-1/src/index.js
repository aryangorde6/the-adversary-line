'use strict';

const { createServer } = require('./server');
const { emptyFixture } = require('./service');

function initialPort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 8080;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return 8080;
  return parsed;
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`[tablekeeper] uncaught exception: ${error && error.stack ? error.stack : String(error)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[tablekeeper] unhandled rejection: ${reason && reason.stack ? reason.stack : String(reason)}\n`);
});

emptyFixture();

const server = createServer();
server.listen(initialPort(), '0.0.0.0', () => {
  process.stdout.write(`[tablekeeper] listening on 0.0.0.0:${initialPort()}\n`);
});
