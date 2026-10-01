'use strict';

/* Local-time helpers for probes that depend on "now". */

const zone = 'Europe/Berlin';

function berlinParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value;
  const weekdays = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    weekday: weekdays[out.weekday],
  };
}

/** A bare local `YYYY-MM-DDTHH:MM` in the restaurant zone, offsetMinutes from now,
 *  rounded up to the next 30-minute grid point. */
function localSlotFromNow(offsetMinutes, stepMinutes = 30) {
  const target = new Date(Date.now() + offsetMinutes * 60000);
  const p = berlinParts(target);
  let minutes = p.hour * 60 + p.minute;
  const step = stepMinutes;
  const remainder = ((minutes % step) + step) % step;
  if (remainder !== 0) minutes += step - remainder;
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const dayShift = Math.floor(minutes / 1440);
  let base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
  const b = berlinParts(base);
  const dateText = `${String(b.year).padStart(4, '0')}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
  return { text: `${dateText}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, weekday: b.weekday, dateText };
}

/** The current local minute in the restaurant zone as a bare `YYYY-MM-DDTHH:MM`,
 *  with no rounding to a slot grid. A booking seeded at this text has already
 *  started, which is what a probe about the cancellation cutoff needs. */
function localMinuteNow() {
  const p = berlinParts(new Date());
  const dateText = `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { text: `${dateText}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`, dateText, weekday: p.weekday };
}

/**
 * A fixture whose first restaurant is open every day until the end of the day,
 * so any local slot a probe derives from the clock is bookable whatever hour the
 * suite happens to run at. Closing at 24:00 rather than 23:59 matters: a probe
 * that lands on 23:30 with a 30 minute booking would otherwise be rejected for
 * ending after closing, which would make the suite fail by time of day alone.
 */
function alwaysOpen(base, overrides = {}) {
  const fixture = JSON.parse(JSON.stringify(base));
  fixture.restaurants[0].opening_hours = [
    { weekday: 'mon', opens: '00:00', closes: '24:00' },
    { weekday: 'tue', opens: '00:00', closes: '24:00' },
    { weekday: 'wed', opens: '00:00', closes: '24:00' },
    { weekday: 'thu', opens: '00:00', closes: '24:00' },
    { weekday: 'fri', opens: '00:00', closes: '24:00' },
    { weekday: 'sat', opens: '00:00', closes: '24:00' },
    { weekday: 'sun', opens: '00:00', closes: '24:00' },
  ];
  fixture.restaurants[0].slot_minutes = 30;
  fixture.restaurants[0].reservation_duration_minutes = 30;
  Object.assign(fixture.restaurants[0], overrides);
  return fixture;
}

module.exports = { berlinParts, localSlotFromNow, localMinuteNow, alwaysOpen };
