// Rows X1..X15: export, import and what must survive them.
import { GET, POST, call, record, BASE, deepEqual } from './lib.mjs';
import { fixture, restaurant, table, login, reset, book, D_THU_FUTURE } from './fixtures.mjs';

const BASE2 = process.env.TK_BASE2 || 'http://127.0.0.1:8081';

const exportState = async (base = BASE) => {
  const res = await fetch(`${base}/_test/export`);
  return { res, body: await res.text() };
};

const importState = (body, base = BASE) => fetch(`${base}/_test/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

export default async function run() {
  // X1 both test endpoints work with no Authorization header
  await reset(fixture());
  const bare = await exportState();
  const bareImport = await importState(bare.body);
  record('X1', bare.res.status === 200 && bareImport.status === 204 && !bare.res.headers.get('www-authenticate'), `export -> ${bare.res.status}, import -> ${bareImport.status}, neither sent an Authorization header`);

  // X2 the envelope
  const envelope = JSON.parse(bare.body);
  const keys = Object.keys(envelope).sort().join(',');
  record('X2', bare.res.status === 200 && envelope.track === 'tablekeeper' && envelope.format_version === 1 && envelope.state && typeof envelope.state === 'object',
    `keys ${keys}, track ${envelope.track}, format_version ${envelope.format_version}, state ${envelope.state ? typeof envelope.state : 'missing'}`);

  // X3, X4, X6, X14, X15 roundtrip and replacement
  await reset(fixture());
  const token = await login();
  const kept = await book(token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'x3-keep' });
  await POST(`/reservations/${kept.json.reference}/cancel`, { token });
  await POST('/reservations', { token, key: 'x3-doomed', body: { restaurant_id: 'r_anker', table_id: 'r_anker' } });
  const snapshot = await exportState();
  const roundtrip = await importState(snapshot.body);
  const roundtripBody = await roundtrip.text();
  const empty = roundtrip.status === 204 && roundtripBody === '';
  const counts = [];
  for (let i = 0; i < 3; i += 1) {
    await importState(snapshot.body);
    const res = await GET('/reservations', { token });
    counts.push((res.json.reservations || []).length);
  }
  const afterRoundtrip = await GET('/reservations', { token });
  const refs = (afterRoundtrip.json.reservations || []).map((r) => r.reference);
  record('X3', roundtrip.status === 204, `the exported object posted back unchanged -> ${roundtrip.status}`);
  record('X4', empty, `import -> ${roundtrip.status} with body ${JSON.stringify(roundtripBody)}`);
  record('X6', counts.every((c) => c === 1) && new Set(refs).size === refs.length, `reservation count after one, two and three imports ${counts.join(', ')}, references ${JSON.stringify(refs)}`);

  const doomed = await book(token, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 2, key: 'x14-key' });
  const stranger = await POST('/auth/signup', { body: { email: 'only-here@example.com', password: 'correct horse', display_name: 'Only Here' } });
  const beforeReplace = await GET('/reservations', { token });
  const beforeStranger = await GET('/reservations', { token: stranger.json.token });
  await importState(snapshot.body);
  const afterReplace = await GET('/reservations', { token });
  const afterStranger = await GET('/reservations', { token: stranger.json.token });
  const afterStrangerLogin = await POST('/auth/login', { body: { email: 'only-here@example.com', password: 'correct horse' } });
  const staleReceipt = await POST('/reservations', { token, key: 'x14-key', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 2 } });
  record('X14', (beforeReplace.json.reservations || []).length === 2 && (beforeStranger.json.reservations || []).length === 0
    && (afterReplace.json.reservations || []).length === 1 && afterStranger.status === 401 && afterStrangerLogin.status === 401
    && staleReceipt.status === 201 && staleReceipt.json.starts_at_local === `${D_THU_FUTURE}T21:00`,
    `the destination had ${(beforeReplace.json.reservations || []).length} reservations before the import and ${(afterReplace.json.reservations || []).length} after; its own account logs in with ${afterStrangerLogin.status} and answers ${afterStranger.status}; its receipt for key x14-key is gone, so the same key with a new body books afresh: ${staleReceipt.status} ${staleReceipt.json?.table_id}, not the stored ${doomed.json.table_id}`);

  await importState(snapshot.body);
  const importedAccount = await POST('/auth/signup', { body: { email: 'imported@example.com', password: 'correct horse', display_name: 'Imported' } });
  await book(importedAccount.json.token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'x15-new' });
  const withImport = JSON.parse((await exportState()).body).state;
  await reset(fixture());
  const cleared = await GET('/reservations', { token });
  const clearedLogin = await POST('/auth/login', { body: { email: 'imported@example.com', password: 'correct horse' } });
  const clearedState = JSON.parse((await exportState()).body).state;
  record('X15', withImport.users.some((u) => u.email === 'imported@example.com') && (cleared.json.reservations || []).length === 0
    && clearedLogin.status === 401 && !clearedState.users.some((u) => u.email === 'imported@example.com') && clearedState.reservations.length === 0,
    `the state before the reset held ${withImport.users.length} accounts and ${withImport.reservations.length} reservations; after reset ${clearedState.users.length} and ${clearedState.reservations.length}, and the imported account logs in with ${clearedLogin.status}`);

  // X7 every rejected import leaves the destination untouched
  await reset(fixture());
  const tok7 = await login();
  const live = await book(tok7, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'x7-live' });
  const before7 = (await exportState()).body;
  const good = JSON.parse(before7);
  const cases = [
    ['unparseable body', '{not json', 400, 'malformed_request'],
    ['missing state', JSON.stringify({ track: 'tablekeeper', format_version: 1 }), 422, 'validation_failed'],
    ['wrong track', JSON.stringify({ ...good, track: 'other' }), 422, 'validation_failed'],
    ['format_version 2', JSON.stringify({ ...good, format_version: 2 }), 422, 'validation_failed'],
    ['state is a string', JSON.stringify({ ...good, state: 'text' }), 422, 'validation_failed'],
    ['state is an array', JSON.stringify({ ...good, state: [] }), 422, 'validation_failed'],
    ['reservations is not a list', JSON.stringify({ ...good, state: { ...good.state, reservations: 7 } }), 422, 'validation_failed'],
    ['reservation with no reference', JSON.stringify({ ...good, state: { ...good.state, reservations: [{ restaurant_id: 'r_anker' }] } }), 422, 'validation_failed'],
    ['both wrong', JSON.stringify({ track: 'other', format_version: 2, state: 'text' }), 422, 'validation_failed'],
  ];
  const seen = [];
  let clean = true;
  for (const [label, payload, wantStatus, wantCode] of cases) {
    const res = await importState(payload);
    const body = await res.text();
    const code = (() => { try { return JSON.parse(body).error.code; } catch { return body.slice(0, 40); } })();
    if (res.status !== wantStatus || code !== wantCode) clean = false;
    seen.push(`${label} ${res.status} ${code}`);
    const now = (await exportState()).body;
    if (now !== before7) clean = false;
  }
  const stillThere = await GET(`/reservations/${live.json.reference}`, { token: tok7 });
  record('X7', clean && stillThere.status === 200, `${seen.join('; ')}; destination export identical after every attempt: ${clean}, the original booking still readable ${stillThere.status}`);

  // X8 each control call answers well inside 10 s
  const timings = [];
  const timed = async (label, fn) => {
    const t0 = Date.now();
    const res = await fn();
    timings.push(`${label} ${Date.now() - t0} ms (${res.status})`);
    return res.status;
  };
  await timed('reset', () => reset(fixture()));
  await timed('export', async () => (await exportState()).res);
  await timed('import', async () => (await importState(before7)));
  const slowest = Math.max(...timings.map((t) => Number(/ (\d+) ms/.exec(t)[1])));
  record('X8', timings.every((t) => t.includes(' ms (2')) && slowest < 10000, timings.join(', '));

  // X9 the export is a read-only snapshot
  await reset(fixture());
  const tok9 = await login();
  const pre = await book(tok9, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'x9-base' });
  const held = await exportState();
  const beforeStateHold = held.body;
  const afterBooking = await book(tok9, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'x9-new' });
  await POST(`/reservations/${afterBooking.json.reference}/cancel`, { token: tok9 });
  const heldAgain = await exportState();
  await importState(held.body);
  const restored = await GET('/reservations', { token: tok9 });
  const restoredRefs = (restored.json.reservations || []).map((r) => r.reference);
  const nowCount = JSON.parse(heldAgain.body).state.reservations.length;
  record('X9', nowCount === 2 && restoredRefs.length === 1 && restoredRefs[0] === pre.json.reference && JSON.parse(beforeStateHold).state.reservations.length === 1,
    `the captured body still holds ${JSON.parse(beforeStateHold).state.reservations.length} reservation while the service now holds ${nowCount}; importing the captured body restored ${JSON.stringify(restoredRefs)}`);

  // X10, X11, X12, X13 what must survive an import
  await reset(fixture());
  const tok10 = await login();
  const survivor = await book(tok10, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'x10-keep' });
  const doomed422 = await POST('/reservations', { token: tok10, key: 'x10-doomed', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  const beforeList = await GET('/reservations', { token: tok10 });
  const beforeState = (await exportState()).body;
  await importState(beforeState);
  const afterList = await GET('/reservations', { token: tok10 });
  const oldTokenWorks = await GET('/reservations', { token: tok10 });
  const oldPassword = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  const availAfter = await GET(`/availability?restaurant_id=r_anker&date=${D_THU_FUTURE}&party_size=4`);
  const retryKey = await POST('/reservations', { token: tok10, key: 'x10-doomed', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  const replay = await POST('/reservations', { token: tok10, key: 'x10-keep', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  const afterReplay = await GET('/reservations', { token: tok10 });
  record('X10', oldTokenWorks.status === 200 && oldPassword.status === 200 && availAfter.status === 200 && availAfter.json.restaurant_id === 'r_anker' && doomed422.status === 409,
    `the old token still lists reservations ${oldTokenWorks.status}, the old password still logs in ${oldPassword.status}, the restaurant still serves ${availAfter.json.slots.length} slots, the key that failed before the export gave ${doomed422.status} ${doomed422.json?.error?.code}`);
  record('X11', deepEqual(beforeList.json, afterList.json), `reservation records byte-identical across the import: ${deepEqual(beforeList.json, afterList.json)} (${JSON.stringify((afterList.json.reservations || []).map((r) => [r.reservation_id, r.reference, r.status, r.starts_at, r.created_at]))})`);
  record('X12', retryKey.status === 409 && retryKey.json?.error?.code === 'table_unavailable', `the key that failed with ${doomed422.status} before the export now gives ${retryKey.status} ${retryKey.json?.error?.code}, so it was never recorded`);
  record('X13', replay.status === 200 && deepEqual(replay.json, survivor.json) && deepEqual(afterReplay.json, beforeList.json),
    `replay after the import -> ${replay.status} with the original body ${deepEqual(replay.json, survivor.json)}, and the reservation set is unchanged ${deepEqual(afterReplay.json, beforeList.json)}`);

  // X5 a second instance, started separately on another port, accepts the same export
  try {
    const resetB = async () => {
      await resetAt(BASE2, fixture());
      return (await postAt(BASE2, '/auth/login', { email: 'ada@example.com', password: 'correct horse' })).json.token;
    };
    const firstToken = await resetB();
    const made = await postAt(BASE2, '/reservations', { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 }, firstToken, 'x5-b');
    const withOwn = await getAt(BASE2, '/reservations', firstToken);
    const emptied = await getAt(BASE2, '/reservations', await resetB());
    const payload = (await exportState()).body;
    const fromA = JSON.parse(payload).state.reservations.map((r) => r.reference);
    const intoB = await importState(payload, BASE2);
    const filled = await getAt(BASE2, '/reservations', tok10);
    const ids = (filled.json.reservations || []).map((r) => r.reference);
    record('X5', made.status === 201 && withOwn.status === 200 && (withOwn.json.reservations || []).length === 1
      && emptied.status === 200 && (emptied.json.reservations || []).length === 0 && intoB.status === 204 && filled.status === 200 && deepEqual(ids, fromA),
      `an export taken from ${BASE} on port 8080 held ${JSON.stringify(fromA)}; imported into ${BASE2} on port 8081 -> ${intoB.status}, which now lists ${filled.status} ${JSON.stringify(ids)} and has lost its own booking ${made.json.reference} (own count before the import ${(withOwn.json.reservations || []).length}, after the reset alone ${(emptied.json.reservations || []).length})`);
  } catch (error) {
    record('X5', false, `second instance unavailable: ${error.message}`);
  }
}

async function postAt(base, path, body, token, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

async function getAt(base, path, token) {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

async function resetAt(base, body) {
  const res = await fetch(`${base}/_test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await res.text();
  return res;
}