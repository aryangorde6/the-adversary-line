'use strict';

/* Section 5 draws one line and the whole service hangs off it: a field of the
 * wrong JSON type is 400 malformed_request, a field of the right type with a bad
 * value is 422 validation_failed. On the fixture path nothing else overrides
 * that, so these probes pin both sides of the line, and pin the three carve-outs
 * the specification names: party_size, a starts_at_local that is a string in the
 * wrong shape, and section 11's batch move. */

const L = require('./lib');

const BASE = {
  users: [{ id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' }],
  restaurants: [{
    id: 'r_anker',
    name: 'Zum Anker',
    timezone: 'Europe/Berlin',
    slot_minutes: 30,
    reservation_duration_minutes: 90,
    cancellation_cutoff_minutes: 120,
    opening_hours: [{ weekday: 'thu', opens: '18:00', closes: '23:00' }],
    tables: [{ id: 't_1', label: '1', capacity: 2 }],
  }],
  reservations: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Set a deep path on a fixture, e.g. ['restaurants', 0, 'slot_minutes']. */
function setPath(fixture, path, value) {
  let at = fixture;
  for (let i = 0; i < path.length - 1; i += 1) at = at[path[i]];
  at[path[path.length - 1]] = value;
  return fixture;
}

function withField(path, value) {
  return setPath(clone(BASE), path, value);
}

/** Delete a deep path on a fixture, e.g. ['restaurants', 0, 'timezone']. */
function dropPath(fixture, path) {
  let at = fixture;
  for (let i = 0; i < path.length - 1; i += 1) at = at[path[i]];
  delete at[path[path.length - 1]];
  return fixture;
}

function seededReservation(overrides = {}) {
  const fixture = clone(BASE);
  fixture.reservations = [{
    id: 'res_1', reference: 'ABC123', user_id: 'u_ada', restaurant_id: 'r_anker',
    table_id: 't_1', party_size: 2, starts_at_local: '2026-09-24T19:00', ...overrides,
  }];
  return fixture;
}

async function resetAnswers(fixture) {
  return L.call('POST', '/_test/reset', { body: fixture });
}

exports.run = async () => {
  await L.step('the shape cases the specification names are 400 malformed_request', async () => {
    const bodies = [
      '{"restaurants":7}',
      '{"users":"ada"}',
      '{"reservations":3}',
      '{"restaurants":[7]}',
      '{"restaurants":[{"id":"r_x","timezone":"Europe/Berlin","slot_minutes":30,"reservation_duration_minutes":30,"cancellation_cutoff_minutes":30,"tables":7}]}',
    ];
    for (const raw of bodies) {
      const res = await L.call('POST', '/_test/reset', { rawBody: raw });
      L.expectError(res, 400, 'malformed_request', `raw ${raw}`);
    }
  });

  await L.step('a fixture field of the wrong JSON type is 400, at every depth', async () => {
    const cases = [
      [['restaurants'], 7, 'restaurants is a number'],
      [['users'], {}, 'users is an object'],
      [['reservations'], 'none', 'reservations is a string'],
      [['restaurants', 0], 7, 'a restaurant is a number'],
      [['restaurants', 0, 'id'], 7, 'restaurant id is a number'],
      [['restaurants', 0, 'name'], 7, 'restaurant name is a number'],
      [['restaurants', 0, 'timezone'], 7, 'timezone is a number'],
      [['restaurants', 0, 'slot_minutes'], '30', 'slot_minutes is a string'],
      
      [['restaurants', 0, 'cancellation_cutoff_minutes'], true, 'cutoff is a boolean'],
      [['restaurants', 0, 'opening_hours'], {}, 'opening_hours is an object'],
      [['restaurants', 0, 'opening_hours', 0], 'thu', 'an opening hours entry is a string'],
      [['restaurants', 0, 'opening_hours', 0, 'weekday'], 7, 'weekday is a number'],
      [['restaurants', 0, 'opening_hours', 0, 'opens'], 1800, 'opens is a number'],
      [['restaurants', 0, 'opening_hours', 0, 'closes'], 2300, 'closes is a number'],
      [['restaurants', 0, 'tables'], 7, 'tables is a number'],
      [['restaurants', 0, 'tables', 0], 7, 'a table is a number'],
      [['restaurants', 0, 'tables', 0, 'id'], 7, 'table id is a number'],
      [['restaurants', 0, 'tables', 0, 'label'], 7, 'table label is a number'],
      [['restaurants', 0, 'tables', 0, 'capacity'], '4', 'capacity is a string'],
      [['users', 0], 7, 'a user is a number'],
      [['users', 0, 'id'], 7, 'user id is a number'],
      [['users', 0, 'email'], 7, 'email is a number'],
      [['users', 0, 'password'], 7, 'password is a number'],
      [['users', 0, 'display_name'], 7, 'display name is a number'],
      [['reservations', 0], 7, 'a seeded reservation is a number'],
    ];
    for (const [path, value, label] of cases) {
      L.expectError(await resetAnswers(withField(path, value)), 400, 'malformed_request', label);
    }
    for (const [path, value, label] of [
      [['reservations', 0, 'reference'], 7, 'seeded reference is a number'],
      [['reservations', 0, 'user_id'], 7, 'seeded user_id is a number'],
      [['reservations', 0, 'table_id'], 7, 'seeded table_id is a number'],
      [['reservations', 0, 'starts_at_local'], 20260924, 'seeded start time is a number'],
      [['reservations', 0, 'status'], 7, 'seeded status is a number'],
    ]) {
      L.expectError(await resetAnswers(setPath(seededReservation(), path, value)), 400, 'malformed_request', label);
    }
  });

  await L.step('a required field that is absent or null is 422, not a wrong type', async () => {
    for (const [path, label] of [
      [['users', 0, 'email'], 'absent user email'],
      [['users', 0, 'password'], 'absent user password'],
      [['restaurants', 0, 'timezone'], 'absent timezone'],
      [['restaurants', 0, 'slot_minutes'], 'absent slot step'],
      [['restaurants', 0, 'opening_hours', 0, 'weekday'], 'absent weekday'],
      [['restaurants', 0, 'opening_hours', 0, 'opens'], 'absent opening time'],
      [['restaurants', 0, 'opening_hours', 0, 'closes'], 'absent closing time'],
      [['restaurants', 0, 'tables', 0, 'id'], 'absent table id'],
      [['restaurants', 0, 'tables', 0, 'capacity'], 'absent capacity'],
    ]) {
      L.expectError(await resetAnswers(dropPath(clone(BASE), path)), 422, 'validation_failed', label);
    }
    for (const [path, label] of [
      [['users', 0, 'email'], 'null user email'],
      [['users', 0, 'password'], 'null user password'],
      [['restaurants', 0, 'timezone'], 'null timezone'],
      [['restaurants', 0, 'slot_minutes'], 'null slot step'],
      [['restaurants', 0, 'opening_hours', 0, 'weekday'], 'null weekday'],
      [['restaurants', 0, 'opening_hours', 0, 'opens'], 'null opening time'],
      [['restaurants', 0, 'tables', 0, 'id'], 'null table id'],
      [['restaurants', 0, 'tables', 0, 'capacity'], 'null capacity'],
    ]) {
      L.expectError(await resetAnswers(setPath(clone(BASE), path, null)), 422, 'validation_failed', label);
    }
    for (const [label, body] of [
      ['a seeded restaurant id that is null', seededReservation({ restaurant_id: null })],
      ['a seeded user id that is null', seededReservation({ user_id: null })],
      ['a seeded table id that is null', seededReservation({ table_id: null })],
      ['a seeded start time that is null', seededReservation({ starts_at_local: null })],
      ['a seeded party size that is null', seededReservation({ party_size: null })],
      ['a seeded party size that is absent', seededReservation({ party_size: undefined })],
    ]) {
      L.expectError(await resetAnswers(body), 422, 'validation_failed', label);
    }
    L.expectError(await resetAnswers(setPath(withField(BASE, ['restaurants', 0], {}), ['restaurants', 0, 'opening_hours', 0, 'closes'], 1800)), 400, 'malformed_request', 'a closing time that is a number');
    L.expectError(await resetAnswers(seededReservation({ restaurant_id: 7 })), 400, 'malformed_request', 'a seeded restaurant id that is a number');
  });

  await L.step('a fixture field of the right type with a bad value is still 422', async () => {
    const cases = [
      [['restaurants', 0, 'slot_minutes'], 0, 'slot_minutes of zero'],
      [['restaurants', 0, 'slot_minutes'], -30, 'a negative slot step'],
      [['restaurants', 0, 'slot_minutes'], 1.5, 'a fractional slot step'],
      [['restaurants', 0, 'reservation_duration_minutes'], 0, 'a zero duration'],
      [['restaurants', 0, 'cancellation_cutoff_minutes'], -1, 'a negative cutoff'],
      [['restaurants', 0, 'cancellation_cutoff_minutes'], 10081, 'a cutoff past the published maximum'],
      [['restaurants', 0, 'slot_minutes'], 0, 'a slot step of zero'],
      [['restaurants', 0, 'id'], '', 'an empty id'],
      [['restaurants', 0, 'id'], 'x'.repeat(65), 'an id of 65 characters'],
      [['restaurants', 0, 'timezone'], 'Mars/Olympus', 'an unknown zone'],
      [['restaurants', 0, 'opening_hours', 0, 'weekday'], 'xyz', 'an unknown weekday'],
      [['restaurants', 0, 'opening_hours', 0, 'opens'], '25:00', 'an opening time past midnight'],
      [['restaurants', 0, 'opening_hours', 0, 'closes'], '17:00', 'closing before opening'],
      [['restaurants', 0, 'tables', 0, 'capacity'], 0, 'a capacity of zero'],
      [['restaurants', 0, 'tables', 0, 'capacity'], 2.5, 'a fractional capacity'],
      [['restaurants', 0, 'tables', 0, 'id'], '', 'an empty table id'],
      [['users', 0, 'email'], 'not-an-email', 'an email that is not one'],
      [['users', 0, 'password'], '', 'an empty password'],
    ];
    for (const [path, value, label] of cases) {
      L.expectError(await resetAnswers(withField(path, value)), 422, 'validation_failed', label);
    }
    for (const [label, body] of [
      ['a seeded reference in the wrong format', seededReservation({ reference: 'lower01' })],
      ['a seeded start time that is not a date', seededReservation({ starts_at_local: '2026-02-30T19:00' })],
      ['a seeded start time in the wrong shape', seededReservation({ starts_at_local: '2026-09-24 19:00' })],
      ['a seeded party size of zero', seededReservation({ party_size: 0 })],
      ['a seeded party size that is a string', seededReservation({ party_size: '2' })],
    ]) {
      L.expectError(await resetAnswers(body), 422, 'validation_failed', label);
    }
  });

  await L.step('the endpoint carve-outs the specification names stay 422', async () => {
    await L.reset(BASE);
    const token = await L.login('ada@example.com', 'correct horse');
    const good = { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 2 };
    for (const [label, body] of [
      ['party_size as a string', { ...good, party_size: '2' }],
      ['party_size as a boolean', { ...good, party_size: true }],
      ['party_size of zero', { ...good, party_size: 0 }],
      ['a start time that is not a bare local minute', { ...good, starts_at_local: '2026-09-24 19:00' }],
    ]) {
      L.expectError(
        await L.call('POST', '/reservations', { token, key: `t-${label}`, body }),
        422, 'validation_failed', label,
      );
    }
    // Section 11: a badly shaped batch move is 422, not 400.
    L.expectError(
      await L.call('POST', '/reservation-moves', { token, key: 't-shapes', body: { moves: [7] } }),
      422, 'validation_failed', 'a batch move that is not an object',
    );
    L.expectError(
      await L.call('POST', '/reservation-moves', { token, key: 't-notarray', body: { moves: 7 } }),
      422, 'validation_failed', 'moves that is not an array',
    );
  });

  await L.step('section 10 keeps an invalid imported state at 422, not 400', async () => {
    await L.reset(BASE);
    const exported = await L.call('GET', '/_test/export');
    L.assert.equal(exported.status, 200, exported.text);
    const broken = clone(exported.json);
    broken.state.restaurants = 7;
    L.expectError(await L.call('POST', '/_test/import', { body: broken }), 422, 'validation_failed', 'imported restaurants that are not an array');
    const brokenReservation = clone(exported.json);
    brokenReservation.state.restaurants[0].tables = 7;
    L.expectError(await L.call('POST', '/_test/import', { body: brokenReservation }), 422, 'validation_failed', 'imported tables that are not an array');
    L.expectError(await L.call('POST', '/_test/import', { rawBody: '{' }), 400, 'malformed_request', 'an unparseable import body');
  });
};