'use strict';

const L = require('./lib');
const clock = require('./clock');

async function setup() {
  await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
  return L.login('ada@example.com', 'correct horse');
}

async function book(t, key, startsAtLocal, tableId = 't_1', partySize = 2) {
  return L.call('POST', '/reservations', {
    token: t,
    key,
    body: { restaurant_id: 'r_anker', table_id: tableId, starts_at_local: startsAtLocal, party_size: partySize },
  });
}

exports.run = async () => {
  await L.step('reservation-moves needs a token', async () => {
    const t = await setup();
    const res = await book(t, 'm-1', clock.localSlotFromNow(300).text);
    L.assert.equal(res.status, 201, res.text);
    L.expectError(
      await L.call('POST', '/reservation-moves', { key: 'm-1', body: { moves: [{ reference: res.json.reference, table_id: 't_2' }] } }),
      401, 'unauthenticated', 'no token',
    );
  });

  await L.step('the moves array must hold 1..8 distinct references', async () => {
    const t = await setup();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-2', slot);
    const b = await book(t, 'm-3', slot, 't_2');
    const cases = [
      undefined,
      [],
      [{ reference: a.json.reference }, { reference: a.json.reference }],
      new Array(9).fill(0).map(() => ({ reference: a.json.reference })),
      [{}],
      ['nope'],
    ];
    for (const moves of cases) {
      L.expectError(
        await L.call('POST', '/reservation-moves', { token: t, key: 'm-bad', body: { moves } }),
        422, 'validation_failed', `moves ${JSON.stringify(moves)}`,
      );
    }
    L.assert.ok(b.status === 201, b.text);
  });

  await L.step('a batch moves every booking and keeps input order', async () => {
    const t = await setup();
    const slotA = clock.localSlotFromNow(300).text;
    const slotB = clock.localSlotFromNow(360).text;
    const a = await book(t, 'm-4', slotA, 't_1', 2);
    const b = await book(t, 'm-5', slotB, 't_2', 4);
    const moves = [
      { reference: b.json.reference, table_id: 't_3' },
      { reference: a.json.reference, table_id: 't_2', party_size: 4 },
    ];
    const res = await L.call('POST', '/reservation-moves', { token: t, key: 'm-6', body: { moves } });
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.reservations.length, 2);
    L.assert.equal(res.json.reservations[0].reference, b.json.reference, 'input order must be kept');
    L.assert.equal(res.json.reservations[0].table_id, 't_3');
    L.assert.equal(res.json.reservations[1].reference, a.json.reference);
    L.assert.equal(res.json.reservations[1].table_id, 't_2');
    L.assert.equal(res.json.reservations[1].party_size, 4);
    L.assert.equal(res.json.reservations[1].starts_at_local, slotA, 'omitted fields are retained');
    L.assert.equal(res.json.reservations[0].reservation_id, b.json.reservation_id, 'identity never changes');
    L.assert.equal(res.json.reservations[0].created_at, b.json.created_at, 'creation time never changes');
  });

  await L.step('a no-op move retains every value', async () => {
    const t = await setup();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-7', slot, 't_1', 2);
    const res = await L.call('POST', '/reservation-moves', {
      token: t,
      key: 'm-8',
      body: { moves: [{ reference: a.json.reference }] },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.deepEqual(res.json.reservations[0], a.json);
  });

  await L.step('an unknown or foreign reference is 404 and nothing changes', async () => {
    const t = await setup();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-9', slot, 't_1', 2);
    const bob = await L.login('bob@example.com', 'hunter22hunter');
    const before = await L.call('GET', `/reservations/${a.json.reference}`, { token: t });
    L.expectError(
      await L.call('POST', '/reservation-moves', { token: t, key: 'm-10', body: { moves: [{ reference: 'NOPE00' }] } }),
      404, 'not_found', 'unknown reference',
    );
    L.expectError(
      await L.call('POST', '/reservation-moves', { token: bob, key: 'm-11', body: { moves: [{ reference: a.json.reference, table_id: 't_2' }] } }),
      404, 'not_found', 'another owner',
    );
    const after = await L.call('GET', `/reservations/${a.json.reference}`, { token: t });
    L.assert.deepEqual(after.json, before.json);
  });

  await L.step('bookings at different restaurants are 422 validation_failed', async () => {
    const slot = clock.localSlotFromNow(300).text;
    const fixture = clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 });
    fixture.restaurants[1].opening_hours = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
      .map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' }));
    fixture.reservations = [
      {
        id: 'res_a',
        reference: 'SAMER1',
        user_id: 'u_ada',
        restaurant_id: 'r_anker',
        table_id: 't_1',
        starts_at_local: slot,
        party_size: 2,
      },
      {
        id: 'res_x',
        reference: 'OTHER1',
        user_id: 'u_ada',
        restaurant_id: 'r_ny',
        table_id: 'n_1',
        starts_at_local: slot,
        party_size: 2,
      },
    ];
    await L.reset(fixture);
    const t = await L.login('ada@example.com', 'correct horse');
    L.expectError(
      await L.call('POST', '/reservation-moves', {
        token: t,
        key: 'm-13',
        body: { moves: [{ reference: 'SAMER1', table_id: 't_2' }, { reference: 'OTHER1', table_id: 'n_1' }] },
      }),
      422, 'validation_failed', 'two restaurants',
    );
  });

  await L.step('a cancelled booking in a batch is 409 reservation_cancelled', async () => {
    const t = await setup();
    const slotA = clock.localSlotFromNow(300).text;
    const slotB = clock.localSlotFromNow(360).text;
    const a = await book(t, 'm-14', slotA, 't_1', 2);
    const b = await book(t, 'm-15', slotB, 't_2', 2);
    await L.call('POST', `/reservations/${b.json.reference}/cancel`, { token: t });
    L.expectError(
      await L.call('POST', '/reservation-moves', {
        token: t,
        key: 'm-16',
        body: { moves: [{ reference: a.json.reference, table_id: 't_2' }, { reference: b.json.reference, table_id: 't_3' }] },
      }),
      409, 'reservation_cancelled', 'cancelled item',
    );
    const after = await L.call('GET', `/reservations/${a.json.reference}`, { token: t });
    L.assert.equal(after.json.table_id, 't_1', 'the other booking must be untouched');
  });

  await L.step('an overlap inside the batch is 409 and the batch changes nothing', async () => {
    const t = await setup();
    const slotA = clock.localSlotFromNow(300).text;
    const slotB = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-17', slotA, 't_1', 2);
    const b = await book(t, 'm-18', slotB, 't_2', 2);
    L.expectError(
      await L.call('POST', '/reservation-moves', {
        token: t,
        key: 'm-19',
        body: { moves: [{ reference: a.json.reference, table_id: 't_3' }, { reference: b.json.reference, table_id: 't_3' }] },
      }),
      409, 'table_unavailable', 'the batch would overlap itself',
    );
    const first = await L.call('GET', `/reservations/${a.json.reference}`, { token: t });
    const second = await L.call('GET', `/reservations/${b.json.reference}`, { token: t });
    L.assert.equal(first.json.table_id, 't_1', 'atomic: the first booking is unchanged');
    L.assert.equal(second.json.table_id, 't_2');
  });

  await L.step('an overlap with an unlisted booking is 409 table_unavailable', async () => {
    const t = await setup();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-20', slot, 't_1', 2);
    await book(t, 'm-21', slot, 't_2', 2);
    L.expectError(
      await L.call('POST', '/reservation-moves', {
        token: t,
        key: 'm-22',
        body: { moves: [{ reference: a.json.reference, table_id: 't_2' }] },
      }),
      409, 'table_unavailable', 'unlisted booking holds the table',
    );
  });

  await L.step('a replayed batch returns the original response with 200', async () => {
    const t = await setup();
    const slotA = clock.localSlotFromNow(300).text;
    const slotB = clock.localSlotFromNow(360).text;
    const a = await book(t, 'm-23', slotA, 't_1', 2);
    const b = await book(t, 'm-24', slotB, 't_2', 2);
    const body = { moves: [{ reference: a.json.reference, table_id: 't_3' }, { reference: b.json.reference }] };
    const first = await L.call('POST', '/reservation-moves', { token: t, key: 'm-25', body });
    L.assert.equal(first.status, 201, first.text);
    const replay = await L.call('POST', '/reservation-moves', { token: t, key: 'm-25', body });
    L.assert.equal(replay.status, 200, replay.text);
    L.assert.deepEqual(replay.json, first.json);
    await L.call('POST', `/reservations/${a.json.reference}/cancel`, { token: t });
    const replay2 = await L.call('POST', '/reservation-moves', { token: t, key: 'm-25', body });
    L.assert.equal(replay2.status, 200, 'a replay still works after a cancellation');
    L.assert.deepEqual(replay2.json, first.json);
  });

  await L.step('the cutoff is measured per booking, before the other changes', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 1440 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const soon = clock.localSlotFromNow(60).text;
    const later = clock.localSlotFromNow(6000).text;
    const a = await book(t, 'm-26', soon, 't_1', 2);
    const b = await book(t, 'm-27', later, 't_2', 2);
    L.assert.equal(a.status, 201, a.text);
    L.expectError(
      await L.call('POST', '/reservation-moves', {
        token: t,
        key: 'm-28',
        body: { moves: [{ reference: b.json.reference, table_id: 't_3' }, { reference: a.json.reference, table_id: 't_3' }] },
      }),
      409, 'cutoff_passed', 'the near booking is inside its cutoff',
    );
    const unchanged = await L.call('GET', `/reservations/${b.json.reference}`, { token: t });
    L.assert.equal(unchanged.json.table_id, 't_2', 'no part of the batch may commit');
  });

  await L.step('unknown fields inside a move item are ignored', async () => {
    const t = await setup();
    const slot = clock.localSlotFromNow(300).text;
    const a = await book(t, 'm-29', slot, 't_1', 2);
    const res = await L.call('POST', '/reservation-moves', {
      token: t,
      key: 'm-30',
      body: { moves: [{ reference: a.json.reference, table_id: 't_2', colour: 'red' }], note: 'hi' },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.reservations[0].table_id, 't_2');
  });
};
