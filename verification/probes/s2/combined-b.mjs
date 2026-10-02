// Stage-2 rows decided against the HTTP API, part two: capacity, availability shape, seeded
// reservations, refusals, patch, cancel, moves and concurrency (stage-2.md §UI, §API, §Model).
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
const declared = [['t_1', 't_2'], ['t_2', 't_3']];
let seq = 0;

function fx(reservations = []) {
  return {
    users: [{ id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' }],
    restaurants: [{
      id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 60,
      reservation_duration_minutes: 120, cancellation_cutoff_minutes: 0,
      opening_hours: [{ weekday, opens: '00:00', closes: '23:00' }], tables, combinable: declared,
    }],
    reservations,
  };
}

async function reset(reservations) {
  const r = await POST('/_test/reset', { body: fx(reservations) });
  if (r.status !== 204) throw new Error(`reset answered ${r.status} ${r.text.slice(0, 160)}`);
  const l = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  return l.json.token;
}
const book = (t, b) => POST('/reservations', { token: t, key: `k${seq++}`, body: b });
const avail = (party) => GET(`/availability?restaurant_id=r_anker&date=${today}&party_size=${party}`);
const slotTimes = (res) => (res.json.slots || []).map((s) => s.starts_at_local);
const freeSlot = async (party, i = 0) => slotTimes(await avail(party))[i];

// Z12, Z13 — expected lists computed here, never read from the answer.
function expected(party) {
  const singles = tables.filter((t) => t.capacity >= party).map((t) => [t.id]);
  const pairs = declared.filter((p) => p.reduce((s, id) => s + cap[id], 0) >= party).map((p) => p.slice());
  return [...singles, ...pairs];
}

export default async function combinedB() {
  group('Z combined tables, part two');

  // Z10, Z11 — the field exists on every slot and holds only single ids in available_table_ids.
  let token = await reset();
  const a1 = await avail(4);
  const noOpts = (a1.json.slots || []).filter((s) => !Array.isArray(s.available_options)).map((s) => s.starts_at_local);
  const badEntry = (a1.json.slots || []).flatMap((s) => (s.available_options || [])
    .filter((o) => !Array.isArray(o.table_ids) || !o.table_ids.length || !Number.isInteger(o.capacity))
    .map(() => s.starts_at_local));
  record('Z10', a1.status === 200 && noOpts.length === 0 && badEntry.length === 0,
    `slots without available_options: ${noOpts.length}, malformed entries: ${badEntry.length}`);
  const notSingle = (a1.json.slots || []).flatMap((s) => (s.available_table_ids || [])
    .filter((id) => !tables.some((t) => t.id === id)).map((id) => `${s.starts_at_local}:${id}`));
  record('Z11', notSingle.length === 0, `non-single ids in available_table_ids: ${notSingle.join(', ') || 'none'}`);

  // Z12, Z13, Z14 — every party size, both directions, order and pair order.
  const wrong = [], wrongOrder = [], wrongPairOrder = [];
  for (let party = 1; party <= 6; party++) {
    const a = await avail(party);
    const want = expected(party);
    for (const slot of a.json.slots || []) {
      const got = (slot.available_options || []).map((o) => o.table_ids);
      const key = (o) => o.join('+');
      const wantKeys = want.map(key);
      const gotKeys = got.map(key);
      if (JSON.stringify([...gotKeys].sort()) !== JSON.stringify([...wantKeys].sort())) {
        wrong.push(`party ${party} ${slot.starts_at_local}: want ${wantKeys.join('|')} got ${gotKeys.join('|')}`);
      }
      if (JSON.stringify(gotKeys) !== JSON.stringify(wantKeys)) {
        wrongOrder.push(`party ${party} ${slot.starts_at_local}: want ${wantKeys.join('|')} got ${gotKeys.join('|')}`);
      }
      for (const pair of declared) {
        const entry = got.find((g) => g.length === 2 && g.includes(pair[0]) && g.includes(pair[1]));
        if (entry && entry.join(',') !== pair.join(',')) wrongPairOrder.push(`${entry.join('+')} vs declared ${pair.join('+')}`);
      }
    }
  }
  record('Z12', wrong.length === 0, wrong.slice(0, 3).join(' ; ') || 'available_options matched the computed expectation at party sizes 1..6 on every slot');
  record('Z13', wrongOrder.length === 0, wrongOrder.slice(0, 3).join(' ; ') || 'singles in fixture order then pairs in combinable order, at every party size');
  record('Z14', wrongPairOrder.length === 0, wrongPairOrder.slice(0, 3).join(' ; ') || 'every pair listed in combinable order');

  // Z7 — the combination's capacity is the sum: the sum books, the sum plus one does not.
  token = await reset();
  const at6 = await freeSlot(6, 0);
  const at7 = await freeSlot(6, 1);
  const onSum = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: at6, party_size: 6 });
  const overSum = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: at7, party_size: 7 });
  const party7 = await avail(7);
  const listedFor7 = (party7.json.slots || []).flatMap((x) => (x.available_options || []).map((o) => o.table_ids.join('+')));
  record('Z7', onSum.status === 201 && overSum.status === 422 && overSum.json.error.code === 'party_exceeds_capacity'
    && listedFor7.length === 0,
    `sum 6 answered ${onSum.status}, sum+1 answered ${overSum.status} ${overSum.json.error && overSum.json.error.code}, options listed for party 7: ${listedFor7.length}`);

  // Z24 — the same limit named as its own table row, on the other declared pair.
  const at24 = await freeSlot(6, 2);
  const over = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_2', 't_3'], starts_at_local: at24, party_size: 7 });
  record('Z24', over.status === 422 && over.json.error.code === 'party_exceeds_capacity',
    `party_size over the summed capacity answered ${over.status} ${over.json && over.json.error && over.json.error.code}`);

  // Z23 — one member taken for an overlapping interval.
  token = await reset();
  const slotA = await freeSlot(2);
  const hold = await book(token, { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: slotA, party_size: 2 });
  const clash = await book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: slotA, party_size: 4 });
  record('Z23', hold.status === 201 && clash.status === 409 && clash.json.error.code === 'table_unavailable',
    `single held ${hold.status}, pair over it answered ${clash.status} ${clash.json && clash.json.error && clash.json.error.code}`);

// Z8, Z9 — seeded reservations: status defaults to confirmed, and both table shapes seed.
  const when = await freeSlot(2, 0);
  token = await reset([
    { id: 'seed1', reference: 'SEED0000001', user_id: 'u_ada', restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: when, party_size: 2 },
    { id: 'seed2', reference: 'SEED0000002', user_id: 'u_ada', restaurant_id: 'r_anker', table_ids: ['t_2', 't_3'], starts_at_local: when, party_size: 4, status: 'cancelled' },
  ]);
  const seeded = await avail(2);
  const s0 = (seeded.json.slots || []).find((x) => x.starts_at_local === when);
  const offered0 = s0 ? s0.available_table_ids : [];
  record('Z8', Boolean(s0) && !offered0.includes('t_1') && offered0.includes('t_2') && offered0.includes('t_3'),
    `one statusless seed and one cancelled pair seed left the slot offering ${JSON.stringify(offered0)}`);
  record('Z9', Boolean(s0) && !offered0.includes('t_1'),
    `the table_id seed occupied t_1, and the table_ids seed carried status cancelled so it held nothing`);

  return { declared, today };
}