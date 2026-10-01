// Rows I1..I12.
import { GET, POST, PATCH, call, record, deepEqual } from './lib.mjs';
import { fixture, fresh, login, reset, avail, book, D_THU_FUTURE, restaurant, seeded } from './fixtures.mjs';

const body = (over = {}) => ({ restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, ...over });

export default async function run() {
  // I1 only the two named write paths require a key
  const withoutKey = [
    await POST('/reservations', { token: await login(), body: body() }),
    await POST('/reservation-moves', { token: await login(), body: { moves: [{ reference: 'ZZZZZZZZ' }] } }),
  ];
  const other = [
    await POST('/auth/signup', { body: { email: 'nokey@example.com', password: 'correct horse' } }),
    await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } }),
    await POST(`/reservations/${'ZZZZZZZZ'}/cancel`, { token: await login() }),
    await PATCH('/reservations/ZZZZZZZZ', { token: await login(), body: { party_size: 2 } }),
  ];
  record('I1', withoutKey.every((r) => r.status === 400 && r.json?.error?.code === 'missing_idempotency_key') && other.every((r) => r.status !== 400 || r.json?.error?.code !== 'missing_idempotency_key'),
    `both named paths: ${withoutKey.map((r) => r.status).join(',')}; other writes: ${other.map((r) => `${r.status} ${r.json?.error?.code || ''}`).join(', ')}`);

  // I2 the key is scoped to the authenticated user
  const ada = await login();
  const bob = (await POST('/auth/signup', { body: { email: 'scope@example.com', password: 'correct horse', display_name: 'Bob' } })).json;
  const a1 = await POST('/reservations', { token: ada, key: 'shared-key', body: body() });
  const b1 = await POST('/reservations', { token: bob.token, key: 'shared-key', body: body({ table_id: 't_1', party_size: 2 }) });
  record('I2', a1.status === 201 && b1.status === 201 && a1.json.reservation_id !== b1.json.reservation_id,
    `user A -> ${a1.status}, user B with the same key -> ${b1.status}`);

  // I3 the same key with the same body on a different path is a different request
  await fresh();
  const token = await login();
  const booking = await POST('/reservations', { token, key: 'path-key', body: body() });
  const movesSameBody = await POST('/reservation-moves', { token, key: 'path-key', body: { moves: [{ reference: booking.json.reference, table_id: 't_2' }] } });
  record('I3', booking.status === 201 && movesSameBody.status === 201,
    `POST /reservations -> ${booking.status}; POST /reservation-moves with the same key -> ${movesSameBody.status} ${movesSameBody.json?.error?.code || ''}`);

  // I4 resolved before endpoint-specific validation and current-resource checks
  await fresh();
  const t = await login();
  const firstUse = await POST('/reservations', { token: t, key: 'order-key', body: body() });
  const thenInvalid = await POST('/reservations', { token: t, key: 'order-key', body: body({ restaurant_id: 'r_nope', table_id: 't_nope', starts_at_local: 'nonsense', party_size: -3 }) });
  const blocker = await book(t, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 2, key: 'order-block' });
  const thenOccupied = await POST('/reservations', { token: t, key: 'order-key', body: body({ table_id: 't_1', party_size: 2, starts_at_local: `${D_THU_FUTURE}T20:30` }) });
  const freeSlotSameKeyElsewhere = await POST('/reservations', { token: t, key: 'order-key', body: body() });
  record('I4', firstUse.status === 201 && blocker.status === 201 && thenInvalid.status === 409 && thenInvalid.json?.error?.code === 'idempotency_key_reuse' && thenOccupied.status === 409 && thenOccupied.json?.error?.code === 'idempotency_key_reuse' && freeSlotSameKeyElsewhere.status === 200,
    `first ${firstUse.status}; invalid body on the same key -> ${thenInvalid.status} ${thenInvalid.json?.error?.code}; occupied table on the same key -> ${thenOccupied.status} ${thenOccupied.json?.error?.code}; exact replay -> ${freeSlotSameKeyElsewhere.status}`);

  // I5 absent or empty header (the codes themselves are row E4)
  record('I5', withoutKey.every((r) => r.status === 400 && r.json?.error?.code === 'missing_idempotency_key'), `absent header -> ${withoutKey.map((r) => `${r.status} ${r.json?.error?.code}`).join(', ')}`);

  // I6 first use is the normal response, 201
  await fresh();
  const tok6 = await login();
  const first = await POST('/reservations', { token: tok6, key: 'first-use', body: body() });
  record('I6', first.status === 201 && first.json.status === 'confirmed', `first use -> ${first.status} ${first.json?.status}`);

  // I7 a replay is 200 with a body identical to the original as a JSON value
  const replay = await POST('/reservations', { token: tok6, key: 'first-use', body: body() });
  record('I7', replay.status === 200 && deepEqual(replay.json, first.json), `replay -> ${replay.status}, body identical as a JSON value: ${deepEqual(replay.json, first.json)}`);

  // I10 same body means the same JSON value: key order and whitespace do not matter
  const reordered = await call('POST', '/reservations', { rawBody: `{ "party_size": 4,\n  "starts_at_local": "${D_THU_FUTURE}T19:00", "table_id": "t_2",\t"restaurant_id": "r_anker" }`, token: tok6, key: 'first-use' });
  const keyOrderReversed = await POST('/reservations', { token: tok6, key: 'first-use', body: { party_size: 4, starts_at_local: `${D_THU_FUTURE}T19:00`, table_id: 't_2', restaurant_id: 'r_anker' } });
  record('I10', reordered.status === 200 && deepEqual(reordered.json, first.json) && keyOrderReversed.status === 200 && deepEqual(keyOrderReversed.json, first.json),
    `reordered and respaced body -> ${reordered.status}, reordered keys -> ${keyOrderReversed.status}`);

  // I8 same key, different body
  const different = await POST('/reservations', { token: tok6, key: 'first-use', body: body({ party_size: 2, table_id: 't_1' }) });
  record('I8', different.status === 409 && different.json?.error?.code === 'idempotency_key_reuse', `different body -> ${different.status} ${different.json?.error?.code}`);

  // I9 a key whose original request failed with 4xx is reusable
  await fresh();
  const tok9 = await login();
  const burned = await POST('/reservations', { token: tok9, key: 'burn-key', body: body({ starts_at_local: 'nonsense' }) });
  const reused = await POST('/reservations', { token: tok9, key: 'burn-key', body: body() });
  const burned404 = await POST('/reservations', { token: tok9, key: 'burn-404', body: body({ restaurant_id: 'r_nope' }) });
  const reused404 = await POST('/reservations', { token: tok9, key: 'burn-404', body: body({ table_id: 't_1', party_size: 2, starts_at_local: `${D_THU_FUTURE}T20:00` }) });
  await book(tok9, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'block' });
  const conflict = await book(tok9, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:30`, party_size: 4, key: 'burn-409' });
  const reused409 = await book(tok9, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T18:00`, party_size: 2, key: 'burn-409' });
  record('I9', burned.status === 422 && reused.status === 201 && burned404.status === 404 && reused404.status === 201 && conflict.status === 409 && reused409.status === 201,
    `422 then reuse ${reused.status}; 404 then reuse ${reused404.status}; 409 then reuse ${reused409.status} (burned ${burned.status}/${burned404.status}/${conflict.status})`);

  // I11 concurrent identical requests with an unused key: exactly one 201
  await fresh();
  const tok11 = await login();
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => POST('/reservations', { token: tok11, key: 'race-key', body: body() })));
  const created = concurrent.filter((r) => r.status === 201);
  const replayed = concurrent.filter((r) => r.status === 200);
  const after = await GET('/reservations', { token: tok11 });
  const sameBody = replayed.every((r) => deepEqual(r.json, created[0] ? created[0].json : null));
  record('I11', created.length === 1 && replayed.length === 7 && sameBody && (after.json.reservations || []).length === 1,
    `statuses ${concurrent.map((r) => r.status).join(',')}; reservations afterwards ${(after.json.reservations || []).length}; replay bodies identical: ${sameBody}`);

  // I12 a successful replay returns the original response and makes no further change
  const patchTo = await PATCH(`/reservations/${created[0].json.reference}`, { token: tok11, body: { party_size: 2, table_id: 't_1' } });
  const replayAfterPatch = await POST('/reservations', { token: tok11, key: 'race-key', body: body() });
  const cancel = await POST(`/reservations/${created[0].json.reference}/cancel`, { token: tok11 });
  const replayAfterCancel = await POST('/reservations', { token: tok11, key: 'race-key', body: body() });
  const afterAll = await GET('/reservations', { token: tok11 });
  const one = afterAll.json.reservations[0];
  record('I12', patchTo.status === 200 && cancel.status === 200 && replayAfterPatch.status === 200 && deepEqual(replayAfterPatch.json, created[0].json) && replayAfterCancel.status === 200 && deepEqual(replayAfterCancel.json, created[0].json) && (afterAll.json.reservations || []).length === 1 && one.status === 'cancelled' && one.party_size === 2,
    `patch ${patchTo.status}, cancel ${cancel.status}, replay after patch ${replayAfterPatch.status} identical ${deepEqual(replayAfterPatch.json, created[0].json)}, replay after cancel ${replayAfterCancel.status} identical ${deepEqual(replayAfterCancel.json, created[0].json)}, reservations ${(afterAll.json.reservations || []).length} with status ${one && one.status}`);
}
