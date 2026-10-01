'use strict';

const { errors } = require('./errors');
const M = require('./model');
const S = require('./store');
const T = require('./time');

/* ----------------------------- ids ----------------------------- */

function nextUserId() {
  const st = M.getState();
  let n = st.counters.user;
  let id;
  do {
    n += 1;
    id = `u_${n}`;
  } while (M.index.usersById.has(id));
  st.counters.user = n;
  return id;
}

function nextReservationId() {
  const st = M.getState();
  let n = st.counters.reservation;
  let id;
  do {
    n += 1;
    id = `res_${n}`;
  } while (M.index.reservationsById.has(id));
  st.counters.reservation = n;
  return id;
}

function newReference() {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = S.randomReference();
    if (!M.index.references.has(candidate)) return candidate;
  }
  const st = M.getState();
  const base = S.randomReference();
  let n = 0;
  while (true) {
    n += 1;
    const candidate = `${base}${n.toString(36).toUpperCase()}`.slice(0, 12);
    if (candidate.length >= 6 && !M.index.references.has(candidate)) return candidate;
  }
}

/* ------------------------- opening hours ------------------------- */

function rangesForWeekday(restaurant, weekday) {
  return restaurant.opening_hours.filter((h) => h.weekday === weekday);
}

function slotLocalMinutes(restaurant, weekday) {
  const duration = restaurant.reservation_duration_minutes;
  const step = restaurant.slot_minutes;
  const out = [];
  for (const range of rangesForWeekday(restaurant, weekday)) {
    const opens = T.parseTimeOfDay(range.opens);
    const closes = T.parseTimeOfDay(range.closes);
    if (!opens || !closes) continue;
    const openMinutes = T.minutesOfDay(opens.hour, opens.minute);
    const closeMinutes = T.minutesOfDay(closes.hour, closes.minute);
    for (let m = openMinutes; m + duration <= closeMinutes; m += step) {
      out.push({ minutes: m, opensAt: openMinutes, closesAt: closeMinutes, range });
    }
  }
  out.sort((a, b) => a.minutes - b.minutes);
  return out;
}

/* --------------------------- occupancy --------------------------- */

/** Half-open [startMs, endMs). */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function tableIsFree(restaurantId, tableId, startMs, endMs, ignore) {
  const ignoreSet = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  for (const r of M.getState().reservations) {
    if (r.status !== 'confirmed') continue;
    if (r.restaurant_id !== restaurantId || r.table_id !== tableId) continue;
    if (ignoreSet.has(r.id)) continue;
    if (overlaps(startMs, endMs, r.starts_instant, r.ends_instant)) return false;
  }
  return true;
}

/* ------------------------ booking validation ---------------------- */

/**
 * Validate one booking's target against a restaurant and return the resolved
 * instants. Shared by POST /reservations, PATCH /reservations/{reference} and
 * every item of POST /reservation-moves so all three enforce identical rules.
 */
function resolveTarget(restaurant, tableId, startsAtLocalText, partySize) {
  const fields = T.parseLocalMinute(startsAtLocalText);
  if (!fields) throw errors.validationFailed('starts_at_local must be a bare local YYYY-MM-DDTHH:MM value');
  const table = restaurant.tables.find((t) => t.id === tableId);
  if (!table) throw errors.notFound('no such table in this restaurant');

  const local = T.resolveLocal(restaurant.timezone, fields.year, fields.month, fields.day, fields.hour, fields.minute);
  if (local.kind === 'gap') {
    throw errors.invalidLocalTime('starts_at_local does not exist in the restaurant timezone on that date');
  }
  if (local.kind !== 'ok') throw errors.validationFailed('starts_at_local is not a real local time');
  const startMs = local.instantMs;
  const durationMs = restaurant.reservation_duration_minutes * 60000;
  const endMs = startMs + durationMs;

  const weekday = T.weekdayName(fields.year, fields.month, fields.day);
  const ranges = rangesForWeekday(restaurant, weekday);
  const minutes = T.minutesOfDay(fields.hour, fields.minute);
  if (ranges.length === 0) throw errors.outsideOpeningHours('the restaurant is closed on that weekday');
  const inHours = ranges
    .map((range) => {
      const opens = T.parseTimeOfDay(range.opens);
      const closes = T.parseTimeOfDay(range.closes);
      if (!opens || !closes) return null;
      return {
        openMinutes: T.minutesOfDay(opens.hour, opens.minute),
        closeMinutes: T.minutesOfDay(closes.hour, closes.minute),
      };
    })
    .filter((r) => r !== null && minutes >= r.openMinutes && minutes <= r.closeMinutes);
  if (inHours.length === 0) throw errors.outsideOpeningHours('the slot is outside opening hours');
  const onGrid = inHours.filter((r) => (minutes - r.openMinutes) % restaurant.slot_minutes === 0);
  if (onGrid.length === 0) throw errors.notOnSlotGrid('starts_at_local is not on the slot grid');
  if (!onGrid.some((r) => minutes + restaurant.reservation_duration_minutes <= r.closeMinutes)) {
    throw errors.outsideOpeningHours('the reservation would end after closing time');
  }

  if (partySize > table.capacity) {
    throw errors.partyExceedsCapacity('party_size exceeds the capacity of the table');
  }
  return { table, startMs, endMs, startsAtLocal: startsAtLocalText };
}

module.exports = {
  nextUserId,
  nextReservationId,
  newReference,
  rangesForWeekday,
  slotLocalMinutes,
  overlaps,
  tableIsFree,
  resolveTarget,
};
