'use strict';

const { errors } = require('./errors');
const M = require('./model');
const S = require('./store');
const { setState } = require('./service');

const TRACK = 'tablekeeper';
const FORMAT_VERSION = 1;

function exportSnapshot() {
  const state = M.getState();
  return {
    track: TRACK,
    format_version: FORMAT_VERSION,
    state: S.deepClone({
      v: state.v,
      counters: state.counters,
      users: state.users,
      tokens: state.tokens,
      restaurants: state.restaurants,
      reservations: state.reservations,
      receipts: state.receipts,
    }),
  };
}

const isPlainObject = S.isPlainObject;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isCount(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isOffsetInstant(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateUser(user) {
  return isPlainObject(user)
    && isNonEmptyString(user.id)
    && isNonEmptyString(user.email)
    && typeof user.display_name === 'string'
    && isNonEmptyString(user.password_hash);
}

function validateToken(token) {
  return isPlainObject(token) && isNonEmptyString(token.token) && isNonEmptyString(token.user_id);
}

function validateRestaurant(r) {
  return isPlainObject(r)
    && isNonEmptyString(r.id)
    && isNonEmptyString(r.timezone)
    && isCount(r.slot_minutes)
    && isCount(r.reservation_duration_minutes)
    && isCount(r.cancellation_cutoff_minutes)
    && Array.isArray(r.opening_hours)
    && r.opening_hours.every((h) => isPlainObject(h) && isNonEmptyString(h.weekday) && isNonEmptyString(h.opens) && isNonEmptyString(h.closes))
    && Array.isArray(r.tables)
    && r.tables.every((t) => isPlainObject(t) && isNonEmptyString(t.id) && isCount(t.capacity));
}

function validateReservation(r) {
  return isPlainObject(r)
    && isNonEmptyString(r.id)
    && isNonEmptyString(r.reference)
    && isNonEmptyString(r.user_id)
    && isNonEmptyString(r.restaurant_id)
    && isNonEmptyString(r.table_id)
    && isCount(r.party_size)
    && r.party_size >= 1
    && (r.status === 'confirmed' || r.status === 'cancelled')
    && isNonEmptyString(r.starts_at_local)
    && isOffsetInstant(r.starts_instant)
    && isOffsetInstant(r.ends_instant)
    && isOffsetInstant(r.created_at);
}

function validateReceipt(r) {
  return isPlainObject(r)
    && isNonEmptyString(r.user_id)
    && typeof r.key === 'string'
    && isNonEmptyString(r.method)
    && isNonEmptyString(r.path)
    && isNonEmptyString(r.body_hash)
    && isCount(r.status)
    && r.status >= 100
    && r.status < 300
    && r.response !== undefined
    && r.response_text !== undefined;
}

/**
 * Validate an exported envelope and return a state object ready to install.
 * Throws 422 validation_failed without touching the destination on any problem.
 */
function parseImport(payload) {
  if (!isPlainObject(payload)) throw errors.validationFailed('import body must be a JSON object');
  if (payload.track !== TRACK) throw errors.validationFailed('import body has the wrong track');
  if (payload.format_version !== FORMAT_VERSION) throw errors.validationFailed('import body has an unsupported format_version');
  const state = payload.state;
  if (!isPlainObject(state)) throw errors.validationFailed('import state must be a JSON object');
  const counters = state.counters;
  if (!isPlainObject(counters) || !isCount(counters.user) || !isCount(counters.reservation)) {
    throw errors.validationFailed('import state has invalid counters');
  }
  for (const key of ['users', 'tokens', 'restaurants', 'reservations', 'receipts']) {
    if (!Array.isArray(state[key])) throw errors.validationFailed(`import state.${key} must be an array`);
  }
  if (!state.users.every(validateUser)) throw errors.validationFailed('import state has an invalid user record');
  if (!state.tokens.every(validateToken)) throw errors.validationFailed('import state has an invalid token record');
  if (!state.restaurants.every(validateRestaurant)) throw errors.validationFailed('import state has an invalid restaurant record');
  if (!state.reservations.every(validateReservation)) throw errors.validationFailed('import state has an invalid reservation record');
  if (!state.receipts.every(validateReceipt)) throw errors.validationFailed('import state has an invalid idempotency receipt');
  return {
    v: S.STATE_VERSION,
    counters: { user: counters.user, reservation: counters.reservation },
    users: S.deepClone(state.users),
    tokens: S.deepClone(state.tokens),
    restaurants: S.deepClone(state.restaurants),
    reservations: S.deepClone(state.reservations),
    receipts: S.deepClone(state.receipts),
  };
}

function importSnapshot(payload) {
  const next = parseImport(payload);
  setState(next);
}

module.exports = { exportSnapshot, importSnapshot, parseImport, TRACK, FORMAT_VERSION };
