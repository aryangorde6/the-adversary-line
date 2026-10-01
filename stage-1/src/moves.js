'use strict';

const { errors } = require('./errors');
const M = require('./model');
const D = require('./domain');
const V = require('./service');
const R = require('./routes');

const MAX_MOVES = 8;

function reservationMoves(ctx) {
  const body = ctx.body;
  const moves = body.moves;
  if (!Array.isArray(moves)) throw errors.validationFailed('moves must be an array');
  if (moves.length < 1 || moves.length > MAX_MOVES) {
    throw errors.validationFailed(`moves must contain between 1 and ${MAX_MOVES} items`);
  }
  const seen = new Set();
  const items = moves.map((entry) => {
    const obj = M.requireObject(entry, 'each move must be an object');
    const reference = obj.reference;
    if (typeof reference !== 'string' || reference.length === 0) {
      throw errors.validationFailed('each move needs a non-empty reference');
    }
    if (seen.has(reference)) throw errors.validationFailed(`duplicate reference ${reference} in moves`);
    seen.add(reference);
    return {
      reference,
      tableId: R.optionalString(obj, 'table_id'),
      startsAtLocal: R.optionalString(obj, 'starts_at_local'),
      partySize: R.optionalPartySize(obj, 'party_size'),
    };
  });

  const reservations = items.map((item) => {
    const reservation = M.index.reservationsByRef.get(item.reference);
    if (!reservation || reservation.user_id !== ctx.user.id) {
      throw errors.notFound('no such reservation in your bookings');
    }
    return reservation;
  });

  const restaurantId = reservations[0].restaurant_id;
  if (!reservations.every((r) => r.restaurant_id === restaurantId)) {
    throw errors.validationFailed('every booking in a batch must be at the same restaurant');
  }
  const restaurant = R.restaurantById(restaurantId);
  const now = Date.now();

  const planned = [];
  for (let i = 0; i < items.length; i += 1) {
    const reservation = reservations[i];
    const item = items[i];
    if (reservation.status === 'cancelled') throw errors.reservationCancelled('the reservation is already cancelled');
    if (R.cutoffReached(reservation, restaurant, now)) {
      throw errors.cutoffPassed('the amendment cutoff for this booking has passed');
    }
    const target = D.resolveTarget(
      restaurant,
      item.tableId === undefined ? reservation.table_id : item.tableId,
      item.startsAtLocal === undefined ? reservation.starts_at_local : item.startsAtLocal,
      item.partySize === undefined ? reservation.party_size : item.partySize,
    );
    planned.push({ reservation, target });
  }

  const ignore = new Set(reservations.map((r) => r.id));
  for (const entry of planned) {
    const { table, startMs, endMs } = entry.target;
    if (!D.tableIsFree(restaurantId, table.id, startMs, endMs, ignore)) {
      throw errors.tableUnavailable('that table is already booked for an overlapping time');
    }
  }
  for (let i = 0; i < planned.length; i += 1) {
    for (let j = i + 1; j < planned.length; j += 1) {
      const a = planned[i].target;
      const b = planned[j].target;
      if (a.table.id !== b.table.id) continue;
      if (D.overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) {
        throw errors.tableUnavailable('the requested bookings would overlap each other');
      }
    }
  }

  for (let i = 0; i < planned.length; i += 1) {
    const { reservation, target } = planned[i];
    const item = items[i];
    if (item.tableId !== undefined) reservation.table_id = target.table.id;
    if (item.startsAtLocal !== undefined) {
      reservation.starts_instant = target.startMs;
      reservation.ends_instant = target.endMs;
      reservation.starts_at_local = target.startsAtLocal;
    }
    if (item.partySize !== undefined) reservation.party_size = item.partySize;
  }
  M.reindex();
  return {
    status: 201,
    body: { reservations: reservations.map((reservation) => V.reservationView(reservation)) },
  };
}

module.exports = { reservationMoves };
