'use strict';

const { errors } = require('./errors');
const M = require('./model');
const S = require('./store');
const T = require('./time');
const D = require('./domain');

/* --------------------------- fixture load --------------------------- */

function normalizeReservations(raw, restaurants) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw errors.validationFailed('reservations must be an array');
  const seenIds = new Set();
  const seenRefs = new Set();
  return raw.map((entry) => {
    const obj = M.requireObject(entry, 'reservation must be an object');
    const restaurant = restaurants.find((r) => r.id === obj.restaurant_id);
    if (!restaurant) throw errors.validationFailed('seeded reservation references an unknown restaurant');
    const tableId = S.requireId(obj.table_id, 'reservation.table_id');
    if (!restaurant.tables.some((t) => t.id === tableId)) {
      throw errors.validationFailed('seeded reservation references an unknown table');
    }
    const id = obj.id === undefined ? undefined : S.requireId(obj.id, 'reservation.id');
    if (id !== undefined) {
      if (seenIds.has(id)) throw errors.validationFailed(`duplicate reservation id ${id}`);
      seenIds.add(id);
    }
    const reference = obj.reference === undefined || obj.reference === null ? undefined : S.requireId(obj.reference, 'reservation.reference');
    if (reference !== undefined && !M.REFERENCE_PATTERN.test(reference)) {
      throw errors.validationFailed('reservation.reference must be 6 to 12 characters of A-Z0-9');
    }
    if (reference !== undefined) {
      if (seenRefs.has(reference)) throw errors.validationFailed(`duplicate reservation reference ${reference}`);
      seenRefs.add(reference);
    }
    const userId = S.requireId(obj.user_id, 'reservation.user_id');
    const partySize = obj.party_size;
    if (typeof partySize !== 'number' || !Number.isInteger(partySize) || partySize < 1) {
      throw errors.validationFailed('reservation.party_size must be a positive integer');
    }
    const fields = T.parseLocalMinute(obj.starts_at_local);
    if (!fields) throw errors.validationFailed('reservation.starts_at_local must be a bare local YYYY-MM-DDTHH:MM value');
    const local = T.resolveLocal(restaurant.timezone, fields.year, fields.month, fields.day, fields.hour, fields.minute);
    if (local.kind !== 'ok') throw errors.validationFailed('reservation.starts_at_local does not exist at that restaurant');
    const status = obj.status === undefined || obj.status === null ? 'confirmed' : String(obj.status);
    if (status !== 'confirmed' && status !== 'cancelled') {
      throw errors.validationFailed('reservation.status must be confirmed or cancelled');
    }
    const createdAt = obj.created_at === undefined || obj.created_at === null
      ? Date.now()
      : Date.parse(String(obj.created_at));
    return {
      id,
      reference,
      user_id: userId,
      restaurant_id: restaurant.id,
      table_id: tableId,
      party_size: partySize,
      status,
      starts_instant: local.instantMs,
      ends_instant: local.instantMs + restaurant.reservation_duration_minutes * 60000,
      starts_at_local: obj.starts_at_local,
      created_at: Number.isNaN(createdAt) ? Date.now() : createdAt,
    };
  });
}

/**
 * Validate a fixture and hash its passwords. Runs before the write mutex is
 * taken, because scrypt is deliberately slow and a reset must not block other
 * requests for its duration.
 */
async function buildFixture(fixture) {
  const body = M.requireObject(fixture === undefined || fixture === null ? {} : fixture, 'fixture must be a JSON object');
  const restaurants = M.normalizeRestaurants(body.restaurants);
  const rawUsers = body.users === undefined || body.users === null ? [] : body.users;
  if (!Array.isArray(rawUsers)) throw errors.validationFailed('users must be an array');
  const hashes = await S.hashManyAsync(rawUsers.map((u) => {
    if (!M.isPlainObject(u) || typeof u.password !== 'string' || u.password.length === 0) {
      throw errors.validationFailed('every seeded user needs a password');
    }
    return u.password;
  }));
  const users = M.normalizeUsers(rawUsers, hashes);
  const reservations = normalizeReservations(body.reservations, restaurants);
  return { users, restaurants, reservations };
}

/** Install a validated fixture. Runs inside the write mutex. */
function installFixture(parts) {
  const state = M.emptyState();
  state.users = parts.users;
  state.restaurants = parts.restaurants;
  let counter = 0;
  state.reservations = parts.reservations.map((r, i) => {
    const id = r.id !== undefined ? r.id : `res_${i + 1}`;
    const numeric = Number(String(id).replace(/^res_/, ''));
    if (Number.isInteger(numeric) && numeric > counter) counter = numeric;
    return { ...r, id };
  });
  state.counters.reservation = counter;
  setState(state);
  let assigned = false;
  for (const r of M.getState().reservations) {
    if (r.reference === undefined) {
      r.reference = D.newReference();
      assigned = true;
    }
  }
  if (assigned) M.reindex();
  return M.getState();
}

function emptyFixture() {
  return installFixture({ users: [], restaurants: [], reservations: [] });
}

function setState(next) {
  const current = M.getState();
  current.v = next.v;
  current.counters = next.counters;
  current.users = next.users;
  current.tokens = next.tokens;
  current.restaurants = next.restaurants;
  current.reservations = next.reservations;
  current.receipts = next.receipts;
  M.reindex();
}

/* ------------------------------ views ------------------------------ */

function reservationView(reservation) {
  const restaurant = M.index.restaurantsById.get(reservation.restaurant_id);
  const zone = restaurant ? restaurant.timezone : 'UTC';
  return {
    reservation_id: reservation.id,
    reference: reservation.reference,
    restaurant_id: reservation.restaurant_id,
    table_id: reservation.table_id,
    party_size: reservation.party_size,
    status: reservation.status,
    starts_at_local: reservation.starts_at_local,
    starts_at: T.rfc3339(reservation.starts_instant, zone),
    ends_at: T.rfc3339(reservation.ends_instant, zone),
    created_at: T.rfc3339(reservation.created_at, 'UTC'),
  };
}

function restaurantSummary(restaurant) {
  return { id: restaurant.id, name: restaurant.name, timezone: restaurant.timezone };
}

function restaurantDetail(restaurant) {
  return {
    id: restaurant.id,
    name: restaurant.name,
    timezone: restaurant.timezone,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: restaurant.opening_hours.map((h) => ({ weekday: h.weekday, opens: h.opens, closes: h.closes })),
    tables: restaurant.tables.map((t) => ({ id: t.id, label: t.label, capacity: t.capacity })),
  };
}

module.exports = {
  buildFixture,
  installFixture,
  emptyFixture,
  setState,
  normalizeReservations,
  reservationView,
  restaurantSummary,
  restaurantDetail,
};
