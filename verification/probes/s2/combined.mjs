// Stage-2 rows decided against the HTTP API: the combined-table rules (Z group) and the
// route rows (R group). Built from stage-2.md text only. Usage: node combined.mjs
import { GET, POST, PATCH, record, group } from '../lib.mjs';

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const today = new Date().toISOString().slice(0, 10);
const weekday = WD[new Date(`${today}T12:00:00Z`).getUTCDay()];
const tables = [
  { id: 't_1', label: 'Window 1', capacity: 2 },
  { id: 't_2', label: 'Window 2', capacity: 4 },
  { id: 't_3', label: 'Patio 3', capacity: 2 },
  { id: 't_4', label: 'Patio 4', capacity: 6 },
];
const cap = Object.fromEntries(tables.map((t) => [t.id, t.capacity]));

function fixture(reservations = [], combinable = [['t_1', 't_2'], ['t_2', 't_3']]) {
  return {
    users: [{ id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' }],
    restaurants: [{
      id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 60,
      reservation_duration_minutes: 120, cancellation_cutoff_minutes: 0,
      opening_hours: [{ weekday, opens: '00:00', closes: '23:00' }],
      tables, combinable,
    }],
    reservations,
  };
}

let seq = 0;
async function reset(reservations, combinable) {
  const r = await POST('/_test/reset', { body: fixture(reservations, combinable) });
  if (r.status !== 204) throw new Error(`reset answered ${r.status} ${r.text.slice(0, 200)}`);
  const l = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  return l.json.token;
}

const book = (token, body) => POST('/reservations', { token, key: `k${seq++}`, body });
const avail = (party, date = today) => GET(`/availability?restaurant_id=r_anker&date=${date}&party_size=${party}`);
const slotAt = (res, time) => (res.json.slots || []).find((s) => s.starts_at_local.endsWith(time));
async function firstFreeSlot(party) {
  const a = await avail(party);
  const s = (a.json.slots || []).find((x) => (x.available_table_ids || []).length > 0);
  return s ? s.starts_at_local : null;
}

export default async function combined() {
  group('Z combined tables');

  // Z15, Z1, Z18, Z19, Z20, Z2 — create a pair and read the response shape.
  let token = await reset();
  const at = await firstFreeSlot(2);
  let r = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: at, party_size: 6 });
  record('Z1', r.status === 201, `declared pair booking answered ${r.status} ${r.text.slice(0, 120)}`);
  const ref = r.json && r.json.reference;
  const back = await GET(`/reservations/${ref}`, { token });
  record('Z18', r.status === 201 && Array.isArray(r.json.table_ids)
    && back.status === 200 && Array.isArray(back.json.table_ids)
    && JSON.stringify(back.json.table_ids) === JSON.stringify(r.json.table_ids),
    `create keys ${JSON.stringify(Object.keys(r.json || {}))}, read-back ${back.status} ${back.text.slice(0, 100)}`);

  record('Z15', r.status === 201 && Array.isArray(r.json.table_ids) && r.json.table_ids.join(',') === 't_1,t_2',
    `table_ids body stored as ${JSON.stringify(r.json && r.json.table_ids)}`);
  record('Z20', r.status === 201 && !('table_id' in r.json)
    && back.status === 200 && !('table_id' in back.json),
    `pair create carried table_id: ${'table_id' in (r.json || {})}, read-back: ${'table_id' in (back.json || {})}`);

  // Z2 — both members held for exactly the full duration, on every slot of the day.
  const start = Date.parse(r.json.starts_at);
  const end = start + 120 * 60000;
  const wrongHold = [];
  const day = await avail(1);
  for (const s of day.json.slots || []) {
    const t = Date.parse(s.starts_at);
    const shouldBlock = t >= start && t < end;
    const offered = s.available_table_ids.includes('t_1') || s.available_table_ids.includes('t_2')
      || (s.available_options || []).some((o) => o.table_ids.some((id) => id === 't_1' || id === 't_2'));
    if (offered === shouldBlock) {
      wrongHold.push(`${s.starts_at_local} ${shouldBlock ? 'should be held but is offered' : 'is free but is held'}`);
    }
  }
  record('Z2', wrongHold.length === 0,
    wrongHold.slice(0, 3).join(' ; ') || `both members held from ${r.json.starts_at_local} to +120 min and free again after, on all ${(day.json.slots || []).length} slots`);

  // Z16, Z19, Z3 — the stage-1 single-table form still works and echoes table_id.
  r = await book(token, { restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: at, party_size: 2 });
  record('Z3', r.status === 201, `table_id body answered ${r.status} ${r.text.slice(0, 120)}`);
  record('Z16', r.status === 201 && Array.isArray(r.json.table_ids) && r.json.table_ids.length === 1,
    `table_id body gave table_ids ${JSON.stringify(r.json && r.json.table_ids)}`);
  record('Z19', r.status === 201 && r.json.table_id === 't_3', `single body carried table_id ${JSON.stringify(r.json && r.json.table_id)}`);

  /* Z17 — both keys at once. Two shapes, because a single one is not enough:
   * a body whose two spellings disagree is refused by the self-agreement check
   * as well, so a service that dropped the both-keys rule entirely would still
   * refuse it and the row would pass for the wrong reason. The agreeing body
   * (table_id t_4 beside table_ids [t_4], on a table nothing else in this run
   * has taken) is refused by the both-keys rule alone, so this pair decides the
   * row on the rule the requirement names. */
  const disagreeing = await book(token, { restaurant_id: 'r_anker', table_id: 't_3', table_ids: ['t_1', 't_2'], starts_at_local: at, party_size: 2 });
  const agreeing = await book(token, { restaurant_id: 'r_anker', table_id: 't_4', table_ids: ['t_4'], starts_at_local: at, party_size: 2 });
  const refused = (x) => x.status === 422 && x.json.error && x.json.error.code === 'validation_failed';
  const after = await avail(2);
  const stillOne = (after.json.slots || []).filter((s) => s.available_options.some((o) => o.table_ids.length > 1)).length;
  record('Z17', refused(disagreeing) && refused(agreeing),
    `both keys disagreeing answered ${disagreeing.status} ${disagreeing.json && disagreeing.json.error && disagreeing.json.error.code}; `
    + `both keys agreeing (table_id t_4 beside table_ids [t_4]) answered ${agreeing.status} `
    + `${agreeing.json && agreeing.json.error && agreeing.json.error.code}; ${stillOne} slots still offer a combination, so neither body booked`);

  // Z5, Z6, Z21 — undeclared and transitive pairs.
  r = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_4'], starts_at_local: at, party_size: 8 });
  record('Z5', r.status === 422 && r.json.error.code === 'combination_not_allowed', `undeclared pair answered ${r.status} ${r.json.error && r.json.error.code}`);
  r = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_3'], starts_at_local: at, party_size: 4 });
  record('Z6', r.status === 422 && r.json.error.code === 'combination_not_allowed', `transitive pair answered ${r.status} ${r.json.error && r.json.error.code}`);
  record('Z21', r.status === 422 && r.json.error.code === 'combination_not_allowed', 'same refusal, named as the table row requires');

  // Z22, Z25 — three tables, and a duplicate id.
  r = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2', 't_3'], starts_at_local: at, party_size: 8 });
  record('Z22', r.status === 422 && r.json.error.code === 'combination_not_allowed', `three tables answered ${r.status} ${r.json.error && r.json.error.code}`);
  r = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_1'], starts_at_local: at, party_size: 2 });
  record('Z25', r.status === 422 && r.json.error.code === 'validation_failed', `duplicate id answered ${r.status} ${r.json.error && r.json.error.code}`);

  // Z4 — a fixture that declares three tables in one entry must not load.
  const bad = await POST('/_test/reset', { body: fixture([], [['t_1', 't_2', 't_3']]) });
  record('Z4', bad.status === 422, `three-table combinable entry in the fixture answered ${bad.status}`);

  return { at, ref };
}