'use strict';

const DAY_MS = 86400000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const formatters = new Map();

function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

function isValidZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function partsOf(instantMs, zone) {
  const out = {};
  for (const p of formatter(zone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

function offsetMsAt(instantMs, zone) {
  const p = partsOf(instantMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Resolve a local wall-clock time in an IANA zone to an absolute instant.
 * Returns { kind: 'ok', instantMs } for an existing local time (fold resolves to
 * the first, earlier occurrence), { kind: 'gap' } when the local time does not
 * exist, { kind: 'invalid' } when the calendar fields are not a real date.
 */
function resolveLocal(zone, year, month, day, hour, minute) {
  if (!isCalendarDate(year, month, day)) return { kind: 'invalid' };
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return { kind: 'invalid' };
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return { kind: 'invalid' };
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = new Set([
    offsetMsAt(naive - DAY_MS, zone),
    offsetMsAt(naive, zone),
    offsetMsAt(naive + DAY_MS, zone),
  ]);
  const matches = [];
  for (const off of offsets) {
    const t = naive - off;
    const p = partsOf(t, zone);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) {
      matches.push(t);
    }
  }
  if (matches.length === 0) {
    const gap = gapBounds(zone, naive);
    return { kind: 'gap', gapFrom: gap && { hour: gap.fromHour, minute: gap.fromMinute }, gapTo: gap && { hour: gap.toHour, minute: gap.toMinute } };
  }
  matches.sort((a, b) => a - b);
  return { kind: 'ok', instantMs: matches[0], ambiguous: matches.length > 1 };
}

/**
 * First instant in (loMs, hiMs] at which the zone offset differs from the
 * offset at loMs, found by bisection on whole minutes. Null when the offset
 * never changes in the window.
 */
function firstTransition(zone, loMs, hiMs) {
  const before = offsetMsAt(loMs, zone);
  if (offsetMsAt(hiMs, zone) === before) return null;
  let lo = loMs;
  let hi = hiMs;
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMsAt(mid, zone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The wall-clock window a spring-forward jump skips, as local hours and
 * minutes. Null when no forward jump is found in the window around the time.
 */
function gapBounds(zone, naiveMs) {
  const at = firstTransition(zone, naiveMs - DAY_MS, naiveMs + DAY_MS);
  if (at === null) return null;
  const jumped = (offsetMsAt(at, zone) - offsetMsAt(at - 60000, zone)) / 60000;
  if (jumped <= 0) return null;
  const after = partsOf(at, zone);
  const toMinutes = after.hour * 60 + after.minute;
  const fromMinutes = toMinutes - jumped;
  if (fromMinutes < 0) return null;
  return {
    fromHour: Math.floor(fromMinutes / 60),
    fromMinute: fromMinutes % 60,
    toHour: after.hour,
    toMinute: after.minute,
  };
}

function isCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const pad2 = (n) => String(n).padStart(2, '0');

function localDateTime(instantMs, zone) {
  const p = partsOf(instantMs, zone);
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    dateText: `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`,
    minuteText: `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`,
  };
}

function offsetText(instantMs, zone) {
  const off = offsetMsAt(instantMs, zone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const hours = Math.floor(abs / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

/** RFC 3339 with explicit offset, e.g. 2026-09-24T19:00:00+02:00 */
function rfc3339(instantMs, zone) {
  const p = partsOf(instantMs, zone);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${offsetText(instantMs, zone)}`;
}

function weekdayName(year, month, day) {
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/* ---- words for messages a person reads ---- */

const WEEKDAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_WORDS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function weekdayWord(year, month, day) {
  return WEEKDAY_WORDS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** "22 September 2026" */
function dateWords(year, month, day) {
  return `${day} ${MONTH_WORDS[month - 1]} ${year}`;
}

/** "19:00" */
function timeWords(hour, minute) {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** "90 minutes", "1 minute" */
function minutesWords(count) {
  return count === 1 ? '1 minute' : `${count} minutes`;
}

/** The compound form used before a noun: "a 90 minute booking". */
function minutesAdjective(count) {
  return `${count} minute`;
}

function minutesOfDay(hour, minute) {
  return hour * 60 + minute;
}

/** Parse a bare local `YYYY-MM-DDTHH:MM`. Returns fields or null. */
function parseLocalMinute(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
}

/**
 * True when text is a bare local `YYYY-MM-DDTHH:MM` naming a real calendar date
 * and a real time of day. This is deliberately a format and calendar question
 * only: it never resolves the minute against a zone, so a local time inside a
 * spring-forward gap still answers true here. Whether that minute exists at a
 * particular restaurant is a runtime question for the booking path, and a state
 * that legitimately stores one must stay importable.
 */
function isRealLocalMinute(text) {
  const f = parseLocalMinute(text);
  if (!f) return false;
  if (!isCalendarDate(f.year, f.month, f.day)) return false;
  if (f.hour > 23 || f.minute > 59) return false;
  return true;
}

function parseDate(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isCalendarDate(year, month, day)) return null;
  return { year, month, day };
}

function parseTimeOfDay(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59) return null;
  if (hour > 23) {
    // 24:00 is the end of the local day and is only meaningful as a closing time.
    if (hour === 24 && minute === 0) return { hour: 24, minute: 0 };
    return null;
  }
  return { hour, minute };
}

module.exports = {
  DAY_MS,
  WEEKDAYS,
  isValidZone,
  partsOf,
  offsetMsAt,
  resolveLocal,
  isCalendarDate,
  localDateTime,
  offsetText,
  rfc3339,
  weekdayName,
  weekdayWord,
  dateWords,
  timeWords,
  minutesWords,
  minutesAdjective,
  minutesOfDay,
  parseLocalMinute,
  isRealLocalMinute,
  parseDate,
  parseTimeOfDay,
};
