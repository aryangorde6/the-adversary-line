'use strict';

const L = require('./lib');
const clock = require('./clock');

const R = 'r_anker';
const T2 = 't_2';
const D = '2026-09-24';

/** Future-dated fixture: the standard one has a 120 minute cutoff, so anything
 *  in the past can neither be cancelled nor amended. */
async function future(overrides = {}) {
  await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30, ...overrides }));
  return L.login('ada@example.com', 'correct horse');
}

async function book(t, key, overrides = {}) {
  return L.call('POST', '/reservations', {
    token: t,
    key,
    body: { restaurant_id: R, table_id: T2, starts_at_local: `${D}T19:00`, party_size: 4, ...overrides },
  });
}

exports.run = async () => {
  await L.step('a confirmed reservation reports its interval and stays stable', async () => {
    const t = await future();
    const res = await book(t, 'b-1');
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.status, 'confirmed');
    L.assert.equal(res.json.party_size, 4);
    L.assert.equal(res.json.table_id, T2);
    L.assert.equal(res.json.starts_at_local, `${D}T19:00`);
    const again = await L.call('GET', `/reservations/${res.json.reference}`, { token: t });
    L.assert.equal(again.status, 200, again.text);
    L.assert.deepEqual(again.json, res.json);
  });

  await L.step('unknown restaurant, unknown table and a foreign table are 404', async () => {
    const t = await future();
    L.expectError(await book(t, 'b-404a', { restaurant_id: 'r_nope' }), 404, 'not_found', 'unknown restaurant');
    L.expectError(await book(t, 'b-404b', { table_id: 't_nope' }), 404, 'not_found', 'unknown table');
    L.expectError(await book(t, 'b-404c', { table_id: 'n_1' }), 404, 'not_found', 'table of another restaurant');
  });

  await L.step('missing fields are 422 validation_failed', async () => {
    const t = await future();
    L.expectError(
      await L.call('POST', '/reservations', { token: t, key: 'b-m1', body: { table_id: T2, starts_at_local: `${D}T19:00`, party_size: 2 } }),
      422, 'validation_failed', 'no restaurant_id',
    );
    L.expectError(
      await L.call('POST', '/reservations', { token: t, key: 'b-m2', body: { restaurant_id: R, starts_at_local: `${D}T19:00`, party_size: 2 } }),
      422, 'validation_failed', 'no table_id',
    );
    L.expectError(
      await L.call('POST', '/reservations', { token: t, key: 'b-m3', body: { restaurant_id: R, table_id: T2, party_size: 2 } }),
      422, 'validation_failed', 'no starts_at_local',
    );
    L.expectError(
      await L.call('POST', '/reservations', { token: t, key: 'b-m4', body: { restaurant_id: R, table_id: T2, starts_at_local: `${D}T19:00` } }),
      422, 'validation_failed', 'no party_size',
    );
  });

  await L.step('party_size of the wrong type is 422, other wrong JSON types are 400', async () => {
    const t = await future();
    for (const value of ['4', true, 4.5, 0, -3, null]) {
      L.expectError(
        await book(t, `b-p-${JSON.stringify(value)}`, { party_size: value }),
        422, 'validation_failed', `party_size ${JSON.stringify(value)}`,
      );
    }
    L.expectError(await book(t, 'b-t1', { restaurant_id: 7 }), 400, 'malformed_request', 'restaurant_id number');
    L.expectError(await book(t, 'b-t2', { table_id: 7 }), 400, 'malformed_request', 'table_id number');
    L.expectError(await book(t, 'b-t3', { starts_at_local: 7 }), 400, 'malformed_request', 'starts_at_local number');
  });

  await L.step('starts_at_local must be a bare local YYYY-MM-DDTHH:MM', async () => {
    const t = await future();
    for (const value of [
      '2026-09-24T19:00:00', '2026-09-24T19:00Z', '2026-09-24T19:00+02:00',
      '2026-09-24 19:00', '2026-09-24', '19:00', '2026-9-24T19:00', '2026-13-24T19:00',
      '2026-09-24T25:00', 'not-a-time',
    ]) {
      L.expectError(await book(t, `b-s-${value}`, { starts_at_local: value }), 422, 'validation_failed', value);
    }
  });

  await L.step('a start off the slot grid is 422 not_on_slot_grid', async () => {
    const t = await future();
    L.expectError(await book(t, 'b-g1', { starts_at_local: `${D}T19:15` }), 422, 'not_on_slot_grid', '19:15');
    L.expectError(await book(t, 'b-g2', { starts_at_local: `${D}T19:45` }), 422, 'not_on_slot_grid', '19:45');
  });

  /* Containment is one rule and it is evaluated before the grid: a start that is
   * inside the open window but whose booking would finish after closing is
   * outside_opening_hours whatever the grid says. The grid is only reached by a
   * start that genuinely fits inside the window. Both halves are pinned here so
   * the two 422 codes cannot trade places again. */
  await L.step('containment is decided before the slot grid', async () => {
    const t = await future({ slot_minutes: 15, reservation_duration_minutes: 90 });
    const late = await L.call('GET', '/availability?restaurant_id=r_anker&date=2026-09-24&party_size=2');
    L.assert.equal(late.status, 200, late.text);
    for (const start of ['23:07', '23:20']) {
      L.expectError(
        await book(t, `b-p${start.slice(0, 2)}`, { starts_at_local: `${D}T${start}` }),
        422, 'outside_opening_hours',
        `${start} is off the grid and would finish after closing, so containment answers first`,
      );
    }
    for (const start of ['22:07', '22:20']) {
      L.expectError(
        await book(t, `b-g${start.slice(3, 5)}`, { starts_at_local: `${D}T${start}` }),
        422, 'not_on_slot_grid',
        `${start} fits inside the window, so only the grid can refuse it`,
      );
    }
    const lastFit = await book(t, 'b-last', { starts_at_local: `${D}T22:30` });
    L.assert.equal(lastFit.status, 201, 'a booking finishing exactly at closing is still accepted');
    const noRoom = await book(t, 'b-t2', { starts_at_local: `${D}T22:30` });
    L.expectError(noRoom, 409, 'table_unavailable', 'the same slot cannot be taken twice');
  });

  await L.step('a closed day, an early start and a late finish are 422 outside_opening_hours', async () => {
    await L.reset(L.FIXTURE);
    const t = await L.login('ada@example.com', 'correct horse');
    L.expectError(await book(t, 'b-o1', { starts_at_local: '2026-09-21T19:00' }), 422, 'outside_opening_hours', 'closed Monday');
    L.expectError(await book(t, 'b-o2', { starts_at_local: `${D}T17:00` }), 422, 'outside_opening_hours', 'before opening');
    L.expectError(await book(t, 'b-o3', { starts_at_local: `${D}T22:00` }), 422, 'outside_opening_hours', 'would end after closing');
    L.expectError(await book(t, 'b-o4', { restaurant_id: 'r_ny', table_id: 'n_1', starts_at_local: '2026-09-24T12:00' }), 422, 'outside_opening_hours', 'closed at the other restaurant');
  });

  await L.step('party_size above the table capacity is 422 party_exceeds_capacity', async () => {
    const t = await future();
    L.expectError(await book(t, 'b-c1', { party_size: 5 }), 422, 'party_exceeds_capacity', 'five at a four-top');
    L.assert.equal((await book(t, 'b-c2', { party_size: 4 })).status, 201);
  });

  await L.step('an overlapping booking on the same table is 409 table_unavailable', async () => {
    const t = await future({ reservation_duration_minutes: 60 });
    L.assert.equal((await book(t, 'b-t1')).status, 201);
    L.assert.equal((await book(t, 'b-t2', { table_id: 't_1', party_size: 2 })).status, 201, 'a different table is free');
    L.expectError(await book(t, 'b-t3', { table_id: T2 }), 409, 'table_unavailable', 'same table and slot');
    L.expectError(
      await book(t, 'b-t4', { table_id: T2, starts_at_local: `${D}T19:30` }),
      409, 'table_unavailable', 'overlapping the next slot',
    );
    L.assert.equal(
      (await book(t, 'b-t5', { table_id: T2, starts_at_local: `${D}T20:00` })).status,
      201,
      'the slot after the interval is free',
    );
  });

  await L.step('a booking that starts when the earlier one ends is accepted', async () => {
    const t = await future();
    L.assert.equal((await book(t, 'b-e1')).status, 201);
    const adjacent = await book(t, 'b-e2', { starts_at_local: `${D}T19:30` });
    L.assert.equal(adjacent.status, 201, adjacent.text);
    const endsAt = adjacent.json.ends_at;
    L.assert.equal(endsAt, `${D}T20:00:00+02:00`, 'a 30 minute booking from 19:30 ends at 20:00');
  });

  await L.step('a rejected booking leaves no trace', async () => {
    const t = await future();
    const before = await L.call('GET', '/reservations', { token: t });
    L.expectError(await book(t, 'b-j1', { party_size: 99 }), 422, 'party_exceeds_capacity', 'too many guests');
    const after = await L.call('GET', '/reservations', { token: t });
    L.assert.deepEqual(after.json, before.json);
  });

  await L.step('the list is the caller own bookings, newest start first', async () => {
    const t = await future();
    L.assert.equal((await book(t, 'b-l1', { starts_at_local: `${D}T19:00` })).status, 201);
    L.assert.equal((await book(t, 'b-l2', { table_id: 't_1', party_size: 2, starts_at_local: `${D}T19:00` })).status, 201);
    L.assert.equal((await book(t, 'b-l3', { table_id: 't_3', party_size: 4, starts_at_local: `${D}T19:00` })).status, 201);
    L.assert.equal((await book(t, 'b-l4', { table_id: 't_1', party_size: 2, starts_at_local: `${D}T21:00` })).status, 201);
    const list = await L.call('GET', '/reservations', { token: t });
    L.assert.equal(list.status, 200, list.text);
    L.assert.deepEqual(list.json.reservations.map((r) => r.starts_at_local), [
      `${D}T21:00`, `${D}T19:00`, `${D}T19:00`, `${D}T19:00`,
    ]);
    for (const entry of list.json.reservations) {
      for (const field of ['reservation_id', 'reference', 'restaurant_id', 'table_id', 'party_size', 'status', 'starts_at_local', 'starts_at', 'ends_at', 'created_at']) {
        L.assert.ok(entry[field] !== undefined, `list entry missing ${field}`);
      }
    }
  });

  await L.step('an empty list is an empty reservations array', async () => {
    const t = await future();
    L.assert.deepEqual((await L.call('GET', '/reservations', { token: t })).json, { reservations: [] });
  });

  await L.step('another diner cannot see or touch a booking', async () => {
    const t = await future();
    const bob = await L.login('bob@example.com', 'hunter22hunter');
    const res = await book(t, 'b-x1');
    const reference = res.json.reference;
    L.expectError(await L.call('GET', `/reservations/${reference}`, { token: bob }), 404, 'not_found', 'read');
    L.expectError(await L.call('POST', `/reservations/${reference}/cancel`, { token: bob }), 404, 'not_found', 'cancel');
    L.expectError(await L.call('PATCH', `/reservations/${reference}`, { token: bob, body: { party_size: 2 } }), 404, 'not_found', 'patch');
    L.assert.equal((await L.call('GET', `/reservations/${reference}`, { token: t })).json.status, 'confirmed');
  });

  await L.step('cancelling twice is not an error', async () => {
    const t = await future();
    const res = await book(t, 'b-k1', { starts_at_local: clock.localSlotFromNow(180).text });
    const first = await L.call('POST', `/reservations/${res.json.reference}/cancel`, { token: t });
    L.assert.equal(first.status, 200, first.text);
    L.assert.equal(first.json.status, 'cancelled');
    const second = await L.call('POST', `/reservations/${res.json.reference}/cancel`, { token: t });
    L.assert.equal(second.status, 200, second.text);
    L.assert.deepEqual(second.json, first.json);
  });

  await L.step('cancelled bookings stay in the list', async () => {
    const t = await future();
    const res = await book(t, 'b-k2', { starts_at_local: clock.localSlotFromNow(180).text });
    await L.call('POST', `/reservations/${res.json.reference}/cancel`, { token: t });
    const list = await L.call('GET', '/reservations', { token: t });
    L.assert.equal(list.json.reservations.length, 1);
    L.assert.equal(list.json.reservations[0].status, 'cancelled');
  });

  await L.step('cancel and amendment inside the cutoff are 409 cutoff_passed', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 1440 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const soon = await book(t, 'b-co1', { starts_at_local: clock.localSlotFromNow(60).text });
    L.assert.equal(soon.status, 201, soon.text);
    L.expectError(
      await L.call('POST', `/reservations/${soon.json.reference}/cancel`, { token: t }),
      409, 'cutoff_passed', 'cancel inside the cutoff',
    );
    L.expectError(
      await L.call('PATCH', `/reservations/${soon.json.reference}`, { token: t, body: { party_size: 2 } }),
      409, 'cutoff_passed', 'amend inside the cutoff',
    );
  });

  await L.step('a booking far enough ahead can be cancelled', async () => {
    const t = await future();
    const far = await book(t, 'b-co2', { starts_at_local: clock.localSlotFromNow(180).text });
    L.assert.equal(far.status, 201, far.text);
    L.assert.equal((await L.call('POST', `/reservations/${far.json.reference}/cancel`, { token: t })).status, 200);
  });

  await L.step('an amendment keeps identity, releases the old slot and takes the new one', async () => {
    const t = await future();
    const slot = clock.localSlotFromNow(300);
    const res = await book(t, 'b-p1', { starts_at_local: slot.text });
    L.assert.equal(res.status, 201, res.text);
    const before = res.json;
    const availabilityBefore = await L.call('GET', `/availability?restaurant_id=${R}&date=${slot.dateText}&party_size=4`);
    L.assert.ok(!availabilityBefore.json.slots.find((s) => s.starts_at_local === slot.text).available_table_ids.includes(T2));
    const moved = clock.localSlotFromNow(600).text;
    const patched = await L.call('PATCH', `/reservations/${before.reference}`, {
      token: t,
      body: { table_id: 't_3', starts_at_local: moved, party_size: 6 },
    });
    L.assert.equal(patched.status, 200, patched.text);
    L.assert.equal(patched.json.reference, before.reference, 'reference must not change');
    L.assert.equal(patched.json.reservation_id, before.reservation_id, 'reservation_id must not change');
    L.assert.equal(patched.json.created_at, before.created_at, 'created_at must not change');
    L.assert.equal(patched.json.table_id, 't_3');
    L.assert.equal(patched.json.party_size, 6);
    L.assert.equal(patched.json.starts_at_local, moved);
    const availabilityAfter = await L.call('GET', `/availability?restaurant_id=${R}&date=${slot.dateText}&party_size=4`);
    L.assert.ok(
      availabilityAfter.json.slots.find((s) => s.starts_at_local === slot.text).available_table_ids.includes(T2),
      'the old table must be released',
    );
    const day = moved.slice(0, 10);
    const newSlotCheck = await L.call('GET', `/availability?restaurant_id=${R}&date=${day}&party_size=6`);
    L.assert.ok(
      !newSlotCheck.json.slots.find((s) => s.starts_at_local === moved).available_table_ids.includes('t_3'),
      'the new table must be taken',
    );
  });

  await L.step('a failed amendment leaves the original booking untouched', async () => {
    const t = await future();
    const slot = clock.localSlotFromNow(300);
    const res = await book(t, 'b-p2', { starts_at_local: slot.text });
    L.assert.equal(res.status, 201, res.text);
    const before = await L.call('GET', `/reservations/${res.json.reference}`, { token: t });
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { party_size: 99 } }),
      422, 'party_exceeds_capacity', 'too many guests',
    );
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { table_id: 't_nope' } }),
      404, 'not_found', 'unknown table',
    );
    const after = await L.call('GET', `/reservations/${res.json.reference}`, { token: t });
    L.assert.deepEqual(after.json, before.json, 'a rejected amendment must change nothing');
    const availability = await L.call('GET', `/availability?restaurant_id=${R}&date=${slot.dateText}&party_size=4`);
    L.assert.ok(
      !availability.json.slots.find((s) => s.starts_at_local === slot.text).available_table_ids.includes(T2),
      'occupancy must be unchanged',
    );
  });

  await L.step('an amendment into an occupied slot is 409 table_unavailable', async () => {
    const t = await future();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'b-p3', { table_id: 't_1', party_size: 2, starts_at_local: slot });
    const b = await book(t, 'b-p4', { table_id: 't_3', party_size: 4, starts_at_local: clock.localSlotFromNow(600).text });
    L.assert.equal(a.status, 201, a.text);
    L.assert.equal(b.status, 201, b.text);
    L.expectError(
      await L.call('PATCH', `/reservations/${b.json.reference}`, { token: t, body: { table_id: 't_1', starts_at_local: slot, party_size: 2 } }),
      409, 'table_unavailable', 'move onto an occupied table',
    );
  });

  await L.step('amending a cancelled booking is 409 reservation_cancelled', async () => {
    const t = await future();
    const res = await book(t, 'b-p5', { starts_at_local: clock.localSlotFromNow(180).text });
    L.assert.equal(res.status, 201, res.text);
    await L.call('POST', `/reservations/${res.json.reference}/cancel`, { token: t });
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { party_size: 2 } }),
      409, 'reservation_cancelled', 'amend a cancelled booking',
    );
  });

  await L.step('an amendment validates exactly like a new booking', async () => {
    const t = await future();
    const slot = clock.localSlotFromNow(240);
    const res = await book(t, 'b-p6', { starts_at_local: slot.text });
    L.assert.equal(res.status, 201, res.text);
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { starts_at_local: `${slot.dateText}T00:15` } }),
      422, 'not_on_slot_grid', 'off grid',
    );
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { party_size: 0 } }),
      422, 'validation_failed', 'party_size below one',
    );
    L.expectError(
      await L.call('PATCH', `/reservations/${res.json.reference}`, { token: t, body: { table_id: 't_nope' } }),
      404, 'not_found', 'unknown table',
    );
  });

  await L.step('a booking in the past is still allowed', async () => {
    const t = await future();
    const res = await book(t, 'b-past', { starts_at_local: '2020-01-01T18:00' });
    L.assert.equal(res.status, 201, res.text);
  });

  await L.step('seeded reservations keep their identity and block their table', async () => {
    const fixture = clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 });
    fixture.reservations = [
      {
        id: 'res_seed',
        reference: 'SEED01',
        user_id: 'u_ada',
        restaurant_id: 'r_anker',
        table_id: 't_1',
        starts_at_local: clock.localSlotFromNow(300).text,
        party_size: 2,
        status: 'confirmed',
      },
    ];
    await L.reset(fixture);
    const t = await L.login('ada@example.com', 'correct horse');
    const own = await L.call('GET', '/reservations/SEED01', { token: t });
    L.assert.equal(own.status, 200, own.text);
    L.assert.equal(own.json.reservation_id, 'res_seed');
    L.assert.equal(own.json.reference, 'SEED01');
    L.expectError(
      await book(t, 'b-seed', { table_id: 't_1', party_size: 2, starts_at_local: clock.localSlotFromNow(300).text }),
      409, 'table_unavailable', 'seeded occupancy',
    );
  });

  await L.step('a seeded cancelled reservation frees its table', async () => {
    const fixture = clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 });
    fixture.reservations = [
      {
        id: 'res_seed',
        reference: 'SEED02',
        user_id: 'u_ada',
        restaurant_id: 'r_anker',
        table_id: 't_1',
        starts_at_local: clock.localSlotFromNow(300).text,
        party_size: 2,
        status: 'cancelled',
      },
    ];
    await L.reset(fixture);
    const t = await L.login('ada@example.com', 'correct horse');
    const res = await book(t, 'b-seed2', { table_id: 't_1', party_size: 2, starts_at_local: clock.localSlotFromNow(300).text });
    L.assert.equal(res.status, 201, res.text);
  });
};
