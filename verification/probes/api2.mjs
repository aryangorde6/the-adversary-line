// Rows P25..P40.
import { GET, POST, PATCH, record, deepEqual } from './lib.mjs';
import { fixture, restaurant, table, fresh, login, reset, avail, book, D_BERLIN_GAP, D_THU_FUTURE } from './fixtures.mjs';

const CREATE_FIELDS = ['created_at', 'ends_at', 'party_size', 'reference', 'reservation_id', 'restaurant_id', 'starts_at', 'starts_at_local', 'status', 'table_id'];

export default async function run() {
  // P25, P26, P27 the caller's list
  await reset(fixture());
  const token = await login();
  const other = (await POST('/auth/signup', { body: { email: 'list@example.com', password: 'correct horse', display_name: 'List' } })).json;
  const mineEarly = await book(token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T18:00`, party_size: 4, key: 'p25-1' });
  const mineLate = await book(token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'p25-2' });
  const mineMiddle = await book(token, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:30`, party_size: 2, key: 'p25-3' });
  await POST(`/reservations/${mineMiddle.json.reference}/cancel`, { token });
  const theirs = await book(other.token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4, key: 'p25-4' });
  const list = await GET('/reservations', { token });
  const items = list.json.reservations || [];
  const starts = items.map((r) => r.starts_at);
  const descending = starts.every((s, i) => i === 0 || starts[i - 1] > s);
  const statuses = items.map((r) => r.status).sort().join(',');
  const shapeOk = items.every((r) => deepEqual(Object.keys(r).sort(), CREATE_FIELDS));
  record('P25', descending && statuses === 'cancelled,confirmed,confirmed' && items.every((r) => r.reference !== theirs.json.reference), `order ${starts.join(' > ')}, statuses ${statuses}`);
  record('P26', list.status === 200 && shapeOk && list.json.reservations.length === 3, `GET /reservations -> ${list.status}, ${items.length} entries, same shape as the create response: ${shapeOk}`);
  await reset(fixture());
  const empty = await GET('/reservations', { token: await login() });
  record('P27', empty.status === 200 && deepEqual(empty.json, { reservations: [] }), `empty list -> ${JSON.stringify(empty.json)}`);

  // P28 and P29 one reservation, 404 for another owner's
  await fresh();
  const owner = await login();
  const stranger = (await POST('/auth/signup', { body: { email: 'stranger@example.com', password: 'correct horse' } })).json;
  const made = await book(owner, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p28-1' });
  const fetched = await GET(`/reservations/${made.json.reference}`, { token: owner });
  const foreignGet = await GET(`/reservations/${made.json.reference}`, { token: stranger.token });
  const foreignPatch = await PATCH(`/reservations/${made.json.reference}`, { token: stranger.token, body: { party_size: 2 } });
  const foreignCancel = await POST(`/reservations/${made.json.reference}/cancel`, { token: stranger.token });
  record('P28', fetched.status === 200 && deepEqual(fetched.json, made.json), `GET own reservation -> ${fetched.status}, identical to the create body: ${deepEqual(fetched.json, made.json)}`);
  record('P29', [foreignGet, foreignPatch, foreignCancel].every((r) => r.status === 404 && r.json?.error?.code === 'not_found'),
    `another owner's booking: GET ${foreignGet.status} ${foreignGet.json?.error?.code}, PATCH ${foreignPatch.status}, cancel ${foreignCancel.status}`);

  // P30 and P31 cancelling frees the table at once
  await fresh();
  const tok30 = await login();
  const toCancel = await book(tok30, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p30-1' });
  const beforeCancel = await avail('r_anker', D_THU_FUTURE, 4);
  const slotBefore = beforeCancel.json.slots.find((s) => s.starts_at_local === `${D_THU_FUTURE}T19:00`);
  const cancelled = await POST(`/reservations/${toCancel.json.reference}/cancel`, { token: tok30 });
  const afterCancel = await avail('r_anker', D_THU_FUTURE, 4);
  const slotAfterCancel = afterCancel.json.slots.find((s) => s.starts_at_local === `${D_THU_FUTURE}T19:00`);
  const rebook = await book(tok30, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p30-2' });
  record('P30', cancelled.status === 200 && cancelled.json.status === 'cancelled' && cancelled.json.reference === toCancel.json.reference && cancelled.json.reservation_id === toCancel.json.reservation_id,
    `cancel -> ${cancelled.status} ${cancelled.json?.status}, same reference and id: ${cancelled.json?.reference === toCancel.json.reference && cancelled.json?.reservation_id === toCancel.json.reservation_id}`);
  record('P31', deepEqual(slotBefore.available_table_ids, []) && slotAfterCancel.available_table_ids.includes('t_2') && rebook.status === 201,
    `tables for a party of 4 at 19:00 before cancel ${JSON.stringify(slotBefore.available_table_ids)}, after cancel ${JSON.stringify(slotAfterCancel.available_table_ids)}, rebooking the same slot -> ${rebook.status}`);

  // P32 cancelling twice is not an error
  const twice = await POST(`/reservations/${toCancel.json.reference}/cancel`, { token: tok30 });
  record('P32', twice.status === 200 && twice.json.status === 'cancelled' && deepEqual(twice.json, cancelled.json), `second cancel -> ${twice.status} ${twice.json?.status}, same body as the first: ${deepEqual(twice.json, cancelled.json)}`);

  // P33 the cutoff, measured against now, with a start a known distance away
    const near = await slotAfter('thu', 60);
  const far = await slotAfter('thu', 300);
  await reset(openAllDay());
  const tok33 = await login();
  const nearBooking = await book(tok33, { table_id: 't_2', starts_at_local: near, party_size: 4, key: 'p33-near' });
  const inWindow = await POST(`/reservations/${nearBooking.json.reference}/cancel`, { token: tok33 });
  const farBooking = await book(tok33, { table_id: 't_1', starts_at_local: far, party_size: 2, key: 'p33-far' });
  const outOfWindow = await POST(`/reservations/${farBooking.json.reference}/cancel`, { token: tok33 });
  const stillConfirmed = await GET(`/reservations/${farBooking.json.reference}`, { token: tok33 });
  record('P33', inWindow.status === 409 && inWindow.json?.error?.code === 'cutoff_passed' && outOfWindow.status === 200 && stillConfirmed.json.status === 'cancelled',
    `start ${near} is ${nearBooking.status === 201 ? '60' : '?'} minutes away, cutoff 120 -> ${inWindow.status} ${inWindow.json?.error?.code}; start ${far} -> ${outOfWindow.status}, status now ${stillConfirmed.json?.status}`);

  // P35, P40 amending: any subset of the three fields, with no idempotency key
  await reset(threeTables());
  const tok35 = await login();
  const base = await book(tok35, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p35-base' });
  const ref = base.json.reference;
  await book(tok35, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 2, key: 'p35-other' });
  const tableOnly = await PATCH(`/reservations/${ref}`, { token: tok35, body: { table_id: 't_3' } });
  const timeOnly = await PATCH(`/reservations/${ref}`, { token: tok35, body: { starts_at_local: `${D_THU_FUTURE}T19:30` } });
  const partyOnly = await PATCH(`/reservations/${ref}`, { token: tok35, body: { party_size: 2 } });
  const allThree = await PATCH(`/reservations/${ref}`, { token: tok35, body: { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T20:00`, party_size: 4 } });
  const noKey = await PATCH(`/reservations/${ref}`, { token: tok35, body: { party_size: 3 } });
  const emptyPatch = await PATCH(`/reservations/${ref}`, { token: tok35, body: {} });
  const pair = await PATCH(`/reservations/${ref}`, { token: tok35, body: { table_id: 't_3', party_size: 4 } });
  record('P35', [tableOnly, timeOnly, partyOnly, allThree, noKey, emptyPatch, pair].every((r) => r.status === 200),
    `table only ${tableOnly.status}, time only ${timeOnly.status}, party only ${partyOnly.status}, all three ${allThree.status}, pair ${pair.status}, no Idempotency-Key header ${noKey.status}, empty body ${emptyPatch.status}`);
  record('P40', [tableOnly, timeOnly, allThree, pair].every((r) => r && r.json && r.json.reference === ref && r.json.reservation_id === base.json.reservation_id),
    `after each change: ${[tableOnly, timeOnly, allThree, pair].map((r) => `${r.json && r.json.reference}/${r.json && r.json.reservation_id}`).join(', ')} against ${ref}/${base.json.reservation_id}`);

  // P36 amendment validation is identical to create
  const badTime = await PATCH(`/reservations/${ref}`, { token: tok35, body: { starts_at_local: `${D_THU_FUTURE}T21:10` } });
  const badParty = await PATCH(`/reservations/${ref}`, { token: tok35, body: { party_size: 99 } });
  const badHours = await PATCH(`/reservations/${ref}`, { token: tok35, body: { starts_at_local: `${D_THU_FUTURE}T22:00` } });
  const badTable = await PATCH(`/reservations/${ref}`, { token: tok35, body: { table_id: 't_missing' } });
  const badPartyType = await PATCH(`/reservations/${ref}`, { token: tok35, body: { party_size: '3' } });
  record('P36', badTime.status === 422 && badTime.json?.error?.code === 'not_on_slot_grid' && badParty.status === 422 && badParty.json?.error?.code === 'party_exceeds_capacity' && badHours.json?.error?.code === 'outside_opening_hours' && badTable.status === 404 && badPartyType.status === 422,
    `off grid ${badTime.status} ${badTime.json?.error?.code}, party too large ${badParty.status} ${badParty.json?.error?.code}, 22:00 ${badHours.status} ${badHours.json?.error?.code}, unknown table ${badTable.status}, party_size string ${badPartyType.status}`);

  // P36 the cutoff on amend is measured against the current start
  await reset(openAllDay());
  const tokCut = await login();
  const near2 = await slotAfter('thu', 60);
  const far2 = await slotAfter('thu', 300);
  const nearBooking2 = await book(tokCut, { table_id: 't_2', starts_at_local: near2, party_size: 4, key: 'p36-near' });
  const farBooking2 = await book(tokCut, { table_id: 't_1', starts_at_local: far2, party_size: 2, key: 'p36-far' });
  const patchFar = await PATCH(`/reservations/${farBooking2.json.reference}`, { token: tokCut, body: { party_size: 2 } });
  const patchNear = await PATCH(`/reservations/${nearBooking2.json.reference}`, { token: tokCut, body: { party_size: 2 } });
  const cancelNear = await POST(`/reservations/${nearBooking2.json.reference}/cancel`, { token: tokCut });
  record('P36b', patchFar.status === 200 && patchNear.status === 409 && patchNear.json?.error?.code === 'cutoff_passed' && cancelNear.status === 409 && cancelNear.json?.error?.code === 'cutoff_passed',
    `amending a booking ${far2} away -> ${patchFar.status}; amending ${near2} away -> ${patchNear.status} ${patchNear.json?.error?.code}; cancelling ${near2} away -> ${cancelNear.status} ${cancelNear.json?.error?.code}`);

  // P37 a cancelled booking is 409 reservation_cancelled
  const cancelledFirst = await POST(`/reservations/${farBooking2.json.reference}/cancel`, { token: tokCut });
  const patchCancelled = await PATCH(`/reservations/${farBooking2.json.reference}`, { token: tokCut, body: { party_size: 3 } });
  const moveCancelled = await POST('/reservation-moves', { token: tokCut, key: 'p37-move', body: { moves: [{ reference: farBooking2.json.reference, party_size: 2 }] } });
  record('P37', cancelledFirst.status === 200 && patchCancelled.status === 409 && patchCancelled.json?.error?.code === 'reservation_cancelled' && moveCancelled.status === 409 && moveCancelled.json?.error?.code === 'reservation_cancelled',
    `cancel ${cancelledFirst.status}; amend -> ${patchCancelled.status} ${patchCancelled.json?.error?.code}; batch move -> ${moveCancelled.status} ${moveCancelled.json?.error?.code}`);

  // P38 an amendment releases the old slot and takes the new one together
  await reset(threeTables());
  const tok38 = await login();
  await book(tok38, { table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2, key: 'p38-holder' });
  const mover = await book(tok38, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p38-mover' });
  const moved = await PATCH(`/reservations/${mover.json.reference}`, { token: tok38, body: { table_id: 't_3', starts_at_local: `${D_THU_FUTURE}T21:00` } });
  const after = await avail('r_anker', D_THU_FUTURE, 4);
  const at = (clock) => after.json.slots.find((x) => x.starts_at_local === `${D_THU_FUTURE}T${clock}`);
  record('P38', moved.status === 200 && moved.json.table_id === 't_3' && moved.json.starts_at_local === `${D_THU_FUTURE}T21:00`
    && at('19:00').available_table_ids.includes('t_2') && at('19:00').available_table_ids.includes('t_3') && !at('21:00').available_table_ids.includes('t_3'),
    `moved t_2 19:00 to t_3 21:00 -> ${moved.status}; tables for a party of 4 at 19:00 ${JSON.stringify(at('19:00').available_table_ids)}, at 21:00 ${JSON.stringify(at('21:00').available_table_ids)}`);

  // P39 a failed amendment leaves the booking and its occupancy untouched
  await reset(threeTables());
  const tok39 = await login();
  const kept = await book(tok39, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p39-base' });
  await book(tok39, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 4, key: 'p39-block' });
  const before = await avail('r_anker', D_THU_FUTURE, 4);
  const failures = [
    await PATCH(`/reservations/${kept.json.reference}`, { token: tok39, body: { starts_at_local: `${D_THU_FUTURE}T21:00` } }),
    await PATCH(`/reservations/${kept.json.reference}`, { token: tok39, body: { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T21:30`, party_size: 4 } }),
    await PATCH(`/reservations/${kept.json.reference}`, { token: tok39, body: { party_size: 99 } }),
    await PATCH(`/reservations/${kept.json.reference}`, { token: tok39, body: { starts_at_local: `${D_THU_FUTURE}T19:05` } }),
    await PATCH(`/reservations/${kept.json.reference}`, { token: tok39, body: { table_id: 't_missing' } }),
  ];
  const unchanged = await GET(`/reservations/${kept.json.reference}`, { token: tok39 });
  const afterFailures = await avail('r_anker', D_THU_FUTURE, 4);
  const slot19 = (r) => r.json.slots.find((x) => x.starts_at_local === `${D_THU_FUTURE}T19:00`).available_table_ids;
  record('P39', failures.every((r) => r.status >= 400) && deepEqual(unchanged.json, kept.json) && deepEqual(slot19(afterFailures), slot19(before)),
    `failures ${failures.map((r) => `${r.status} ${r.json?.error?.code}`).join(', ')}; booking unchanged ${deepEqual(unchanged.json, kept.json)}; availability unchanged ${deepEqual(slot19(afterFailures), slot19(before))}`);

  // P20 a local time inside the spring-forward gap
  const gapWeekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${D_BERLIN_GAP}T12:00:00Z`).getUTCDay()];
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 15, reservation_duration_minutes: 30, opening_hours: [{ weekday: gapWeekday, opens: '00:00', closes: '23:45' }] })] }));
  const tok20 = await login();
  const gapBookings = [];
  for (const clock of ['01:00', '02:00', '02:15', '02:45', '03:00']) gapBookings.push(await book(tok20, { table_id: 't_2', starts_at_local: `${D_BERLIN_GAP}T${clock}`, party_size: 4, key: `p20-${clock}` }));
  record('P20', gapBookings[0].status === 201 && gapBookings[1].status === 422 && gapBookings[1].json?.error?.code === 'invalid_local_time'
    && gapBookings[2].json?.error?.code === 'invalid_local_time' && gapBookings[3].json?.error?.code === 'invalid_local_time' && gapBookings[4].status === 201,
    `01:00 -> ${gapBookings[0].status}, 02:00 -> ${gapBookings[1].status} ${gapBookings[1].json?.error?.code}, 02:15 -> ${gapBookings[2].status} ${gapBookings[2].json?.error?.code}, 02:45 -> ${gapBookings[3].status} ${gapBookings[3].json?.error?.code}, 03:00 -> ${gapBookings[4].status}`);

  // P34 cancelling a booking that belongs to somebody else
  await fresh();
  const owner34 = await login();
  const other34 = (await POST('/auth/signup', { body: { email: 'not-mine@example.com', password: 'correct horse' } })).json.token;
  const held34 = await book(owner34, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'p34-1' });
  const strangerCancel = await POST(`/reservations/${held34.json.reference}/cancel`, { token: other34 });
  const ownerView = await GET(`/reservations/${held34.json.reference}`, { token: owner34 });
  record('P34', strangerCancel.status === 404 && strangerCancel.json?.error?.code === 'not_found' && ownerView.json.status === 'confirmed',
    `another user cancelling ${held34.json.reference} -> ${strangerCancel.status} ${strangerCancel.json?.error?.code}; the booking is still ${ownerView.json?.status}`);
}

function threeTables() {
  return fixture({ restaurants: [restaurant({ tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4)] })] });
}

function openAllDay() {
  const weekday = berlinWeekday();
  return fixture({ restaurants: [restaurant({ slot_minutes: 15, reservation_duration_minutes: 60, opening_hours: [{ weekday, opens: '00:00', closes: '23:45' }] })] });
}

function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { date: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`, minutes: get('hour') * 60 + get('minute') };
}

function berlinWeekday() {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getUTCDay()];
}

// The next on-grid local slot at least `ahead` minutes from now, today in Berlin.
async function slotAfter(weekday, ahead) {
  const { date, minutes } = berlinNow();
  const target = Math.ceil((minutes + ahead) / 15) * 15;
  const hour = String(Math.floor(target / 60)).padStart(2, '0');
  const minute = String(target % 60).padStart(2, '0');
  return `${date}T${hour}:${minute}`;
}
