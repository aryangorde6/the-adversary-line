'use strict';

/* Stage 2: a booking may occupy a declared pair of tables as one unit.
 *
 * Slots are taken from the clock rather than written as literal dates, because a
 * literal date silently falls behind the cutoff as soon as the calendar moves
 * past it. The restaurant is opened around the clock with a 90 minute booking,
 * so two slots 90 minutes apart abut exactly and a slot repeated overlaps.
 *
 * The fixtures here declare combinable deliberately in an order that is not
 * fixture table order, because the specification pins the response to
 * combinable order and a suite that declared it in table order could not tell
 * the two rules apart. */

const L = require('./lib');
const clock = require('./clock');


/* t_1 seats 2, t_2 seats 4, t_3 seats 6, so the pair t_1+t_2 seats 6 and the
 * pair t_2+t_3 seats 10. Party sizes below are chosen to sit exactly on, and
 * just past, each sum. */
function paired(combinable) {
  const fixture = clock.alwaysOpen(L.FIXTURE, {
    cancellation_cutoff_minutes: 30,
    reservation_duration_minutes: 90,
  });
  fixture.restaurants.find((r) => r.id === 'r_anker').combinable = combinable;
  return fixture;
}

/* Two tables and three tables, declared as t_3+t_1 and t_1+t_2 so that the
 * written order differs from both fixture table order and sorted order. */
const COMBINABLE = [['t_3', 't_1'], ['t_1', 't_2']];

/* Bookings are 90 minutes, so a slot repeated overlaps and a slot 90 minutes
 * later does not. */
const NEAR = () => clock.localSlotFromNow(300);
const ABUTTING = () => clock.localSlotFromNow(390);
const DISTANT = () => clock.localSlotFromNow(480);

async function setup(combinable = COMBINABLE) {
  await L.reset(paired(combinable));
  return L.login('ada@example.com', 'correct horse');
}

async function book(token, body, key) {
  return L.call('POST', '/reservations', { token, key, body });
}

async function slotOf(date, restaurantId, partySize) {
  const res = await L.call('GET', `/availability?restaurant_id=${restaurantId}&date=${date}&party_size=${partySize}`);
  L.assert.equal(res.status, 200, `availability ${date}: ${res.text}`);
  return res.json.slots;
}

exports.run = async () => {
  /* ------------------------------------------------------------------ *
   * The declared list on the fixture.
   * ------------------------------------------------------------------ */

  await L.step('an absent combinable list means no declared pairs', async () => {
    const token = await setup([]);
    const res = await book(token, {
      restaurant_id: 'r_anker',
      table_ids: ['t_1', 't_2'],
      starts_at_local: NEAR().text,
      party_size: 4,
    }, 'absent');
    /* Absence is a valid fixture, and the restaurant has declared nothing, so
     * the pair is not bookable. This is the reading that lets a stage-2 service
     * accept a stage-1 export, where every restaurant omits the field. */
    L.expectError(res, 422, 'combination_not_allowed', 'a pair at a restaurant that declared none');
    const slots = await slotOf(NEAR().dateText, 'r_anker', 4);
    L.assert.equal(slots[0].available_options.every((o) => o.table_ids.length === 1), true,
      'no pair appears in available_options when none is declared');
  });

  await L.step('combinable keeps its written order', async () => {
    await setup();
    const restaurant = (await L.call('GET', '/restaurants/r_anker')).json;
    /* The detail endpoint must not expose the list, which is a recorded
     * decision rather than a gap: the UI reads available_options instead, and
     * the stage-1 detail shape is a fixture shape nobody asked to change. */
    L.assert.equal('combinable' in restaurant, false,
      'restaurantDetail does not expose combinable');
    L.assert.equal(JSON.stringify(restaurant).includes('combinable'), false,
      'and does not expose it under any spelling');
  });

  for (const [label, combinable] of [
    ['a pair naming a table the restaurant does not have', [['t_1', 't_9']]],
    ['a self-pair', [['t_1', 't_1']]],
    ['a triple', [['t_1', 't_2', 't_3']]],
    ['a pair repeated', [['t_1', 't_2'], ['t_1', 't_2']]],
    ['a pair repeated in the other order', [['t_1', 't_2'], ['t_2', 't_1']]],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await L.step(`combinable refuses ${label}`, async () => {
      const res = await L.call('POST', '/_test/reset', { body: paired(combinable) });
      /* Refused, never dropped. A quietly dropped pair would leave the tables
       * unbookable together anyway, so dropping it would hide the mistake
       * rather than change what can be booked. */
      L.expectError(res, 422, 'validation_failed', label);
    });
  }

  await L.step('a restaurant with no combinable field is still a valid fixture', async () => {
    const res = await L.call('POST', '/_test/reset', { body: L.FIXTURE });
    L.assert.equal(res.status, 204, `absent combinable is accepted: ${res.text}`);
  });

  /* ------------------------------------------------------------------ *
   * available_options.
   * ------------------------------------------------------------------ */

  await L.step('available_options orders singles then pairs, and never widens available_table_ids', async () => {
    await setup();
    const slots = await slotOf(NEAR().dateText, 'r_anker', 2);
    const first = slots.find((s) => s.starts_at_local === NEAR().text);
    L.assert.ok(first, 'the 19:00 slot is listed');

    /* Singles in fixture order. */
    const singles = first.available_options.filter((o) => o.table_ids.length === 1).map((o) => o.table_ids[0]);
    L.assert.deepEqual(singles, ['t_1', 't_2', 't_3'],
      'single options come first, in fixture table order');

    /* Then pairs in combinable order, not table order. combinable is
     * [t_3,t_1] then [t_1,t_2], so a suite that read table order would see
     * [t_1,t_2] first and fail. */
    const pairs = first.available_options.filter((o) => o.table_ids.length === 2).map((o) => o.table_ids);
    L.assert.deepEqual(pairs, [['t_3', 't_1'], ['t_1', 't_2']],
      'pair options follow in combinable order');

    /* And the ids inside a pair are in combinable order too, not sorted. */
    L.assert.deepEqual(pairs[0], ['t_3', 't_1'],
      'table_ids within a pair keep combinable order rather than being sorted');

    /* available_table_ids stays singles-only, so a stage-1 client that looks a
     * table up in it never receives something it did not ask for. */
    L.assert.deepEqual(first.available_table_ids, ['t_1', 't_2', 't_3'],
      'available_table_ids lists single table ids in fixture order');
    L.assert.equal(first.available_table_ids.every((id) => typeof id === 'string'), true,
      'available_table_ids holds no pair and no nested list');
    L.assert.equal(first.available_options.some((o) => Array.isArray(o.table_ids) === false), false,
      'every available_options entry carries a table_ids array');
  });

  await L.step('a pair is offered when the party fits the sum of its capacities', async () => {
    await setup();
    /* t_3+t_1 seats 8. */
    const fits = (await slotOf(NEAR().dateText, 'r_anker', 8))[0];
    const pairs = fits.available_options.filter((o) => o.table_ids.length === 2).map((o) => o.table_ids);
    L.assert.deepEqual(pairs, [['t_3', 't_1']],
      'the 8-seat pair is offered to a party of 8, and the 6-seat pair is not');
    /* The 6-seat pair cannot take 8, and no single table can either, so the
     * singles list is empty for this party rather than quietly offering t_3. */
    L.assert.equal(fits.available_table_ids.includes('t_3'), false,
      't_3 alone seats 6 and so is not offered to a party of 8');
    L.assert.deepEqual(fits.available_table_ids, [],
      'and no single table seats 8, so available_table_ids is empty');
  });

  await L.step('a pair disappears from available_options when one of its tables is taken', async () => {
    const token = await setup();
    const res = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: NEAR().text, party_size: 6,
    }, 'take-t3');
    L.assert.equal(res.status, 201, res.text);

    const slots = await slotOf(NEAR().dateText, 'r_anker', 2);
    const first = slots.find((s) => s.starts_at_local === NEAR().text);
    const pairs = first.available_options.filter((o) => o.table_ids.length === 2).map((o) => o.table_ids);
    L.assert.deepEqual(pairs, [['t_1', 't_2']],
      'only the pair whose tables are all free remains');
    L.assert.equal(first.available_table_ids.includes('t_3'), false,
      'and the taken table is gone from available_table_ids');
  });

  /* ------------------------------------------------------------------ *
   * Capacity adds up across the set.
   * ------------------------------------------------------------------ */

  await L.step('capacity is the sum over the set, not any one table', async () => {
    const token = await setup();
    /* t_1 seats 2 and t_2 seats 4, and neither alone would take 6. */
    const fits = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 6,
    }, 'sum-fits');
    L.assert.equal(fits.status, 201, `six seats across two tables: ${fits.text}`);

    /* The same set cannot take 7. */
    const tooBig = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: ABUTTING().text, party_size: 7,
    }, 'sum-too-big');
    L.expectError(tooBig, 422, 'party_exceeds_capacity', 'seven seats across a six-seat set');
  });

  await L.step('a single table keeps the stage-1 seats message', async () => {
    const token = await setup([]);
    const res = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 3,
    }, 'single-seats');
    L.expectError(res, 422, 'party_exceeds_capacity', 'three at a two-seat table');
    L.assert.match(res.json.error.message, /Table 1 at Zum Anker seats 2, and you asked for 3\./,
      'the single-table wording is unchanged from stage 1');
  });

  /* ------------------------------------------------------------------ *
   * The request and response contract.
   * ------------------------------------------------------------------ */

  await L.step('table_ids and table_id are both accepted on create', async () => {
    const token = await setup();
    const plural = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'plural');
    L.assert.equal(plural.status, 201, plural.text);
    const singular = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_3', starts_at_local: NEAR().text, party_size: 4,
    }, 'singular');
    L.assert.equal(singular.status, 201, singular.text);
  });

  await L.step('a response carries table_ids always and table_id only for one table', async () => {
    const token = await setup();
    const pair = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'shape-pair');
    L.assert.equal(pair.status, 201, pair.text);
    L.assert.deepEqual(pair.json.table_ids, ['t_1', 't_2'], 'a combined booking carries table_ids');
    L.assert.equal('table_id' in pair.json, false,
      'and carries no table_id, so no client can read a single table off a pair');

    const single = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_3'], starts_at_local: NEAR().text, party_size: 2,
    }, 'shape-single');
    L.assert.equal(single.status, 201, single.text);
    L.assert.deepEqual(single.json.table_ids, ['t_3'], 'a single booking carries table_ids');
    L.assert.equal(single.json.table_id, 't_3',
      'and also table_id, so a stage-1 client keeps working on it');

    /* Every read path agrees, not just the create response. */
    const list = await L.call('GET', '/reservations', { token });
    for (const entry of list.json.reservations) {
      L.assert.equal(Array.isArray(entry.table_ids), true, 'a listed reservation carries table_ids');
      L.assert.equal('table_id' in entry, entry.table_ids.length === 1,
        'table_id appears on exactly the single-table reservations');
    }
  });

  await L.step('the request contract refuses the four malformed shapes', async () => {
    const token = await setup();

    const both = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', table_ids: ['t_1'], starts_at_local: NEAR().text, party_size: 2,
    }, 'both');
    L.expectError(both, 422, 'validation_failed', 'both spellings in one request');

    const three = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2', 't_3'], starts_at_local: NEAR().text, party_size: 2,
    }, 'three');
    L.expectError(three, 422, 'combination_not_allowed', 'three tables');

    const undeclared = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_2', 't_3'], starts_at_local: NEAR().text, party_size: 4,
    }, 'undeclared');
    L.expectError(undeclared, 422, 'combination_not_allowed', 'a pair the restaurant never declared');

    const duplicate = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_1'], starts_at_local: NEAR().text, party_size: 2,
    }, 'duplicate');
    L.expectError(duplicate, 422, 'validation_failed', 'the same table named twice in a set');

    const neither = await book(token, {
      restaurant_id: 'r_anker', starts_at_local: NEAR().text, party_size: 2,
    }, 'neither');
    L.expectError(neither, 422, 'validation_failed', 'no table named at all');
  });

  await L.step('an undeclared pair is refused even when both tables are free', async () => {
    const token = await setup();
    /* Nothing occupies t_2 or t_3 at this slot, so the only reason to refuse
     * t_2+t_3 is that the restaurant never declared that pair. Two tables that
     * happen to be free together are not thereby combinable. */
    const slots = await slotOf(NEAR().dateText, 'r_anker', 4);
    const first = slots.find((s) => s.starts_at_local === NEAR().text);
    L.assert.equal(first.available_table_ids.includes('t_2'), true, 't_2 is free at this slot');
    L.assert.equal(first.available_table_ids.includes('t_3'), true, 't_3 is free at this slot');
    const res = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_2', 't_3'], starts_at_local: NEAR().text, party_size: 4,
    }, 'free-but-undeclared');
    L.expectError(res, 422, 'combination_not_allowed', 'two free tables that were never declared a pair');
  });

  /* ------------------------------------------------------------------ *
   * Freeness is per member.
   * ------------------------------------------------------------------ */

  await L.step('a combination needs every one of its tables free', async () => {
    const token = await setup();
    const held = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 2,
    }, 'hold-t1');
    L.assert.equal(held.status, 201, held.text);

    const refused = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'pair-onto-held');
    L.expectError(refused, 409, 'table_unavailable', 'a pair whose first table is taken');

    /* Cancelling the single booking frees every member, which is what makes the
     * pair bookable a moment later. */
    const cancelled = await L.call('POST', `/reservations/${held.json.reference}/cancel`, { token });
    L.assert.equal(cancelled.status, 200, cancelled.text);
    const now = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'pair-after-cancel');
    L.assert.equal(now.status, 201, `the pair is bookable once the table is released: ${now.text}`);
  });

  await L.step('cancelling a combined booking frees both of its tables', async () => {
    const token = await setup();
    const pair = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'cancel-pair');
    L.assert.equal(pair.status, 201, pair.text);
    const cancelled = await L.call('POST', `/reservations/${pair.json.reference}/cancel`, { token });
    L.assert.equal(cancelled.status, 200, cancelled.text);
    L.assert.deepEqual(cancelled.json.table_ids, ['t_1', 't_2'],
      'the cancelled view still names both tables');
    for (const table of ['t_1', 't_2']) {
      const slots = await slotOf(NEAR().dateText, 'r_anker', 2);
      const first = slots.find((s) => s.starts_at_local === NEAR().text);
      L.assert.equal(first.available_table_ids.includes(table), true,
        `${table} is free again after the pair was cancelled`);
    }
  });

  /* ------------------------------------------------------------------ *
   * Amending across a set.
   * ------------------------------------------------------------------ */

  await L.step('a PATCH can move a booking onto a declared pair', async () => {
    const token = await setup();
    const single = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 2,
    }, 'patch-single');
    L.assert.equal(single.status, 201, single.text);

    const widened = await L.call('PATCH', `/reservations/${single.json.reference}`, {
      token,
      body: { table_ids: ['t_1', 't_2'], party_size: 6 },
    });
    L.assert.equal(widened.status, 200, widened.text);
    L.assert.deepEqual(widened.json.table_ids, ['t_1', 't_2'], 'the amended booking names both tables');
    L.assert.equal('table_id' in widened.json, false, 'and no longer carries a singular table');

    /* Back to one table, by either spelling. The party has to come down with the
     * set, because a PATCH that names no party size keeps the current one, and
     * six people do not fit at Table 2 alone. */
    const narrowed = await L.call('PATCH', `/reservations/${single.json.reference}`, {
      token,
      body: { table_id: 't_2', party_size: 4 },
    });
    L.assert.equal(narrowed.status, 200, narrowed.text);
    L.assert.deepEqual(narrowed.json.table_ids, ['t_2'], 'the set is replaced, not merged');
    L.assert.equal(narrowed.json.table_id, 't_2', 'and a single-member set carries the singular spelling');
  });

  await L.step('a PATCH that names no table keeps the current set', async () => {
    const token = await setup();
    const pair = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'patch-keep');
    L.assert.equal(pair.status, 201, pair.text);
    const only = await L.call('PATCH', `/reservations/${pair.json.reference}`, {
      token, body: { party_size: 5 },
    });
    L.assert.equal(only.status, 200, only.text);
    L.assert.deepEqual(only.json.table_ids, ['t_1', 't_2'], 'the pair survives a party-size-only PATCH');
  });

  await L.step('a PATCH onto an undeclared pair is refused', async () => {
    const token = await setup();
    const single = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 2,
    }, 'patch-refuse');
    const res = await L.call('PATCH', `/reservations/${single.json.reference}`, {
      token, body: { table_ids: ['t_2', 't_3'] },
    });
    L.expectError(res, 422, 'combination_not_allowed', 'amending onto a pair that was never declared');
  });

  /* ------------------------------------------------------------------ *
   * Moves carry sets and collide on any shared member.
   * ------------------------------------------------------------------ */

  await L.step('a move can take a booking onto a declared pair', async () => {
    const token = await setup();
    const single = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 2,
    }, 'move-onto-pair');
    L.assert.equal(single.status, 201, single.text);
    const moved = await L.call('POST', '/reservation-moves', {
      token,
      key: 'move-pair',
      body: { moves: [{ reference: single.json.reference, table_ids: ['t_3', 't_1'], party_size: 8 }] },
    });
    L.assert.equal(moved.status, 201, moved.text);
    L.assert.deepEqual(moved.json.reservations[0].table_ids, ['t_3', 't_1'],
      'the moved booking holds the pair in the order it was asked for');
  });

  await L.step('two moves collide when they share any one table of a pair', async () => {
    const token = await setup();
    /* [t_3,t_1] and [t_1,t_2] share t_1 without either naming the same table
     * first, so this only fails if the overlap test is a set intersection. */
    const a = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_3', 't_1'], starts_at_local: NEAR().text, party_size: 8,
    }, 'share-a');
    L.assert.equal(a.status, 201, a.text);
    const b = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: NEAR().text, party_size: 2,
    }, 'share-b');
    L.assert.equal(b.status, 201, b.text);

    const clash = await L.call('POST', '/reservation-moves', {
      token,
      key: 'share-clash',
      body: { moves: [{ reference: b.json.reference, table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text }] },
    });
    L.expectError(clash, 409, 'table_unavailable',
      'a batch whose two results share t_1 over an overlapping time');

    /* Whole-request atomicity is unchanged, so the refused batch moved nothing. */
    const still = await L.call('GET', `/reservations/${b.json.reference}`, { token });
    L.assert.deepEqual(still.json.table_ids, ['t_2'], 'the refused batch left the booking on its own table');
    L.assert.equal(still.json.starts_at_local, NEAR().text, 'and left its start time alone');
  });

  await L.step('a batch whose results share a member but do not overlap is allowed', async () => {
    const token = await setup();
    /* 19:00 for 90 minutes ends at 20:30, so a 21:00 start cannot overlap it
     * even though the two sets share t_1. */
    const a = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_3', 't_1'], starts_at_local: NEAR().text, party_size: 8,
    }, 'no-overlap-a');
    L.assert.equal(a.status, 201, a.text);
    /* b has to start somewhere free of a, so it is booked at the abutting slot
     * and then moved further away; the point of the probe is that a shared table
     * id with no shared interval is not a collision. */
    const b = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: ABUTTING().text, party_size: 2,
    }, 'no-overlap-b');
    L.assert.equal(b.status, 201, b.text);
    const later = DISTANT().text;
    const res = await L.call('POST', '/reservation-moves', {
      token,
      key: 'no-overlap',
      body: { moves: [{ reference: b.json.reference, table_ids: ['t_1', 't_2'], starts_at_local: later }] },
    });
    L.assert.equal(res.status, 201, `sharing a table without overlapping is fine: ${res.text}`);
  });

  /* ------------------------------------------------------------------ *
   * Import carries both spellings.
   * ------------------------------------------------------------------ */

  await L.step('an import carries a stage-1 singular booking into stage 2', async () => {
    const token = await setup([]);
    const booked = await book(token, {
      restaurant_id: 'r_anker', table_id: 't_1', starts_at_local: NEAR().text, party_size: 2,
    }, 'import-singular');
    L.assert.equal(booked.status, 201, booked.text);
    const snapshot = (await L.call('GET', '/_test/export')).json;

    /* Rewritten into the stage-1 stored shape: one table_id and no table_ids,
     * which is exactly what a stage-1 export looks like. */
    const stageOne = JSON.parse(JSON.stringify(snapshot));
    for (const record of stageOne.state.reservations) {
      if (Array.isArray(record.table_ids) && record.table_ids.length === 1) {
        record.table_id = record.table_ids[0];
        delete record.table_ids;
      }
    }
    const res = await L.call('POST', '/_test/import', { body: stageOne });
    L.assert.equal(res.status, 204, `a stage-1 shaped export imports: ${res.text}`);
    const after = (await L.call('GET', `/reservations/${booked.json.reference}`, { token }));
    L.assert.deepEqual(after.json.table_ids, ['t_1'], 'the singular record is served as a set of one');
    L.assert.equal(after.json.table_id, 't_1', 'and also carries the singular spelling');
  });

  await L.step('a stored record naming both spellings is read when they agree and refused when they do not', async () => {
    const token = await setup();
    /* Only a one-table booking can carry both spellings, since a singular field
     * cannot describe a pair. So this probe books one table. */
    const booked = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1'], starts_at_local: NEAR().text, party_size: 2,
    }, 'import-both');
    L.assert.equal(booked.status, 201, booked.text);
    const snapshot = JSON.parse(JSON.stringify((await L.call('GET', '/_test/export')).json));

    /* Both spellings, agreeing: carried rather than refused. */
    const agreeing = JSON.parse(JSON.stringify(snapshot));
    for (const record of agreeing.state.reservations) record.table_id = record.table_ids[0];
    L.assert.equal(agreeing.state.reservations[0].table_id, 't_1', 'the probe really set both fields');
    const ok = await L.call('POST', '/_test/import', { body: agreeing });
    L.assert.equal(ok.status, 204, `two agreeing spellings are one statement: ${ok.text}`);

    /* Both spellings, contradicting: a genuine contradiction is still refused,
     * because carrying a record that says two different things is not the same
     * as carrying a state that could not be booked today. */
    const clashing = JSON.parse(JSON.stringify(snapshot));
    for (const record of clashing.state.reservations) record.table_id = 't_3';
    const bad = await L.call('POST', '/_test/import', { body: clashing });
    L.expectError(bad, 422, 'validation_failed', 'two spellings that disagree');
  });

  await L.step('a declared pair round-trips through export and import', async () => {
    const token = await setup();
    const pair = await book(token, {
      restaurant_id: 'r_anker', table_ids: ['t_1', 't_2'], starts_at_local: NEAR().text, party_size: 4,
    }, 'round-trip');
    L.assert.equal(pair.status, 201, pair.text);
    const snapshot = (await L.call('GET', '/_test/export')).json;
    const res = await L.call('POST', '/_test/import', { body: JSON.parse(JSON.stringify(snapshot)) });
    L.assert.equal(res.status, 204, `a stage-2 export imports into itself: ${res.text}`);
    const after = await L.call('GET', `/reservations/${pair.json.reference}`, { token });
    L.assert.deepEqual(after.json.table_ids, ['t_1', 't_2'], 'the pair survived the round trip');
    /* The declared list came back, so the pair is still bookable rather than
     * silently demoted to an undeclared set. */
    const distant = DISTANT();
    const slots = await slotOf(distant.dateText, 'r_anker', 4);
    const first = slots.find((s) => s.starts_at_local === distant.text);
    const pairs = first.available_options.filter((o) => o.table_ids.length === 2).map((o) => o.table_ids);
    L.assert.deepEqual(pairs, [['t_3', 't_1'], ['t_1', 't_2']],
      'both declared pairs are offered at a free slot, in written order, so the list survived the round trip');
  });
};