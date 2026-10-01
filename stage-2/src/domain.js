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

/** Every table id a stored reservation occupies. Reads the stage-2 array shape
 * and falls back to the stage-1 singular field, so a record imported from a
 * stage-1 export is treated exactly like one this service wrote. */
function reservedTableIds(reservation) {
  if (Array.isArray(reservation.table_ids)) return reservation.table_ids;
  if (typeof reservation.table_id === 'string') return [reservation.table_id];
  return [];
}

/** The first occupied table that collides, or null when the whole set is free.
 * A combination is free only when every member is, so one taken table is enough
 * to refuse it. */
function blockingTableId(restaurantId, tableIds, startMs, endMs, ignore) {
  const wanted = new Set(tableIds);
  const ignoreSet = ignore instanceof Set ? ignore : new Set(ignore ? [ignore] : []);
  for (const r of M.getState().reservations) {
    if (r.status !== 'confirmed') continue;
    if (r.restaurant_id !== restaurantId) continue;
    if (ignoreSet.has(r.id)) continue;
    if (!reservedTableIds(r).some((id) => wanted.has(id))) continue;
    if (overlaps(startMs, endMs, r.starts_instant, r.ends_instant)) return r;
  }
  return null;
}

function tablesAreFree(restaurantId, tableIds, startMs, endMs, ignore) {
  return blockingTableId(restaurantId, tableIds, startMs, endMs, ignore) === null;
}

/** Tables two results would share, or an empty array when they share none.
 * Set intersection, because two combinations can collide on any member without
 * their ids being equal anywhere. */
function sharedTableIds(aTableIds, bTableIds) {
  const b = new Set(bTableIds);
  return aTableIds.filter((id) => b.has(id));
}

/**
 * Read the table set of a booking out of one object, from `table_ids` or from a
 * singular `table_id` read as a set of one. This is the only place either shape
 * is interpreted, so every path that accepts a booking set agrees on which
 * spellings exist and on which defects are refused.
 *
 * `mode` decides one thing, because a request and a stored record are not the
 * same thing. A request carrying both spellings is refused outright, because a
 * caller sending two descriptions of one booking is ambiguous no matter whether
 * they happen to agree. A stored record carrying both is accepted when the two
 * agree, because a record is state to be carried rather than a request to be
 * obeyed, and refusing a pair of fields that say the same thing would reject a
 * state the service can represent. Either way a genuine contradiction is 422.
 *
 * Order is the order written, never sorted: available_options orders by
 * combinable order, so a set read from anywhere must not be reordered here.
 */
function tableSetFrom(source, label, mode) {
  const singular = source.table_id !== undefined && source.table_id !== null;
  const plural = source.table_ids !== undefined && source.table_ids !== null;
  if (!singular && !plural) {
    throw errors.validationFailed(`${label} must name the tables for this booking`);
  }

  const readSet = () => {
    if (!Array.isArray(source.table_ids)) throw errors.validationFailed(`${label}.table_ids must be an array of table ids`);
    return source.table_ids.map((value, i) => S.requireId(value, `${label}.table_ids[${i}]`));
  };

  if (singular && plural) {
    if (mode !== 'stored') {
      throw errors.validationFailed(`${label} must carry either table_id or table_ids, not both`);
    }
    const set = readSet();
    const single = S.requireId(source.table_id, `${label}.table_id`);
    /* A singular field can only ever mean a set of one, so two spellings agree
     * only when the set has one member and it is that table. */
    if (set.length !== 1 || set[0] !== single) {
      throw errors.validationFailed(`${label} disagrees with itself: table_ids names ${set.join(' and ')} while table_id names ${single}`);
    }
    return set;
  }

  const ids = plural ? readSet() : [S.requireId(source.table_id, `${label}.table_id`)];
  if (ids.length === 0) throw errors.validationFailed(`${label} must name at least one table`);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw errors.validationFailed(`${label} names table ${id} twice`);
    seen.add(id);
  }
  return ids;
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

/** The one sentence used everywhere a booking can no longer be changed because
 * the restaurant needs notice first. Shared by cancel, amend and batch moves.
 */
function cutoffMessage(restaurant, startsAtLocalText) {
  const fields = T.parseLocalMinute(startsAtLocalText);
  const when = fields
    ? `${startWords(fields)} on ${dayWords(fields)}`
    : `${startsAtLocalText}`;
  return `${restaurantName(restaurant)} needs ${noticeWords(restaurant.cancellation_cutoff_minutes)} notice before a booking starts, and this one starts at ${when}, so it can no longer be cancelled or changed.`;
}

/**
 * Validate one booking's target against a restaurant and return the resolved
 * instants. Shared by POST /reservations, PATCH /reservations/{reference} and
 * every item of POST /reservation-moves so all three enforce identical rules.
 *
 * Takes the whole table set. Seats add up, so capacity is the sum over the set
 * rather than the capacity of any one table; a two-table combination of two
 * 2-seat tables seats 4.
 */
function resolveTarget(restaurant, tableIds, startsAtLocalText, partySize) {
  const name = restaurantName(restaurant);
  const fields = T.parseLocalMinute(startsAtLocalText);
  if (!fields) {
    throw errors.validationFailed('The start time must be written like 2026-09-24T19:00, with no seconds and no time zone.');
  }
  if (!T.isCalendarDate(fields.year, fields.month, fields.day)) {
    throw errors.validationFailed(`${T.dateWords(fields.year, fields.month, fields.day)} is not a date.`);
  }
  const tables = [];
  for (const id of tableIds) {
    const table = restaurant.tables.find((t) => t.id === id);
    if (!table) throw errors.notFound('no such table in this restaurant');
    tables.push(table);
  }

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

  const seats = tables.reduce((sum, t) => sum + t.capacity, 0);
  if (partySize > seats) {
    throw errors.partyExceedsCapacity(capacityWords(tables, name, seats, partySize));
  }
  return { tables, tableIds: [...tableIds], startMs, endMs, startsAtLocal: startsAtLocalText };
}

/** The seats sentence, kept verbatim for a single table so the stage-1 wording
 * is unchanged, and summed for a combination where no single table would read
 * correctly. */
function capacityWords(tables, name, seats, partySize) {
  if (tables.length === 1) {
    return `${tableWords(tables[0])} at ${name} seats ${tables[0].capacity}, and you asked for ${partySize}.`;
  }
  const names = tables.map((t) => tableWords(t)).join(' and ');
  return `${names} at ${name} seat ${seats} between them, and you asked for ${partySize}.`;
}

/* ------------------------- combination policy ---------------------- */

/** Is this pair one the restaurant declared? A declared pair is unordered, so
 * either written order matches, which is the same comparison the fixture
 * validation makes when it refuses a repeated pair. */
function declaresPair(restaurant, a, b) {
  return restaurant.combinable.some((pair) => (pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a));
}

/**
 * Refuse any table set the restaurant has not offered. One table always exists
 * to be booked; two tables must be a declared pair; anything longer is not a
 * thing this service can seat at all.
 *
 * Declared rather than inferable on purpose. Two tables that happen to be free
 * together are not thereby combinable, and quietly accepting the pair would let
 * a client seat a party across tables the restaurant has never offered as one.
 * So this runs before any freeness check: an undeclared pair is refused whether
 * or not the tables happen to be free.
 */
function checkCombinationAllowed(restaurant, tableIds) {
  if (tableIds.length === 1) return tableIds;
  if (tableIds.length > 2) {
    throw errors.combinationNotAllowed(`a booking can use at most two tables, and this one asks for ${tableIds.length}.`);
  }
  const [a, b] = tableIds;
  if (!declaresPair(restaurant, a, b)) {
    throw errors.combinationNotAllowed(`${restaurantName(restaurant)} does not offer ${tableWordsById(restaurant, a)} together with ${tableWordsById(restaurant, b)}, so they cannot be booked as one.`);
  }
  return tableIds;
}

/** Table words for an id that may not resolve, so the sentence still reads. */
function tableWordsById(restaurant, id) {
  const table = restaurant.tables.find((t) => t.id === id);
  return table ? tableWords(table) : id;
}

/** The unavailability sentence, kept verbatim for one table. */
function unavailableWords(tableIds) {
  if (tableIds.length === 1) return 'that table is already booked for an overlapping time';
  return `one of those tables is already booked for an overlapping time, so the pair cannot be taken as a whole`;
}

module.exports = {
  nextUserId,
  nextReservationId,
  newReference,
  rangesForWeekday,
  slotLocalMinutes,
  overlaps,
  tablesAreFree,
  blockingTableId,
  reservedTableIds,
  sharedTableIds,
  tableSetFrom,
  resolveTarget,
  restaurantName,
  tableWords,
  declaresPair,
  checkCombinationAllowed,
  unavailableWords,
  cutoffMessage,
};
