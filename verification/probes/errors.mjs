// Rows E1..E17: the status/code table, its precedence rules and the reserved 400.
import { GET, POST, PATCH, call, record } from './lib.mjs';
import { fixture, fresh, login, reset, avail, book, D_THU_FUTURE } from './fixtures.mjs';

function code(res) { return res.json && res.json.error ? res.json.error.code : `no error code (${res.status} ${res.text.slice(0, 60)})`; }

export default async function run() {
  let token = await fresh();

  // E3 / E14 400 malformed_request is reserved for an unparseable body or a wrong JSON type
  const malformed = [];
  const truncated = await call('POST', '/auth/signup', { rawBody: '{"email":' });
  malformed.push(['unparseable signup body', truncated, 400, 'malformed_request']);
  const notObject = await call('POST', '/auth/signup', { rawBody: '[1,2,3]' });
  malformed.push(['signup body is an array', notObject, 400, 'malformed_request']);
  const wrongType = await call('POST', '/auth/signup', { body: { email: 5, password: 'longenough' } });
  malformed.push(['signup email is a number', wrongType, 400, 'malformed_request']);
  const wrongPasswordType = await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: ['x'] } });
  malformed.push(['login password is an array', wrongPasswordType, 400, 'malformed_request']);
  const wrongRestaurantType = await POST('/reservations', { token, key: 'e3-1', body: { restaurant_id: 42, table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  malformed.push(['reservation restaurant_id is a number', wrongRestaurantType, 400, 'malformed_request']);
  const wrongStartsType = await POST('/reservations', { token, key: 'e3-2', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: 20261210, party_size: 4 } });
  malformed.push(['reservation starts_at_local is a number', wrongStartsType, 400, 'malformed_request']);
  const wrongMovesItem = await POST('/reservation-moves', { token, key: 'e3-3', body: { moves: ['nope'] } });
  const badMovesItem = wrongMovesItem.status !== 422 || code(wrongMovesItem) !== 'validation_failed';
  for (const [label, raw] of [
    ['fixture restaurants is a number', '{"restaurants": 7}'],
    ['fixture users is a string', '{"users": "ada"}'],
    ['fixture reservations is a number', '{"reservations": 3}'],
    ['fixture restaurant is not an object', '{"restaurants": [7]}'],
    /* A name is supplied here on purpose. The row is about tables being a number
     * rather than an array, and section 4 types the name as a required string, so
     * a fixture without one is refused for the missing name before the wrong type
     * is ever reached and the row would be deciding a different field. */
    ['fixture tables is a number', '{"restaurants": [{"id":"r_a","name":"Second","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":90,"cancellation_cutoff_minutes":60,"tables": 7}]}'],
  ]) {
    const res = await call('POST', '/_test/reset', { rawBody: raw });
    malformed.push([label, res, 400, 'malformed_request']);
  }
  const badImport = await call('POST', '/_test/import', { rawBody: 'not json at all' });
  malformed.push(['unparseable import body', badImport, 400, 'malformed_request']);
  const wrong = malformed.filter(([, res, s, c]) => res.status !== s || code(res) !== c);
  const detail = (badMovesItem ? `moves item of the wrong type: ${wrongMovesItem.status} ${code(wrongMovesItem)}; ` : '') + (wrong.length ? wrong.map(([n, r, s, c]) => `${n}: expected ${s} ${c}, got ${r.status} ${code(r)}`).join('; ') : `${malformed.length} wrong-type or unparseable bodies, all 400 malformed_request`);
  record('E3', wrong.length === 0 && !badMovesItem, detail);
  record('E14', wrong.length === 0, `same set as E3: 400 used only for an unparseable body or a wrong JSON type${wrong.length ? `, but ${wrong.length} case(s) answered another code` : ''}`);

  // E4 header absent or empty on both write paths
  const absent = [];
  const a1 = await POST('/reservations', { token, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  absent.push(['reservations without the header', a1]);
  const a2 = await POST('/reservation-moves', { token, body: { moves: [{ reference: 'SEED001', table_id: 't_2' }] } });
  absent.push(['reservation-moves without the header', a2]);
  const a4 = await POST('/reservations', { token, key: '', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } });
  absent.push(['reservations with an explicitly empty header', a4]);
  const badAbsent = absent.filter(([, r]) => r.status !== 400 || code(r) !== 'missing_idempotency_key');
  record('E4', badAbsent.length === 0, badAbsent.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${absent.length} absent or empty headers, all 400 missing_idempotency_key`);

  // E5 401 unauthenticated: missing, malformed and unknown tokens on every protected endpoint
  const guarded = [
    ['GET', '/reservations', {}],
    ['POST', '/reservations', { key: 'e5-x', body: {} }],
    ['GET', '/reservations/ABCD123456', {}],
    ['POST', '/reservations/ABCD123456/cancel', {}],
    ['PATCH', '/reservations/ABCD123456', { body: { party_size: 2 } }],
    ['POST', '/reservation-moves', { key: 'e5-y', body: { moves: [] } }],
  ];
  const variants = [
    ['no header', {}],
    ['empty header', { authRaw: '' }],
    ['no scheme', { authRaw: 'abc123' }],
    ['wrong scheme', { authRaw: 'Basic abc123' }],
    ['bearer with no token', { authRaw: 'Bearer' }],
    ['bearer with blank token', { authRaw: 'Bearer   ' }],
    ['unknown token', { authRaw: 'Bearer not-a-real-token' }],
  ];
  const authFailures = [];
  for (const [method, path, opts] of guarded) {
    for (const [name, headers] of variants) {
      const res = await call(method, path, { ...opts, ...headers });
      if (res.status !== 401 || code(res) !== 'unauthenticated') authFailures.push(`${method} ${path} with ${name}: ${res.status} ${code(res)}`);
    }
  }
  record('E5', authFailures.length === 0, authFailures.slice(0, 8).join('; ') || `${guarded.length} endpoints x ${variants.length} bad tokens, all 401 unauthenticated`);

  // E6 nothing in stage 1 names 403, so a stage-1 answer of 403 would be wrong
  const otherUser = await POST('/auth/signup', { body: { email: 'other@example.com', password: 'longenough', display_name: 'Other' } });
  const otherToken = otherUser.json.token;
  await fresh();
  token = await login();
  const mine = await book(await login(), { starts_at_local: `${D_THU_FUTURE}T19:00`, key: 'e6-1' });
  const forbiddenHits = [];
  for (const path of [`/reservations/${mine.json.reference}`, `/reservations/${mine.json.reference}/cancel`]) {
    const get = await GET(path, { token: otherToken });
    if (get.status === 403) forbiddenHits.push(`${path} -> 403`);
    const patch = await PATCH(path, { token: otherToken, body: { party_size: 2 } });
    if (patch.status === 403) forbiddenHits.push(`PATCH ${path} -> 403`);
    const cancel = await POST(path, { token: otherToken });
    if (cancel.status === 403) forbiddenHits.push(`POST ${path} -> 403`);
  }
  record('E6', forbiddenHits.length === 0, forbiddenHits.join('; ') || 'no stage-1 answer used 403 forbidden');

  // E7 404 not_found for no such resource
  const n404 = [
    ['unknown restaurant detail', await GET('/restaurants/r_missing')],
    ['availability for an unknown restaurant', await avail('r_missing', D_THU_FUTURE, 2)],
    ['unknown restaurant in a booking', await book(token, { restaurant_id: 'r_missing', starts_at_local: `${D_THU_FUTURE}T19:00` })],
    ['unknown table in a booking', await book(token, { table_id: 't_missing', starts_at_local: `${D_THU_FUTURE}T19:00` })],
    ['unknown reference', await GET('/reservations/ZZZZZZZZ', { token })],
    ['unknown reference in moves', await POST('/reservation-moves', { token, key: 'e7-1', body: { moves: [{ reference: 'ZZZZZZZZ', table_id: 't_2' }] } })],
  ];
  const bad404 = n404.filter(([, r]) => r.status !== 404 || code(r) !== 'not_found');
  record('E7', bad404.length === 0, bad404.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${n404.length} unknown resources, all 404 not_found`);

  // E8 / E3 409 idempotency_key_reuse
  const keyBody = { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 2 };
  const first = await POST('/reservations', { token, key: 'e8-key', body: keyBody });
  const reuse = await POST('/reservations', { token, key: 'e8-key', body: { ...keyBody, table_id: 't_2' } });
  record('E8', first.status === 201 && reuse.status === 409 && code(reuse) === 'idempotency_key_reuse',
    `first ${first.status}, different body on the same key -> ${reuse.status} ${code(reuse)}`);

  // E9 422 validation_failed for a missing required field or query parameter
  const missing = [];
  for (const field of ['restaurant_id', 'table_id', 'starts_at_local', 'party_size']) {
    const body = { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4 };
    delete body[field];
    missing.push([`reservation without ${field}`, await POST('/reservations', { token, key: `e9-${field}`, body })]);
  }
  for (const field of ['email', 'password']) {
    const body = { email: 'x@example.com', password: 'longenough', display_name: 'X' };
    delete body[field];
    missing.push([`signup without ${field}`, await POST('/auth/signup', { body })]);
  }
  for (const q of [`date=${D_THU_FUTURE}&party_size=2`, `restaurant_id=r_anker&party_size=2`, `restaurant_id=r_anker&date=${D_THU_FUTURE}`]) {
    missing.push([`availability without ${q}`, await GET(`/availability?${q}`)]);
  }
  const badMissing = missing.filter(([, r]) => r.status !== 422 || code(r) !== 'validation_failed');
  record('E9', badMissing.length === 0, badMissing.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${missing.length} missing fields or parameters, all 422 validation_failed`);

  // E10 out-of-range and invalid-format values of the right JSON type
  const range = [];
  range.push(['availability date 2026-02-30', await avail('r_anker', '2026-02-30', 2)]);
  range.push(['availability date 2026-13-01', await avail('r_anker', '2026-13-01', 2)]);
  range.push(['availability party_size 0', await avail('r_anker', D_THU_FUTURE, 0)]);
  range.push(['availability party_size -3', await avail('r_anker', D_THU_FUTURE, -3)]);
  range.push(['availability party_size 99999999999999999999', await avail('r_anker', D_THU_FUTURE, '99999999999999999999')]);
  const badRange = range.filter(([, r]) => r.status !== 422 || code(r) !== 'validation_failed');
  record('E10', badRange.length === 0, badRange.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${range.length} invalid dates, negative counts and over-length values, all 422 validation_failed`);

  // E11 invalid party_size values, strings and booleans included
  const party = [];
  for (const value of ['4', true, false, 4.5, 0, -1, null, [], {}]) {
    party.push([`party_size ${JSON.stringify(value)}`, await POST('/reservations', {
      token, key: `e11-${Math.random()}`, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T22:00`, party_size: value },
    })]);
  }
  const badParty = party.filter(([, r]) => r.status !== 422 || code(r) !== 'validation_failed');
  record('E11', badParty.length === 0, badParty.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${party.length} invalid party_size values, all 422 validation_failed`);

  // E12 starts_at_local must be a bare local YYYY-MM-DDTHH:MM
  const starts = [];
  for (const value of [
    '2026-12-10T19:00Z', '2026-12-10T19:00+01:00', '2026-12-10T19:00:00', '2026-12-10 19:00',
    '2026-12-10', '2026-12-10T19', '10/12/2026 19:00', '2026-12-10T24:00', '2026-12-10T19:60', '',
  ]) {
    starts.push([`starts_at_local ${JSON.stringify(value)}`, await POST('/reservations', {
      token, key: `e12-${Math.random()}`, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: value, party_size: 4 },
    })]);
  }
  const badStarts = starts.filter(([, r]) => r.status !== 422 || code(r) !== 'validation_failed');
  record('E12', badStarts.length === 0, badStarts.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${starts.length} malformed starts_at_local strings, all 422 validation_failed`);

  // E13 an integer query parameter is plain decimal digits
  const digits = [];
  for (const value of ['1e9', '4.0', '+4', '4.5', '0x10', '4e0', '4_0', '--4']) {
    digits.push([`party_size=${value}`, await avail('r_anker', D_THU_FUTURE, value)]);
  }
  const leadingZero = await avail('r_anker', D_THU_FUTURE, '007');
  record('E13b', leadingZero.status === 200 && leadingZero.json.slots.length > 0, `party_size=007 -> ${leadingZero.status}`);
  const badDigits = digits.filter(([, r]) => r.status !== 422 || code(r) !== 'validation_failed');
  record('E13', badDigits.length === 0, badDigits.map(([n, r]) => `${n}: ${r.status} ${code(r)}`).join('; ') || `${digits.length} non-plain-digit query values, all 422 validation_failed`);

  // E15 the key is 1 to 255 characters, on a clean slate of its own
  await fresh();
  token = await login();
  const keyBody2 = { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T18:00`, party_size: 2 };
  const short = await POST('/reservations', { token, key: 'a', body: keyBody2 });
  const exact255 = await POST('/reservations', { token, key: 'K'.repeat(255), body: { ...keyBody2, starts_at_local: `${D_THU_FUTURE}T20:00` } });
  const over = await POST('/reservations', { token, key: 'K'.repeat(256), body: { ...keyBody2, starts_at_local: `${D_THU_FUTURE}T21:00` } });
  const overOnMoves = await POST('/reservation-moves', { token, key: 'K'.repeat(300), body: { moves: [{ reference: 'SEED001' }] } });
  record('E15', short.status === 201 && exact255.status === 201 && over.status === 422 && code(over) === 'validation_failed' && overOnMoves.status === 422 && code(overOnMoves) === 'validation_failed',
    `1 char ${short.status}, 255 chars ${exact255.status}, 256 chars -> ${over.status} ${code(over)}, 300 chars on moves -> ${overOnMoves.status} ${code(overOnMoves)}`);

  // E17 endpoint-specific field rules take precedence over the generic wrong-type rule
  await fresh();
  token = await login();
  const generic = await POST('/reservations', { token, key: 'e17-a', body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2, mystery: { deep: [1] } } });
  const genericWrongType = await POST('/reservations', { token, key: 'e17-b', body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 2, mystery: 5 } });
  const special = await POST('/reservations', { token, key: 'e17-c', body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: '4' } });
  record('E17', generic.status === 201 && genericWrongType.status === 201 && special.status === 422 && code(special) === 'validation_failed',
    `unknown fields ignored (${generic.status} ${code(generic)}, wrong-typed unknown field ${genericWrongType.status} ${code(genericWrongType)}), party_size string -> ${special.status} ${code(special)}`);
}
