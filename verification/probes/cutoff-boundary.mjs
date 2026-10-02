// Rows P33b and P33c: the cancellation cutoff boundary.
//
// Mutant 15 changed `now + cutoff >= starts_at` to `now + cutoff > starts_at` in
// stage-1/src/routes.js. Over HTTP that difference lives in a single millisecond:
// `starts_at` is always a whole local minute, so `now + cutoff*60000 == starts_at`
// holds only when the service's own clock lands on that exact millisecond, which a
// probe cannot force and would pass or fail by luck. P33b therefore asks the exported
// function the same question at three instants around the boundary, and P33c pins the
// behaviour over HTTP at minute granularity, where both implementations agree.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { GET, POST, record } from './lib.mjs';
import { fixture, reset, login, fresh } from './fixtures.mjs';

const WD = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const STAGE1 = process.env.TK_STAGE1
  || new URL('../../stage-1/src/routes.js', import.meta.url).pathname;

export default async function run() {
  // P33b the boundary itself, asked in process so the instant is exact.
  const routes = await import(pathToFileURL(STAGE1).href);
  const START = Date.parse('2026-10-02T19:00:00+02:00');
  const ask = (cutoff, now) => routes.cutoffReached({ starts_instant: START },
    { cancellation_cutoff_minutes: cutoff }, now);
  const zero = { exact: ask(0, START), after: ask(0, START + 1), before: ask(0, START - 1) };
  const hour = { exact: ask(120, START - 120 * 60000), after: ask(120, START - 120 * 60000 + 1),
    before: ask(120, START - 120 * 60000 - 1) };
  record('P33b', zero.exact && zero.after && !zero.before && hour.exact && hour.after && !hour.before,
    `cutoff 0: at the boundary ${zero.exact}, a millisecond later ${zero.after}, a millisecond earlier ${zero.before}; `
    + `cutoff 120 at exactly start minus 120 minutes: ${hour.exact}, later ${hour.after}, earlier ${hour.before}`);

  // P33c the same rule over HTTP, at the granularity a client can actually reach.
  // A client can choose the start to the minute, but the service's own clock decides
  // "now", so equality with `starts_at - cutoff` is not reachable from outside. These
  // cases pin the rule on both sides of the boundary with the cutoffs derived from the
  // clock at the moment of the call.
  let ok = true;
  const detail = [];
  const nextHour = () => new Date(Math.ceil((Date.now() + 60000) / 3600000) * 3600000);

  // A cutoff of zero: the start hour has already arrived, and the next hour has not.
  await reset(fixture({ restaurants: [openAllDay(0)] }));
  const tok0 = await login();
  const arrived = new Date(Math.floor(Date.now() / 3600000) * 3600000);
  const later = nextHour();
  const arrivedRef = await book(tok0, iso(arrived), 't_1');
  const arrivedCancel = await POST(`/reservations/${arrivedRef.json.reference}/cancel`, { token: tok0 });
  const laterRef = await book(tok0, iso(later), 't_2');
  const laterCancel = await POST(`/reservations/${laterRef.json.reference}/cancel`, { token: tok0 });
  ok = ok && arrivedCancel.status === 409 && arrivedCancel.json?.error?.code === 'cutoff_passed'
    && laterCancel.status === 200 && laterCancel.json?.status === 'cancelled';
  detail.push(`cutoff 0: a start that has arrived answers ${arrivedCancel.status} `
    + `${arrivedCancel.json?.error?.code}, a later start answers ${laterCancel.status}`);

  // The general form: one start, two cutoffs, each derived from the clock so the start
  // is unambiguously inside the window or unambiguously outside it. The distance is
  // measured again immediately before the cancel, so a minute rolling over mid-case is
  // reported rather than silently turned into a wrong expectation.
  for (const label of ['inside', 'outside']) {
    const when = nextHour();
    const distance = Math.floor((when.getTime() - Date.now()) / 60000);
    const cutoff = label === 'inside' ? distance + 2 : Math.max(0, distance - 2);
    await reset(fixture({ restaurants: [openAllDay(cutoff)] }));
    const token = await login();
    const made = await book(token, iso(when));
    const at = Math.floor((when.getTime() - Date.now()) / 60000);
    const cancel = await POST(`/reservations/${made.json.reference}/cancel`, { token });
    const still = label === 'inside' ? at < cutoff : at > cutoff;
    const right = still && (label === 'inside'
      ? cancel.status === 409 && cancel.json?.error?.code === 'cutoff_passed'
      : cancel.status === 200 && cancel.json?.status === 'cancelled');
    ok = ok && right;
    detail.push(`a start ${at} minutes out with cutoff ${cutoff}, ${label} the window, answers `
      + `${cancel.status} ${cancel.json?.error?.code || cancel.json?.status}`);
  }
  record('P33c', ok, detail.join('; '));
}

// The restaurant's timezone is Europe/Berlin, so a start derived from the clock has to
// be written in Berlin wall-clock time or the booking lands on a different minute than
// the one the arithmetic used.
const BERLIN_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function iso(date) {
  const parts = Object.fromEntries(BERLIN_FMT.formatToParts(date).map((p) => [p.type, p.value]));
  // stage-1.md wants YYYY-MM-DDTHH:MM with no seconds and no offset.
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

function openAllDay(cutoff) {
  return {
    id: 'r_anker',
    name: 'Zum Anker',
    timezone: 'Europe/Berlin',
    slot_minutes: 60,
    reservation_duration_minutes: 120,
    cancellation_cutoff_minutes: cutoff,
    tables: [{ id: 't_1', label: 'Window 1', capacity: 4 }, { id: 't_2', label: 'Window 2', capacity: 4 }],
    // Every weekday open, so a start derived from the clock is bookable whatever
    // hour the probe runs. Closing at 23:59 keeps a 120 minute booking that starts
    // at 23:00 inside opening hours.
    opening_hours: WD.map((weekday) => ({ weekday, opens: '00:00', closes: '23:59' })),
  };
}

async function book(token, starts_at_local, tableId = 't_1') {
  return POST('/reservations', {
    token,
    key: `p33-${Math.random().toString(36).slice(2)}`,
    body: { restaurant_id: 'r_anker', table_id: tableId, starts_at_local, party_size: 2 },
  });
}
