'use strict';

const L = require('./lib');
const clock = require('./clock');

const A = '/availability';

exports.run = async () => {
  await L.step('availability needs all three query parameters', async () => {
    await L.reset(L.FIXTURE);
    for (const query of [
      'restaurant_id=r_anker&date=2026-09-24',
      'restaurant_id=r_anker&party_size=2',
      'date=2026-09-24&party_size=2',
      '',
    ]) {
      L.expectError(await L.call('GET', `${A}?${query}`), 422, 'validation_failed', `query "${query}"`);
    }
  });

  await L.step('integer query parameters must be plain decimal digits', async () => {
    for (const value of ['1e9', '4.0', '+4', '-2', 'two', '']) {
      const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=${encodeURIComponent(value)}`);
      L.expectError(res, 422, 'validation_failed', `party_size=${value}`);
    }
    const zero = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=0`);
    L.expectError(zero, 422, 'validation_failed', 'party_size=0');
  });

  await L.step('an invalid date or unknown restaurant is rejected', async () => {
    L.expectError(
      await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-02-30&party_size=2`),
      422, 'validation_failed', 'impossible date',
    );
    L.expectError(
      await L.call('GET', `${A}?restaurant_id=r_anker&date=24-09-2026&party_size=2`),
      422, 'validation_failed', 'wrong date format',
    );
    L.expectError(
      await L.call('GET', `${A}?restaurant_id=r_nope&date=2026-09-24&party_size=2`),
      404, 'not_found', 'unknown restaurant',
    );
  });

  await L.step('slots step by slot_minutes while the duration still fits before closing', async () => {
    const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=2`);
    L.assert.equal(res.status, 200, res.text);
    L.assert.equal(res.json.restaurant_id, 'r_anker');
    L.assert.equal(res.json.date, '2026-09-24');
    L.assert.equal(res.json.timezone, 'Europe/Berlin');
    const starts = res.json.slots.map((s) => s.starts_at_local);
    L.assert.deepEqual(starts, [
      '2026-09-24T18:00', '2026-09-24T18:30', '2026-09-24T19:00', '2026-09-24T19:30',
      '2026-09-24T20:00', '2026-09-24T20:30', '2026-09-24T21:00', '2026-09-24T21:30',
    ]);
    const first = res.json.slots[0];
    L.assert.equal(first.starts_at, '2026-09-24T18:00:00+02:00');
    L.assert.deepEqual(first.available_table_ids, ['t_1', 't_2', 't_3']);
  });

  await L.step('available_table_ids honours capacity and fixture order', async () => {
    const two = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=2`);
    L.assert.deepEqual(two.json.slots[0].available_table_ids, ['t_1', 't_2', 't_3']);
    const four = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=4`);
    L.assert.deepEqual(four.json.slots[0].available_table_ids, ['t_2', 't_3']);
    const six = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=6`);
    L.assert.deepEqual(six.json.slots[0].available_table_ids, ['t_3']);
    const huge = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=7`);
    L.assert.deepEqual(huge.json.slots[0].available_table_ids, []);
    L.assert.equal(huge.json.slots.length, 8, 'a slot with no table still appears');
  });

  await L.step('a closed weekday returns no slots', async () => {
    const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-21&party_size=2`);
    L.assert.equal(res.status, 200, res.text);
    L.assert.deepEqual(res.json.slots, []);
  });

  await L.step('availability reflects confirmed occupancy with half-open intervals', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const booking = await L.call('POST', '/reservations', {
      token,
      key: 'av-1',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 2 },
    });
    L.assert.equal(booking.status, 201, booking.text);
    const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-09-24&party_size=2`);
    const byStart = new Map(res.json.slots.map((s) => [s.starts_at_local, s.available_table_ids]));
    L.assert.deepEqual(byStart.get('2026-09-24T18:00'), ['t_2', 't_3'], '18:00 overlaps 19:00');
    L.assert.deepEqual(byStart.get('2026-09-24T18:30'), ['t_2', 't_3'], '18:30 overlaps 19:00');
    L.assert.deepEqual(byStart.get('2026-09-24T19:00'), ['t_2', 't_3']);
    L.assert.deepEqual(byStart.get('2026-09-24T20:00'), ['t_2', 't_3']);
    L.assert.deepEqual(byStart.get('2026-09-24T20:30'), ['t_1', 't_2', 't_3'], '20:30 starts exactly when the booking ends');
  });

  await L.step('a cancelled booking frees its slot at once', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const token = await L.login('ada@example.com', 'correct horse');
    const slot = clock.localSlotFromNow(300);
    const booking = await L.call('POST', '/reservations', {
      token,
      key: 'av-cancel',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot.text, party_size: 2 },
    });
    L.assert.equal(booking.status, 201, booking.text);
    const before = await L.call('GET', `${A}?restaurant_id=r_anker&date=${slot.dateText}&party_size=2`);
    L.assert.ok(!before.json.slots.find((s) => s.starts_at_local === slot.text).available_table_ids.includes('t_1'));
    const cancelled = await L.call('POST', `/reservations/${booking.json.reference}/cancel`, { token });
    L.assert.equal(cancelled.status, 200, cancelled.text);
    const after = await L.call('GET', `${A}?restaurant_id=r_anker&date=${slot.dateText}&party_size=2`);
    L.assert.ok(after.json.slots.find((s) => s.starts_at_local === slot.text).available_table_ids.includes('t_1'), 'the cancelled table must be offered again');
  });

  await L.step('spring-forward times never appear and cannot be booked', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].opening_hours = [{ weekday: 'sun', opens: '00:00', closes: '23:59' }];
    await L.reset(fixture);
    const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-03-29&party_size=2`);
    L.assert.equal(res.status, 200, res.text);
    const starts = res.json.slots.map((s) => s.starts_at_local);
    L.assert.ok(!starts.some((s) => s >= '2026-03-29T02:00' && s < '2026-03-29T03:00'), `gap slot offered: ${starts.join(',')}`);
    L.assert.ok(starts.includes('2026-03-29T01:30'));
    L.assert.ok(starts.includes('2026-03-29T03:00'));
    const token = await L.login('ada@example.com', 'correct horse');
    L.expectError(
      await L.call('POST', '/reservations', {
        token,
        key: 'dst-gap',
        body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-03-29T02:30', party_size: 2 },
      }),
      422, 'invalid_local_time', 'booking inside the gap',
    );
  });

  await L.step('fall-back times appear once, at the first occurrence', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].opening_hours = [{ weekday: 'sun', opens: '00:00', closes: '23:59' }];
    fixture.restaurants[0].slot_minutes = 30;
    fixture.restaurants[0].reservation_duration_minutes = 30;
    await L.reset(fixture);
    const res = await L.call('GET', `${A}?restaurant_id=r_anker&date=2026-10-25&party_size=2`);
    L.assert.equal(res.status, 200, res.text);
    const twice = res.json.slots.filter((s) => s.starts_at_local === '2026-10-25T02:00');
    L.assert.equal(twice.length, 1, 'the repeated hour appears once');
    L.assert.equal(twice[0].starts_at, '2026-10-25T02:00:00+02:00', 'the first occurrence is before the clocks change');
  });

  await L.step('reservation duration is absolute time across a fall-back', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].opening_hours = [{ weekday: 'sun', opens: '00:00', closes: '23:59' }];
    fixture.restaurants[0].slot_minutes = 30;
    fixture.restaurants[0].reservation_duration_minutes = 90;
    await L.reset(fixture);
    const token = await L.login('ada@example.com', 'correct horse');
    const res = await L.call('POST', '/reservations', {
      token,
      key: 'dst-dur',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-10-25T01:30', party_size: 2 },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.starts_at, '2026-10-25T01:30:00+02:00');
    L.assert.equal(res.json.ends_at, '2026-10-25T02:00:00+01:00', '90 real minutes after 01:30 CEST is 02:00 CET');
  });

  await L.step('New York transitions follow the IANA rules', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[1].opening_hours = [
      { weekday: 'sun', opens: '00:00', closes: '23:59' },
      { weekday: 'sat', opens: '10:00', closes: '22:00' },
    ];
    await L.reset(fixture);
    const spring = await L.call('GET', `${A}?restaurant_id=r_ny&date=2026-03-08&party_size=2`);
    L.assert.ok(!spring.json.slots.some((s) => s.starts_at_local === '2026-03-08T02:00'), 'New York gap slot offered');
    const fall = await L.call('GET', `${A}?restaurant_id=r_ny&date=2026-11-01&party_size=2`);
    const repeat = fall.json.slots.filter((s) => s.starts_at_local === '2026-11-01T01:00');
    L.assert.equal(repeat.length, 1);
    L.assert.equal(repeat[0].starts_at, '2026-11-01T01:00:00-04:00', 'first occurrence is still daylight saving time');
  });
};
