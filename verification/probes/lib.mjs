// Probe helpers. Nothing here is product code: this file only talks HTTP to a
// running service and records whether a stage-1.md ledger row holds.
import { readFileSync } from 'node:fs';

export const BASE = process.env.TK_BASE || 'http://127.0.0.1:8080';
export const LEDGER = new URL('../ledger-stage-1.md', import.meta.url).pathname;

export const results = [];
export const violations = [];
let current = '(none)';

export function group(name) { current = name; }

export function record(rowId, ok, detail) {
  results.push({ rowId, ok: Boolean(ok), detail: detail || '', group: current });
}

export function ledgerRows() {
  const text = readFileSync(LEDGER, 'utf8');
  const ids = new Set();
  for (const line of text.split('\n')) {
    const m = /^\|\s*((?:D|C|M|E|A|I|P|T|X|V)\d+)\s\|/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Every response goes through here, so a 5xx anywhere in the suite is recorded.
export async function call(method, path, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
  if (opts.authRaw !== undefined) headers.Authorization = opts.authRaw;
  let body;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers['Content-Type'] = opts.contentType || 'application/json';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = opts.contentType || 'application/json';
  }
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  const ms = Date.now() - started;
  let json = null;
  try { json = text.length ? JSON.parse(text) : null; } catch { json = null; }
  const out = { status: res.status, json, text, headers: res.headers, ms };
  if (res.status >= 500) violations.push({ rowId: 'E16', detail: `${method} ${path} answered ${res.status}` });
  if (ms > 5000 && path !== '/_test/reset') violations.push({ rowId: 'D11', detail: `${method} ${path} took ${ms}ms` });
  if (res.status >= 400) checkErrorShape(method, path, res.status, json);
  return out;
}

// E1 and E2 are checked on every non-2xx answer in the suite, wherever it came from.
const CODE_STATUS = {
  malformed_request: 400,
  missing_idempotency_key: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  idempotency_key_reuse: 409,
  table_unavailable: 409,
  cutoff_passed: 409,
  reservation_cancelled: 409,
  email_taken: 409,
  validation_failed: 422,
  not_on_slot_grid: 422,
  outside_opening_hours: 422,
  party_exceeds_capacity: 422,
  invalid_local_time: 422,
};

function checkErrorShape(method, path, status, json) {
  const where = `${method} ${path} answered ${status}`;
  const keys = json && typeof json === 'object' ? Object.keys(json) : [];
  const inner = json && json.error && typeof json.error === 'object' ? Object.keys(json.error) : [];
  if (keys.length !== 1 || keys[0] !== 'error' || inner.length !== 2 || !inner.includes('code') || !inner.includes('message')
    || typeof json.error.code !== 'string' || typeof json.error.message !== 'string') {
    violations.push({ rowId: 'E1', detail: `${where} with body ${JSON.stringify(json).slice(0, 160)}` });
    return;
  }
  const want = CODE_STATUS[json.error.code];
  if (want === undefined) violations.push({ rowId: 'E2', detail: `${where} with code ${json.error.code}, which the specification never documents` });
  else if (want !== status) violations.push({ rowId: 'E2', detail: `${where} with code ${json.error.code}, which the specification pairs with ${want}` });
}

export const GET = (p, o) => call('GET', p, o);
export const POST = (p, o) => call('POST', p, o);
export const PATCH = (p, o) => call('PATCH', p, o);

export function deepEqual(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v === undefined ? null : v;
}

export function isRfc3339WithOffset(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s);
}

export function isBareLocal(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
}

export function slotsFor(res, date) {
  return res.json.slots.filter((s) => s.starts_at_local.startsWith(date));
}
