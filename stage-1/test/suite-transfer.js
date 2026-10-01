'use strict';

const L = require('./lib');
const clock = require('./clock');

exports.run = async () => {
  await L.step('export returns the documented envelope', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const res = await L.call('GET', '/_test/export');
    L.assert.equal(res.status, 200, res.text);
    L.assert.equal(res.json.track, 'tablekeeper');
    L.assert.equal(res.json.format_version, 1);
    L.assert.ok(res.json.state && typeof res.json.state === 'object', 'state must be an object');
  });

  await L.step('export is unauthenticated and needs no token', async () => {
    const res = await L.call('GET', '/_test/export');
    L.assert.equal(res.status, 200);
  });

  await L.step('an unchanged export imports back without regenerating anything', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const slot = clock.localSlotFromNow(300).text;
    const booking = await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-1',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot, party_size: 2 },
    });
    L.assert.equal(booking.status, 201, booking.text);
    const failed = await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-2',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: `${slot.dateText}T00:07`, party_size: 2 },
    });
    L.assert.equal(failed.status, 422, failed.text);

    const snapshot = (await L.call('GET', '/_test/export')).json;
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));

    const imported = await L.call('POST', '/_test/import', { body: snapshot });
    L.assert.equal(imported.status, 204, imported.text);
    L.assert.equal(imported.text, '', 'import returns no body');

    const restored = await L.call('GET', `/reservations/${booking.json.reference}`, { token: t });
    L.assert.equal(restored.status, 200, `hashed-password login must survive import: ${restored.text}`);
    L.assert.deepEqual(restored.json, booking.json, 'identities and timestamps must not be regenerated');

    const replay = await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-1',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot, party_size: 2 },
    });
    L.assert.equal(replay.status, 200, `receipts must survive import: ${replay.text}`);
    L.assert.deepEqual(replay.json, booking.json);

    const retry = await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-2',
      body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: slot, party_size: 2 },
    });
    L.assert.equal(retry.status, 201, `failed keys stay reusable after import: ${retry.text}`);
  });

  await L.step('import replaces the destination and does not merge', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const snapshot = (await L.call('GET', '/_test/export')).json;
    await L.reset(L.FIXTURE);
    const t = await L.login('ada@example.com', 'correct horse');
    await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-3',
      body: { restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: '2026-09-24T19:00', party_size: 2 },
    });
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    const afterImport = await L.login('ada@example.com', 'correct horse');
    const list = await L.call('GET', '/reservations', { token: afterImport });
    L.assert.deepEqual(list.json, { reservations: [] }, 'previous destination data must be gone');
    const restaurants = await L.call('GET', '/restaurants');
    L.assert.deepEqual(restaurants.json.restaurants.map((r) => r.id), ['r_anker', 'r_ny']);
  });

  await L.step('repeating an import restores the same state without duplicating it', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    await L.call('POST', '/reservations', {
      token: t,
      key: 'x-key-4',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: clock.localSlotFromNow(300).text, party_size: 2 },
    });
    const snapshot = (await L.call('GET', '/_test/export')).json;
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    const list = await L.call('GET', '/reservations', { token: t });
    L.assert.equal(list.json.reservations.length, 1, 'import must not duplicate bookings');
    const again = (await L.call('GET', '/_test/export')).json;
    L.assert.deepEqual(again.state, snapshot.state, 'a second round trip is stable');
  });

  await L.step('batch receipts survive export and import', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const slotA = clock.localSlotFromNow(300).text;
    const slotB = clock.localSlotFromNow(360).text;
    const a = await L.call('POST', '/reservations', {
      token: t, key: 'x-key-5',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slotA, party_size: 2 },
    });
    const b = await L.call('POST', '/reservations', {
      token: t, key: 'x-key-6',
      body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: slotB, party_size: 2 },
    });
    const batch = await L.call('POST', '/reservation-moves', {
      token: t,
      key: 'x-batch-1',
      body: { moves: [{ reference: a.json.reference, table_id: 't_3' }, { reference: b.json.reference, table_id: 't_3', starts_at_local: clock.localSlotFromNow(720).text }] },
    });
    L.assert.equal(batch.status, 201, batch.text);
    const snapshot = (await L.call('GET', '/_test/export')).json;
    await L.reset(L.FIXTURE);
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    const replay = await L.call('POST', '/reservation-moves', {
      token: t,
      key: 'x-batch-1',
      body: { moves: [{ reference: a.json.reference, table_id: 't_3' }, { reference: b.json.reference, table_id: 't_3', starts_at_local: clock.localSlotFromNow(720).text }] },
    });
    L.assert.equal(replay.status, 200, replay.text);
    L.assert.deepEqual(replay.json, batch.json);
  });

  await L.step('counters are preserved so ids are never reused', async () => {
    await L.reset(L.FIXTURE);
    const first = await L.call('POST', '/auth/signup', { body: { email: 'one@example.com', password: 'longenough1' } });
    L.assert.equal(first.status, 201, first.text);
    const booking = await L.call('POST', '/reservations', {
      token: (await L.login('ada@example.com', 'correct horse')),
      key: 'x-key-7',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 2 },
    });
    L.assert.equal(booking.status, 201, booking.text);
    const snapshot = (await L.call('GET', '/_test/export')).json;
    await L.reset(L.FIXTURE);
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    const second = await L.call('POST', '/auth/signup', { body: { email: 'two@example.com', password: 'longenough1' } });
    L.assert.equal(second.status, 201, second.text);
    L.assert.notEqual(second.json.user_id, first.json.user_id, 'a fresh id counter would collide');
  });

  await L.step('a bad import is rejected without changing the destination', async () => {
    await L.reset(L.FIXTURE);
    const snapshot = (await L.call('GET', '/_test/export')).json;
    const before = (await L.call('GET', '/restaurants')).json;
    const bad = [
      {},
      { track: 'other', format_version: 1, state: snapshot.state },
      { track: 'tablekeeper', format_version: 2, state: snapshot.state },
      { track: 'tablekeeper', format_version: 1 },
      { track: 'tablekeeper', format_version: 1, state: 'nope' },
      { track: 'tablekeeper', format_version: 1, state: { ...snapshot.state, reservations: 'nope' } },
      { track: 'tablekeeper', format_version: 1, state: { ...snapshot.state, users: [{ id: 'u_x' }] } },
      { track: 'tablekeeper', format_version: 1, state: { ...snapshot.state, counters: { user: -1, reservation: 0 } } },
    ];
    for (const payload of bad) {
      L.expectError(
        await L.call('POST', '/_test/import', { body: payload }),
        422, 'validation_failed', `import ${JSON.stringify(payload).slice(0, 60)}`,
      );
    }
    L.expectError(
      await L.call('POST', '/_test/import', { rawBody: '{oops' }),
      400, 'malformed_request', 'invalid json',
    );
    const after = (await L.call('GET', '/restaurants')).json;
    L.assert.deepEqual(after, before, 'a rejected import must change nothing');
  });

  await L.step('reset still clears imported state', async () => {
    await L.reset(L.FIXTURE);
    const snapshot = (await L.call('GET', '/_test/export')).json;
    L.assert.equal((await L.call('POST', '/_test/import', { body: snapshot })).status, 204);
    await L.reset({});
    const list = await L.call('GET', '/restaurants');
    L.assert.deepEqual(list.json, { restaurants: [] });
    const t = await L.call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
    L.expectError(t, 401, 'unauthenticated', 'reset clears credentials');
  });
};
