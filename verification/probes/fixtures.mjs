// Fixture builders, written from stage-1.md sections 3.3, 4 and 9.
export const BERLIN = 'Europe/Berlin';
export const NEWYORK = 'America/New_York';

// 2026-09-24 and 2026-12-10 are Thursdays; the four DST dates in the stage-1.md
// transition table are all Sundays.
export const D_THU = '2026-09-24';
export const D_THU_FUTURE = '2026-12-10';
export const D_BERLIN_GAP = '2026-03-29';
export const D_BERLIN_FOLD = '2026-10-25';
export const D_NY_GAP = '2026-03-08';
export const D_NY_FOLD = '2026-11-01';

export function table(id, capacity, label) {
  return { id, label: label === undefined ? id : label, capacity };
}

export function restaurant(over = {}) {
  return {
    id: 'r_anker',
    name: 'Zum Anker',
    timezone: BERLIN,
    slot_minutes: 30,
    reservation_duration_minutes: 90,
    cancellation_cutoff_minutes: 120,
    opening_hours: [
      { weekday: 'thu', opens: '18:00', closes: '23:00' },
      { weekday: 'fri', opens: '18:00', closes: '23:30' },
    ],
    tables: [table('t_1', 2, '1'), table('t_2', 4, '2')],
    ...over,
  };
}

export function fixture(over = {}) {
  return {
    users: [{ id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' }],
    restaurants: [restaurant()],
    reservations: [],
    ...over,
  };
}

export function seeded(over = {}) {
  return {
    id: 'res_seed',
    reference: 'SEED001',
    user_id: 'u_ada',
    restaurant_id: 'r_anker',
    table_id: 't_1',
    starts_at_local: `${D_THU_FUTURE}T19:00`,
    party_size: 2,
    ...over,
  };
}

export async function reset(body) {
  const res = await fetch(`${(await import('./lib.mjs')).BASE}/_test/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body === undefined ? fixture() : body),
  });
  const text = await res.text();
  if (res.status !== 204) throw new Error(`reset answered ${res.status} ${text.slice(0, 200)}`);
  return res;
}

export async function login(email = 'ada@example.com', password = 'correct horse') {
  const { POST } = await import('./lib.mjs');
  const res = await POST('/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login answered ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.token;
}

export async function fresh(over = {}, seed) {
  const fx = fixture(over);
  if (seed) fx.reservations = [seeded(seed)];
  await reset(fx);
  return login();
}

export async function avail(restaurantId, date, partySize, extra = '') {
  const { GET } = await import('./lib.mjs');
  const q = `restaurant_id=${encodeURIComponent(restaurantId)}&date=${date}&party_size=${partySize}${extra}`;
  return GET(`/availability?${q}`);
}

export async function book(token, { table_id = 't_2', starts_at_local, party_size = 4, key, restaurant_id = 'r_anker' }) {
  const { POST } = await import('./lib.mjs');
  return POST('/reservations', {
    token,
    key: key === undefined ? `k-${Math.random().toString(36).slice(2)}` : key,
    body: { restaurant_id, table_id, starts_at_local, party_size },
  });
}
