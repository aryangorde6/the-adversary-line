'use strict';

/* The wording a person reads on the booking path. Status and code are pinned
 * elsewhere; these checks exist so the sentences keep naming the restaurant,
 * the day, the time and the table instead of a field name. */

const L = require('./lib');
const clock = require('./clock');

const R = 'r_anker';

/** Assert one error carries this exact status, code and sentence. */
function say(res, status, code, message, label) {
  L.expectError(res, status, code, label);
  L.assert.equal(res.json.error.message, message, `${label}: wrong wording -> ${res.json.error.message}`);
}

async function plain(overrides = {}) {
  await L.reset(clock.alwaysOpen(L.FIXTURE, { cancellation_cutoff_minutes: 30, ...overrides }));
  return L.login('ada@example.com', 'correct horse');
}

/** "Thursday 1 October 2026", built independently of the service wording. */
function dayWords(dateText) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).formatToParts(new Date(`${dateText}T12:00:00Z`));
  const at = (type) => parts.find((p) => p.type === type).value;
  return `${at('weekday')} ${at('day')} ${at('month')} ${at('year')}`;
}

/** The fixture's own opening hours, so the messages can name them. */
async function standard() {
  await L.reset(L.FIXTURE);
  return L.login('ada@example.com', 'correct horse');
}

async function attempt(token, key, body) {
  return L.call('POST', '/reservations', { token, key, body });
}

exports.run = async () => {
  await L.step('a start time written wrongly is shown the shape to use', async () => {
    const t = await plain();
    say(
      await attempt(t, 'w-1', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24 19:00', party_size: 2 }),
      422, 'validation_failed',
      'The start time must be written like 2026-09-24T19:00, with no seconds and no time zone.',
      'start time shape',
    );
  });

  await L.step('a date that does not exist is named in full', async () => {
    const t = await plain();
    say(
      await attempt(t, 'w-2', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-02-30T19:00', party_size: 2 }),
      422, 'validation_failed', '30 February 2026 is not a date.', 'impossible date',
    );
  });

  await L.step('a time of day that does not exist is named', async () => {
    const t = await plain();
    say(
      await attempt(t, 'w-3', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T25:00', party_size: 2 }),
      422, 'validation_failed', '25:00 is not a time of day.', 'impossible time',
    );
  });

  await L.step('a skipped hour says which hour is skipped and why', async () => {
    const t = await plain();
    say(
      await attempt(t, 'w-4', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-03-29T02:30', party_size: 2 }),
      422, 'invalid_local_time',
      '02:30 does not exist at Zum Anker on 29 March 2026, because the clocks go forward from 02:00 to 03:00, so nothing happens between those times.',
      'spring forward gap',
    );
  });

  await L.step('a closed day names the day', async () => {
    const t = await standard();
    say(
      await attempt(t, 'w-5', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-22T19:00', party_size: 2 }),
      422, 'outside_opening_hours', 'Zum Anker is closed on Tuesday 22 September 2026.', 'closed weekday',
    );
  });

  await L.step('a time outside opening hours says the hours it falls outside', async () => {
    const t = await standard();
    say(
      await attempt(t, 'w-6', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T12:00', party_size: 2 }),
      422, 'outside_opening_hours',
      'Zum Anker is open 18:00 to 23:00 on Thursday 24 September 2026, and 12:00 is outside those hours.',
      'outside hours',
    );
  });

  await L.step('a time between start times says the step it must follow', async () => {
    const t = await standard();
    say(
      await attempt(t, 'w-7', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T19:10', party_size: 2 }),
      422, 'not_on_slot_grid',
      '19:10 is not one of the start times Zum Anker offers; Zum Anker takes bookings every 30 minutes from 18:00.',
      'off the step pattern',
    );
  });

  await L.step('a booking that would end late says where it would end', async () => {
    const t = await standard();
    say(
      await attempt(t, 'w-8', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T22:00', party_size: 2 }),
      422, 'outside_opening_hours',
      'A 90 minute booking from 22:00 would end at 23:30, after Zum Anker closes at 23:00.',
      'ends after closing',
    );
  });

  await L.step('too many guests names the table and what it seats', async () => {
    const t = await plain();
    say(
      await attempt(t, 'w-9', { restaurant_id: R, table_id: 't_2', starts_at_local: '2026-09-24T19:00', party_size: 6 }),
      422, 'party_exceeds_capacity', 'Table 2 at Zum Anker seats 4, and you asked for 6.', 'over capacity',
    );
  });

  await L.step('a party size that is not a whole number reads the same everywhere', async () => {
    const t = await plain();
    const sentence = 'the number of guests must be a whole number of at least 1.';
    say(
      await attempt(t, 'w-10', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: '2' }),
      422, 'validation_failed', sentence, 'party size on booking',
    );
    say(
      await attempt(t, 'w-11', { restaurant_id: R, table_id: 't_1', starts_at_local: '2026-09-24T19:00', party_size: 0 }),
      422, 'validation_failed', sentence, 'party size of zero',
    );
    say(
      await L.call('GET', '/availability?restaurant_id=r_anker&date=2026-09-24&party_size=0'),
      422, 'validation_failed', sentence, 'party size on availability',
    );
    say(
      await L.call('POST', '/reservation-moves', { token: t, key: 'w-12', body: { moves: [{ reference: 'ABC123', party_size: 1.5 }] } }),
      422, 'validation_failed', sentence, 'party size inside a batch move',
    );
  });

  await L.step('an email that is not an email says so in plain words', async () => {
    say(
      await L.call('POST', '/auth/signup', { body: { email: 'not-an-email', password: 'longenough1' } }),
      422, 'validation_failed', 'That does not look like an email address.', 'signup email',
    );
  });

  await L.step('a reference that is not yours is refused without saying whether it exists', async () => {
    const t = await plain();
    const sentence = 'We could not find a booking with that reference in your bookings.';
    say(await L.call('GET', '/reservations/ZZZZZZ', { token: t }), 404, 'not_found', sentence, 'read one booking');
    say(await L.call('POST', '/reservations/ZZZZZZ/cancel', { token: t }), 404, 'not_found', sentence, 'cancel one booking');
    say(
      await L.call('POST', '/reservation-moves', { token: t, key: 'w-13', body: { moves: [{ reference: 'ZZZZZZ', party_size: 2 }] } }),
      404, 'not_found', sentence, 'move one booking',
    );
  });

  await L.step('too late to change says how much notice is needed and when it starts', async () => {
    const t = await plain({ cancellation_cutoff_minutes: 10080 });
    const slot = clock.localSlotFromNow(60);
    const made = await attempt(t, 'w-14', { restaurant_id: R, table_id: 't_1', starts_at_local: slot.text, party_size: 2 });
    L.assert.equal(made.status, 201, made.text);
    const reference = made.json.reference;

    const words = dayWords(slot.dateText);
    const expected = `Zum Anker needs 10080 minutes' notice before a booking starts, and this one starts at ${slot.text.slice(11)} on ${words}, so it can no longer be cancelled or changed.`;

    say(await L.call('POST', `/reservations/${reference}/cancel`, { token: t }), 409, 'cutoff_passed', expected, 'cancel too late');
    say(await L.call('PATCH', `/reservations/${reference}`, { token: t, body: { party_size: 3 } }), 409, 'cutoff_passed', expected, 'amend too late');
    say(
      await L.call('POST', '/reservation-moves', { token: t, key: 'w-15', body: { moves: [{ reference, party_size: 3 }] } }),
      409, 'cutoff_passed', expected, 'move too late',
    );
  });

  await L.step('a seeded fixture is shown the same start time shape', async () => {
    const fixture = JSON.parse(JSON.stringify(L.FIXTURE));
    fixture.reservations = [{
      id: 'res_seed', reference: 'ABC123', user_id: 'u_ada', restaurant_id: R, table_id: 't_1',
      party_size: 2, status: 'confirmed', starts_at_local: '2026-09-24 19:00',
    }];
    say(
      await L.call('POST', '/_test/reset', { body: fixture }),
      422, 'validation_failed',
      'The start time must be written like 2026-09-24T19:00, with no seconds and no time zone.',
      'seeded start time shape',
    );
  });
};
