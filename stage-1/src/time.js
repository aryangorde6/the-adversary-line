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
  if (matches.length === 0) return { kind: 'gap' };
  matches.sort((a, b) => a - b);
  return { kind: 'ok', instantMs: matches[0], ambiguous: matches.length > 1 };
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
  minutesOfDay,
  parseLocalMinute,
  parseDate,
  parseTimeOfDay,
};
