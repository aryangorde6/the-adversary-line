'use strict';

const L = require('./lib');
const clock = require('./clock');

exports.run = async () => {
  await L.step('fifty concurrent bookings never double-occupy one table', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const slot = clock.localSlotFromNow(600).text;
    const attempts = await Promise.all(
      Array.from({ length: 50 }, (_, i) => L.call('POST', '/reservations', {
        token: t,
        key: `c-${i}`,
        body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot, party_size: 2 },
      })),
    );
    const created = attempts.filter((r) => r.status === 201);
    const refused = attempts.filter((r) => r.status === 409);
    L.assert.equal(created.length, 1, `exactly one booking must win, statuses: ${attempts.map((r) => r.status).join(',')}`);
    L.assert.equal(refused.length, 49, 'every loser must be 409 table_unavailable');
    for (const res of refused) L.assert.equal(res.json.error.code, 'table_unavailable');
    const list = await L.call('GET', '/reservations', { token: t });
    L.assert.equal(list.json.reservations.length, 1, 'exactly one reservation may exist');
  });

  await L.step('many concurrent bookings spread over three tables and sixteen slots', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const slots = [];
    for (let n = 0; slots.length < 16 && n < 40; n += 1) {
      const slot = clock.localSlotFromNow(300 + n * 30).text;
      if (!slot.endsWith('T23:30')) slots.push(slot);
    }
    L.assert.equal(slots.length, 16, 'sixteen usable slots');
    const tables = ['t_1', 't_2', 't_3'];
    const plan = [];
    for (const slot of slots) {
      for (const table of tables) plan.push({ table, slot });
    }
    const attempts = await Promise.all(plan.map((p, i) => L.call('POST', '/reservations', {
      token: t,
      key: `d-${i}`,
      body: { restaurant_id: 'r_anker', table_id: p.table, starts_at_local: p.slot, party_size: 2 },
    })));
    const created = attempts.filter((r) => r.status === 201);
    const refused = attempts.filter((r) => r.status === 409);
    L.assert.equal(
      created.length + refused.length, plan.length,
      `unexpected statuses: ${[...new Set(attempts.map((r) => r.status))].join(',')}`,
    );
    const pairs = new Set(plan.map((p) => `${p.table}|${p.slot}`));
    L.assert.equal(pairs.size, plan.length, 'the plan must not repeat a table and slot');
    L.assert.equal(created.length, plan.length, 'every table and slot pair admits exactly one booking');
  });

  await L.step('concurrent mixed traffic never produces a 5xx', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30 }));
    const t = await L.login('ada@example.com', 'correct horse');
    const slot = clock.localSlotFromNow(900).text;
    const work = [];
    for (let i = 0; i < 50; i += 1) {
      if (i % 5 === 0) work.push(L.call('GET', '/availability?restaurant_id=r_anker&date=2026-09-24&party_size=2'));
      else if (i % 5 === 1) work.push(L.call('GET', '/reservations', { token: t }));
      else if (i % 5 === 2) work.push(L.call('POST', '/reservations', { token: t, body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot, party_size: 2 } }));
      else if (i % 5 === 3) work.push(L.call('GET', '/restaurants/r_anker'));
      else work.push(L.call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } }));
    }
    const results = await Promise.all(work);
    const bad = results.filter((r) => r.status >= 500);
    L.assert.equal(bad.length, 0, `5xx seen: ${bad.map((r) => `${r.status} ${r.text}`).join(' | ')}`);
    const noKey = results.filter((r, i) => i % 5 === 2 && r.status !== 400);
    L.assert.equal(noKey.length, 0, 'a write without an idempotency key is 400');
  });

  await L.step('interleaved resets leave a consistent service', async () => {
    await L.reset(L.FIXTURE);
    const t = await L.login('ada@example.com', 'correct horse');
    const slot = clock.localSlotFromNow(1200).text;
    const work = [];
    for (let i = 0; i < 20; i += 1) {
      work.push(L.call('POST', '/reservations', {
        token: t,
        key: `e-${i}`,
        body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: slot, party_size: 2 },
      }));
    }
    const results = await Promise.all(work);
    for (const res of results) L.assert.ok(res.status < 500, `5xx: ${res.status} ${res.text}`);
    const list = await L.call('GET', '/reservations', { token: t });
    L.assert.ok(list.json.reservations.length <= 1, 'no overlapping confirmed booking may survive');
  });
};
