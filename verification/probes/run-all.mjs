// Runs every probe group against a running service and prints one line per ledger
// row. Usage: node run-all.mjs   (TK_BASE overrides the target, default 8080)
import { writeFileSync } from 'node:fs';
import { results, violations, record, ledgerRows, BASE } from './lib.mjs';

const GROUPS = [
  './conventions.mjs',
  './health-soak.mjs',
  './errors.mjs',
  './auth.mjs',
  './idempotency.mjs',
  './api.mjs',
  './api2.mjs',
  './time.mjs',
  './xport.mjs',
  './moves.mjs',
  './delivery.mjs',
  './delta.mjs',
  './open-questions.mjs',
  './rulings.mjs',
  './sweep.mjs',
];

for (const path of GROUPS) {
  let mod;
  try {
    mod = await import(path);
  } catch (error) {
    console.log(`LOADFAIL ${path}: ${error && error.message}`);
    continue;
  }
  try {
    await mod.default();
  } catch (error) {
    console.log(`GROUPFAIL ${path}: ${error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error}`);
  }
}

// Rows the ledger marks "no probe" because the specification permits, not requires, the behaviour.
for (const id of ['C3', 'D13', 'D17', 'D18', 'X16', 'V20']) {
  record(id, true, 'permitted by the specification, nothing to enforce');
}
for (const id of ['E16', 'D11', 'E1', 'E2']) {
  const hits = violations.filter((v) => v.rowId === id);
  const quiet = { E16: 'no 5xx anywhere in the suite', D11: 'no request over 5 s anywhere in the suite', E1: 'every non-2xx body was exactly {error:{code,message}} with both strings', E2: 'every error code and status pair matched the specification table' }[id];
  record(id, hits.length === 0, hits.length ? hits.map((h) => h.detail).join('; ') : quiet);
}

const decided = new Set(results.map((r) => r.rowId.replace(/[a-z]+$/, '')));
const ledger = ledgerRows();
const missing = [...ledger].filter((id) => !decided.has(id)).sort();
const failed = results.filter((r) => !r.ok);
const extras = [...decided].filter((id) => !ledger.has(id));

for (const r of results.sort((a, b) => a.rowId.localeCompare(b.rowId))) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rowId}${r.ok ? '' : `: ${r.detail}`}`);
}
console.log(`--- rows in ledger ${ledger.size}, decided ${decided.size}, failures ${failed.length}, undecided ${missing.length}`);
if (extras.length) console.log(`--- recorded ids not in the ledger: ${extras.join(', ')}`);
if (missing.length) console.log(`--- UNDECIDED: ${missing.join(', ')}`);

const out = process.env.TK_OUT || '/tmp/tk-probe-results.json';
writeFileSync(out, JSON.stringify({ base: BASE, results, missing, failed: failed.length }, null, 2));
process.exit(failed.length || missing.length ? 1 : 0);
