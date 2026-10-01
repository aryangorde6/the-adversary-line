// Rows T12..T18: the ad00f9b delta. Which local minutes are classified how,
// that folds still resolve to the first occurrence, and the two extended paths.
import { GET, POST, record, deepEqual } from './lib.mjs';
import { BERLIN, NEWYORK, fixture, restaurant, table, login, reset, avail, book } from './fixtures.mjs';

const DAYS = [
  ['gap', BERLIN, '2026-03-29', '+01:00', '+02:00'],
  ['fold', BERLIN, '2026-10-25', '+02:00', '+01:00'],
  ['gap', NEWYORK, '2026-03-08', '-05:00', '-04:00'],
  ['fold', NEWYORK, '2026-11-01', '-04:00', '-05:00'],
  ['plain', BERLIN, '2026-06-15', '+02:00', '+02:00'],
  ['plain', NEWYORK, '2026-06-15', '-04:00', '-04:00'],
];

const zoneDay = (id, zone, date, duration = 30) => fixture({
  restaurants: [restaurant({
    id, timezone: zone, slot_minutes: 15, reservation_duration_minutes: duration,
    opening_hours: [{ weekday: weekdayOf(date), opens: '00:00', closes: '23:45' }],
    tables: Array.from({ length: 96 }, (_, i) => table(`t_${String(i).padStart(2, '0')}`, 4)),
  })],
});

const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export default async function run() {
  // T12 every minute of the four named transitions plus two ordinary days, in both zones
  for (const [kind, zone, date, stdOffset, dstOffset] of DAYS) {
    await reset(zoneDay('r_zone', zone, date));
    const tok = await login();
    const list = await avail('r_zone', date, 4);
    const slots = list.json.slots || [];
    const gaps = [];
    const closing = [];
    const resolved = [];
    for (let m = 0; m < 24 * 60; m += 15) {
      const booked = await book(tok, { restaurant_id: 'r_zone', table_id: `t_${String(m / 15).padStart(2, '0')}`, starts_at_local: `${date}T${clock(m)}`, party_size: 4, key: `t12-${zone}-${date}-${m}` });
      if (booked.status === 422 && booked.json?.error?.code === 'invalid_local_time') gaps.push(clock(m));
      else if (booked.status === 201) resolved.push({ at: clock(m), startsAt: booked.json.starts_at });
      if (booked.status !== 201 && booked.json?.error?.code !== 'invalid_local_time') closing.push(`${clock(m)} ${booked.status} ${booked.json?.error?.code}`);
    }
    const slotLocals = slots.map((s) => s.starts_at_local.slice(11));
    const unique = new Set(slotLocals).size === slotLocals.length;
    const expectGaps = kind === 'gap' ? 4 : 0;
    const offsets = [...new Set(resolved.map((r) => r.startsAt.slice(-6)))].sort();
    const wanted = [...new Set([stdOffset, dstOffset])].sort();
    const row = `${kind}-${zone === BERLIN ? 'berlin' : 'ny'}-${date}`;
    record(`T12.${row}`, gaps.length === expectGaps && closing.length === 2 && closing.every((c) => c.includes('outside_opening_hours')) && resolved.length + gaps.length === 94 && unique
      && (kind === 'plain' ? offsets.length === 1 && offsets[0] === stdOffset : offsets.length === 2 && offsets.join() === wanted.join()),
      `${zone} ${date}: ${gaps.length} nonexistent minutes (${gaps.join(' ') || 'none'}), ${resolved.length} resolved with offsets ${offsets.join(', ')}, ${closing.length} refused for the last two slots (${closing.join('; ')}), ${slotLocals.length} slots each listed once: ${unique}`);
  }

  // T13 the fall-back hour resolves to the first occurrence, proven by instant and offset
  for (const [kind, zone, date, dstOffset] of DAYS.filter((d) => d[0] === 'fold')) {
    await reset(zoneDay('r_zone', zone, date));
    const tok = await login();
    const wallClock = zone === BERLIN ? '02:30' : '01:30';
    const first = await book(tok, { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: `${date}T${wallClock}`, party_size: 4, key: `t13-${zone}` });
    const instant = Date.parse(first.json.starts_at);
    const localAtSecondPass = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(instant + 3600 * 1000));
    record(`T13.${zone === BERLIN ? 'berlin' : 'ny'}`, first.status === 201 && first.json.starts_at.endsWith(dstOffset) && localAtSecondPass.startsWith(date),
      `${wallClock} local on ${date} resolved to ${first.json.starts_at}, and one hour later the wall clock reads ${localAtSecondPass} rather than ${wallClock}, so this is the first pass, not the second`);
  }

  // T14 the impossible time of day and the other malformed local strings still give 422 validation_failed
  await reset(zoneDay('r_zone', BERLIN, '2026-12-10', 90));
  const tok14 = await login();
  const cases = ['25:00', '24:00', '19:60', '19:00:00', '2026-12-10', '2026-02-30', '2026-13-01', '2026-00-10', '2026-12-32', 'T19:00', '2026-12-10T7:00'];
  const seen = [];
  let ok = true;
  for (const local of cases) {
    const res = await POST('/reservations', { token: tok14, key: `t14-${local.replace(/\W/g, '')}`, body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: local, party_size: 4 } });
    seen.push(`${local} ${res.status} ${res.json?.error?.code}`);
    if (res.status !== 422 || res.json?.error?.code !== 'validation_failed') ok = false;
  }
  record('T14', ok, seen.join('; '));

  // T15 a booking that would end past midnight keeps the code it had
  const midnight = await POST('/reservations', { token: tok14, key: 't15-midnight', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-10T23:00', party_size: 4 } });
  const exactlyClose = await POST('/reservations', { token: tok14, key: 't15-close', body: { restaurant_id: 'r_zone', table_id: 't_01', starts_at_local: '2026-12-10T23:00', party_size: 2 } });
  const closedWeekday = await POST('/reservations', { token: tok14, key: 't15-weekday', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-11T19:00', party_size: 4 } });
  const twentyTwoForty = await POST('/reservations', { token: tok14, key: 't15-late', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-10T22:40', party_size: 4 } });
  record('T15', midnight.status === 422 && midnight.json?.error?.code === 'outside_opening_hours' && closedWeekday.json?.error?.code === 'outside_opening_hours',
    `a 90 minute booking from 23:00, which would end at 00:30 the next day -> ${midnight.status} ${midnight.json?.error?.code}; the same start on a weekday with no hours -> ${closedWeekday.status} ${closedWeekday.json?.error?.code}; a start that ends exactly at 23:45 -> ${exactlyClose.status}; 22:40 past the last slot that fits -> ${twentyTwoForty.status} ${twentyTwoForty.json?.error?.code}`);

  // T16 both faults at once, as the foreman asked, and one fault alone
  await reset(zoneDay('r_zone', BERLIN, '2026-12-10', 90));
  const tok16 = await login();
  const bothFaults = await POST('/reservations', { token: tok16, key: 't16-both', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-10T23:07', party_size: 4 } });
  const offGridInside = await POST('/reservations', { token: tok16, key: 't16-grid', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-10T19:07', party_size: 4 } });
  const outsideOnly = await POST('/reservations', { token: tok16, key: 't16-hours', body: { restaurant_id: 'r_zone', table_id: 't_00', starts_at_local: '2026-12-10T23:30', party_size: 4 } });
  record('T16', bothFaults.json?.error?.code === 'outside_opening_hours' && offGridInside.json?.error?.code === 'not_on_slot_grid' && outsideOnly.json?.error?.code === 'outside_opening_hours',
    `off the grid and past closing together (23:07) -> ${bothFaults.status} ${bothFaults.json?.error?.code}; off the grid alone (19:07) -> ${offGridInside.status} ${offGridInside.json?.error?.code}; outside the hours alone (23:30) -> ${outsideOnly.status} ${outsideOnly.json?.error?.code}`);
}

function weekdayOf(date) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
}