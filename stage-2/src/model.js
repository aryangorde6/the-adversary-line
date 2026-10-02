'use strict';

const { errors } = require('./errors');
const S = require('./store');
const T = require('./time');

const { requireRecord, requireList, requireText, requireAmount, requireId, isPlainObject } = S;

const REFERENCE_PATTERN = /^[A-Z0-9]{6,12}$/;

let state = emptyState();

function emptyState() {
  return {
    v: S.STATE_VERSION,
    counters: { user: 0, reservation: 0 },
    users: [],
    tokens: [],
    restaurants: [],
    reservations: [],
    receipts: [],
  };
}

const index = {
  usersById: new Map(),
  usersByEmail: new Map(),
  tokensByValue: new Map(),
  restaurantsById: new Map(),
  reservationsByRef: new Map(),
  reservationsById: new Map(),
  reservationsByUser: new Map(),
  references: new Set(),
  receiptsByKey: new Map(),
};

function receiptKey(userId, key, method, path) {
  return JSON.stringify([userId, method, path, key]);
}

/* Every reader reaches a restaurant through restaurantsById, so the declared-pair
 * default is filled in here rather than at each place that iterates combinable.
 * Absent means no declared pairs: that is the default normalizeCombinable
 * documents, and it is the only reading under which a stage-1 export, which never
 * writes the field, can be carried at all. Filling it per consumer instead would
 * be the same invariant restated once per consumer, and the next consumer added
 * would be the one that forgets.
 *
 * Only the index is given the default. state.restaurants keeps the bytes it was
 * stored with, so a state that arrived without the field is exported without it
 * and the round trip stays exact. A restaurant that already declares pairs is
 * handed back as itself rather than copied, so the fixture path allocates
 * nothing and index identity matches stored identity.
 *
 * The copy is shallow and safe because a stored restaurant is never mutated once
 * it is installed: the only field written after install is a reservation's
 * reference, and the arrays below are read-only everywhere they are reachable. */
function withDeclaredPairs(restaurant) {
  if (Array.isArray(restaurant.combinable)) return restaurant;
  return { ...restaurant, combinable: [] };
}

function reindex() {
  index.usersById = new Map(state.users.map((u) => [u.id, u]));
  index.usersByEmail = new Map(state.users.map((u) => [u.email.toLowerCase(), u]));
  index.tokensByValue = new Map(state.tokens.map((t) => [t.token, t.user_id]));
  index.restaurantsById = new Map(state.restaurants.map((r) => [r.id, withDeclaredPairs(r)]));
  index.reservationsByRef = new Map(state.reservations.map((r) => [r.reference, r]));
  index.reservationsById = new Map(state.reservations.map((r) => [r.id, r]));
  index.reservationsByUser = new Map();
  for (const r of state.reservations) {
    const list = index.reservationsByUser.get(r.user_id) || [];
    list.push(r);
    index.reservationsByUser.set(r.user_id, list);
  }
  index.references = new Set(state.reservations.map((r) => r.reference));
  index.receiptsByKey = new Map();
  for (const rec of state.receipts) {
    index.receiptsByKey.set(receiptKey(rec.user_id, rec.key, rec.method, rec.path), rec);
  }
}

function getState() {
  return state;
}

/* The three minute settings do not share one range. A slot step of zero would make
 * slot generation non-terminating and a zero length reservation is degenerate, so
 * both start at 1. A cutoff of zero is a real policy: every booking is then inside
 * the cutoff, which is what the arithmetic in the booking path already does, so
 * zero is a value rather than a missing one.
 *
 * The cutoff has no ceiling. stage-1.md states no range for this field, and its own
 * shipped checks seed a decade wide cutoff and require it accepted, so a cap here
 * would refuse a fixture the specification never asked to refuse. */
const MINUTE_BOUNDS = {
  slot_minutes: { min: 1, max: undefined },
  reservation_duration_minutes: { min: 1, max: undefined },
  cancellation_cutoff_minutes: { min: 0, max: undefined },
};

/* Returns the reason a minute setting is unusable, or null when it is fine.
 * A non-number is reported here too so the import validator can reuse this; the
 * fixture path checks the JSON type first and answers 400 for it. */
function minuteSettingProblem(value, label, bounds) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${label} must be a whole number of minutes`;
  if (value < bounds.min) {
    return bounds.min === 1
      ? `${label} must be a positive whole number of minutes`
      : `${label} must not be negative`;
  }
  if (bounds.max !== undefined && value > bounds.max) return `${label} must be at most ${bounds.max} minutes`;
  return null;
}

function requireMinuteSetting(value, field, label) {
  requireAmount(value, `${label} must be a number of minutes`);
  const problem = minuteSettingProblem(value, label, MINUTE_BOUNDS[field]);
  if (problem) throw errors.validationFailed(problem);
  return value;
}

/** True when all three minute settings sit inside their own range. */
function hasValidMinuteSettings(restaurant) {
  return Object.keys(MINUTE_BOUNDS).every(
    (field) => minuteSettingProblem(restaurant[field], field, MINUTE_BOUNDS[field]) === null,
  );
}

function normalizeOpeningHours(raw, label) {
  if (raw === undefined || raw === null) return [];
  requireList(raw, `${label}.opening_hours must be an array`);
  return raw.map((entry) => {
    const obj = requireRecord(entry, `${label}.opening_hours entry must be an object`);
    requireText(obj.weekday, `${label}.opening_hours.weekday must be a string`);
    const weekday = obj.weekday.toLowerCase();
    if (!T.WEEKDAYS.includes(weekday)) throw errors.validationFailed(`${label}.opening_hours.weekday is invalid`);
    requireText(obj.opens, `${label}.opening_hours.opens must be a string`);
    requireText(obj.closes, `${label}.opening_hours.closes must be a string`);
    const opens = T.parseTimeOfDay(obj.opens);
    const closes = T.parseTimeOfDay(obj.closes);
    if (!opens || !closes) throw errors.validationFailed(`${label}.opening_hours times must be HH:MM`);
    if (opens.hour === 24) throw errors.validationFailed(`${label}.opening_hours.opens must be earlier than 24:00`);
    if (T.minutesOfDay(closes.hour, closes.minute) <= T.minutesOfDay(opens.hour, opens.minute)) {
      throw errors.validationFailed(`${label}.opening_hours must close after it opens on the same local day`);
    }
    return { weekday, opens: obj.opens, closes: obj.closes };
  });
}

function normalizeTables(raw, label) {
  if (raw === undefined || raw === null) return [];
  requireList(raw, `${label}.tables must be an array`);
  const seen = new Set();
  return raw.map((entry) => {
    const obj = requireRecord(entry, `${label}.tables entry must be an object`);
    const id = requireId(obj.id, `${label}.tables[].id`);
    if (seen.has(id)) throw errors.validationFailed(`${label}.tables contains duplicate id ${id}`);
    seen.add(id);
    requireAmount(obj.capacity, `${label}.tables[].capacity must be a number`);
    if (!Number.isInteger(obj.capacity) || obj.capacity < 1) {
      throw errors.validationFailed(`${label}.tables[].capacity must be a positive integer`);
    }
    requireText(obj.label, `${label}.tables[].label must be a string`);
    return { id, label: obj.label, capacity: obj.capacity };
  });
}

function normalizeRestaurants(raw) {
  if (raw === undefined || raw === null) return [];
  requireList(raw, 'restaurants must be an array');
  const seen = new Set();
  return raw.map((entry) => {
    const obj = requireRecord(entry, 'restaurant must be an object');
    const id = requireId(obj.id, 'restaurant.id');
    if (seen.has(id)) throw errors.validationFailed(`duplicate restaurant id ${id}`);
    seen.add(id);
    requireText(obj.timezone, `restaurant ${id} timezone must be a string`);
    if (!T.isValidZone(obj.timezone)) throw errors.validationFailed(`restaurant ${id} has an invalid timezone`);
    requireText(obj.name, `restaurant ${id} name must be a string`);
    const tables = normalizeTables(obj.tables, `restaurant ${id}`);
    return {
      id,
      name: obj.name,
      timezone: obj.timezone,
      slot_minutes: requireMinuteSetting(obj.slot_minutes, 'slot_minutes', `restaurant ${id} slot_minutes`),
      reservation_duration_minutes: requireMinuteSetting(obj.reservation_duration_minutes, 'reservation_duration_minutes', `restaurant ${id} reservation_duration_minutes`),
      cancellation_cutoff_minutes: requireMinuteSetting(obj.cancellation_cutoff_minutes, 'cancellation_cutoff_minutes', `restaurant ${id} cancellation_cutoff_minutes`),
      opening_hours: normalizeOpeningHours(obj.opening_hours, `restaurant ${id}`),
      tables,
      combinable: normalizeCombinable(obj.combinable, tables, id),
    };
  });
}

/* Declared table pairs. Absent means no declared pairs, which is what every
 * stage-1 fixture says by omission and is the only reading under which a
 * stage-2 service can accept a stage-1 export.
 *
 * Order is kept exactly as written and never sorted: stage 2 orders
 * available_options by combinable order and puts a pair's table_ids in
 * combinable order, so storing this as a set of pairs would lose the only order
 * the responses are specified in. Duplicate detection canonicalises to a sorted
 * key, because a pair is unordered and ["t_2","t_1"] repeats ["t_1","t_2"].
 *
 * All four defects are refused rather than dropped. A silently dropped pair is a
 * policy the restaurant did not choose: an undeclared pair has to stay
 * unbookable, so quietly forgetting it would change nothing about bookability
 * but would hide the mistake from whoever wrote the fixture. */
function normalizeCombinable(raw, tables, restaurantId) {
  if (raw === undefined || raw === null) return [];
  requireList(raw, `restaurant ${restaurantId} combinable must be an array`);
  const known = new Set(tables.map((t) => t.id));
  const seen = new Set();
  return raw.map((entry, i) => {
    const label = `restaurant ${restaurantId} combinable[${i}]`;
    requireList(entry, `${label} must be an array of two table ids`);
    if (entry.length !== 2) {
      throw errors.validationFailed(`${label} must name exactly two tables, and got ${entry.length}`);
    }
    const pair = entry.map((value, at) => {
      requireText(value, `${label}[${at}] must be a table id string`);
      if (!known.has(value)) throw errors.validationFailed(`${label} names ${value}, which is not a table in ${restaurantId}`);
      return value;
    });
    if (pair[0] === pair[1]) throw errors.validationFailed(`${label} must name two different tables, and names ${pair[0]} twice`);
    const key = JSON.stringify([...pair].sort());
    if (seen.has(key)) throw errors.validationFailed(`${label} repeats the pair ${pair[0]} and ${pair[1]}`);
    seen.add(key);
    return pair;
  });
}

function normalizeUsers(raw, hashes) {
  if (raw === undefined || raw === null) return [];
  requireList(raw, 'users must be an array');
  const seenIds = new Set();
  const seenEmails = new Set();
  return raw.map((entry, i) => {
    const obj = requireRecord(entry, 'user must be an object');
    const id = requireId(obj.id, 'user.id');
    if (seenIds.has(id)) throw errors.validationFailed(`duplicate user id ${id}`);
    seenIds.add(id);
    requireText(obj.email, `user ${id} email must be a string`);
    if (!S.emailLooksValid(obj.email)) throw errors.validationFailed(`user ${id} has an invalid email`);
    const email = obj.email.toLowerCase();
    if (seenEmails.has(email)) throw errors.validationFailed(`duplicate email ${email}`);
    seenEmails.add(email);
    requireText(obj.password, `user ${id} password must be a string`);
    if (obj.password.length === 0) {
      throw errors.validationFailed(`user ${id} must have a password`);
    }
    requireText(obj.display_name, `user ${id} display_name must be a string`);
    return {
      id,
      email,
      display_name: obj.display_name,
      password_hash: hashes ? hashes[i] : S.hashPassword(obj.password),
    };
  });
}

module.exports = {
  requireRecord,
  requireList,
  requireText,
  requireAmount,
  emptyState,
  reindex,
  receiptKey,
  getState,
  index,
  requireMinuteSetting,
  hasValidMinuteSettings,
  MINUTE_BOUNDS,
  REFERENCE_PATTERN,
  normalizeRestaurants,
  normalizeOpeningHours,
  normalizeTables,
  normalizeCombinable,
  normalizeUsers,
  requireObject: S.requireObject,
  isPlainObject,
};
