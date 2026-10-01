// Rows V1..V19: POST /reservation-moves.
import { GET, POST, PATCH, record, deepEqual, BASE } from './lib.mjs';
import { fixture, restaurant, table, fresh, login, reset, avail, book, D_THU_FUTURE } from './fixtures.mjs';

const THREE = () => fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 60, tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4), table('t_4', 4)] })] });
const OTHER = () => ({ ...THREE(), restaurants: [restaurant({ id: 'r_other', name: 'Other', tables: [table('t_o', 4)] }), restaurant({ slot_minutes: 30, reservation_duration_minutes: 60, tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4), table('t_4', 4)] })] });

const move = (token, moves, key, extra = {}) => POST('/reservation-moves', { token, key, body: { moves }, ...extra });
const ids = (res) => (res.json.reservations || []).map((r) => r.reference);
const slotIds = (clock, party = 4) => avail('r_anker', D_THU_FUTURE, party).then((r) => r.json.slots.find((s) => s.starts_at_local === `${D_THU_FUTURE}T${clock}`).available_table_ids);

export default async function run() {
  // V1, V3, V16 two bookings moved in one call, echoed in input order
  await reset(THREE());
  const tok = await login();
  const a = await book(tok, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T18:00`, party_size: 2, key: 'v1-a' });
  const b = await book(tok, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'v1-b' });
  const both = await move(tok, [{ reference: b.json.reference, table_id: 't_3' }, { reference: a.json.reference, starts_at_local: `${D_THU_FUTURE}T22:00` }], 'v1-batch');
  const order = ids(both);
  record('V1', both.status === 201 && deepEqual(order, [b.json.reference, a.json.reference]), `two bookings in one call -> ${both.status}, moved back to ${JSON.stringify(order)}`);
  record('V3', both.status === 201, `the documented body shape {moves:[{reference,table_id},{reference,starts_at_local}]} -> ${both.status}`);
  const shapes = [both.json.reservations[0], both.json.reservations[1]];
  record('V16', both.status === 201 && Array.isArray(both.json.reservations) && both.json.reservations.length === 2 && shapes.every((r) => deepEqual(Object.keys(r).sort(), ['created_at', 'ends_at', 'party_size', 'reference', 'reservation_id', 'restaurant_id', 'starts_at', 'starts_at_local', 'status', 'table_id'])),
    `201 with reservations in input order ${JSON.stringify(order)}, ${both.json.reservations.length} entries, each with the full reservation shape`);

  // V8 an unchanged item keeps its values, unknown keys are ignored
  const unchangedFirst = await move(tok, [{ reference: b.json.reference }, { reference: a.json.reference, table_id: 't_4' }], 'v8-batch');
  const movedField = unchangedFirst.json.reservations[1];
  record('V8', unchangedFirst.status === 201 && unchangedFirst.json.reservations[0].table_id === 't_3' && unchangedFirst.json.reservations[0].starts_at_local === `${D_THU_FUTURE}T20:00`
    && movedField.table_id === 't_4' && movedField.starts_at_local === `${D_THU_FUTURE}T22:00`,
    `an item with no fields keeps t_3 20:00 (${unchangedFirst.json.reservations[0].table_id} ${unchangedFirst.json.reservations[0].starts_at_local}), the next moved to t_4 (${movedField.table_id} ${movedField.starts_at_local})`);

  await fresh(THREE());
  const tok8 = await login();
  const t1 = await book(tok8, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v8-1' });
  const withUnknown = await move(tok8, [{ reference: t1.json.reference, table_id: 't_3', party_size: 2, notes: 'window seat', id: 'res_x', status: 'cancelled' }], 'v8-unknown');
  const t2 = await book(tok8, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T18:00`, party_size: 4, key: 'v8-2' });
  const eachField = await move(tok8, [{ reference: t2.json.reference, party_size: 2 }], 'v8-party');
  record('V8b', withUnknown.status === 201 && withUnknown.json.reservations[0].table_id === 't_3' && withUnknown.json.reservations[0].party_size === 2
    && withUnknown.json.reservations[0].status === 'confirmed' && eachField.status === 201 && eachField.json.reservations[0].party_size === 2 && eachField.json.reservations[0].table_id === 't_2',
    `table_id and party_size in one item -> ${withUnknown.status} t_3 party 2, status still ${withUnknown.json.reservations[0].status}, unknown keys ignored; party_size alone -> ${eachField.status} party ${eachField.json.reservations[0].party_size} on ${eachField.json.reservations[0].table_id}`);

  // V9 the identity of a booking never changes
  await fresh(THREE());
  const tok9 = await login();
  const victim = await book(tok9, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v9-1' });
  const moved9 = await move(tok9, [{ reference: victim.json.reference, table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T21:00` }], 'v9-batch');
  const after9 = moved9.json.reservations[0];
  record('V9', moved9.status === 201 && after9.reservation_id === victim.json.reservation_id && after9.reference === victim.json.reference && after9.created_at === victim.json.created_at,
    `reservation_id ${after9.reservation_id}, reference ${after9.reference}, created_at ${after9.created_at} (user_id is not part of the response shape: the caller owns it by construction)`);

  // V18 a batch that restates the current values changes nothing
  const noop = await move(tok9, [{ reference: victim.json.reference, table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4 }], 'v18-batch');
  record('V18', noop.status === 201 && deepEqual(noop.json.reservations[0], after9), `restating every value -> ${noop.status} ${deepEqual(noop.json.reservations[0], after9) ? 'identical body' : 'different body'}`);

  // V14 an unchanged listed booking still holds its slot
  await fresh(THREE());
  const tok14 = await login();
  const stays = await book(tok14, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v14-stays' });
  const goes = await book(tok14, { table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v14-goes' });
  const batch14 = await move(tok14, [{ reference: stays.json.reference }, { reference: goes.json.reference, table_id: 't_4' }], 'v14-batch');
  const after14 = await slotIds('19:00');
  record('V14', batch14.status === 201 && batch14.json.reservations[0].table_id === 't_2' && !after14.includes('t_2') && !after14.includes('t_4') && after14.includes('t_3'),
    `the untouched item still holds t_2 at 19:00 and the moved one holds t_4, so the tables free for a party of 4 are ${JSON.stringify(after14)}`);

  // V17 a replay returns the stored 201 as 200, even after the booking changed again
  await fresh(THREE());
  const tok17 = await login();
  const b17 = await book(tok17, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v17-1' });
  const sameBody = [{ reference: b17.json.reference, table_id: 't_3' }];
  const first17 = await move(tok17, sameBody, 'v17-batch');
  await PATCH(`/reservations/${b17.json.reference}`, { token: tok17, body: { table_id: 't_4' } });
  const replayAfterAmend = await move(tok17, sameBody, 'v17-batch');
  await POST(`/reservations/${b17.json.reference}/cancel`, { token: tok17 });
  const replayAfterCancel = await move(tok17, sameBody, 'v17-batch');
  record('V17', first17.status === 201 && replayAfterAmend.status === 200 && deepEqual(replayAfterAmend.json, first17.json) && replayAfterCancel.status === 200 && deepEqual(replayAfterCancel.json, first17.json),
    `original ${first17.status}, replay after a later amend ${replayAfterAmend.status} identical ${deepEqual(replayAfterAmend.json, first17.json)}, replay after a cancel ${replayAfterCancel.status} identical ${deepEqual(replayAfterCancel.json, first17.json)}`);

  // V2 authentication and the idempotency key are required
  await fresh(THREE());
  const tok2 = await login();
  const b2 = await book(tok2, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v2-1' });
  const anon = await POST('/reservation-moves', { body: { moves: [{ reference: b2.json.reference, table_id: 't_3' }] }, key: 'v2-anon' });
  const noKey = await POST('/reservation-moves', { token: tok2, body: { moves: [{ reference: b2.json.reference, table_id: 't_3' }] } });
  record('V2', anon.status === 401 && anon.json?.error?.code === 'unauthenticated' && noKey.status === 400 && noKey.json?.error?.code === 'missing_idempotency_key',
    `no token -> ${anon.status} ${anon.json?.error?.code}, no Idempotency-Key -> ${noKey.status} ${noKey.json?.error?.code}`);

  // V4 the shape of the batch
  await fresh(OPEN_ALL());
  const tok4 = await login();
  const refs4 = [];
  for (let i = 0; i < 8; i += 1) {
    const made4 = await book(tok4, { table_id: i % 2 === 0 ? 't_2' : 't_3', starts_at_local: `${D_THU_FUTURE}T${String(6 + i).padStart(2, '0')}:00`, party_size: 4, key: `v4-${i}` });
    refs4.push(made4.json.reference);
  }
  const eight = Array.from({ length: 8 }, (_, i) => ({ reference: refs4[i], table_id: 't_4' }));
  const badShapes = [
    ['empty moves', { moves: [] }],
    ['nine moves', { moves: Array.from({ length: 9 }, (_, i) => ({ reference: refs4[i], table_id: 't_3' })) }],
    ['moves is a string', { moves: 'BOOK01' }],
    ['moves is an object', { moves: { reference: refs4[0], table_id: 't_3' } }],
    ['item is a string', { moves: [refs4[0]] }],
    ['item is an array', { moves: [[refs4[0]]] }],
    ['reference is a number', { moves: [{ reference: 7, table_id: 't_3' }] }],
    ['reference missing', { moves: [{ table_id: 't_3' }] }],
    ['reference empty', { moves: [{ reference: '', table_id: 't_3' }] }],
    ['duplicate references', { moves: [{ reference: refs4[0], table_id: 't_3' }, { reference: refs4[0], table_id: 't_4' }] }],
    ['body has no moves', {}],
    ['moves null', { moves: null }],
  ];
  const seen = [];
  let ok = true;
  for (const [label, body] of badShapes) {
    const res = await POST('/reservation-moves', { token: tok4, key: `v4-${label.replace(/\W+/g, '-')}`, body });
    seen.push(`${label} ${res.status} ${res.json?.error?.code}`);
    if (res.status !== 422 || res.json?.error?.code !== 'validation_failed') ok = false;
  }
  const eightRes = await move(tok4, eight, 'v4-eight');
  const eightCount = (eightRes.json.reservations || []).length;
  record('V4', ok && eightRes.status === 201 && eightCount === 8, `${seen.join('; ')}; eight distinct moves -> ${eightRes.status} with ${eightCount} reservations`);

  // V5, V6, V7 ownership and restaurant
  await fresh(OTHER());
  const tok5 = await login();
  const stranger = (await POST('/auth/signup', { body: { email: 'nosy@example.com', password: 'correct horse' } })).json.token;
  const mine5 = await book(tok5, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v5-mine' });
  const theirs5 = await book(stranger, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'v5-theirs' });
  const other5 = await book(tok5, { restaurant_id: 'r_other', table_id: 't_o', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v5-other' });
  const unknown = await move(tok5, [{ reference: 'ZZZZZZZZ', table_id: 't_3' }], 'v6-unknown');
  const foreign = await move(tok5, [{ reference: theirs5.json.reference, table_id: 't_3' }], 'v6-foreign');
  const mixed = await move(tok5, [{ reference: mine5.json.reference, table_id: 't_3' }, { reference: other5.json.reference, table_id: 't_o2' }], 'v7-mixed');
  const onlyOther = await move(tok5, [{ reference: other5.json.reference }], 'v7-only-other');
  record('V5', mine5.status === 201 && theirs5.status === 201 && mixed.status === 422 && mixed.json?.error?.code === 'validation_failed', `a batch mixing r_anker and r_other -> ${mixed.status} ${mixed.json?.error?.code}`);
  record('V6', unknown.status === 404 && unknown.json?.error?.code === 'not_found' && foreign.status === 404 && foreign.json?.error?.code === 'not_found',
    `an unknown reference -> ${unknown.status} ${unknown.json?.error?.code}, another owner's booking -> ${foreign.status} ${foreign.json?.error?.code}`);
  record('V7', mixed.status === 422 && mixed.json?.error?.code === 'validation_failed' && onlyOther.status === 201, `two restaurants in one batch -> ${mixed.status} ${mixed.json?.error?.code}, a batch confined to r_other -> ${onlyOther.status}`);

  // V10 a cancelled booking
  await fresh(THREE());
  const tok10 = await login();
  const dead = await book(tok10, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v10-1' });
  await POST(`/reservations/${dead.json.reference}/cancel`, { token: tok10 });
  const onDead = await move(tok10, [{ reference: dead.json.reference, table_id: 't_3' }], 'v10-batch');
  record('V10', onDead.status === 409 && onDead.json?.error?.code === 'reservation_cancelled', `a cancelled booking in a batch -> ${onDead.status} ${onDead.json?.error?.code}`);

  // V11 the cutoff of each listed booking
  await fresh(OPEN_TODAY());
  const tok11 = await login();
  const near = await book(tok11, { table_id: 't_2', starts_at_local: nearSlot(), party_size: 4, key: 'v11-near' });
  const onNear = await move(tok11, [{ reference: near.json.reference, table_id: 't_3' }], 'v11-batch');
  record('V11', near.status === 201 && onNear.status === 409 && onNear.json?.error?.code === 'cutoff_passed',
    `a booking starting ${nearSlot()} with a 120 minute cutoff -> ${onNear.status} ${onNear.json?.error?.code}`);

  // V12 error precedence
  await fresh(OPEN_TODAY());
  const tok12 = await login();
  const faultA = await book(tok12, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v12-a' });
  const faultB = await book(tok12, { table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'v12-b' });
  const faultC = await book(tok12, { table_id: 't_4', starts_at_local: nearSlot(), party_size: 4, key: 'v12-c' });
  const badParty = { reference: faultA.json.reference, party_size: 99 };
  const badTime = { reference: faultB.json.reference, starts_at_local: `${D_THU_FUTURE}T20:07` };
  const order1 = await move(tok12, [badParty, badTime], 'v12-order1');
  const order2 = await move(tok12, [badTime, badParty], 'v12-order2');
  const cutoffWins = await move(tok12, [{ reference: faultC.json.reference, party_size: 99 }, badParty], 'v12-cutoff');
  record('V12', order1.json?.error?.code === 'party_exceeds_capacity' && order2.json?.error?.code === 'not_on_slot_grid' && cutoffWins.json?.error?.code === 'cutoff_passed',
    `party fault first -> ${order1.status} ${order1.json?.error?.code}, grid fault first -> ${order2.status} ${order2.json?.error?.code}, a cutoff fault beside a bad field -> ${cutoffWins.status} ${cutoffWins.json?.error?.code}`);

  // V13 conflicts
  await fresh(THREE());
  const tok13 = await login();
  const left = await book(tok13, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v13-left' });
  const right = await book(tok13, { table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v13-right' });
  const ontoEachOther = await move(tok13, [{ reference: left.json.reference, table_id: 't_4' }, { reference: right.json.reference, table_id: 't_4' }], 'v13-pair');
  const unlisted = await book(tok13, { table_id: 't_4', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'v13-unlisted' });
  const ontoUnlisted = await move(tok13, [{ reference: left.json.reference, table_id: 't_4', starts_at_local: `${D_THU_FUTURE}T20:00` }], 'v13-unlisted');
  record('V13', ontoEachOther.status === 409 && ontoEachOther.json?.error?.code === 'table_unavailable' && ontoUnlisted.status === 409 && ontoUnlisted.json?.error?.code === 'table_unavailable',
    `two listed bookings onto one overlapping table -> ${ontoEachOther.status} ${ontoEachOther.json?.error?.code}; onto a table an unlisted booking holds -> ${ontoUnlisted.status} ${ontoUnlisted.json?.error?.code}`);

  // V15 atomicity
  await fresh(THREE());
  const tok15 = await login();
  const keep15 = await book(tok15, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v15-keep' });
  const good15 = await book(tok15, { table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v15-good' });
  const block15 = await book(tok15, { table_id: 't_4', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'v15-block' });
  const before = await slotIds('19:00');
  const failing = await move(tok15, [{ reference: good15.json.reference, table_id: 't_2' }, { reference: keep15.json.reference, table_id: 't_4', starts_at_local: `${D_THU_FUTURE}T21:00` }], 'v15-batch');
  const afterFail = await slotIds('19:00');
  const keepAfter = await GET(`/reservations/${keep15.json.reference}`, { token: tok15 });
  const goodAfter = await GET(`/reservations/${good15.json.reference}`, { token: tok15 });
  const retry = await move(tok15, [{ reference: good15.json.reference, table_id: 't_4' }, { reference: keep15.json.reference, table_id: 't_3' }], 'v15-batch');
  record('V15', failing.status === 409 && deepEqual(afterFail, before) && deepEqual(keepAfter.json, keep15.json) && deepEqual(goodAfter.json, good15.json) && retry.status === 201,
    `the failing batch answered ${failing.status} ${failing.json?.error?.code}; availability ${JSON.stringify(before)} before and ${JSON.stringify(afterFail)} after; both bookings unchanged ${deepEqual(keepAfter.json, keep15.json) && deepEqual(goodAfter.json, good15.json)}; the same key then succeeded ${retry.status}`);

  // V19 a batch receipt survives export and import
  await fresh(THREE());
  const tok19 = await login();
  const b19 = await book(tok19, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'v19-book' });
  const sameBody19 = [{ reference: b19.json.reference, table_id: 't_3' }];
  const batch19 = await move(tok19, sameBody19, 'v19-batch');
  const exported = await (await fetch(`${BASE}/_test/export`)).text();
  await fetch(`${BASE}/_test/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exported });
  const replay19 = await move(tok19, sameBody19, 'v19-batch');
  const now19 = await GET(`/reservations/${b19.json.reference}`, { token: tok19 });
  record('V19', batch19.status === 201 && replay19.status === 200 && deepEqual(replay19.json, batch19.json) && now19.json.table_id === 't_3',
    `batch ${batch19.status}, replay after an import round trip -> ${replay19.status} identical ${deepEqual(replay19.json, batch19.json)}, the booking is still on ${now19.json.table_id}`);
}

const OPEN_ALL = () => {
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${D_THU_FUTURE}T12:00:00Z`).getUTCDay()];
  return fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 60, opening_hours: [{ weekday, opens: '00:00', closes: '23:45' }], tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4), table('t_4', 4)] })] });
};

const OPEN_TODAY = () => {
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getUTCDay()];
  return fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 60, opening_hours: [{ weekday, opens: '00:00', closes: '23:45' }], tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4), table('t_4', 4)] })] });
};

function nearSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const date = `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`;
  const target = Math.ceil((get('hour') * 60 + get('minute') + 45) / 30) * 30;
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
  return `${date}T${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}`;
}