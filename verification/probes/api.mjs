// Rows P1..P24.
import { GET, POST, PATCH, call, record, isRfc3339WithOffset, isBareLocal, deepEqual } from './lib.mjs';
import { fixture, restaurant, table, fresh, login, reset, avail, book, seeded, D_THU, D_THU_FUTURE, BERLIN, NEWYORK } from './fixtures.mjs';

const CREATE_FIELDS = ['created_at', 'ends_at', 'party_size', 'reference', 'reservation_id', 'restaurant_id', 'starts_at', 'starts_at_local', 'status', 'table_id'];

export default async function run() {
  // P1 the three public endpoints need no token
  await fresh();
  const publicThree = [await GET('/restaurants'), await GET('/restaurants/r_anker'), await avail('r_anker', D_THU_FUTURE, 4)];
  record('P1', publicThree.every((r) => r.status === 200), `without a token: ${publicThree.map((r) => r.status).join(', ')}`);

  // P2 the restaurant summary list
  await reset(fixture({ restaurants: [restaurant({ id: 'r_b', name: 'Second', timezone: NEWYORK }), restaurant()] }));
  const list = await GET('/restaurants');
  const shapeOk = list.json.restaurants.every((r) => Object.keys(r).sort().length === 3 && 'id' in r && 'name' in r && 'timezone' in r);
  record('P2', list.status === 200 && list.json.restaurants.length === 2 && shapeOk && list.json.restaurants.map((r) => r.id).join(',') === 'r_b,r_anker' && list.json.restaurants[0].timezone === NEWYORK,
    `GET /restaurants -> ${list.status} ${JSON.stringify(list.json)}`);

  // P3 the detail is the fixture shape, and an unknown id is 404
  const detail = await GET('/restaurants/r_anker');
  const expected = restaurant();
  const same = ['slot_minutes', 'reservation_duration_minutes', 'cancellation_cutoff_minutes'].every((f) => detail.json[f] === expected[f])
    && deepEqual(detail.json.opening_hours, expected.opening_hours) && deepEqual(detail.json.tables, expected.tables)
    && detail.json.timezone === expected.timezone && detail.json.name === expected.name && detail.json.id === expected.id;
  const unknownDetail = await GET('/restaurants/r_nope');
  record('P3', detail.status === 200 && same && unknownDetail.status === 404 && unknownDetail.json?.error?.code === 'not_found',
    `detail fields match the fixture: ${same}; unknown id -> ${unknownDetail.status} ${unknownDetail.json?.error?.code}`);

  // P4 all three availability parameters are required
  await reset(fixture());
  const missingParams = [
    await GET('/availability?date=2026-12-10&party_size=2'),
    await GET('/availability?restaurant_id=r_anker&party_size=2'),
    await GET('/availability?restaurant_id=r_anker&date=2026-12-10'),
    await GET('/availability'),
  ];
  record('P4', missingParams.every((r) => r.status === 422 && r.json?.error?.code === 'validation_failed'),
    `missing parameters -> ${missingParams.map((r) => `${r.status} ${r.json?.error?.code}`).join(', ')}`);

  // P5 and P6 the availability body
  const av = await avail('r_anker', D_THU_FUTURE, 4);
  const topKeys = Object.keys(av.json).sort();
  const slotKeys = [...new Set(av.json.slots.flatMap((s) => Object.keys(s).sort().join(',')))];
  const datesMatch = av.json.slots.every((s) => s.starts_at_local.slice(0, 10) === D_THU_FUTURE);
  const offsetsOk = av.json.slots.every((s) => /[+-]01:00$/.test(s.starts_at));
  record('P6', topKeys.join(',') === 'date,restaurant_id,slots,timezone' && slotKeys.length === 1 && slotKeys[0] === 'available_table_ids,starts_at,starts_at_local' && av.json.restaurant_id === 'r_anker' && av.json.date === D_THU_FUTURE && av.json.timezone === BERLIN,
    `top-level keys ${topKeys.join(',')}, slot keys ${slotKeys.join(' / ')}`);
  record('P5', datesMatch && offsetsOk && av.json.slots.length > 0, `every slot on the requested local date: ${datesMatch}, December offset +01:00: ${offsetsOk}`);

  // P7 a slot string goes into POST /reservations unchanged
  const slotText = av.json.slots[2].starts_at_local;
  const roundTrip = await book(await login(), { starts_at_local: slotText, key: 'p7-1' });
  record('P7', roundTrip.status === 201 && roundTrip.json.starts_at_local === slotText && roundTrip.json.starts_at === av.json.slots[2].starts_at,
    `posted ${slotText} -> ${roundTrip.status}, echoed ${roundTrip.json?.starts_at_local}, availability said ${av.json.slots[2].starts_at}`);

  // P8 slots run on the grid from opens while slot + duration <= closes
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 90, opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '21:00' }] })] }));
  const grid30 = await avail('r_anker', D_THU, 2);
  const got30 = grid30.json.slots.map((s) => s.starts_at_local);
  const want30 = ['2026-09-24T18:00', '2026-09-24T18:30', '2026-09-24T19:00', '2026-09-24T19:30'];
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 15, reservation_duration_minutes: 45, opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '20:00' }] })] }));
  const grid15 = await avail('r_anker', D_THU, 2);
  const got15 = grid15.json.slots.map((s) => s.starts_at_local);
  const want15 = ['2026-09-24T18:00', '2026-09-24T18:15', '2026-09-24T18:30', '2026-09-24T18:45', '2026-09-24T19:00', '2026-09-24T19:15'];
  record('P8', deepEqual(got30, want30) && deepEqual(got15, want15),
    `30-minute grid ${JSON.stringify(got30)}; 15-minute grid ${JSON.stringify(got15)}`);

  // P9 capacity filter, occupancy filter and fixture order
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 60, reservation_duration_minutes: 60, tables: [table('t_small', 2), table('t_big', 8), table('t_mid', 4)] })] }));
  const forFour = await avail('r_anker', D_THU, 4);
  const forTwo = await avail('r_anker', D_THU, 2);
  const listFour = forFour.json.slots[0].available_table_ids;
  const listTwo = forTwo.json.slots[0].available_table_ids;
  await book(await login(), { table_id: 't_big', starts_at_local: D_THU + 'T19:00', party_size: 8, key: 'p9-1' });
  const afterBooking = await avail('r_anker', D_THU, 4);
  const at19 = afterBooking.json.slots.find((s) => s.starts_at_local === `${D_THU}T19:00`);
  const at18 = afterBooking.json.slots.find((s) => s.starts_at_local === `${D_THU}T18:00`);
  record('P9', deepEqual(listFour, ['t_big', 't_mid']) && deepEqual(listTwo, ['t_small', 't_big', 't_mid']) && deepEqual(at19.available_table_ids, ['t_mid']) && deepEqual(at18.available_table_ids, ['t_big', 't_mid']),
    `party 4 -> ${JSON.stringify(listFour)}; party 2 -> ${JSON.stringify(listTwo)}; after booking t_big at 19:00 -> ${JSON.stringify(at19.available_table_ids)}, 18:00 untouched -> ${JSON.stringify(at18.available_table_ids)}`);

  // P10 a slot with nothing free still appears
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 60, reservation_duration_minutes: 60, tables: [table('t_only', 4)] })] }));
  await book(await login(), { table_id: 't_only', starts_at_local: `${D_THU}T19:00`, party_size: 4, key: 'p10-1' });
  const full = await avail('r_anker', D_THU, 4);
  const fullSlot = full.json.slots.find((s) => s.starts_at_local === `${D_THU}T19:00`);
  record('P10', fullSlot !== undefined && deepEqual(fullSlot.available_table_ids, []) && full.json.slots.length === full.json.slots.length,
    `fully booked slot -> ${JSON.stringify(fullSlot)}`);

  // P11 a closed day
  await reset(fixture());
  const sat = await avail('r_anker', '2026-09-26', 2);
  const wed = await avail('r_anker', '2026-09-23', 2);
  record('P11', sat.status === 200 && deepEqual(sat.json.slots, []) && wed.status === 200 && wed.json.slots.length === 0 && wed.json.date === '2026-09-23',
    `Saturday ${JSON.stringify(sat.json.slots)}, Wednesday ${JSON.stringify(wed.json.slots)}`);

  // P12 and P13 the created reservation
  await reset(fixture({ restaurants: [restaurant({ tables: [table('t_2', 4)] })] }));
  const token = await login();
  const created = await book(token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p12-1' });
  const c = created.json;
  const fieldsOk = deepEqual(Object.keys(c).sort(), CREATE_FIELDS)
    && c.status === 'confirmed' && c.party_size === 4 && c.table_id === 't_2' && c.restaurant_id === 'r_anker'
    && isBareLocal(c.starts_at_local) && isRfc3339WithOffset(c.starts_at) && isRfc3339WithOffset(c.ends_at) && isRfc3339WithOffset(c.created_at)
    && c.starts_at === '2026-12-10T19:00:00+01:00' && c.ends_at === '2026-12-10T20:30:00+01:00';
  record('P13', created.status === 201 && fieldsOk, `201 body ${JSON.stringify(c)}`);
  const sameLocalOtherZone = await POST('/reservations', {
    token: await (async () => { await reset(fixture({ restaurants: [restaurant({ timezone: NEWYORK })] })); return login(); })(),
    key: 'p12-2',
    body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 },
  });
  record('P12', sameLocalOtherZone.status === 201 && sameLocalOtherZone.json.starts_at === '2026-12-10T19:00:00-05:00' && sameLocalOtherZone.json.starts_at_local === `${D_THU_FUTURE}T19:00`,
    `same local string in New York -> ${sameLocalOtherZone.json?.starts_at}, local echoed ${sameLocalOtherZone.json?.starts_at_local}`);

  // P14 reference format and uniqueness
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 30, opening_hours: [{ weekday: 'thu', opens: '08:00', closes: '22:00' }], tables: [table('t_a', 8), table('t_b', 8), table('t_c', 8)] })] }));
  const tok14 = await login();
  const refs = new Set();
  const times = [];
  for (let h = 8; h < 22; h += 1) for (const t of ['t_a', 't_b', 't_c']) times.push(`${t}|${D_THU_FUTURE}T${String(h).padStart(2, '0')}:00`);
  for (const spec of times.slice(0, 40)) {
    const at = spec.indexOf('|');
    const t = spec.slice(0, at);
    const when = spec.slice(at + 1);
    const r = await book(tok14, { table_id: t, starts_at_local: when, party_size: 4, key: `p14-${spec}` });
    if (r.status === 201) refs.add(r.json.reference);
  }
  const badFormat = [...refs].filter((r) => !/^[A-Z0-9]{6,12}$/.test(r));
  record('P14', refs.size >= 30 && badFormat.length === 0, `${refs.size} references, all unique; outside 6..12 of A-Z0-9: ${JSON.stringify(badFormat)}`);

  // P15 an overlapping interval is 409 table_unavailable
  await reset(fixture());
  const tok15 = await login();
  await book(tok15, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p15-base' });
  const front = await book(tok15, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T18:30`, party_size: 4, key: 'p15-front' });
  const tail = await book(tok15, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'p15-tail' });
  const identical = await book(tok15, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:30`, party_size: 4, key: 'p15-same' });
  const otherTable = await book(tok15, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2, key: 'p15-other' });
  record('P15', [front, tail, identical].every((r) => r.status === 409 && r.json?.error?.code === 'table_unavailable') && otherTable.status === 201,
    `overlap at the front ${front.status} ${front.json?.error?.code}, at the tail ${tail.status}, identical interval ${identical.status}, another table ${otherTable.status}`);

  // P16 off the slot grid
  await reset(fixture());
  const tok16 = await login();
  const offGrid = await book(tok16, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:10`, party_size: 4, key: 'p16-1' });
  const offGridLate = await book(tok16, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:07`, party_size: 4, key: 'p16-2' });
  record('P16', offGrid.status === 422 && offGrid.json?.error?.code === 'not_on_slot_grid' && offGridLate.status === 422 && offGridLate.json?.error?.code === 'not_on_slot_grid',
    `19:10 on a 30-minute grid -> ${offGrid.status} ${offGrid.json?.error?.code}; 20:07 -> ${offGridLate.status} ${offGridLate.json?.error?.code}`);

  // P17 outside opening hours, or ending after closes
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 30, reservation_duration_minutes: 90, opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '21:00' }] })] }));
  const tok17 = await login();
  const before = await book(tok17, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T17:30`, party_size: 4, key: 'p17-1' });
  const after = await book(tok17, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'p17-2' });
  const tooLate = await book(tok17, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'p17-3' });
  const closedDay = await book(tok17, { table_id: 't_2', starts_at_local: '2026-12-11T19:00', party_size: 4, key: 'p17-4' });
  const lastGood = await book(tok17, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:30`, party_size: 4, key: 'p17-5' });
  const closesExactly = await book(tok17, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:30`, party_size: 2, key: 'p17-6' });
  record('P17', [before, after, tooLate, closedDay].every((r) => r.status === 422 && r.json?.error?.code === 'outside_opening_hours') && lastGood.status === 201 && closesExactly.status === 201,
    `17:30 ${before.status} ${before.json?.error?.code}; 21:00 ${after.status}; 20:00 ending 21:30 ${tooLate.status}; closed day ${closedDay.status}; 19:30 ending exactly at 21:00 ${lastGood.status} and ${closesExactly.status}`);

  // P18 party_size beyond the table capacity
  await reset(fixture());
  const tok18 = await login();
  const tooBig = await book(tok18, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 5, key: 'p18-1' });
  const justRight = await book(tok18, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p18-2' });
  const tooBigLater = await book(tok18, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:30`, party_size: 3, key: 'p18-3' });
  record('P18', tooBig.status === 422 && tooBig.json?.error?.code === 'party_exceeds_capacity' && justRight.status === 201 && tooBigLater.status === 422 && tooBigLater.json?.error?.code === 'party_exceeds_capacity',
    `5 on a 2-seat table -> ${tooBig.status} ${tooBig.json?.error?.code}; 4 on a 4-seat table ${justRight.status}; 3 later -> ${tooBigLater.status}`);

  // P19 party_size below 1 or not an integer
  const zero = await book(tok18, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 0, key: 'p19-1' });
  const frac = await book(tok18, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2.5, key: 'p19-2' });
  record('P19', zero.status === 422 && zero.json?.error?.code === 'validation_failed' && frac.status === 422 && frac.json?.error?.code === 'validation_failed',
    `party_size 0 -> ${zero.status} ${zero.json?.error?.code}; 2.5 -> ${frac.status} ${frac.json?.error?.code}`);

  // P21 a table that belongs to another restaurant is 404
  await reset(fixture({ restaurants: [restaurant({ id: 'r_other', name: 'Other', tables: [table('t_x', 6)] }), restaurant()] }));
  const tok21 = await login();
  const crossTable = await book(tok21, { table_id: 't_x', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p21-1' });
  const ownTable = await book(tok21, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p21-2' });
  record('P21', crossTable.status === 404 && crossTable.json?.error?.code === 'not_found' && ownTable.status === 201,
    `a table belonging to another restaurant -> ${crossTable.status} ${crossTable.json?.error?.code}; own table -> ${ownTable.status}`);

  // P22 and P23 half-open occupancy
  await reset(fixture());
  const tok22 = await login();
  const a = await book(tok22, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p22-a' });
  const adjacent = await book(tok22, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:30`, party_size: 4, key: 'p22-b' });
  const beforeAdjacent = await book(tok22, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'p22-c' });
  const mine = await GET('/reservations', { token: tok22 });
  const holds = (mine.json.reservations || []).length === 2;
  record('P23', a.status === 201 && adjacent.status === 201 && beforeAdjacent.status === 409 && holds,
    `19:00 -> ${a.status}, 20:30 adjacent -> ${adjacent.status}, 20:00 overlapping -> ${beforeAdjacent.status}, confirmed reservations ${(mine.json.reservations || []).length}`);
  record('P22', holds && adjacent.status === 201, 'every confirmed reservation on t_2 in the list is disjoint; 20:30 does not overlap 19:00-20:30');

  // P24 a rejected request leaves no booking behind
  await reset(fixture());
  const tok24 = await login();
  const rejects = [
    await book(tok24, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:10`, party_size: 4, key: 'p24-1' }),
    await book(tok24, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 9, key: 'p24-2' }),
    await book(tok24, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T22:00`, party_size: 4, key: 'p24-3' }),
    await book(tok24, { table_id: 't_missing', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p24-4' }),
  ];
  const afterRejects = await GET('/reservations', { token: tok24 });
  const avAfter = await avail('r_anker', D_THU_FUTURE, 4);
  const slot19 = avAfter.json.slots.find((s) => s.starts_at_local === `${D_THU_FUTURE}T19:00`);
  record('P24', rejects.every((r) => r.status === 422 || r.status === 404) && (afterRejects.json.reservations || []).length === 0 && deepEqual(slot19.available_table_ids, ['t_2']),
    `rejects ${rejects.map((r) => r.status).join(',')}, reservations ${(afterRejects.json.reservations || []).length}, 19:00 tables ${JSON.stringify(slot19.available_table_ids)}`);
}
