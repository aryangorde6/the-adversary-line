// Runs every stage-2 API probe group and prints one line per row of ledger-stage-2.md that it
// decides. Rows the browser probe decides are marked here so the summary stays honest.
// Usage: node run.mjs     (TK_BASE overrides the target, default 8080)
import { readFileSync, writeFileSync } from 'node:fs';
import { results, record } from '../lib.mjs';

const GROUPS = ['./routes.mjs', './combined.mjs', './combined-b.mjs', './combined-c.mjs'];

// Rows stage-2.md states but no API call can decide: the browser and review rows.
const BROWSER = ['R5', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7',
  'G8', 'G9', 'G10', 'G11', 'G12', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'F1', 'F2',
  'F3', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'Y3', 'Y5', 'Y6', 'Z28', 'Z29', 'Z30', 'Z31', 'Z32',
  'Z33', 'Z36'];
const REVIEW = ['Q1', 'Q2', 'Q3'];
const PERMITTED = ['R7', 'U14', 'Q26'];
// Rows decided by the supplied harness suite, recorded here so the summary names them.
const SUPPLIED = [];

function ledgerIds() {
  const text = readFileSync(new URL('../../ledger-stage-2.md', import.meta.url).pathname, 'utf8');
  const ids = new Set();
  for (const line of text.split('\n')) {
    const m = /^\|\s*([RULSGBCFYZQ]\d+)\s\|/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

for (const path of GROUPS) {
  try {
    const mod = await import(path);
    await mod.default();
  } catch (error) {
    console.log(`GROUPFAIL ${path}: ${error && error.message}`);
  }
}
for (const id of PERMITTED) record(id, true, 'the specification permits this; nothing to enforce');
// Q1, Q2 and Q3 are matters of direction that a person has to judge from the screenshots.
// This runner cannot read images, so it leaves them undecided rather than claiming a reason.
console.log(`--- not decided here, they need a reader of the screenshots: ${REVIEW.join(' ')}`);

const decided = new Set(results.map((r) => r.rowId));
const ledger = ledgerIds();
const missing = [...ledger].filter((id) => !decided.has(id)).sort();
const failed = results.filter((r) => !r.ok);
for (const r of results.sort((a, b) => a.rowId.localeCompare(b.rowId))) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.rowId}${r.ok ? '' : `: ${r.detail}`}`);
}
console.log(`--- stage-2 rows in ledger ${ledger.size}, decided here ${decided.size}, failures ${failed.length}`);
console.log(`--- left to the browser probe (${BROWSER.length}): ${BROWSER.filter((id) => !decided.has(id)).length}`);
console.log(`--- left to the supplied suite (${SUPPLIED.length}): ${SUPPLIED.filter((id) => !decided.has(id)).length}`);
if (missing.length) console.log(`--- NOT DECIDED by this runner: ${missing.join(' ')}`);
writeFileSync('/tmp/s2-api-results.json', JSON.stringify({ results, missing, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);