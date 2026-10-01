'use strict';

const crypto = require('node:crypto');
const { errors } = require('./errors');
const T = require('./time');

const STATE_VERSION = 1;
const REFERENCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REFERENCE_LENGTH = 8;
const MAX_ID_LENGTH = 64;

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Stable JSON text: object keys sorted, so key order never affects equality. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashBody(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Single global write mutex: a FIFO promise queue. Every mutating
 * request runs its whole validate-then-commit inside one critical
 * section, which is what makes concurrent writes behave exactly like
 * sequential writes and keeps occupancy consistent by construction.
 * ------------------------------------------------------------------ */
let lockTail = Promise.resolve();

function withLock(fn) {
  const result = lockTail.then(fn, fn);
  lockTail = result.then(noop, noop);
  return result;
}

function noop() {}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function randomReference() {
  const bytes = crypto.randomBytes(REFERENCE_LENGTH);
  let out = '';
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) out += REFERENCE_ALPHABET[bytes[i] % REFERENCE_ALPHABET.length];
  return out;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SCRYPT_OPTS = { ...SCRYPT, maxmem: 96 * 1024 * 1024 };

function deriveKey(password, salt, length) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(password, 'utf8'), salt, length, SCRYPT_OPTS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function formatHash(key, salt) {
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return null;
  }
  if (expected.length === 0) return null;
  return { N, r, p, salt, expected };
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, 64, SCRYPT_OPTS);
  return formatHash(key, salt);
}

async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(password, salt, 64);
  return formatHash(key, salt);
}

async function hashManyAsync(passwords) {
  return Promise.all(passwords.map((password) => hashPasswordAsync(password)));
}

function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let actual;
  try {
    actual = crypto.scryptSync(Buffer.from(password, 'utf8'), parsed.salt, parsed.expected.length, {
      N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 96 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === parsed.expected.length && crypto.timingSafeEqual(actual, parsed.expected);
}

async function verifyPasswordAsync(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let actual;
  try {
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(Buffer.from(password, 'utf8'), parsed.salt, parsed.expected.length, {
        N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 96 * 1024 * 1024,
      }, (error, key) => (error ? reject(error) : resolve(key)));
    });
  } catch {
    return false;
  }
  return actual.length === parsed.expected.length && crypto.timingSafeEqual(actual, parsed.expected);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, message) {
  if (!isPlainObject(value)) throw errors.validationFailed(message || 'body must be a JSON object');
  return value;
}

/* ---- fixture field types ----
 * Spec section 5 reserves 400 malformed_request for a body that does not parse
 * or a field of the wrong JSON type, and gives 422 validation_failed to a field
 * of the correct type whose format or value is wrong. It also gives 422 to "a
 * required field, query parameter or header is missing", so the line this draws
 * is between a field that is absent and a field that is present and wrongly
 * typed. These guards draw it for the fixture path only; the endpoint paths keep
 * their own rules, and section 11 keeps a badly shaped batch move at 422. */

/* Absent is missing, not mistyped: undefined and null both mean the caller left
 * the field out, which is section 5's 422. This matches how every endpoint
 * already treats a null body field, so one rule now covers the whole service. */
function present(value) {
  return value !== undefined && value !== null;
}

function requireRecord(value, message) {
  if (!present(value)) throw errors.validationFailed(`${message} is missing`);
  if (!isPlainObject(value)) throw errors.malformedRequest(message);
  return value;
}

function requireList(value, message) {
  if (!present(value)) throw errors.validationFailed(`${message} is missing`);
  if (!Array.isArray(value)) throw errors.malformedRequest(message);
  return value;
}

function requireText(value, message) {
  if (!present(value)) throw errors.validationFailed(`${message} is missing`);
  if (typeof value !== 'string') throw errors.malformedRequest(message);
  return value;
}

function requireAmount(value, message) {
  if (!present(value)) throw errors.validationFailed(`${message} is missing`);
  if (typeof value !== 'number' || Number.isNaN(value)) throw errors.malformedRequest(message);
  return value;
}

function requireId(value, name) {
  if (!present(value)) throw errors.validationFailed(`${name} is missing`);
  if (typeof value !== 'string') throw errors.malformedRequest(`${name} must be a string`);
  if (value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw errors.validationFailed(`${name} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function requireInteger(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw errors.validationFailed(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) throw errors.validationFailed(`${name} must be at least ${min}`);
  if (max !== undefined && value > max) throw errors.validationFailed(`${name} must be at most ${max}`);
  return value;
}

function emailLooksValid(email) {
  if (typeof email !== 'string') return false;
  if (email.length < 3 || email.length > 254) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

module.exports = {
  STATE_VERSION,
  MAX_ID_LENGTH,
  deepClone,
  canonicalJson,
  hashBody,
  withLock,
  randomToken,
  randomReference,
  hashPassword,
  hashPasswordAsync,
  hashManyAsync,
  verifyPassword,
  verifyPasswordAsync,
  isPlainObject,
  requireObject,
  requireRecord,
  requireList,
  requireText,
  requireAmount,
  requireId,
  requireInteger,
  emailLooksValid,
};
