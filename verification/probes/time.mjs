// Rows T1..T11: daylight-saving gaps, folds, offsets and absolute duration.
import { GET, POST, record, deepEqual } from './lib.mjs';
import { BERLIN, NEWYORK, D_BERLIN_GAP, D_BERLIN_FOLD, D_NY_GAP, D_NY_FOLD, fixture, restaurant, table, login, reset, avail, book } from './fixtures.mjs';

const WANT = (id, body, extra = {}) => ({
  id,
  name: 'Dst',
  timezone: body.timezone,
  slot_minutes: 15,
  reservation_duration_minutes: body.duration ?? 30,
  cancellation_cutoff_minutes: 120,
  tables: [table('t_1', 2), table('t_2', 4), table('t_3', 4)],
  opening_hours: [{ weekday: weekdayOf(body.date), opens: '00:00', closes: '23:45' }],
  ...extra,
});

export default async function run() {
  // T1 the same local string means different instants in different zones
  await reset(fixture({ restaurants: [WANT('berlin', { timezone: BERLIN, date: '2026-12-10' }), WANT('ny', { timezone: NEWYORK, date: '2026-12-10' })] }));
  const tok1 = await login();
  const b1 = await book(tok1, { restaurant_id: 'berlin', table_id: 't_2', starts_at_local: '2026-12-10T19:00', party_size: 4, key: 't1-b' });
  const n1 = await book(tok1, { restaurant_id: 'ny', table_id: 't_2', starts_at_local: '2026-12-10T19:00', party_size: 4, key: 't1-n' });
  const offsets = [b1.json.starts_at, n1.json.starts_at].map((s) => s.slice(-6));
  const instants = [b1.json.starts_at, n1.json.starts_at].map((s) => Date.parse(s));
  record('T1', offsets[0] === '+01:00' && offsets[1] === '-05:00' && b1.json.starts_at_local === n1.json.starts_at_local && instants[0] !== instants[1],
    `local 2026-12-10T19:00 -> Berlin ${b1.json.starts_at}, New York ${n1.json.starts_at}`);

  // T2, T3 the skipped hour never appears, and booking it is invalid_local_time
  const gapCases = [
    ['berlin', BERLIN, D_BERLIN_GAP, '02:00', '02:45', '+01:00'],
    ['ny', NEWYORK, D_NY_GAP, '02:00', '02:45', '-05:00'],
  ];
  for (const [label, zone, date, first, last, stdOffset] of gapCases) {
    await reset(fixture({ restaurants: [WANT(label, { timezone: zone, date })] }));
    const tok = await login();
    const list = await avail(label, date, 4);
    const locals = list.json.slots.map((s) => s.starts_at_local.slice(11));
    const gapPresent = locals.some((t) => t >= first && t <= last);
    const clocks = ['01:00', '03:15', '05:00', '07:00'];
    const around = [];
    for (const clock of clocks) around.push(await book(tok, { restaurant_id: label, table_id: 't_2', starts_at_local: `${date}T${clock}`, party_size: 4, key: `gap-${label}-${clock}` }));
    const gapBooking = await book(tok, { restaurant_id: label, table_id: 't_2', starts_at_local: `${date}T02:30`, party_size: 4, key: `gap-${label}-mid` });
    const before = around[0].json.starts_at.slice(-6);
    const afterOffset = around[1].json.starts_at.slice(-6);
    const row = label === 'berlin' ? 'T2' : 'T5';
    record(row, list.status === 200 && !gapPresent && around.every((b) => b.status === 201) && before === stdOffset && afterOffset !== stdOffset && afterOffset === dstOffset(label),
      `${zone} ${date}: ${locals.length} slots, none in ${first}..${last}: ${!gapPresent}, 01:00 -> ${around[0].json.starts_at}, 03:15 -> ${around[1].json.starts_at}, 05:00 -> ${around[2].json.starts_at}, 07:00 -> ${around[3].json.starts_at}`);
    const row3 = label === 'berlin' ? 'T3' : 'T7';
    record(row3, gapBooking.status === 422 && gapBooking.json?.error?.code === 'invalid_local_time' && gapBooking.json?.error?.code !== 'not_on_slot_grid',
      `booking ${date}T02:30 -> ${gapBooking.status} ${gapBooking.json?.error?.code}`);
  }

  // T4, T6, T8 the repeated hour resolves to the first occurrence only
  const foldCases = [
    ['berlin', BERLIN, D_BERLIN_FOLD, '02:00', '02:45', '+02:00', 'T4', 'T6'],
    ['ny', NEWYORK, D_NY_FOLD, '01:00', '01:45', '-04:00', 'T4', 'T8'],
  ];
  for (const [label, zone, date, first, last, dstOffset, rowShared, rowZone] of foldCases) {
    await reset(fixture({ restaurants: [WANT(label, { timezone: zone, date })] }));
    const tok = await login();
    const list = await avail(label, date, 4);
    const locals = list.json.slots.map((s) => s.starts_at_local.slice(11));
    const repeated = locals.filter((t) => t >= first && t <= last);
    const clock = label === 'berlin' ? '02:30' : '01:30';
    const mid = `${date}T${clock}`;
    const booking = await book(tok, { restaurant_id: label, table_id: 't_2', starts_at_local: mid, party_size: 4, key: `fold-${label}` });
    const firstInstant = Date.parse(`${date}T${repeated.length ? mid.slice(11) : '12:00'}${dstOffset}`);
    const secondInstant = firstInstant + 60 * 60 * 1000;
    const got = Date.parse(booking.json.starts_at);
    record(rowShared, list.status === 200 && locals.length === new Set(locals).size && repeated.length > 0 && booking.status === 201 && booking.json.starts_at.endsWith(dstOffset) && got === firstInstant && got !== secondInstant,
      `${zone} ${date}: repeated local times ${JSON.stringify(repeated)} appear once each; booking ${mid} -> ${booking.json.starts_at}, which is the first occurrence (${got === firstInstant}) and not the second (${got !== secondInstant})`);
    record(rowZone, booking.status === 201 && booking.json.starts_at_local === mid, `${zone} ${date}: booked ${mid} -> ${booking.status} ${booking.json?.starts_at_local}`);
  }

  // T9 offsets follow the IANA rules, checked against Node's own computation
  const dates = ['2026-01-15', '2026-03-29', '2026-07-15', '2026-10-25', '2026-12-10'];
  const rows = [];
  let ok = true;
  for (const zone of [BERLIN, NEWYORK]) {
    for (const date of dates) {
      await reset(fixture({ restaurants: [WANT('r_dst', { timezone: zone, date })] }));
      const tok = await login();
      const booked = await book(tok, { restaurant_id: 'r_dst', table_id: 't_2', starts_at_local: `${date}T12:00`, party_size: 4, key: `t9-${zone}-${date}` });
      const mine = booked.json.starts_at.slice(-6);
      const want = offsetFor(zone, Date.parse(booked.json.starts_at));
      if (mine !== want) ok = false;
      rows.push(`${zone} ${date} ${mine}${mine === want ? '' : ` != ${want}`}`);
    }
  }
  record('T9', ok, rows.join(', '));

  // T10 and T11 the duration is absolute time across a fold
  await reset(fixture({ restaurants: [WANT('r_dst', { timezone: BERLIN, date: D_BERLIN_FOLD, duration: 90 })] }));
  const tok10 = await login();
  const booking10 = await book(tok10, { restaurant_id: 'r_dst', table_id: 't_2', starts_at_local: `${D_BERLIN_FOLD}T01:30`, party_size: 4, key: 't10-1' });
  const start = Date.parse(booking10.json.starts_at);
  const end = Date.parse(booking10.json.ends_at);
  const localEnd = new Intl.DateTimeFormat('sv-SE', { timeZone: BERLIN, dateStyle: 'short', timeStyle: 'short' }).format(new Date(end));
  const foldSlot = (await avail('r_dst', D_BERLIN_FOLD, 4)).json.slots.find((s2) => s2.starts_at_local === `${D_BERLIN_FOLD}T02:30`);
  const foldEnd = foldSlot ? Date.parse(foldSlot.starts_at) + 90 * 60 * 1000 : null;
  record('T10', booking10.json.starts_at.endsWith('+02:00') && booking10.json.ends_at.endsWith('+01:00') && end - start === 90 * 60 * 1000 && booking10.json.ends_at === `${D_BERLIN_FOLD}T02:00:00+01:00`
    && foldSlot && foldSlot.starts_at.endsWith('+02:00') && new Date(foldEnd).toISOString() === '2026-10-25T02:00:00.000Z',
    `01:30 local -> ${booking10.json.starts_at}, ends ${booking10.json.ends_at} (local ${localEnd}, ${(end - start) / 60000} real minutes); availability 02:30 -> ${foldSlot && foldSlot.starts_at}, 90 real minutes later ${foldEnd && new Date(foldEnd).toISOString()}`);
  record('T11', booking10.json.starts_at_local === `${D_BERLIN_FOLD}T01:30` && deepEqual(booking10.json, (await GET(`/reservations/${booking10.json.reference}`, { token: tok10 })).json),
    `echoed starts_at_local ${booking10.json.starts_at_local}`);

}

function dstOffset(label) {
  return label === 'berlin' ? '+02:00' : '-04:00';
}

function offsetFor(zone, instant) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset', hour12: false }).formatToParts(new Date(instant));
  const raw = parts.find((p) => p.type === 'timeZoneName').value;
  return raw === 'GMT' ? '+00:00' : raw.replace('GMT', '');
}

function weekdayOf(date) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
}