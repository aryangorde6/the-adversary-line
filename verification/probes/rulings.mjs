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

  // R2 starts_at_local: wrong JSON type 400, string that is not a bare local 422
  const starts = [];
  for (const value of [20261210, true, null, {}, []]) {
    const res = await resetRaw(seedRaw({ starts_at_local: value }));
    starts.push(`seeded ${JSON.stringify(value)} ${res.status} ${code(res.text)}`);
  }
  for (const value of ['not a date', '2026-12-10T19:00:00Z', '2026-12-10 19:00', '2026-02-30T19:00', '2026-12-10T25:00', '2026-12-10']) {
    const res = await resetRaw(seedRaw({ starts_at_local: value }));
    starts.push(`seeded ${JSON.stringify(value)} ${res.status} ${code(res.text)}`);
  }
  record('R2', starts.slice(0, 5).every((l) => / 400 /.test(l)) && starts.slice(5).every((l) => / 422 /.test(l)), starts.join('; '));

  // R3 name, label and display_name are strings in section 4, so a number is 400
  const coerced = [];
  coerced.push(`restaurant name ${(await resetRaw(fixture({ restaurants: [restaurant({ name: 7 })] }))).status}`);
  coerced.push(`table label ${(await resetRaw(fixture({ restaurants: [restaurant({ tables: [table('t_1', 2, 7)] })] }))).status}`);
  coerced.push(`display_name ${(await resetRaw(fixture({ users: [{ ...fixture().users[0], display_name: 7 }] }))).status}`);
  await reset(fixture());
  const tok3 = await login();
  const amenity = await POST(`/restaurants/${'r_anker'}/amenities`, { token: tok3, body: { name: 7 } }).catch(() => null);
  coerced.push(`the amenity endpoint exists: ${amenity === null ? 'no' : amenity.status}`);
  record('R3', coerced.slice(0, 3).every((l) => l.endsWith('400')), coerced.join('; '));

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
  const state2 = JSON.parse(JSON.stringify(await exportState()));
  state2.state.restaurants[0].cancellation_cutoff_minutes = 0;
  const viaImport = await importState(state2);
  record('Q1', cutoffZero.status === 204 && cutoffString.status === 400 && cutoffNegative.status === 422 && cutoffHuge.status === 204 && viaImport.status === 204,
    `cutoff 0 through reset -> ${cutoffZero.status} ${code(cutoffZero.text)}; the string "0" -> ${cutoffString.status} ${code(cutoffString.text)}; -1 -> ${cutoffNegative.status} ${code(cutoffNegative.text)}; 10080 -> ${cutoffHuge.status}; the same 0 through /_test/import -> ${viaImport.status} ${code(viaImport.text)}`);
}

function code(text) {
  try { return JSON.parse(text).error.code; } catch { return text.slice(0, 40); }
}