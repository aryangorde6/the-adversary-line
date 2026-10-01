// The two questions the foreman left open on ad00f9b, plus the characterisation
// of the grid-versus-hours precedence the foreman's Decision 2 asserts.
import { GET, POST, record, deepEqual, BASE } from './lib.mjs';
import { fixture, restaurant, table, login, reset, book, D_THU_FUTURE } from './fixtures.mjs';

const resetRaw = async (body) => {
  const res = await fetch(`${BASE}/_test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const exportState = async () => JSON.parse(await (await fetch(`${BASE}/_test/export`)).text());
const importState = async (payload) => {
  const res = await fetch(`${BASE}/_test/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: res.status, text: await res.text() };
};

export default async function run() {
  // O1 may a fixture declare cancellation_cutoff_minutes 0
  const withCutoff = (value) => fixture({ restaurants: [restaurant({ id: 'r_cut', name: 'Cut', cancellation_cutoff_minutes: value, slot_minutes: 15, reservation_duration_minutes: 60, opening_hours: [{ weekday: weekdayOf(today()), opens: '00:00', closes: '23:45' }] })] });
  const seen = [];
  const answers = {};
  for (const value of [0, -1, 1, 0.5, '0', 10081, 604800]) {
    const res = await resetRaw(withCutoff(value));
    answers[value] = res.status;
    seen.push(`${JSON.stringify(value)} ${res.status} ${res.text.slice(0, 90)}`);
  }
  record('O1', answers[0] === 204, seen.join('; '));

  // O2 the same field with the same value through the other test endpoint
  await reset(fixture());
  const tok2 = await login();
  await book(tok2, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'o2-keep' });
  const snap = await exportState();
  const mutated = JSON.parse(JSON.stringify(snap));
  mutated.state.restaurants[0].cancellation_cutoff_minutes = 0;
  const intoZero = await importState(mutated);
  const nowZero = await exportState();
  record('O2', intoZero.status === 204 && nowZero.state.restaurants[0].cancellation_cutoff_minutes === 0,
    `import of a state carrying cancellation_cutoff_minutes 0 -> ${intoZero.status} ${intoZero.text.slice(0, 80)}, and the installed value is ${nowZero.state.restaurants[0].cancellation_cutoff_minutes}`);

  // O3 with a cutoff of 0 installed, a booking starting exactly now
  await resetRaw(withCutoff(1));
  const minute = restaurant({ id: 'r_cut', name: 'Cut', cancellation_cutoff_minutes: 0, slot_minutes: 1, reservation_duration_minutes: 60, opening_hours: [{ weekday: weekdayOf(today()), opens: '00:00', closes: '23:45' }], tables: [table('t_2', 4), table('t_3', 4), table('t_4', 4)] });
  const zeroState = JSON.parse(JSON.stringify(await exportState()));
  zeroState.state.restaurants = [minute];
  const viaImport = await importState(zeroState);
  const tok3 = await login();
  const exactNow = await book(tok3, { restaurant_id: 'r_cut', table_id: 't_2', starts_at_local: justNowLocal(), party_size: 4, key: 'o3-now' });
  const cancelNow = exactNow.status === 201 ? await POST(`/reservations/${exactNow.json.reference}/cancel`, { token: tok3 }) : exactNow;
  const soon = await book(tok3, { restaurant_id: 'r_cut', table_id: 't_3', starts_at_local: laterLocal(), party_size: 4, key: 'o3-later' });
  const cancelSoon = soon.status === 201 ? await POST(`/reservations/${soon.json.reference}/cancel`, { token: tok3 }) : soon;
  const started = await book(tok3, { restaurant_id: 'r_cut', table_id: 't_4', starts_at_local: earlierLocal(), party_size: 4, key: 'o3-past' });
  const cancelStarted = started.status === 201 ? await POST(`/reservations/${started.json.reference}/cancel`, { token: tok3 }) : started;
  record('O3', viaImport.status === 204 && exactNow.status === 201 && cancelNow.status === 409 && cancelNow.json?.error?.code === 'cutoff_passed' && cancelSoon.status === 200 && cancelSoon.json?.status === 'cancelled' && cancelStarted.status === 409 && cancelStarted.json?.error?.code === 'cutoff_passed',
    `a cutoff of 0 cannot be seeded by reset (O1) and can only be installed by import (${viaImport.status}); with it at 0 (now ${berlinNow()} Berlin) a booking starting exactly at ${exactNow.json?.starts_at_local} -> cancel ${cancelNow.status} ${cancelNow.json?.error?.code}, one starting at ${soon.json?.starts_at_local} -> ${cancelSoon.status} ${cancelSoon.json?.status}, one that started at ${started.json?.starts_at_local} -> ${cancelStarted.status} ${cancelStarted.json?.error?.code}`);

  // O4 a negative cutoff
  const negative = await resetRaw(withCutoff(-30));
  record('O4', negative.status === 422 && /validation_failed/.test(negative.text),
    `cancellation_cutoff_minutes -30 -> ${negative.status} ${negative.text.slice(0, 120)}`);

  // O5 an import carrying an impossible local time
  await reset(fixture());
  const tok5 = await login();
  const held = await book(tok5, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'o5-1' });
  const good = await exportState();
  const broken = JSON.parse(JSON.stringify(good));
  broken.state.reservations[0].starts_at_local = '2026-02-30T19:00';
  const refused = await importState(broken);
  const stateAfter = await exportState();
  const stillThere = await GET(`/reservations/${held.json.reference}`, { token: tok5 });
  record('O5', refused.status === 422 && refused.text.includes('validation_failed') && stateAfter.state.reservations[0].starts_at_local === `${D_THU_FUTURE}T19:00` && stillThere.status === 200,
    `an export whose reservation carries starts_at_local 2026-02-30T19:00 -> ${refused.status} ${refused.text.slice(0, 120)}; the destination still holds ${stateAfter.state.reservations[0].starts_at_local} and the booking reads ${stillThere.status}`);

  // O6 the same for a bare-local string that is not a bare local value at all
  for (const [label, value] of [['impossible hour', '25:00'], ['not a bare local value', '2026-12-10T19:00:00Z'], ['unknown weekday text', 'not a date']]) {
    const bad = JSON.parse(JSON.stringify(good));
    bad.state.reservations[0].starts_at_local = value;
    const res = await importState(bad);
    const after = await exportState();
    record(`O6.${label.replace(/\W+/g, '-')}`, res.status === 422 && after.state.reservations[0].starts_at_local === `${D_THU_FUTURE}T19:00`,
      `starts_at_local ${JSON.stringify(value)} -> ${res.status} ${res.text.slice(0, 100)}; the destination still holds ${after.state.reservations[0].starts_at_local}`);
  }

  // O7 the precedence Decision 2 asserts, measured both ways
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 15, reservation_duration_minutes: 90, opening_hours: [{ weekday: weekdayOf(D_THU_FUTURE), opens: '18:00', closes: '23:45' }], tables: [table('t_1', 4), table('t_2', 4), table('t_3', 4), table('t_4', 4), table('t_5', 4), table('t_6', 4), table('t_7', 4), table('t_8', 4)] })] }));
  const tok7 = await login();
  const probes = [
    ['17:37', 't_1', 'off the grid and before opens 18:00'],
    ['17:45', 't_2', 'off the grid and before opens 18:00'],
    ['18:07', 't_3', 'off the grid, inside the hours'],
    ['22:20', 't_4', 'off the grid, inside the hours, would fit'],
    ['22:30', 't_5', 'on the grid, would end at 00:00'],
    ['23:07', 't_6', 'off the grid and would end at 00:37'],
    ['23:20', 't_7', 'off the grid and would end at 00:50'],
    ['00:07', 't_8', 'off the grid and after closes'],
  ];
  const lines = [];
  for (const [clock, tableId, why] of probes) {
    const res = await POST('/reservations', { token: tok7, key: `o7-${tableId}`, body: { restaurant_id: 'r_anker', table_id: tableId, starts_at_local: `${D_THU_FUTURE}T${clock}`, party_size: 4 } });
    lines.push(`${clock} ${res.status} ${res.json?.error?.code || 'booked'} (${why})`);
  }
  record('O7', lines.length === 8, lines.join('; '));
}

function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')} ${String(get('hour')).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}`;
}
const clockOf = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
function justNowLocal() { const [, time] = berlinNow().split(' '); return `${berlinNow().split(' ')[0]}T${time}`; }
function laterLocal() { const [date, time] = berlinNow().split(' '); const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); return `${date}T${clockOf(m + 60)}`; }
function earlierLocal() { const [date, time] = berlinNow().split(' '); const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); return `${date}T${clockOf(Math.max(0, m - 30))}`; }
function today() { return berlinNow().split(' ')[0]; }
function weekdayOf(date) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00Z`).getUTCDay()]; }