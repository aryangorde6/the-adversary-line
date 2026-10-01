'use strict';

/* Probe helpers for the stage-1 suite. The service is booted in-process on an
 * ephemeral port, so the suite needs no container and no background process. */

const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

const state = { base: '', failures: [], checks: 0, passed: 0, server: null };

async function start() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.server = server;
  return server;
}

async function stop() {
  if (!state.server) return;
  await new Promise((resolve) => state.server.close(resolve));
  state.server = null;
}

async function call(method, path, options = {}) {
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  let payload;
  if (options.rawBody !== undefined) {
    payload = options.rawBody;
    headers['Content-Type'] = 'application/json';
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${state.base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

function expectError(res, status, code, label) {
  assert.equal(res.status, status, `${label}: status ${res.status}, body ${res.text}`);
  assert.ok(res.json && res.json.error !== undefined, `${label}: missing error envelope, body ${res.text}`);
  assert.equal(res.json.error.code, code, `${label}: code ${res.json.error.code}`);
  assert.equal(typeof res.json.error.message, 'string', `${label}: message is not a string`);
  assert.ok(res.json.error.message.length > 0, `${label}: message is empty`);
}

async function reset(fixture) {
  const res = await call('POST', '/_test/reset', { body: fixture });
  assert.equal(res.status, 204, `reset: status ${res.status}, body ${res.text}`);
  assert.equal(res.text, '', 'reset must return no body');
}

async function login(email, password) {
  const res = await call('POST', '/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login ${email}: status ${res.status}, body ${res.text}`);
  return res.json.token;
}

async function step(name, fn) {
  state.checks += 1;
  try {
    await fn();
    state.passed += 1;
  } catch (error) {
    state.failures.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}

function report() {
  return { checks: state.checks, passed: state.passed, failures: state.failures };
}

const FIXTURE = {
  users: [
    { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' },
    { id: 'u_bob', email: 'bob@example.com', password: 'hunter22hunter', display_name: 'Bob' },
  ],
  restaurants: [
    {
      id: 'r_anker',
      name: 'Zum Anker',
      timezone: 'Europe/Berlin',
      slot_minutes: 30,
      reservation_duration_minutes: 90,
      cancellation_cutoff_minutes: 120,
      opening_hours: [
        { weekday: 'thu', opens: '18:00', closes: '23:00' },
        { weekday: 'fri', opens: '18:00', closes: '23:30' },
        { weekday: 'sat', opens: '18:00', closes: '23:59' },
        { weekday: 'sun', opens: '09:00', closes: '22:00' },
      ],
      tables: [
        { id: 't_1', label: '1', capacity: 2 },
        { id: 't_2', label: '2', capacity: 4 },
        { id: 't_3', label: '3', capacity: 6 },
      ],
    },
    {
      id: 'r_ny',
      name: 'Deli',
      timezone: 'America/New_York',
      slot_minutes: 60,
      reservation_duration_minutes: 60,
      cancellation_cutoff_minutes: 30,
      opening_hours: [{ weekday: 'sat', opens: '10:00', closes: '22:00' }],
      tables: [{ id: 'n_1', label: 'A', capacity: 4 }],
    },
  ],
  reservations: [],
};

module.exports = { start, stop, call, expectError, reset, login, step, report, FIXTURE, assert, state };
