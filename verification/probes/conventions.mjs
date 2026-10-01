// Rows C1..C12 and M1..M8.
import { GET, POST, PATCH, record, isRfc3339WithOffset, isBareLocal, call } from './lib.mjs';
import { fixture, restaurant, table, fresh, login, reset, avail, book, seeded, D_THU, D_THU_FUTURE, BERLIN } from './fixtures.mjs';

const RES_FIELDS = ['reservation_id', 'reference', 'restaurant_id', 'table_id', 'party_size', 'status', 'starts_at_local', 'starts_at', 'ends_at', 'created_at'];

export default async function run() {
  const token = await fresh();

  // C1 / C2 health
  const h = await GET('/health');
  record('C1', h.status === 200 && h.json && h.json.status === 'ok' && deep(h.json, { status: 'ok' }),
    `GET /health -> ${h.status} ${h.text}`);

  // C4 reset is 204 with an empty body
  const r = await call('POST', '/_test/reset', { body: fixture() });
  record('C4', r.status === 204 && r.text === '', `reset -> ${r.status} body=${JSON.stringify(r.text)}`);

  // C5 reset replaces everything, and repeats
  const c5token = await login();
  await book(c5token, { starts_at_local: `${D_THU_FUTURE}T19:00`, key: 'c5-a' });
  let list = await GET('/reservations', { token: c5token });
  const beforeSecond = (list.json.reservations || []).length;
  await reset(fixture());
  const afterToken = await login();
  list = await GET('/reservations', { token: afterToken });
  record('C5', beforeSecond === 1 && (list.json.reservations || []).length === 0,
    `one reservation before the second reset, ${(list.json.reservations || []).length} after (${list.status})`);
  await reset(fixture());
  await reset(fixture());
  const restaurants = await GET('/restaurants');
  record('C5b', restaurants.status === 200 && restaurants.json.restaurants.length === 1, `third reset then GET /restaurants -> ${restaurants.status}`);

  // C6 reset needs no authentication (no header sent above) and lives in the image under test
  record('C6', r.status === 204, `reset without Authorization -> ${r.status}`);

  // C7 content type
  const ct = (await GET('/restaurants')).headers.get('content-type');
  const ctBook = (await book(await login(), { starts_at_local: `${D_THU_FUTURE}T19:00` })).headers.get('content-type');
  record('C7', /application\/json/i.test(ct) && /utf-8/i.test(ct) && /utf-8/i.test(ctBook), `content-type ${ct} / ${ctBook}`);

  // C8 every timestamp in a spread of responses is RFC 3339 with an explicit offset
  const tok = await login();
  const made = await book(tok, { starts_at_local: `${D_THU_FUTURE}T19:00` });
  const mine = await GET('/reservations', { token: tok });
  const av = await avail('r_anker', D_THU_FUTURE, 4);
  const stamps = [];
  for (const r of [made, mine]) {
    for (const res of [r.json, ...(r.json.reservations || [])]) {
      for (const f of ['starts_at', 'ends_at', 'created_at']) if (res && res[f] !== undefined) stamps.push([f, res[f]]);
    }
  }
  for (const s of av.json.slots) { stamps.push(['starts_at', s.starts_at]); stamps.push(['starts_at_local', s.starts_at_local]); }
  const bad = stamps.filter(([f, v]) => (f === 'starts_at_local' ? !isBareLocal(v) : !isRfc3339WithOffset(v)));
  record('C8', stamps.length > 0 && bad.length === 0, `${stamps.length} timestamps checked, bad: ${JSON.stringify(bad)}`);

  // C9 / C12 unknown body fields are ignored
  const tok2 = await login();
  const s1 = await POST('/auth/signup', { body: { email: 'new@example.com', password: 'longenough', display_name: 'New', nickname: 'x', extra: { a: 1 } } });
  const l1 = await POST('/auth/login', { body: { email: 'new@example.com', password: 'longenough', remember: true } });
  await reset(fixture());
  const b1 = await book(await login(), { starts_at_local: `${D_THU_FUTURE}T19:00`, key: 'c9-1' });
  const b2 = await POST('/reservations', { token: await login(), key: 'c9-2', body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 2, seating: 'bar' } });
  const mv = await POST('/reservation-moves', { token: await login(), key: 'c9-3', body: { moves: [{ reference: b1.json.reference, table_id: 't_2', note: 'window' }] } });
  const r1 = await call('POST', '/_test/reset', { body: fixture({ future_flag: true, users: [{ id: 'u_x', email: 'x@example.com', password: 'longenough', display_name: 'X', role: 'admin' }], extra_top: [1, 2] }) });
  record('C9', s1.status === 201 && l1.status === 200 && b1.status === 201 && b2.status === 201 && mv.status === 201 && r1.status === 204,
    `signup ${s1.status}, login ${l1.status}, book ${b1.status}/${b2.status}, moves ${mv.status}, reset-with-extras ${r1.status}`);
  record('C12', b2.status === 201, `POST /reservations with an unknown field -> ${b2.status}`);

  // C10 unknown query parameters are ignored
  const q1 = await avail('r_anker', D_THU_FUTURE, 4, '&page=3&sort=desc&cursor=abc');
  const q2 = await avail('r_anker', D_THU_FUTURE, 4);
  record('C10', q1.status === 200 && deep(q1.json, q2.json), `unknown query params changed the body: ${q1.status}`);

  // C11 ids stay at or below 64 characters, including ids supplied in a fixture
  const longId = 'L'.repeat(65);
  const badReset = await call('POST', '/_test/reset', { body: fixture({ restaurants: [restaurant({ id: longId })] }) });
  const okReset = await call('POST', '/_test/reset', { body: fixture({ restaurants: [restaurant({ id: 'R'.repeat(64) })] }) });
  const ids = [];
  if (okReset.status === 204) {
    const tok3 = await login();
    const made2 = await book(tok3, { starts_at_local: `${D_THU_FUTURE}T19:00` });
    ids.push(made2.json.reservation_id, made2.json.reference);
    const list2 = await GET('/restaurants', {});
    ids.push(list2.json.restaurants[0].id);
    for (const key of Object.keys(made2.json)) if (key.endsWith('_id')) ids.push(made2.json[key]);
  }
  const tooLong = ids.filter((v) => typeof v === 'string' && v.length > 64);
  record('C11', badReset.status === 422 && badReset.json?.error?.code === 'validation_failed' && okReset.status === 204 && tooLong.length === 0,
    `65-char fixture id -> ${badReset.status}, 64-char -> ${okReset.status}, emitted ids over 64: ${JSON.stringify(tooLong)}`);

  // M1 restaurant and table creation endpoints are out of scope
  await reset(fixture());
  const create = await POST('/restaurants', { token: await login(), body: { id: 'r_new', name: 'New', timezone: BERLIN } });
  const listAfter = await GET('/restaurants');
  record('M1', listAfter.json.restaurants.length === 1 && listAfter.json.restaurants[0].id === 'r_anker' && create.status < 500,
    `POST /restaurants -> ${create.status}, restaurants now ${listAfter.json.restaurants.length}`);

  // M2 a seeded user logs in immediately
  await reset(fixture());
  const seededLogin = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  const seededToken = seededLogin.json && seededLogin.json.token;
  const whoami = await GET('/reservations', { token: seededToken });
  record('M2', seededLogin.status === 200 && whoami.status === 200 && seededToken, `seeded login -> ${seededLogin.status}, token usable -> ${whoami.status}`);

  // M3 a seeded reservation appears, occupies its table, and blocks availability
  await fresh({}, seeded({ table_id: 't_2', party_size: 4, starts_at_local: `${D_THU_FUTURE}T19:00` }));
  const ownerList = await GET('/reservations', { token: await login() });
  const avBefore = await avail('r_anker', D_THU_FUTURE, 4);
  const slot19 = avBefore.json.slots.find((s) => s.starts_at_local === `${D_THU_FUTURE}T19:00`);
  record('M3', (ownerList.json.reservations || []).length === 1 && ownerList.json.reservations[0].reference === 'SEED001' && slot19 && !slot19.available_table_ids.includes('t_2'),
    `seeded reservation listed: ${(ownerList.json.reservations || []).length}, t_2 free at 19:00: ${slot19 && slot19.available_table_ids.join(',')}`);
  const takeSeeded = await book(await login(), { table_id: 't_2', starts_at_local: `${D_THU_FUTURE}T19:00`, party_size: 4 });
  record('M3b', takeSeeded.status === 409 && takeSeeded.json?.error?.code === 'table_unavailable', `booking over a seeded reservation -> ${takeSeeded.status} ${takeSeeded.json?.error?.code}`);

  // M4 each weekday name opens its own day, and nothing else
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const perDay = [];
  for (const weekday of days) {
    const fx = fixture({ restaurants: [restaurant({ opening_hours: [{ weekday, opens: '12:00', closes: '15:00' }] })] });
    await reset(fx);
    const counts = [];
    for (const date of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-12', '2026-12-13']) {
      const a = await avail('r_anker', date, 2);
      counts.push(a.json.slots.length);
    }
    perDay.push([weekday, counts]);
  }
  const wrong = perDay.filter(([, counts]) => counts.filter((n) => n > 0).length !== 1);
  record('M4', wrong.length === 0, `weekday entries opening the wrong day: ${JSON.stringify(wrong)}`);

  // M5 slots run from opens on the slot grid while slot + duration <= closes
  await reset(fixture({ restaurants: [restaurant({ slot_minutes: 45, reservation_duration_minutes: 60, opening_hours: [{ weekday: 'thu', opens: '11:00', closes: '15:00' }] })] }));
  const grid = await avail('r_anker', D_THU, 2);
  const starts = grid.json.slots.map((s) => s.starts_at_local.slice(11));
  const expected = [];
  for (let m = 11 * 60; m + 60 <= 15 * 60; m += 45) expected.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  record('M5', deep(starts, expected), `slots ${JSON.stringify(starts)} expected ${JSON.stringify(expected)}`);

  // M6 no slot ends after closes and none spills into the next local day
  const lastSlot = grid.json.slots[grid.json.slots.length - 1];
  record('M6', starts.every((s) => s >= '11:00' && s < '15:00') && lastSlot.starts_at_local.slice(0, 10) === D_THU,
    `last slot ${lastSlot && lastSlot.starts_at_local}, ends ${lastSlot && lastSlot.ends_at || lastSlot && lastSlot.starts_at}`);

  // M7 a past start is not rejected for being in the past
  await reset(fixture());
  const past = await book(await login(), { starts_at_local: `${D_THU}T19:00` });
  record('M7', past.status === 201, `booking a start in the past (${D_THU}T19:00, today is later) -> ${past.status}`);
  const pastCancel = await POST(`/reservations/${past.json.reference}/cancel`, { token: await login() });
  record('M7b', pastCancel.status === 409 && pastCancel.json?.error?.code === 'cutoff_passed',
    `cancelling that past booking -> ${pastCancel.status} ${pastCancel.json?.error?.code}`);
  const pastPatch = await PATCH(`/reservations/${past.json.reference}`, { token: await login(), body: { party_size: 3 } });
  record('M7c', pastPatch.status === 409 && pastPatch.json?.error?.code === 'cutoff_passed',
    `amending that past booking -> ${pastPatch.status} ${pastPatch.json?.error?.code}`);

  // M8 a weekday with no entry is closed
  await reset(fixture());
  const sat = await avail('r_anker', '2026-09-26', 4);
  record('M8', sat.status === 200 && Array.isArray(sat.json.slots) && sat.json.slots.length === 0, `Saturday -> ${JSON.stringify(sat.json.slots)}`);
}

function deep(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
