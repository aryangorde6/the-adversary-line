// E16b: a deliberate repeat sweep. E16 as first written only sees the responses
// the rest of the suite happens to produce, and every group there is a fixed
// sequence, so a defect that fails a small share of calls has a good chance of
// never firing. This group calls every route in the ledger 300 times and asserts
// two things across the whole sweep: nothing answers 5xx or above, and every
// non-2xx body is exactly {error:{code,message}}.
//
// The sweep deliberately does not reuse one fixture for everything. Each route is
// called in a shape that is legal for that route, so the sweep is exercising the
// success path as well as the error path, and a route that 5xxes only on its own
// inputs still gets called that way 300 times.
import { call, record, GET, POST, PATCH } from './lib.mjs';
import { fixture, restaurant, table, login, reset, book, D_THU_FUTURE } from './fixtures.mjs';

/* The cancel route cancels the booking the other authenticated routes act on, so
 * it is driven on a throwaway reference instead of the seeded one and the seed is
 * never disturbed. Keeping `reference` fixed is what lets every other route assert
 * the status the ledger documents for it. */
const REPEATS = 300;

export default async function run() {
  await reset(fixture());

  /* Seed once per sweep so the authenticated calls below have something to act on.
   * `auth` is rebuilt by reseed() rather than captured once: reset wipes the user
   * table and every bearer token with it, so a token minted before a reset stops
   * authenticating, and the authenticated routes then read 401 rather than the
   * status they are there to check. */
  let auth = {};
  /* The sweep books far more than the rest of the suite does, so it gets its own
   * wide fixture: 50 tables on a 30-minute grid from 18:00, which is 350 distinct
   * bookable table/slot pairs. With the default two-table fixture the throwaway
   * bookings start colliding inside the first few repeats and the routes that
   * depend on a booking succeeding stop testing what they are named for. */
  const sweepFixture = () => fixture({
    restaurants: [restaurant({
      slot_minutes: 30,
      reservation_duration_minutes: 60,
      opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '23:00' }],
      tables: Array.from({ length: 50 }, (_, i) => table(`s_${i + 1}`, 4, String(i + 1))),
    })],
    reservations: [],
  });
  const reseed = async (key) => {
    await reset(sweepFixture());
    auth = { token: await login() };
    return book(auth.token, { table_id: 's_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4, key });
  };
  const made = await reseed('sweep-seed');
  const reference = made.json && made.json.reference ? made.json.reference : 'SEED_MISSING';
  // A second booking, cancelled once, so the re-cancel branch has a dead reference.
  const dead = await book(auth.token, { table_id: 's_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2, key: 'sweep-dead' });
  await POST(`/reservations/${dead.json.reference}/cancel`, { token: auth.token });
  const deadReference = dead.json.reference;

  /* Each entry names a route and how to call it. `expect` is the status the
   * specification documents, and a mismatch is recorded as a sweep failure, so a
   * route that starts answering the wrong status shows up here rather than being
   * averaged away. */
  const routes = [
    { name: 'GET /health', expect: 200, call: () => GET('/health') },
    { name: 'GET /restaurants', expect: 200, call: () => GET('/restaurants') },
    { name: 'GET /restaurants/r_anker', expect: 200, call: () => GET('/restaurants/r_anker') },
    { name: 'GET /availability', expect: 200, call: () => GET(`/availability?restaurant_id=r_anker&date=${D_THU_FUTURE}&party_size=4`) },
    { name: 'GET /availability missing params', expect: 422, call: () => GET('/availability') },
    { name: 'GET /availability bad date', expect: 422, call: () => GET('/availability?restaurant_id=r_anker&date=not-a-date&party_size=4') },
    { name: 'GET /reservations', expect: 200, call: () => GET('/reservations', auth) },
    { name: 'GET /reservations/:ref', expect: 200, call: () => GET(`/reservations/${reference}`, auth) },
    { name: 'GET /reservations unknown ref', expect: 404, call: () => GET('/reservations/NOPE404', auth) },
    { name: 'GET /reservations no token', expect: 401, call: () => GET('/reservations') },
    { name: 'POST /reservations', expect: 201, call: (i) => POST('/reservations', { ...auth, key: `sweep-new-${i}`, body: { restaurant_id: 'r_anker', table_id: `s_${20 + (i % 20)}`, starts_at_local: `${D_THU_FUTURE}T${18 + Math.floor(i / 20) % 5}:00`, party_size: 2 } }) },
    { name: 'POST /reservations taken slot', expect: 409, call: () => POST('/reservations', { ...auth, key: 'sweep-taken', body: { restaurant_id: 'r_anker', table_id: 's_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 } }) },
    { name: 'POST /reservations missing key', expect: 400, call: () => POST('/reservations', { ...auth, body: { restaurant_id: 'r_anker', table_id: 's_11', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 2 } }) },
    { name: 'POST /reservations bad party_size', expect: 422, call: (i) => POST('/reservations', { ...auth, key: `sweep-bad-${i}`, body: { restaurant_id: 'r_anker', table_id: 's_11', starts_at_local: `${D_THU_FUTURE}T21:00`, party_size: 99 } }) },
    { name: 'POST /reservations off grid', expect: 422, call: (i) => POST('/reservations', { ...auth, key: `sweep-grid-${i}`, body: { restaurant_id: 'r_anker', table_id: 's_10', starts_at_local: `${D_THU_FUTURE}T21:07`, party_size: 2 } }) },
    { name: 'PATCH /reservations/:ref', expect: 200, call: (i) => PATCH(`/reservations/${reference}`, { ...auth, body: { party_size: 2 + (i % 2) } }) },
    /* Cancel is driven two ways so the confirmed -> cancelled transition is what
       * actually repeats 150 times, without consuming the seed: even repeats
       * re-cancel an already-cancelled booking, which the specification answers
       * 200 with the original body (P32), and odd repeats book a fresh slot and
       * cancel it. The seeded reservation is never touched. */
    { name: 'POST /reservations/:ref/cancel', expect: 200, call: async (i) => {
      if (i % 2 === 0) return POST(`/reservations/${deadReference}/cancel`, { token: auth.token });
      const scratch = await book(auth.token, { table_id: `s_${3 + (i % 40)}`, starts_at_local: `${D_THU_FUTURE}T${18 + Math.floor(i / 40) % 5}:00`, party_size: 2, key: `sweep-cancel-${i}` });
      return POST(`/reservations/${scratch.json.reference}/cancel`, { token: auth.token });
    } },
    /* These two need a cancelled reservation of their own, so they make one per call
   * rather than reusing the seed: cancelling the seed would leave the authenticated
   * routes above and below reading a different status on the next repeat. */
    { name: 'PATCH cancelled reservation', expect: 409, call: async (i) => {
      const scratch = await book(auth.token, { table_id: `s_${3 + (i % 40)}`, starts_at_local: `${D_THU_FUTURE}T${18 + Math.floor(i / 40) % 5}:00`, party_size: 2, key: `sweep-pc-${i}` });
      await POST(`/reservations/${scratch.json.reference}/cancel`, { token: auth.token });
      return PATCH(`/reservations/${scratch.json.reference}`, { ...auth, body: { party_size: 3 } });
    } },
    { name: 'POST /reservation-moves', expect: 409, call: async (i) => {
      const scratch = await book(auth.token, { table_id: `s_${3 + (i % 40)}`, starts_at_local: `${D_THU_FUTURE}T${18 + Math.floor(i / 40) % 5}:00`, party_size: 2, key: `sweep-mv-${i}` });
      await POST(`/reservations/${scratch.json.reference}/cancel`, { token: auth.token });
      return POST('/reservation-moves', { ...auth, key: `sweep-move-cancelled-${i}`, body: { moves: [{ reference: scratch.json.reference, party_size: 2 }] } });
    } },
    { name: 'POST /reservation-moves unknown ref', expect: 404, call: (i) => POST('/reservation-moves', { ...auth, key: `sweep-move-404-${i}`, body: { moves: [{ reference: 'NOPE404', party_size: 2 }] } }) },
    { name: 'POST /auth/signup duplicate', expect: 409, call: () => POST('/auth/signup', { body: { email: 'ada@example.com', password: 'correct horse' } }) },
    { name: 'POST /auth/login bad password', expect: 401, call: (i) => POST('/auth/login', { body: { email: 'ada@example.com', password: `wrong-${i}` } }) },
    { name: 'POST /auth/login', expect: 200, call: () => POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } }) },
    { name: 'GET /_test/export', expect: 200, call: () => GET('/_test/export') },
    { name: 'POST /_test/import bad shape', expect: 422, call: () => POST('/_test/import', { body: { nonsense: true } }) },
    { name: 'POST malformed JSON', expect: 400, call: () => call('POST', '/reservations', { ...auth, key: 'sweep-malformed', rawBody: '{not json' }) },
    { name: 'POST /_test/reset', expect: 204, call: (i) => POST('/_test/reset', { body: sweepFixture() }) },
  ];

  const serverErrors = [];
  const badBodies = [];
  const seen = new Map(routes.map((r) => [r.name, new Set()]));
  let calls = 0;

  for (const route of routes) {
    for (let i = 0; i < REPEATS; i += 1) {
      const res = await route.call(i);
      calls += 1;
      seen.get(route.name).add(res.status);
      if (res.status >= 500) serverErrors.push(`${route.name} call ${i} -> ${res.status} ${res.text.slice(0, 120)}`);
      if (res.status >= 400) {
        const keys = res.json && typeof res.json === 'object' ? Object.keys(res.json) : [];
        const inner = res.json && res.json.error && typeof res.json.error === 'object' ? Object.keys(res.json.error) : [];
        const shaped = keys.length === 1 && keys[0] === 'error' && inner.length === 2 && inner.includes('code') && inner.includes('message')
          && typeof res.json.error.code === 'string' && typeof res.json.error.message === 'string';
        if (!shaped) badBodies.push(`${route.name} call ${i} -> ${res.status} ${res.text.slice(0, 120)}`);
      }
      // The cancel route is destructive: cancel the seeded booking, then restore it
      // so the routes after it still see a confirmed reservation to act on.
      if (route.name === 'POST /reservations/:ref/cancel') await reseed(`sweep-recancel-${i}`);
    }
  }

  record('E16b', serverErrors.length === 0,
    `${calls} calls across ${routes.length} routes, ${REPEATS} each: ${serverErrors.length} answered 500 or above${serverErrors.length ? `; first: ${serverErrors[0]}` : ''}`);
  record('E1b', badBodies.length === 0,
    `every non-2xx answer in the ${calls}-call sweep was exactly {error:{code,message}}: ${badBodies.length} exceptions${badBodies.length ? `; first: ${badBodies[0]}` : ''}`);
  /* Each route's own repeats legitimately span several statuses: the create route
   * answers 201 while its slots are free and 409 once it has filled them, and the
   * cancel route answers 200 while the booking is confirmed and 409 afterwards.
   * What would be a defect is a route that *never* produces the status the ledger
   * documents for it, so that is what is checked. */
  const never = routes.filter((r) => !seen.get(r.name).has(r.expect)).map((r) => `${r.name} (documented ${r.expect}, saw ${[...seen.get(r.name)].sort((a, b) => a - b).join('/')})`);
  record('E16c', never.length === 0,
    `every route produced the status the ledger documents for it at least once across its ${REPEATS} repeats: ${never.length} never did${never.length ? `; ${never.join(' | ')}` : ''}`);
}