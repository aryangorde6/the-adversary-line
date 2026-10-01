'use strict';

const L = require('./lib');
const clock = require('./clock');

/** An export snapshot cannot be replayed through /_test/reset as it stands: the
 * envelope carries password_hash and a numeric created_at, and the fixture door
 * carries a plaintext password and the documented fields only. This rebuilds the
 * fixture-shaped input from a snapshot — the stored restaurants verbatim, and each
 * stored reservation projected onto the fields stage-1 section 4 names for a seeded
 * booking, so the comparison is between the two doors and not between their shapes. */
function seededFrom(snapshot) {
  const stored = snapshot.state || snapshot;
  const copy = (value) => JSON.parse(JSON.stringify(value || []));
  const seededFields = ['id', 'reference', 'user_id', 'restaurant_id', 'table_id', 'table_ids', 'party_size', 'status', 'starts_at_local'];
  return {
    users: copy(L.FIXTURE.users),
    restaurants: copy(stored.restaurants),
    reservations: copy(stored.reservations).map((r) => {
      const out = {};
      for (const field of seededFields) if (r[field] !== undefined) out[field] = r[field];
      return out;
    }),
  };
}

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

  /* A reservation's local start time must name a real calendar date and a real
   * time of day. That is a format and calendar question, not a resolvability one:
   * a local time inside a spring-forward gap is still a well formed local time,
   * so a state that legitimately stores one stays importable. */
  await L.step('an import refuses a local start time that cannot exist, and accepts a gap time', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const booked = await L.call('POST', '/reservations', {
      token,
      key: 'im-1',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 2 },
    });
    L.assert.equal(booked.status, 201, booked.text);
    const good = (await L.call('GET', '/_test/export')).json;
    const before = (await L.call('GET', '/restaurants')).json;
    const withLocal = (text) => {
      const payload = JSON.parse(JSON.stringify(good));
      payload.state.reservations[0].starts_at_local = text;
      return payload;
    };
    for (const [text, why] of [
      ['2026-02-30T19:00', 'February 30 is not a date'],
      ['2026-13-01T19:00', 'there is no month 13'],
      ['2026-12-10T25:00', 'there is no hour 25'],
      ['2026-12-10T19:60', 'there is no minute 60'],
      ['2026-12-10T19:00:00Z', 'a zoned instant is not a bare local time'],
      ['2026-12-10 19:00', 'a space is not the local separator'],
      ['not a date', 'not a time at all'],
      ['2026-12-10', 'no time of day'],
      ['2026-12-10T24:00', 'a start time of 24:00 is not a time of day'],
      ['', 'an empty string'],
    ]) {
      L.expectError(
        await L.call('POST', '/_test/import', { body: withLocal(text) }),
        422, 'validation_failed', `an import carrying ${JSON.stringify(text)}: ${why}`,
      );
    }
    const after = (await L.call('GET', '/restaurants')).json;
    L.assert.deepEqual(after, before, 'a refused import must leave the destination untouched');

    /* Berlin springs forward on 2026-03-29, so 02:30 does not exist that day. It
     * is still a well formed local time and must survive an import. */
    const gap = withLocal('2026-03-29T02:30');
    L.assert.equal((await L.call('POST', '/_test/import', { body: gap })).status, 204, 'a gap local time imports');
    const still = (await L.call('GET', '/_test/export')).json;
    L.assert.equal(still.state.reservations[0].starts_at_local, '2026-03-29T02:30', 'a gap local time survives the round trip');
  });

  /* One identical value through both doors, compared rather than asserted twice:
   * the two test endpoints must agree about the shape and calendar reality of a
   * stored local start time. This is the pair that caught reset answering 422
   * for a value import happily installed.
   *
   * The one thing they deliberately do not share is resolvability. A seeded
   * booking has to be given an instant, so a time inside a DST spring-forward
   * gap has no instant to give and seeding it is refused; an imported record
   * carries its instants in the envelope already, and section F3 says a
   * well-formed local time must import even when it falls in a gap. That
   * asymmetry is a difference in what each door is asked to do, so it is
   * asserted as its own fact below rather than folded into this comparison. */
  await L.step('reset and import agree on the shape of a stored local start time', async () => {
    for (const [text, valid] of [
      ['2026-09-24T19:00', true],
      ['2026-02-30T19:00', false],
      ['2026-13-01T19:00', false],
      ['2026-12-10T19:60', false],
      ['2026-12-10T24:00', false],
      ['2026-12-10T19:00:00Z', false],
      ['2026-12-10 19:00', false],
      ['2026-12-10T9:00', false],
      ['2026-1-10T19:00', false],
      ['not a date', false],
      ['2026-12-10T19:00 ', false],
    ]) {
      const snapshot = await L.call('GET', '/_test/export');
      L.assert.equal(snapshot.status, 200, snapshot.text);
      const viaImport = JSON.parse(JSON.stringify(snapshot.json));
      await L.reset(L.FIXTURE);
      const token = await L.login('ada@example.com', 'correct horse');
      const booked = await L.call('POST', '/reservations', {
        token,
        key: 'pair',
        body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 2 },
      });
      L.assert.equal(booked.status, 201, booked.text);
      const live = JSON.parse(JSON.stringify((await L.call('GET', '/_test/export')).json));
      viaImport.state.reservations[0].starts_at_local = text;
      live.state.reservations[0].starts_at_local = text;
      const imported = await L.call('POST', '/_test/import', { body: viaImport });
      const reseeded = await L.call('POST', '/_test/reset', { body: seededFrom(live) });

      const sameVerdict = valid
        ? imported.status === 204 && reseeded.status === 204
        : imported.status === 422 && reseeded.status === 422;
      L.assert.equal(sameVerdict, true, `${JSON.stringify(text)} answers ${imported.status} through import and ${reseeded.status} ${reseeded.text.slice(0, 140)} through reset`);
    }
  });

  /* The asymmetry the previous step deliberately leaves out, pinned so that it
   * reads as a decision about resolvability rather than as an oversight. Both
   * awkward minutes are named: the spring-forward gap, which has no instant at
   * all, and the fall-back hour, which has two. Neither is a shape problem and
   * neither may be refused as one. */
  await L.step('gap and fall-back local times import but cannot be seeded', async () => {
    for (const [local, which, seededStatus] of [
      ['2026-03-29T02:30', 'spring-forward gap', 422],
      ['2026-10-25T02:30', 'fall-back hour', 204],
    ]) {
      const live = JSON.parse(JSON.stringify((await L.call('GET', '/_test/export')).json));
      const record = { ...live.state.reservations[0], starts_at_local: local };
      const seeded = await L.call('POST', '/_test/reset', { body: seededFrom({ state: { ...live.state, reservations: [record] } }) });
      L.assert.equal(seeded.status, seededStatus, `seeding the ${which} time answers ${seeded.status}: ${seeded.text.slice(0, 160)}`);
      const imported = await L.call('POST', '/_test/import', { body: { ...live, state: { ...live.state, reservations: [record] } } });
      L.assert.equal(imported.status, 204, `importing the ${which} time is allowed: ${imported.text}`);
      const held = (await L.call('GET', '/_test/export')).json.state.reservations[0].starts_at_local;
      L.assert.equal(held, local, `the ${which} time is stored as written, not rewritten`);
      await L.call('POST', '/_test/import', { body: live });
    }
  });

  /* The booking path is where resolvability lives, so it is pinned here too:
   * the same gap minute that an import must accept is one the service refuses to
   * create, and it never appears in availability. */
  await L.step('the booking path refuses a gap minute the import path accepts', async () => {
    await L.reset(clock.alwaysOpen(L.FIXTURE, { slot_minutes: 1 }));
    const token = await L.login('ada@example.com', 'correct horse');
    const created = await L.call('POST', '/reservations', {
      token,
      key: 'gap-key',
      body: { restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: '2026-03-29T02:30', party_size: 2 },
    });
    L.expectError(created, 422, 'invalid_local_time', 'creating a booking in the spring-forward gap');
    const slots = await L.call('GET', '/availability?restaurant_id=r_anker&date=2026-03-29&party_size=2');
    L.assert.equal(slots.status, 200, slots.text);
    const listed = (slots.json.slots || []).map((s) => s.starts_at_local);
    L.assert.equal(listed.includes('2026-03-29T02:30'), false, 'the gap minute is never offered as an available start');
  });

  /* The import path must not be able to install a minute setting the fixture
   * path refuses, or the two halves of the service would disagree about the same
   * field. */
  await L.step('an import refuses minute settings the fixture refuses', async () => {
    await L.reset(L.FIXTURE);
    const good = (await L.call('GET', '/_test/export')).json;
    const before = (await L.call('GET', '/restaurants')).json;
    const withSetting = (field, value) => {
      const payload = JSON.parse(JSON.stringify(good));
      payload.state.restaurants[0][field] = value;
      return payload;
    };
    for (const [field, value, why] of [
      ['slot_minutes', 0, 'a slot step of zero'],
      ['slot_minutes', -30, 'a negative slot step'],
      ['slot_minutes', 30.5, 'a fractional slot step'],
      ['reservation_duration_minutes', 0, 'a zero length reservation'],
      ['reservation_duration_minutes', -30, 'a negative duration'],
      ['cancellation_cutoff_minutes', -1, 'a negative cutoff'],
    ]) {
      L.expectError(
        await L.call('POST', '/_test/import', { body: withSetting(field, value) }),
        422, 'validation_failed', `an import carrying ${field}=${value}: ${why}`,
      );
    }
    for (const [field, value] of [
      ['slot_minutes', 1],
      ['reservation_duration_minutes', 1],
      ['cancellation_cutoff_minutes', 0],
      ['cancellation_cutoff_minutes', 10080],
      ['cancellation_cutoff_minutes', 60 * 24 * 3650],
    ]) {
      const payload = withSetting(field, value);
      L.assert.equal(
        (await L.call('POST', '/_test/import', { body: payload })).status,
        204, `an import carrying ${field}=${value} is accepted`,
      );
    }
    L.assert.deepEqual((await L.call('GET', '/restaurants')).json, before, 'the last import succeeded');
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
