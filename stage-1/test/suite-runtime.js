'use strict';

const L = require('./lib');

const A = '2026-09-24T19:00';

exports.run = async () => {
  await L.step('GET /health returns 200 ok', async () => {
    const res = await L.call('GET', '/health');
    L.assert.equal(res.status, 200);
    L.assert.deepEqual(res.json, { status: 'ok' });
  });

  await L.step('unknown endpoint is 404 not_found', async () => {
    L.expectError(await L.call('GET', '/nope'), 404, 'not_found', 'unknown path');
  });

  await L.step('unknown method on a known path is 404 not_found', async () => {
    L.expectError(await L.call('DELETE', '/restaurants'), 404, 'not_found', 'DELETE /restaurants');
  });

  await L.step('reset is unauthenticated and returns 204 with no body', async () => {
    await L.reset(L.FIXTURE);
  });

  await L.step('reset makes only the fixture state visible', async () => {
    const res = await L.call('GET', '/restaurants');
    L.assert.equal(res.status, 200);
    L.assert.deepEqual(res.json.restaurants.map((r) => r.id), ['r_anker', 'r_ny']);
    L.assert.deepEqual(res.json.restaurants[0], { id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin' });
  });

  await L.step('GET /restaurants/{id} returns the fixture shape', async () => {
    const res = await L.call('GET', '/restaurants/r_anker');
    L.assert.equal(res.status, 200);
    for (const field of ['slot_minutes', 'reservation_duration_minutes', 'cancellation_cutoff_minutes', 'opening_hours', 'tables']) {
      L.assert.ok(res.json[field] !== undefined, `missing ${field}`);
    }
    L.assert.deepEqual(res.json.tables[0], { id: 't_1', label: '1', capacity: 2 });
  });

  await L.step('unknown restaurant detail is 404', async () => {
    L.expectError(await L.call('GET', '/restaurants/r_nope'), 404, 'not_found', 'unknown restaurant');
  });

  await L.step('protected endpoints need a bearer token', async () => {
    L.expectError(await L.call('GET', '/reservations'), 401, 'unauthenticated', 'no token');
    L.expectError(await L.call('GET', '/reservations', { token: 'nope' }), 401, 'unauthenticated', 'unknown token');
    L.expectError(await L.call('GET', '/reservations', { token: '' }), 401, 'unauthenticated', 'empty token');
  });

  await L.step('malformed Authorization header is 401', async () => {
    const res = await fetch(`${L.state.base}/reservations`, { headers: { Authorization: 'Basic abc' } });
    L.assert.equal(res.status, 401);
    const body = await res.json();
    L.assert.equal(body.error.code, 'unauthenticated');
  });

  await L.step('unparseable body is 400 malformed_request', async () => {
    const res = await L.call('POST', '/auth/login', { rawBody: '{not json' });
    L.expectError(res, 400, 'malformed_request', 'broken json');
  });

  await L.step('non-object body is 400 malformed_request', async () => {
    L.expectError(await L.call('POST', '/auth/login', { rawBody: '[]' }), 400, 'malformed_request', 'array body');
    L.expectError(await L.call('POST', '/auth/login', { rawBody: '"hello"' }), 400, 'malformed_request', 'string body');
  });

  await L.step('unknown fields and query parameters are ignored', async () => {
    await L.reset(L.FIXTURE);
    const res = await L.call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse', nickname: 'x' } });
    L.assert.equal(res.status, 200);
    const list = await L.call('GET', `/restaurants?unexpected=1&page=abc`, {});
    L.assert.equal(list.status, 200);
  });

  await L.step('timestamps carry an explicit offset', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const res = await L.call('POST', '/reservations', {
      token,
      key: 'k-offset-1',
      body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: A, party_size: 4 },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.match(res.json.starts_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    L.assert.match(res.json.ends_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    L.assert.match(res.json.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    L.assert.equal(res.json.starts_at, '2026-09-24T19:00:00+02:00');
    L.assert.equal(res.json.ends_at, '2026-09-24T20:30:00+02:00');
  });

  await L.step('reference is 6..12 chars of A-Z0-9 and unique', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      const res = await L.call('POST', '/reservations', {
        token,
        key: `k-ref-${i}`,
        body: { restaurant_id: 'r_anker', table_id: ['t_1', 't_2', 't_3'][i % 3], starts_at_local: i < 3 ? '2026-09-24T18:00' : '2026-09-24T21:00', party_size: 2 },
      });
      L.assert.equal(res.status, 201, res.text);
      L.assert.match(res.json.reference, /^[A-Z0-9]{6,12}$/);
      L.assert.ok(!seen.has(res.json.reference), 'reference repeated');
      seen.add(res.json.reference);
    }
  });

  await L.step('ids supplied in a fixture may be at most 64 characters', async () => {
    const long = 'x'.repeat(65);
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].id = long;
    const res = await L.call('POST', '/_test/reset', { body: fixture });
    L.assert.equal(res.status, 422, `oversized id: status ${res.status}, body ${res.text}`);
    L.assert.equal(res.json.error.code, 'validation_failed');
  });

  await L.step('a restaurant may close at 24:00 and may use long cutoffs', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].opening_hours = [{ weekday: 'thu', opens: '22:00', closes: '24:00' }];
    fixture.restaurants[0].cancellation_cutoff_minutes = 2880;
    fixture.restaurants[0].reservation_duration_minutes = 120;
    const reset = await L.call('POST', '/_test/reset', { body: fixture });
    L.assert.equal(reset.status, 204, reset.text);
    const slots = await L.call('GET', '/availability?restaurant_id=r_anker&date=2026-09-24&party_size=2');
    L.assert.deepEqual(slots.json.slots.map((s) => s.starts_at_local), ['2026-09-24T22:00']);
    const token = await L.login('ada@example.com', 'correct horse');
    const res = await L.call('POST', '/reservations', {
      token,
      key: 'k-late',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T22:00', party_size: 2 },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.ends_at, '2026-09-25T00:00:00+02:00');
    L.expectError(
      await L.call('POST', '/reservations', {
        token,
        key: 'k-late-2',
        body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: '2026-09-24T23:00', party_size: 2 },
      }),
      422, 'outside_opening_hours', 'would end after 24:00',
    );
  });

  await L.step('a fixture that closes before it opens is rejected', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.restaurants[0].opening_hours = [{ weekday: 'thu', opens: '22:00', closes: '02:00' }];
    const res = await L.call('POST', '/_test/reset', { body: fixture });
    L.expectError(res, 422, 'validation_failed', 'overnight opening hours');
  });

  await L.step('an invalid fixture leaves the running state untouched', async () => {
    await L.reset(L.FIXTURE);
    const before = await L.call('GET', '/restaurants');
    const broken = { restaurants: [{ id: 'r_x', timezone: 'Not/AZone', slot_minutes: 30, reservation_duration_minutes: 30, cancellation_cutoff_minutes: 30, tables: [] }] };
    L.expectError(await L.call('POST', '/_test/reset', { body: broken }), 422, 'validation_failed', 'bad timezone');
    const after = await L.call('GET', '/restaurants');
    L.assert.deepEqual(after.json, before.json, 'a rejected reset must not change state');
  });

  await L.step('idempotency keys containing separators stay distinct', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const body = { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: A, party_size: 4 };
    const first = await L.call('POST', '/reservations', { token, key: 'a|b', body });
    L.assert.equal(first.status, 201, first.text);
    const other = await L.call('POST', '/reservations', { token, key: 'b', body: { ...body, table_id: 't_3', party_size: 4 } });
    L.assert.equal(other.status, 201, other.text);
    const replay = await L.call('POST', '/reservations', { token, key: 'a|b', body });
    L.assert.equal(replay.status, 200, replay.text);
    L.assert.deepEqual(replay.json, first.json);
    L.expectError(
      await L.call('POST', '/reservations', { token, key: 'b', body: { ...body, table_id: 't_1', party_size: 2 } }),
      409, 'idempotency_key_reuse', 'key b with another body',
    );
  });

  await L.step('an empty body is accepted and validated like an empty object', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    L.expectError(
      await L.call('POST', '/reservations', { token, key: 'k-empty' }),
      422, 'validation_failed', 'no fields at all',
    );
    const cancelled = await L.call('POST', '/reservations/NOPE01/cancel', { token });
    L.expectError(cancelled, 404, 'not_found', 'cancel with no body');
  });
};
