'use strict';

const L = require('./lib');
const clock = require('./clock');

const BOOK = (overrides = {}) => ({
  restaurant_id: 'r_anker',
  table_id: 't_2',
  starts_at_local: clock.localSlotFromNow(300).text,
  party_size: 4,
  ...overrides,
});

async function freshToken() {
  await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
  return L.login('ada@example.com', 'correct horse');
}

exports.run = async () => {
  await L.step('absent or empty Idempotency-Key is 400 missing_idempotency_key', async () => {
    const token = await freshToken();
    L.expectError(await L.call('POST', '/reservations', { token, body: BOOK() }), 400, 'missing_idempotency_key', 'absent');
    L.expectError(
      await L.call('POST', '/reservations', { token, key: '', body: BOOK() }),
      400, 'missing_idempotency_key', 'empty',
    );
    L.expectError(
      await L.call('POST', '/reservation-moves', { token, body: { moves: [{ reference: 'X' }] } }),
      400, 'missing_idempotency_key', 'absent on moves',
    );
  });

  await L.step('an Idempotency-Key over 255 characters is 422 validation_failed', async () => {
    const token = await freshToken();
    L.expectError(
      await L.call('POST', '/reservations', { token, key: 'z'.repeat(256), body: BOOK() }),
      422, 'validation_failed', 'long key',
    );
    const ok = await L.call('POST', '/reservations', { token, key: 'z'.repeat(255), body: BOOK() });
    L.assert.equal(ok.status, 201, '255 characters is allowed');
  });

  await L.step('first use returns 201 and a replay returns 200 with the same body', async () => {
    const token = await freshToken();
    const first = await L.call('POST', '/reservations', { token, key: 'k1', body: BOOK() });
    L.assert.equal(first.status, 201, first.text);
    const replay = await L.call('POST', '/reservations', { token, key: 'k1', body: BOOK() });
    L.assert.equal(replay.status, 200, replay.text);
    L.assert.deepEqual(replay.json, first.json);
  });

  await L.step('key order and whitespace do not make a body different', async () => {
    const token = await freshToken();
    const first = await L.call('POST', '/reservations', { token, key: 'k-order', body: BOOK() });
    L.assert.equal(first.status, 201, first.text);
    const reordered = await L.call('POST', '/reservations', {
      token,
      key: 'k-order',
      body: {
        party_size: 4,
        starts_at_local: BOOK().starts_at_local,
        table_id: 't_2',
        restaurant_id: 'r_anker',
      },
    });
    L.assert.equal(reordered.status, 200, reordered.text);
    L.assert.deepEqual(reordered.json, first.json);
  });

  await L.step('same key with a different body is 409 idempotency_key_reuse', async () => {
    const token = await freshToken();
    L.assert.equal((await L.call('POST', '/reservations', { token, key: 'k2', body: BOOK() })).status, 201);
    L.expectError(
      await L.call('POST', '/reservations', { token, key: 'k2', body: BOOK({ party_size: 2 }) }),
      409, 'idempotency_key_reuse', 'different body',
    );
  });

  await L.step('key reuse is decided before the new body is validated', async () => {
    const token = await freshToken();
    L.assert.equal((await L.call('POST', '/reservations', { token, key: 'k3', body: BOOK() })).status, 201);
    const invalid = await L.call('POST', '/reservations', {
      token,
      key: 'k3',
      body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: 'nonsense', party_size: 0 },
    });
    L.expectError(invalid, 409, 'idempotency_key_reuse', 'invalid body with a used key');
  });

  await L.step('a key whose original request failed with 4xx stays reusable', async () => {
    const token = await freshToken();
    const failed = await L.call('POST', '/reservations', {
      token,
      key: 'k-retry',
      body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: '2026-09-24T19:15', party_size: 4 },
    });
    L.expectError(failed, 422, 'not_on_slot_grid', 'off-grid attempt');
    const retried = await L.call('POST', '/reservations', { token, key: 'k-retry', body: BOOK() });
    L.assert.equal(retried.status, 201, `reused key after 4xx: ${retried.text}`);
  });

  await L.step('keys are scoped per authenticated user', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const ada = await L.login('ada@example.com', 'correct horse');
    const bob = await L.login('bob@example.com', 'hunter22hunter');
    const first = await L.call('POST', '/reservations', { token: ada, key: 'shared', body: BOOK() });
    L.assert.equal(first.status, 201, first.text);
    const second = await L.call('POST', '/reservations', { token: bob, key: 'shared', body: BOOK({ table_id: 't_3' }) });
    L.assert.equal(second.status, 201, `other user's key: ${second.text}`);
  });

  await L.step('the same key on a different path is a different request', async () => {
    const token = await freshToken();
    const book = await L.call('POST', '/reservations', { token, key: 'cross', body: BOOK() });
    L.assert.equal(book.status, 201, book.text);
    const moved = await L.call('POST', '/reservation-moves', {
      token,
      key: 'cross',
      body: { moves: [{ reference: book.json.reference, table_id: 't_3' }] },
    });
    L.assert.equal(moved.status, 201, `same key on another path: ${moved.text}`);
  });

  await L.step('a replay makes no further state change', async () => {
    const token = await freshToken();
    const first = await L.call('POST', '/reservations', { token, key: 'k-replay', body: BOOK() });
    L.assert.equal(first.status, 201, first.text);
    await L.call('POST', `/reservations/${first.json.reference}/cancel`, { token });
    const replay = await L.call('POST', '/reservations', { token, key: 'k-replay', body: BOOK() });
    L.assert.equal(replay.status, 200, replay.text);
    L.assert.deepEqual(replay.json, first.json, 'replay must return the original response');
    const current = await L.call('GET', `/reservations/${first.json.reference}`, { token });
    L.assert.equal(current.json.status, 'cancelled', 'replay must not re-book the table');
  });

  await L.step('concurrent identical requests create exactly one reservation', async () => {
    const token = await freshToken();
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => L.call('POST', '/reservations', { token, key: 'k-conc', body: BOOK() })),
    );
    const created = attempts.filter((r) => r.status === 201);
    const replays = attempts.filter((r) => r.status === 200);
    L.assert.equal(created.length, 1, `expected one 201, got ${attempts.map((r) => r.status).join(',')}`);
    L.assert.equal(replays.length, attempts.length - 1, 'the rest must be 200 replays');
    for (const replay of replays) L.assert.deepEqual(replay.json, created[0].json);
    const list = await L.call('GET', '/reservations', { token });
    L.assert.equal(list.json.reservations.length, 1, 'only one reservation may exist');
  });
};
