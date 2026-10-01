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
/* ------------------------- message wording ------------------------- */

/** "Zum Anker" for a restaurant, falling back to "this restaurant". */
function restaurantName(restaurant) {
  return restaurant.name ? `${restaurant.name}` : 'this restaurant';
}

/**
 * How a person refers to a table: a bare number reads as "Table 2", while a
 * label that already carries a word, such as "Window 3", is used as it stands.
 */
function tableWords(table) {
  return /^[0-9]/.test(table.label) ? `Table ${table.label}` : `${table.label}`;
}

/** "18:00 to 23:00", one item per opening range on that day. */
function openingWords(ranges) {
  return ranges
    .map((r) => `${T.timeWords(r.open.hour, r.open.minute)} to ${T.timeWords(r.close.hour, r.close.minute)}`)
    .join(' and ');
}

function startWords(fields) {
  return T.timeWords(fields.hour, fields.minute);
}

function dayWords(fields) {
  return `${T.weekdayWord(fields.year, fields.month, fields.day)} ${T.dateWords(fields.year, fields.month, fields.day)}`;
}

/** "90 minutes" with the possessive apostrophe the notice sentence needs. */
function noticeWords(minutes) {
  return `${T.minutesWords(minutes)}'`;
}

/**
 * The one sentence used everywhere a booking can no longer be changed because
 * the restaurant needs notice first. Shared by cancel, amend and batch moves.
 */
function cutoffMessage(restaurant, startsAtLocalText) {
  const fields = T.parseLocalMinute(startsAtLocalText);
  const when = fields
    ? `${startWords(fields)} on ${dayWords(fields)}`
    : `${startsAtLocalText}`;
  return `${restaurantName(restaurant)} needs ${noticeWords(restaurant.cancellation_cutoff_minutes)} notice before a booking starts, and this one starts at ${when}, so it can no longer be cancelled or changed.`;
}

function resolveTarget(restaurant, tableId, startsAtLocalText, partySize) {
  const name = restaurantName(restaurant);
  const fields = T.parseLocalMinute(startsAtLocalText);
  if (!fields) {
    throw errors.validationFailed('The start time must be written like 2026-09-24T19:00, with no seconds and no time zone.');
  }
  if (!T.isCalendarDate(fields.year, fields.month, fields.day)) {
    throw errors.validationFailed(`${T.dateWords(fields.year, fields.month, fields.day)} is not a date.`);
  }
  const table = restaurant.tables.find((t) => t.id === tableId);
  if (!table) throw errors.notFound('no such table in this restaurant');

  const local = T.resolveLocal(restaurant.timezone, fields.year, fields.month, fields.day, fields.hour, fields.minute);
  if (local.kind === 'gap') {
    const jump = local.gapFrom && local.gapTo
      ? `, because the clocks go forward from ${T.timeWords(local.gapFrom.hour, local.gapFrom.minute)} to ${T.timeWords(local.gapTo.hour, local.gapTo.minute)}, so nothing happens between those times`
      : '';
    throw errors.invalidLocalTime(`${startWords(fields)} does not exist at ${name} on ${T.dateWords(fields.year, fields.month, fields.day)}${jump}.`);
  }
  if (local.kind !== 'ok') throw errors.validationFailed(`${startWords(fields)} is not a time of day.`);
  const startMs = local.instantMs;
  const durationMs = restaurant.reservation_duration_minutes * 60000;
  const endMs = startMs + durationMs;

  const weekday = T.weekdayName(fields.year, fields.month, fields.day);
  const ranges = rangesForWeekday(restaurant, weekday);
  const minutes = T.minutesOfDay(fields.hour, fields.minute);
  if (ranges.length === 0) throw errors.outsideOpeningHours(`${name} is closed on ${dayWords(fields)}.`);
  const inHours = ranges
    .map((range) => {
      const opens = T.parseTimeOfDay(range.opens);
      const closes = T.parseTimeOfDay(range.closes);
      if (!opens || !closes) return null;
      return {
        open: opens,
        close: closes,
        openMinutes: T.minutesOfDay(opens.hour, opens.minute),
        closeMinutes: T.minutesOfDay(closes.hour, closes.minute),
      };
    })
    .filter((r) => r !== null && minutes >= r.openMinutes && minutes <= r.closeMinutes);
  if (inHours.length === 0) {
    const todays = ranges
      .map((r) => ({ open: T.parseTimeOfDay(r.opens), close: T.parseTimeOfDay(r.closes) }))
      .filter((r) => r.open && r.close);
    throw errors.outsideOpeningHours(`${name} is open ${openingWords(todays)} on ${dayWords(fields)}, and ${startWords(fields)} is outside those hours.`);
  }
  /* Containment first, as one rule: a start must fall inside an open window and
   * the booking must finish before that window closes. Whichever half fails is
   * outside_opening_hours whatever the slot grid says, so the grid is only ever
   * consulted for a start that is genuinely inside the open window. */
  const closing = inHours.find((r) => minutes + restaurant.reservation_duration_minutes > r.closeMinutes);
  if (closing) {
    const endMinutes = minutes + restaurant.reservation_duration_minutes;
    const nextDay = endMinutes >= 1440;
    const endText = `${T.timeWords(Math.floor((endMinutes % 1440) / 60), endMinutes % 60)}${nextDay ? ' the next day' : ''}`;
    throw errors.outsideOpeningHours(`A ${T.minutesAdjective(restaurant.reservation_duration_minutes)} booking from ${startWords(fields)} would end at ${endText}, after ${name} closes at ${T.timeWords(closing.close.hour, closing.close.minute)}.`);
  }
  const onGrid = inHours.filter((r) => (minutes - r.openMinutes) % restaurant.slot_minutes === 0);
  if (onGrid.length === 0) {
    const first = inHours[0];
    throw errors.notOnSlotGrid(`${startWords(fields)} is not one of the start times ${name} offers; ${name} takes bookings every ${T.minutesWords(restaurant.slot_minutes)} from ${T.timeWords(first.open.hour, first.open.minute)}.`);
  }

  if (partySize > table.capacity) {
    throw errors.partyExceedsCapacity(`${tableWords(table)} at ${name} seats ${table.capacity}, and you asked for ${partySize}.`);
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
  restaurantName,
  tableWords,
  cutoffMessage,
};
