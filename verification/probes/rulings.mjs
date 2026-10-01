// The foreman's rulings 1-3 on 6b470d7, plus the paired fixture-versus-import
// probe that decides open question 2.
import { POST, GET, record } from './lib.mjs';
import { fixture, restaurant, table, seeded, login, reset, book, D_THU_FUTURE } from './fixtures.mjs';

const resetRaw = async (body) => {
  const res = await fetch(`${(await import('./lib.mjs')).BASE}/_test/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};
const exportState = async () => JSON.parse(await (await fetch(`${(await import('./lib.mjs')).BASE}/_test/export`)).text());
const importState = async (payload) => {
  const res = await fetch(`${(await import('./lib.mjs')).BASE}/_test/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: res.status, text: await res.text() };
};
const seedRaw = (over) => fixture({ reservations: [seeded(over)] });

export default async function run() {
  // R1 a party_size of the wrong JSON type is 422 everywhere, fixtures included
  const party = [];
  for (const value of ['2', true, false, 0, -1, 2.5, null]) {
    const res = await resetRaw(seedRaw({ party_size: value }));
    party.push(`seeded ${JSON.stringify(value)} ${res.status} ${code(res.text)}`);
  }
  await reset(fixture());
  const tok = await login();
  for (const value of ['2', true, 0]) {
    const res = await POST('/reservations', { token: tok, key: `r1-${JSON.stringify(value)}`, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: value } });
    party.push(`booked ${JSON.stringify(value)} ${res.status} ${code(res.text)}`);
  }
  await resetRaw(fixture({ reservations: [seeded()] }));
  const tokMove = await login();
  for (const [label, body] of [
    ['party_size "3"', { moves: [{ reference: 'SEED001', party_size: '3' }] }],
    ['party_size 0', { moves: [{ reference: 'SEED001', party_size: 0 }] }],
    ['moves is a number', { moves: 7 }],
  ]) {
    const res = await POST('/reservation-moves', { token: tokMove, key: `r1-move-${label}`, body });
    party.push(`moved with ${label} ${res.status} ${code(res.text)}`);
  }
  record('R1', party.every((line) => / 422 /.test(line)), party.join('; '));

  // R2 starts_at_local: a wrong JSON type other than null is 400, null is a missing field
  const starts = [];
  const startCases = [
    [20261210, 400], [true, 400], [{}, 400], [[], 400],
    [null, 422], ['not a date', 422], ['2026-12-10T19:00:00Z', 422], ['2026-12-10 19:00', 422],
    ['2026-02-30T19:00', 422], ['2026-12-10T25:00', 422], ['2026-12-10', 422],
  ];
  for (const [value, want] of startCases) {
    const res = await resetRaw(seedRaw({ starts_at_local: value }));
    starts.push({ line: `seeded ${JSON.stringify(value)} ${res.status} ${code(res.text)}`, want });
  }
  record('R2', starts.every((entry) => entry.line.includes(` ${entry.want} `)), starts.map((e) => e.line).join('; '));

  // R3 name, label and display_name are strings in section 4: a number is 400, null is missing
  const coerced = [];
  const coercedCases = [
    ['restaurant name', () => fixture({ restaurants: [restaurant({ name: 7 })] }), 400],
    ['restaurant name', () => fixture({ restaurants: [restaurant({ name: null })] }), 422],
    ['table label', () => fixture({ restaurants: [restaurant({ tables: [table('t_1', 2, 7)] })] }), 400],
    ['table label', () => fixture({ restaurants: [restaurant({ tables: [table('t_1', 2, null)] })] }), 422],
    ['display_name', () => fixture({ users: [{ ...fixture().users[0], display_name: 7 }] }), 400],
    ['display_name', () => fixture({ users: [{ ...fixture().users[0], display_name: null }] }), 422],
    ['timezone', () => fixture({ restaurants: [restaurant({ timezone: 7 })] }), 400],
    ['timezone', () => fixture({ restaurants: [restaurant({ timezone: null })] }), 422],
    ['email', () => fixture({ users: [{ ...fixture().users[0], email: 7 }] }), 400],
    ['email absent', () => { const user = { ...fixture().users[0] }; delete user.email; return fixture({ users: [user] }); }, 422],
    ['weekday', () => fixture({ restaurants: [restaurant({ opening_hours: [{ weekday: 7, opens: '18:00', closes: '23:00' }] })] }), 400],
    ['weekday absent', () => fixture({ restaurants: [restaurant({ opening_hours: [{ opens: '18:00', closes: '23:00' }] })] }), 422],
    ['capacity', () => fixture({ restaurants: [restaurant({ tables: [table('t_1', '4')] })] }), 400],
    ['capacity null', () => fixture({ restaurants: [restaurant({ tables: [table('t_1', null)] })] }), 422],
    ['table id absent', () => fixture({ restaurants: [restaurant({ tables: [{ capacity: 4 }] })] }), 422],
    ['party_size null', () => seedRaw({ party_size: null }), 422],
  ];
  for (const [label, build, want] of coercedCases) {
    const res = await resetRaw(build());
    coerced.push({ line: `${label} ${res.status} ${code(res.text)}`, want });
  }
  record('R3', coerced.every((entry) => entry.line.includes(` ${entry.want} `)), coerced.map((e) => e.line).join('; '));

  /* R5 an optional field that is absent or null is accepted as absent, not a
   * missing-field error. The room owner named four of them, so all four are
   * checked in both states, plus a real value of each to show the door is not
   * simply accepting anything. */
  const optional = [];
  for (const field of ['id', 'reference', 'status', 'created_at']) {
    for (const [state, over] of [['absent', undefined], ['null', null]]) {
      const body = seedRaw(over === undefined ? {} : { [field]: over });
      if (over === undefined) delete body.reservations[0][field];
      const res = await resetRaw(body);
      optional.push({ line: `reservation ${field} ${state} ${res.status} ${code(res.text)}`, want: 204 });
    }
    const given = { id: 'res_custom', reference: 'SEEDCUSTOM', status: 'confirmed', created_at: '2026-12-01T10:00' }[field];
    const res = await resetRaw(seedRaw({ [field]: given }));
    optional.push({ line: `reservation ${field} a real value ${res.status} ${code(res.text)}`, want: 204 });
  }
  record('R5', optional.every((entry) => entry.line.includes(' 204 ')), optional.map((e) => e.line).join('; '));

  // R4 right-type bad values stay 422, unknown fields stay ignored
  const kept = [];
  for (const [label, body] of [
    ['slot_minutes 0', fixture({ restaurants: [restaurant({ slot_minutes: 0 })] })],
    ['capacity -1', fixture({ restaurants: [restaurant({ tables: [table('t_1', -1)] })] })],
    ['bad email', fixture({ users: [{ id: 'u_ada', email: 'not-an-email', password: 'correct horse', display_name: 'Ada' }] })],
    ['empty id', fixture({ restaurants: [restaurant({ id: '' })] })],
    ['unknown field ignored', fixture({ restaurants: [restaurant()], nonsense: 1 })],
  ]) kept.push(`${label} ${(await resetRaw(body)).status}`);
  record('R4', kept.slice(0, 4).every((l) => l.endsWith('422')) && kept[4].endsWith('204'), kept.join('; '));

  // Q2 the same impossible local time through the fixture path and through import
  const value = '2026-02-30T19:00';
  await resetRaw(seedRaw());
  const throughFixture = await resetRaw(seedRaw({ starts_at_local: value }));
  await reset(fixture());
  const tok5 = await login();
  const held = await book(tok5, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: 'q2-1' });
  const state = JSON.parse(JSON.stringify(await exportState()));
  state.state.reservations[0].starts_at_local = value;
  const throughImport = await importState(state);
  const after = await exportState();
  const read = await GET(`/reservations/${held.json.reference}`, { token: tok5 });
  record('Q2', throughFixture.status === 422 && throughImport.status === 422 && after.state.reservations[0].starts_at_local === `${D_THU_FUTURE}T19:00` && read.status === 200,
    `the same starts_at_local ${value}: seeded through /_test/reset -> ${throughFixture.status} ${code(throughFixture.text)}, carried into /_test/import -> ${throughImport.status} ${code(throughImport.text)}; after the import the destination holds ${after.state.reservations[0].starts_at_local} and the booking reads ${read.status} with starts_at ${read.json?.starts_at}`);

  // Q1 the neighbouring edges of a cutoff of 0, again on this head
  const cutoffZero = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: 0 })] }));
  const cutoffString = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: '0' })] }));
  const cutoffNegative = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: -1 })] }));
  const cutoffHuge = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: 10080 })] }));
  const cutoffDecade = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: 60 * 24 * 3650 })] }));
  const cutoffFraction = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: 30.5 })] }));
  const cutoffWeek = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: -30 })] }));
  const state2 = JSON.parse(JSON.stringify(await exportState()));
  state2.state.restaurants[0].cancellation_cutoff_minutes = 0;
  const viaImport = await importState(state2);
  const overBounds = [];
  for (const value of [10081, 604800]) {
    const res = await resetRaw(fixture({ restaurants: [restaurant({ cancellation_cutoff_minutes: value })] }));
    overBounds.push(`${value} -> ${res.status}`);
  }
  record('Q1', cutoffZero.status === 204 && cutoffString.status === 400 && cutoffNegative.status === 422 && cutoffWeek.status === 422 && cutoffFraction.status === 422 && cutoffHuge.status === 204 && cutoffDecade.status === 204 && viaImport.status === 204,
    `cutoff 0 through reset -> ${cutoffZero.status} ${code(cutoffZero.text)}; the string "0" -> ${cutoffString.status} ${code(cutoffString.text)}; -1 -> ${cutoffNegative.status} ${code(cutoffNegative.text)}; -30 -> ${cutoffWeek.status} ${code(cutoffWeek.text)}; 30.5 -> ${cutoffFraction.status} ${code(cutoffFraction.text)}; 10080 -> ${cutoffHuge.status}; a decade, ${60 * 24 * 3650} -> ${cutoffDecade.status} ${code(cutoffDecade.text)}; the same 0 through /_test/import -> ${viaImport.status} ${code(viaImport.text)}; further above the range, recorded not asserted: ${overBounds.join(', ')}`);

  // Q3 the F3 boundary: format and calendar reality are checked, resolvability is not
  const gapState = async (value) => {
    await reset(fixture());
    const token = await login();
    const held = await book(token, { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key: `q3-${value}` });
    const payload = JSON.parse(JSON.stringify(await exportState()));
    payload.state.reservations[0].starts_at_local = value;
    const res = await importState(payload);
    const after = await exportState();
    return { res, after, held, token, ok: after.state.reservations[0].starts_at_local === value };
  };
  const gap = await gapState('2026-03-29T02:30');
  record('Q3.gap-time-importable', gap.res.status === 204 && gap.ok,
    `a well-formed local time inside the Berlin spring-forward gap, 2026-03-29T02:30 -> import ${gap.res.status} ${code(gap.res.text)}, and the destination holds ${gap.after.state.reservations[0].starts_at_local}; the booking path refuses the same minute with 422 invalid_local_time (T12)`);
  const fold = await gapState('2026-10-25T02:30');
  record('Q3.fold-time-importable', fold.res.status === 204 && fold.ok,
    `a well-formed local time inside the Berlin fall-back hour, 2026-10-25T02:30 -> import ${fold.res.status} ${code(fold.res.text)}, and the destination holds ${fold.after.state.reservations[0].starts_at_local}`);
  const calendar = [];
  for (const value of ['2026-02-30T19:00', '2026-13-01T19:00', '2026-12-10T24:00', '2026-12-10T19:60', 'not a date', '2026-12-10T19:00:00Z', '2026-12-10 19:00']) {
    const attempt = await gapState(value);
    calendar.push({ line: `${value} -> ${attempt.res.status} ${code(attempt.res.text)}, the destination still holds ${attempt.after.state.reservations[0].starts_at_local}`, ok: attempt.res.status === 422 && attempt.after.state.reservations[0].starts_at_local === `${D_THU_FUTURE}T19:00` });
  }
  record('Q3.calendar-refused', calendar.every((entry) => entry.ok), calendar.map((e) => e.line).join('; '));
}

function code(text) {
  try { return JSON.parse(text).error.code; } catch { return text.slice(0, 40); }
}