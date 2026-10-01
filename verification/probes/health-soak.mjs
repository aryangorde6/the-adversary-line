// C1b: /health must answer 200 with exactly {"status":"ok"} on *every* call, not
// just the first one. The suite elsewhere only touches /health a handful of times,
// so a service that fails a small share of health checks by some other route goes
// unseen: C1 is a per-request contract, and a flaky answer is a broken C1 even when
// the failure never surfaces as a 5xx.
import { record, GET } from './lib.mjs';

// 400 sequential calls. A defect that fails a share p of calls is missed with
// probability (1-p)^N, so p=0.1 needs about 100 calls to be a coin flip and 400
// puts that below 1e-18.
const CALLS = 400;

export default async function run() {
  const codes = new Map();
  const wrongBody = [];
  for (let i = 0; i < CALLS; i += 1) {
    const res = await GET('/health');
    codes.set(res.status, (codes.get(res.status) || 0) + 1);
    if (res.status === 200 && res.text !== '{"status":"ok"}') wrongBody.push(`call ${i}: ${res.text.slice(0, 80)}`);
  }
  const tally = [...codes].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}x${n}`).join(', ');
  const notOk = [...codes].filter(([s]) => s !== 200);
  record('C1b', notOk.length === 0 && wrongBody.length === 0,
    `${CALLS} sequential /health calls: ${tally}${notOk.length ? `; ${notOk.length} status(es) other than 200` : '; every call 200'}${wrongBody.length ? `; wrong body on ${wrongBody.length}: ${wrongBody.slice(0, 3).join(' | ')}` : '; every body exactly {"status":"ok"}'}`);

  // The same contract under load: 50 calls in flight at once, all must be 200.
  const burst = await Promise.all(Array.from({ length: 50 }, () => GET('/health')));
  const burstCodes = new Map();
  for (const res of burst) burstCodes.set(res.status, (burstCodes.get(res.status) || 0) + 1);
  const burstTally = [...burstCodes].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}x${n}`).join(', ');
  record('C1c', burst.every((r) => r.status === 200 && r.text === '{"status":"ok"}'),
    `50 /health calls in flight at once: ${burstTally}`);
}