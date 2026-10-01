'use strict';

const { errors } = require('./errors');
const M = require('./model');
const S = require('./store');
const T = require('./time');
const D = require('./domain');
const V = require('./service');
const X = require('./transfer');

/* --------------------------- field checks --------------------------- */

function optionalString(body, name) {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw errors.malformedRequest(`${name} must be a string`);
  return value;
}

function requiredString(body, name) {
  const value = body[name];
  if (value === undefined || value === null) throw errors.validationFailed(`${name} is required`);
  if (typeof value !== 'string') throw errors.malformedRequest(`${name} must be a string`);
  if (value.length === 0) throw errors.validationFailed(`${name} must not be empty`);
  return value;
}

function optionalPartySize(body, name) {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw errors.validationFailed('the number of guests must be a whole number of at least 1.');
  }
  return value;
}

function queryString(query, name) {
  const value = query.get(name);
  if (value === null || value === undefined) throw errors.validationFailed(`${name} query parameter is required`);
  if (typeof value !== 'string' || value.length === 0) throw errors.validationFailed(`${name} must be a non-empty value`);
  return value;
}

function queryInteger(query, name) {
  const value = queryString(query, name);
  if (!/^[0-9]+$/.test(value)) throw errors.validationFailed(`${name} must be written as plain decimal digits`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw errors.validationFailed(`${name} is out of range`);
  return parsed;
}

function restaurantById(id) {
  const restaurant = M.index.restaurantsById.get(id);
  if (!restaurant) throw errors.notFound('no such restaurant');
  return restaurant;
}

function cutoffReached(reservation, restaurant, now) {
  return now + restaurant.cancellation_cutoff_minutes * 60000 >= reservation.starts_instant;
}

function ownReservation(user, reference) {
  const reservation = M.index.reservationsByRef.get(reference);
  if (!reservation || reservation.user_id !== user.id) {
    throw errors.notFound('We could not find a booking with that reference in your bookings.');
  }
  return reservation;
}

/* ----------------------------- handlers ----------------------------- */

function health() {
  return { status: 200, body: { status: 'ok' } };
}

async function prepareReset(ctx) {
  return { fixture: await V.buildFixture(ctx.body) };
}

function reset(ctx) {
  V.installFixture(ctx.auth.fixture);
  return { status: 204 };
}

function exportHandler() {
  return { status: 200, body: X.exportSnapshot() };
}

function importHandler(ctx) {
  X.importSnapshot(ctx.body);
  return { status: 204 };
}

function signup(ctx) {
  const email = ctx.auth.email;
  const state = M.getState();
  if (M.index.usersByEmail.has(email.toLowerCase())) throw errors.emailTaken('that email is already registered');
  const user = {
    id: D.nextUserId(),
    email: email.toLowerCase(),
    display_name: ctx.auth.displayName === undefined ? email.split('@')[0] : ctx.auth.displayName,
    password_hash: ctx.auth.passwordHash,
  };
  state.users.push(user);
  const token = S.randomToken();
  state.tokens.push({ token, user_id: user.id });
  M.reindex();
  return { status: 201, body: { user_id: user.id, display_name: user.display_name, token } };
}

/* Password hashing and verification are deliberately done before the write
 * mutex is taken, so fifty concurrent logins cannot serialise behind scrypt. */
async function prepareSignup(ctx) {
  const body = ctx.body;
  const email = requiredString(body, 'email');
  const password = optionalString(body, 'password');
  if (password === undefined) throw errors.validationFailed('password is required');
  if (password.length < 8) throw errors.validationFailed('password must be at least 8 characters');
  if (!S.emailLooksValid(email)) throw errors.validationFailed('That does not look like an email address.');
  const displayName = optionalString(body, 'display_name');
  return { email, displayName, passwordHash: await S.hashPasswordAsync(password) };
}

async function prepareLogin(ctx) {
  const body = ctx.body;
  const email = requiredString(body, 'email');
  const password = optionalString(body, 'password');
  if (password === undefined) throw errors.validationFailed('password is required');
  const user = M.index.usersByEmail.get(email.toLowerCase());
  if (!user) throw errors.unauthenticated('email or password is not correct');
  const ok = await S.verifyPasswordAsync(password, user.password_hash);
  if (!ok) throw errors.unauthenticated('email or password is not correct');
  return { email, userId: user.id };
}

function login(ctx) {
  const user = M.index.usersById.get(ctx.auth.userId);
  if (!user) throw errors.unauthenticated('email or password is not correct');
  const token = S.randomToken();
  M.getState().tokens.push({ token, user_id: user.id });
  M.reindex();
  return { status: 200, body: { user_id: user.id, display_name: user.display_name, token } };
}

function listRestaurants() {
  return { status: 200, body: { restaurants: M.getState().restaurants.map(V.restaurantSummary) } };
}

function getRestaurant(ctx) {
  return { status: 200, body: V.restaurantDetail(restaurantById(ctx.params.id)) };
}

function availability(ctx) {
  const restaurantId = queryString(ctx.query, 'restaurant_id');
  const dateText = queryString(ctx.query, 'date');
  const partySize = queryInteger(ctx.query, 'party_size');
  const restaurant = restaurantById(restaurantId);
  const date = T.parseDate(dateText);
  if (!date) throw errors.validationFailed('date must be a real calendar date written as YYYY-MM-DD');
  if (partySize < 1) throw errors.validationFailed('the number of guests must be a whole number of at least 1.');
  const weekday = T.weekdayName(date.year, date.month, date.day);
  const durationMs = restaurant.reservation_duration_minutes * 60000;
  const slots = [];
  for (const slot of D.slotLocalMinutes(restaurant, weekday)) {
    const hour = Math.floor(slot.minutes / 60);
    const minute = slot.minutes % 60;
    const local = T.resolveLocal(restaurant.timezone, date.year, date.month, date.day, hour, minute);
    if (local.kind !== 'ok') continue;
    const startMs = local.instantMs;
    const endMs = startMs + durationMs;
    const available = restaurant.tables
      .filter((table) => table.capacity >= partySize && D.tableIsFree(restaurant.id, table.id, startMs, endMs, null))
      .map((table) => table.id);
    slots.push({
      starts_at_local: T.localDateTime(startMs, restaurant.timezone).minuteText,
      starts_at: T.rfc3339(startMs, restaurant.timezone),
      available_table_ids: available,
    });
  }
  return {
    status: 200,
    body: {
      restaurant_id: restaurant.id,
      date: dateText,
      timezone: restaurant.timezone,
      slots,
    },
  };
}

function createReservation(ctx) {
  const body = ctx.body;
  const restaurantId = requiredString(body, 'restaurant_id');
  const tableId = requiredString(body, 'table_id');
  const startsAtLocal = requiredString(body, 'starts_at_local');
  const partySize = optionalPartySize(body, 'party_size');
  if (partySize === undefined) throw errors.validationFailed('party_size is required');
  const restaurant = restaurantById(restaurantId);
  const target = D.resolveTarget(restaurant, tableId, startsAtLocal, partySize);
  if (!D.tableIsFree(restaurant.id, target.table.id, target.startMs, target.endMs, null)) {
    throw errors.tableUnavailable('that table is already booked for an overlapping time');
  }
  const reservation = {
    id: D.nextReservationId(),
    reference: D.newReference(),
    user_id: ctx.user.id,
    restaurant_id: restaurant.id,
    table_id: target.table.id,
    party_size: partySize,
    status: 'confirmed',
    starts_instant: target.startMs,
    ends_instant: target.endMs,
    starts_at_local: target.startsAtLocal,
    created_at: Date.now(),
  };
  M.getState().reservations.push(reservation);
  M.reindex();
  return { status: 201, body: V.reservationView(reservation) };
}

function listReservations(ctx) {
  const list = (M.index.reservationsByUser.get(ctx.user.id) || []).slice().sort((a, b) => b.starts_instant - a.starts_instant);
  return { status: 200, body: { reservations: list.map(V.reservationView) } };
}

function getReservation(ctx) {
  return { status: 200, body: V.reservationView(ownReservation(ctx.user, ctx.params.reference)) };
}

function cancelReservation(ctx) {
  const reservation = ownReservation(ctx.user, ctx.params.reference);
  if (reservation.status === 'cancelled') return { status: 200, body: V.reservationView(reservation) };
  const restaurant = restaurantById(reservation.restaurant_id);
  if (cutoffReached(reservation, restaurant, Date.now())) {
    throw errors.cutoffPassed(D.cutoffMessage(restaurant, reservation.starts_at_local));
  }
  reservation.status = 'cancelled';
  M.reindex();
  return { status: 200, body: V.reservationView(reservation) };
}

function patchReservation(ctx) {
  const reservation = ownReservation(ctx.user, ctx.params.reference);
  const body = ctx.body;
  if (reservation.status === 'cancelled') throw errors.reservationCancelled('the reservation is already cancelled');
  const restaurant = restaurantById(reservation.restaurant_id);
  if (cutoffReached(reservation, restaurant, Date.now())) {
    throw errors.cutoffPassed(D.cutoffMessage(restaurant, reservation.starts_at_local));
  }
  const tableId = optionalString(body, 'table_id') === undefined ? reservation.table_id : optionalString(body, 'table_id');
  const startsAtLocal = optionalString(body, 'starts_at_local') === undefined ? reservation.starts_at_local : optionalString(body, 'starts_at_local');
  const partySize = optionalPartySize(body, 'party_size') === undefined ? reservation.party_size : optionalPartySize(body, 'party_size');
  const target = D.resolveTarget(restaurant, tableId, startsAtLocal, partySize);
  if (!D.tableIsFree(restaurant.id, target.table.id, target.startMs, target.endMs, new Set([reservation.id]))) {
    throw errors.tableUnavailable('that table is already booked for an overlapping time');
  }
  reservation.table_id = target.table.id;
  reservation.party_size = partySize;
  reservation.starts_instant = target.startMs;
  reservation.ends_instant = target.endMs;
  reservation.starts_at_local = target.startsAtLocal;
  M.reindex();
  return { status: 200, body: V.reservationView(reservation) };
}

module.exports = {
  optionalString,
  requiredString,
  optionalPartySize,
  queryString,
  queryInteger,
  restaurantById,
  cutoffReached,
  ownReservation,
  health,
  prepareReset,
  reset,
  prepareSignup,
  prepareLogin,
  exportHandler,
  importHandler,
  signup,
  login,
  listRestaurants,
  getRestaurant,
  availability,
  createReservation,
  listReservations,
  getReservation,
  cancelReservation,
  patchReservation,
};
