'use strict';

const { errors } = require('./errors');
const S = require('./store');
const T = require('./time');

const { requireObject, requireId, isPlainObject } = S;

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

function reindex() {
  index.usersById = new Map(state.users.map((u) => [u.id, u]));
  index.usersByEmail = new Map(state.users.map((u) => [u.email.toLowerCase(), u]));
  index.tokensByValue = new Map(state.tokens.map((t) => [t.token, t.user_id]));
  index.restaurantsById = new Map(state.restaurants.map((r) => [r.id, r]));
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

function requireSlot(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw errors.validationFailed(`${label} must be a positive whole number of minutes`);
  }
  return value;
}

function normalizeOpeningHours(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw errors.validationFailed(`${label}.opening_hours must be an array`);
  return raw.map((entry) => {
    const obj = requireObject(entry, `${label}.opening_hours entry must be an object`);
    const weekday = String(obj.weekday === undefined ? '' : obj.weekday).toLowerCase();
    if (!T.WEEKDAYS.includes(weekday)) throw errors.validationFailed(`${label}.opening_hours.weekday is invalid`);
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
  if (!Array.isArray(raw)) throw errors.validationFailed(`${label}.tables must be an array`);
  const seen = new Set();
  return raw.map((entry) => {
    const obj = requireObject(entry, `${label}.tables entry must be an object`);
    const id = requireId(obj.id, `${label}.tables[].id`);
    if (seen.has(id)) throw errors.validationFailed(`${label}.tables contains duplicate id ${id}`);
    seen.add(id);
    if (typeof obj.capacity !== 'number' || !Number.isInteger(obj.capacity) || obj.capacity < 1) {
      throw errors.validationFailed(`${label}.tables[].capacity must be a positive integer`);
    }
    return {
      id,
      label: obj.label === undefined || obj.label === null ? id : String(obj.label),
      capacity: obj.capacity,
    };
  });
}

function normalizeRestaurants(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw errors.validationFailed('restaurants must be an array');
  const seen = new Set();
  return raw.map((entry) => {
    const obj = requireObject(entry, 'restaurant must be an object');
    const id = requireId(obj.id, 'restaurant.id');
    if (seen.has(id)) throw errors.validationFailed(`duplicate restaurant id ${id}`);
    seen.add(id);
    if (!T.isValidZone(obj.timezone)) throw errors.validationFailed(`restaurant ${id} has an invalid timezone`);
    return {
      id,
      name: obj.name === undefined || obj.name === null ? id : String(obj.name),
      timezone: obj.timezone,
      slot_minutes: requireSlot(obj.slot_minutes, `restaurant ${id} slot_minutes`),
      reservation_duration_minutes: requireSlot(obj.reservation_duration_minutes, `restaurant ${id} reservation_duration_minutes`),
      cancellation_cutoff_minutes: requireSlot(obj.cancellation_cutoff_minutes, `restaurant ${id} cancellation_cutoff_minutes`),
      opening_hours: normalizeOpeningHours(obj.opening_hours, `restaurant ${id}`),
      tables: normalizeTables(obj.tables, `restaurant ${id}`),
    };
  });
}

function normalizeUsers(raw, hashes) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw errors.validationFailed('users must be an array');
  const seenIds = new Set();
  const seenEmails = new Set();
  return raw.map((entry, i) => {
    const obj = requireObject(entry, 'user must be an object');
    const id = requireId(obj.id, 'user.id');
    if (seenIds.has(id)) throw errors.validationFailed(`duplicate user id ${id}`);
    seenIds.add(id);
    if (!S.emailLooksValid(obj.email)) throw errors.validationFailed(`user ${id} has an invalid email`);
    const email = String(obj.email).toLowerCase();
    if (seenEmails.has(email)) throw errors.validationFailed(`duplicate email ${email}`);
    seenEmails.add(email);
    if (typeof obj.password !== 'string' || obj.password.length === 0) {
      throw errors.validationFailed(`user ${id} must have a password`);
    }
    return {
      id,
      email,
      display_name: obj.display_name === undefined || obj.display_name === null ? email.split('@')[0] : String(obj.display_name),
      password_hash: hashes ? hashes[i] : S.hashPassword(obj.password),
    };
  });
}

module.exports = {
  emptyState,
  reindex,
  receiptKey,
  getState,
  index,
  requireSlot,
  REFERENCE_PATTERN,
  normalizeRestaurants,
  normalizeOpeningHours,
  normalizeTables,
  normalizeUsers,
  requireObject,
  isPlainObject,
};
