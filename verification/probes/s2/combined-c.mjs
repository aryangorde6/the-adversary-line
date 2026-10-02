// Stage-2 rows decided against the HTTP API, part three: patch, cancel, atomic moves and
// concurrency (stage-2.md §API and §Concurrent bookings and amendments).
import { GET, POST, PATCH, record, group } from '../lib.mjs';

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// Open every weekday, and work on a date at least three hours ahead, so that amendment and
// cancellation rows are not answered with cutoff_passed for being in the past.
const ALL_DAYS = WD.map((weekday) => ({ weekday, opens: '00:00', closes: '23:00' }));
let DATE = null;
async function pickDate() {
  if (DATE) return DATE;
  for (let add = 0; add < 4; add++) {
    const d = new Date(Date.now() + add * 86400000).toISOString().slice(0, 10);
    const res = await GET(`/availability?restaurant_id=r_anker&date=${d}&party_size=1`);
    const future = (res.json.slots || []).filter((x) => Date.parse(x.starts_at) > Date.now() + 3 * 3600000);
    if (future.length >= 3) { DATE = d; return d; }
  }
  throw new Error('no date with three slots more than three hours ahead');
}
const tables = [
  { id: 't_1', label: 'Window 1', capacity: 2 },
  { id: 't_2', label: 'Window 2', capacity: 4 },
  { id: 't_3', label: 'Patio 3', capacity: 2 },
  { id: 't_4', label: 'Patio 4', capacity: 6 },
];
const declared = [['t_1', 't_2'], ['t_2', 't_3']];
let seq = 0;

async function reset(reservations = []) {
  const r = await POST('/_test/reset', {
    body: {
      users: [{ id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' }],
      restaurants: [{
        id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 60,
        reservation_duration_minutes: 120, cancellation_cutoff_minutes: 0,
        opening_hours: ALL_DAYS, tables, combinable: declared,
      }],
      reservations,
    },
  });
  if (r.status !== 204) throw new Error(`reset answered ${r.status} ${r.text.slice(0, 160)}`);
  const l = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  return l.json.token;
}
const book = (t, b) => POST('/reservations', { token: t, key: `k${seq++}`, body: b });
const avail = (party) => GET(`/availability?restaurant_id=r_anker&date=${DATE}&party_size=${party}`);
// Only slots more than three hours ahead: amendment rows would otherwise be answered
// cutoff_passed for being in the past, which says nothing about table_ids.
const slotAt = async (i, party = 1) => {
  const all = (await avail(party)).json.slots || [];
  const future = all.filter((x) => Date.parse(x.starts_at) > Date.now() + 3 * 3600000);
  return future[i].starts_at_local;
};
const singlesAt = async (time) => {
  const a = await avail(1);
  const s = a.json.slots.find((x) => x.starts_at_local === time);
  return s ? s.available_table_ids : [];
};
const code = (r) => (r.json && r.json.error ? r.json.error.code : String(r.status));

export default async function combinedC() {
  group('Z combined tables, part three');
  await pickDate();

  // Z26 — PATCH takes table_ids under the same rules as create.
  let token = await reset();
  const when = await slotAt(0, 2);
  const made = await book(token, { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: when, party_size: 2 });
  const ref = made.json.reference;
  const moved = await PATCH(`/reservations/${ref}`, { token, body: { table_ids: ['t_2', 't_3'], party_size: 6 } });
  const after = await GET(`/reservations/${ref}`, { token });
  const heldNow = await singlesAt(when);
  const ok26 = moved.status === 200 && JSON.stringify(after.json.table_ids) === JSON.stringify(['t_2', 't_3'])
    && !heldNow.includes('t_2') && !heldNow.includes('t_3') && heldNow.includes('t_1');
  const bad = [
    ['undeclared pair', { table_ids: ['t_1', 't_4'], party_size: 6 }, 'combination_not_allowed'],
    ['three tables', { table_ids: ['t_1', 't_2', 't_3'], party_size: 6 }, 'combination_not_allowed'],
    ['over capacity', { table_ids: ['t_1', 't_2'], party_size: 7 }, 'party_exceeds_capacity'],
    ['duplicate id', { table_ids: ['t_1', 't_1'], party_size: 2 }, 'validation_failed'],
  ];
  const refusals = [];
  for (const [what, body, want] of bad) {
    const r = await PATCH(`/reservations/${ref}`, { token, body });
    if (r.status !== 422 || code(r) !== want) refusals.push(`${what}: ${r.status} ${code(r)}`);
  }
  const stillPair = await GET(`/reservations/${ref}`, { token });
  const okAtomic = JSON.stringify(stillPair.json.table_ids) === JSON.stringify(['t_2', 't_3']);
  record('Z26', ok26 && refusals.length === 0 && okAtomic,
    `patch to a declared pair answered ${moved.status} ${JSON.stringify(after.json.table_ids)}; refusals: ${refusals.join('; ') || 'all five as documented'}; after the refusals the booking is still ${JSON.stringify(stillPair.json.table_ids)}`);

  // Z27 — cancelling frees every table in the set.
  const cancelled = await POST(`/reservations/${ref}/cancel`, { token });
  const freed = await singlesAt(when);
  record('Z27', cancelled.status === 200 && freed.includes('t_2') && freed.includes('t_3'),
    `cancel answered ${cancelled.status}; the slot then offers ${JSON.stringify(freed)}`);

  // Z34, Z35 — moves accept table_ids per move, and no table ends up in overlapping bookings.
  // The two bookings sit two slots apart, because a 120-minute booking starting one slot after
  // another would overlap it, and a move batch must not collide with itself.
  token = await reset();
  const a = await slotAt(0, 2);
  const c = await slotAt(2, 2);
  const midway = new Date(Date.parse(`${a}:00+01:00`) + 3600000).toISOString().slice(0, 16);
  const r1 = await book(token, { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: a, party_size: 2 });
  const r2 = await book(token, { restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: c, party_size: 2 });
  const batch = await POST('/reservation-moves', {
    token, key: `m${seq++}`,
    body: { moves: [{ reference: r1.json.reference, table_ids: ['t_1', 't_2'] }, { reference: r2.json.reference, table_ids: ['t_2', 't_3'] }] },
  });
  const afterBatch = await GET(`/reservations/${r1.json.reference}`, { token });
  record('Z34', batch.status === 201 && JSON.stringify(afterBatch.json.table_ids) === JSON.stringify(['t_1', 't_2']),
    `a move batch naming table_ids answered ${batch.status} ${batch.text.slice(0, 140)}; the first booking now holds ${JSON.stringify(afterBatch.json.table_ids)}`);
  const overlap = await POST('/reservation-moves', {
    token, key: `m${seq++}`,
    body: { moves: [{ reference: r2.json.reference, table_ids: ['t_1', 't_2'], starts_at_local: midway }] },
  });
  const afterOverlap = await GET(`/reservations/${r2.json.reference}`, { token });
  record('Z35', overlap.status === 409 && code(overlap) === 'table_unavailable'
    && JSON.stringify(afterOverlap.json.table_ids) === JSON.stringify(['t_2', 't_3'])
    && JSON.stringify(afterOverlap.json.starts_at_local) === JSON.stringify(c),
    `a move onto tables held at an overlapping time answered ${overlap.status} ${code(overlap)}; the booking still holds ${JSON.stringify(afterOverlap.json.table_ids)} at ${afterOverlap.json.starts_at_local}`);

  /* The second half of Z35 is a batch that collides with itself. The check above
   * only proves a move is refused when the clash is with a booking already in
   * state, which the per-move conflict check answers on its own. A batch whose
   * own two moves name the same tables over the same interval can only be caught
   * by comparing the batch's results against each other, so it needs its own
   * request: one batch, two moves, one shared table, one shared time. */
  token = await reset();
  const b1 = await slotAt(0, 2);
  const b2 = await slotAt(0, 2);
  const self1 = await book(token, { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: b1, party_size: 2 });
  const self2 = await book(token, { restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: b2, party_size: 2 });
  const intra = await POST('/reservation-moves', {
    token, key: `m${seq++}`,
    body: {
      moves: [
        { reference: self1.json.reference, table_ids: ['t_1', 't_2'], starts_at_local: b1 },
        { reference: self2.json.reference, table_ids: ['t_1', 't_2'], starts_at_local: b1 },
      ],
    },
  });
  const selfAfter1 = await GET(`/reservations/${self1.json.reference}`, { token });
  const selfAfter2 = await GET(`/reservations/${self2.json.reference}`, { token });
  const heldSamePair = (x) => JSON.stringify(x.json.table_ids) === JSON.stringify(['t_1', 't_2']);
  const bothCommitted = intra.status === 201 && heldSamePair(selfAfter1) && heldSamePair(selfAfter2);
  record('Z35', bothCommitted === false && intra.status === 409 && code(intra) === 'table_unavailable'
    && !heldSamePair(selfAfter1) && !heldSamePair(selfAfter2),
    `one batch naming the same pair at the same slot twice answered ${intra.status} ${code(intra)}; `
    + `the two bookings still hold ${JSON.stringify(selfAfter1.json.table_ids)} and ${JSON.stringify(selfAfter2.json.table_ids)}, `
    + `so the batch changed nothing`);

  // Z37 — 50 in-flight bookings over one member: one winner, no double booking.
  token = await reset();
  const target = await slotAt(0, 2);
  const inFlight = Array.from({ length: 50 }, () => book(token, { restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: target, party_size: 6 }));
  const answers = await Promise.all(inFlight);
  const tally = {};
  for (const r of answers) tally[r.status] = (tally[r.status] || 0) + 1;
  const readBack = await singlesAt(target);
  record('Z37', tally['201'] === 1 && (tally['409'] || 0) === 49 && !readBack.includes('t_1') && !readBack.includes('t_2'),
    `50 concurrent pair bookings gave ${JSON.stringify(tally)}; the slot then offers ${JSON.stringify(readBack)}`);
}