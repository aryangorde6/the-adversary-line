'use strict';

const http = require('node:http');
const { AppError, errors, toEnvelope } = require('./errors');
const M = require('./model');
const S = require('./store');
const R = require('./routes');
const X = require('./transfer');
const ST = require('./static');
const { reservationMoves } = require('./moves');

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDEMPOTENCY_PATHS = new Set(['/reservations', '/reservation-moves']);

const routes = [
  { method: 'GET', pattern: /^\/health$/, public: true, handler: R.health },
  { method: 'POST', pattern: /^\/_test\/reset$/, public: true, prepare: R.prepareReset, handler: R.reset },
  { method: 'GET', pattern: /^\/_test\/export$/, public: true, handler: R.exportHandler },
  { method: 'POST', pattern: /^\/_test\/import$/, public: true, handler: R.importHandler },
  { method: 'POST', pattern: /^\/auth\/signup$/, public: true, prepare: R.prepareSignup, handler: R.signup },
  { method: 'POST', pattern: /^\/auth\/login$/, public: true, prepare: R.prepareLogin, handler: R.login },
  { method: 'GET', pattern: /^\/restaurants$/, public: true, handler: R.listRestaurants },
  { method: 'GET', pattern: /^\/restaurants\/([^/]+)$/, public: true, handler: R.getRestaurant, params: ['id'] },
  { method: 'GET', pattern: /^\/availability$/, public: true, handler: R.availability },
  { method: 'POST', pattern: /^\/reservations$/, handler: R.createReservation },
  { method: 'GET', pattern: /^\/reservations$/, handler: R.listReservations },
  { method: 'GET', pattern: /^\/reservations\/([^/]+)$/, handler: R.getReservation, params: ['reference'] },
  { method: 'POST', pattern: /^\/reservations\/([^/]+)\/cancel$/, handler: R.cancelReservation, params: ['reference'] },
  { method: 'PATCH', pattern: /^\/reservations\/([^/]+)$/, handler: R.patchReservation, params: ['reference'] },
  { method: 'POST', pattern: /^\/reservation-moves$/, handler: reservationMoves },
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params = {};
    if (route.params) route.params.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(400, 'malformed_request', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(buffer, { allowEmpty }) {
  if (buffer.length === 0) {
    if (allowEmpty) return {};
    throw errors.malformedRequest('a JSON object body is required');
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw errors.malformedRequest('request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.malformedRequest('request body must be a JSON object');
  }
  return parsed;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.trim().length === 0) {
    throw errors.unauthenticated('a bearer token is required');
  }
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!m) throw errors.unauthenticated('the Authorization header must be a Bearer token');
  const value = m[1].trim();
  if (value.length === 0) throw errors.unauthenticated('a bearer token is required');
  return value;
}

function requireIdempotencyKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined || raw === null) throw errors.missingIdempotencyKey('the Idempotency-Key header is required');
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  if (value.length === 0) throw errors.missingIdempotencyKey('the Idempotency-Key header must not be empty');
  if (value.length > 255) throw errors.validationFailed('the Idempotency-Key header must be at most 255 characters');
  return value;
}

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(text);
}

function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function sendError(res, error) {
  if (error instanceof AppError) {
    sendJson(res, error.status, toEnvelope(error));
    return;
  }
  process.stderr.write(`[tablekeeper] unexpected failure: ${error && error.stack ? error.stack : String(error)}\n`);
  sendJson(res, 422, { error: { code: 'validation_failed', message: 'the request could not be processed' } });
}

function storeReceipt(userId, key, method, path, bodyHash, status, body) {
  const state = M.getState();
  const receipt = {
    user_id: userId,
    key,
    method,
    path,
    body_hash: bodyHash,
    status,
    response: body,
    response_text: JSON.stringify(body),
  };
  state.receipts.push(receipt);
  M.index.receiptsByKey.set(M.receiptKey(userId, key, method, path), receipt);
  return receipt;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://service.local');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const matched = matchRoute(req.method, pathname);
  if (!matched) {
    /* Static answers are tried only once the API has declined the path, so an
     * endpoint is never shadowed by a file and a screen route can never shadow
     * an endpoint. An unknown path then keeps the JSON error body, which is the
     * only 404 shape this service has besides a missing file, and those two
     * must not be confused: the four screen routes are the only HTML answers. */
    const served = await ST.serve(req, res, pathname);
    if (served) return;
    sendJson(res, 404, { error: { code: 'not_found', message: 'no such endpoint' } });
    return;
  }
  const needsAuth = !matched.route.public;
  const needsIdempotency = IDEMPOTENCY_PATHS.has(pathname) && req.method === 'POST';

  let user = null;
  let key = null;
  let body;
  let auth;
  try {
    const buffer = await readBody(req);
    body = parseBody(buffer, { allowEmpty: true });
    if (needsAuth) {
      const token = bearerToken(req);
      const userId = M.index.tokensByValue.get(token);
      if (!userId) throw errors.unauthenticated('the bearer token is not valid');
      user = M.index.usersById.get(userId) || null;
      if (!user) throw errors.unauthenticated('the bearer token is not valid');
    }
    if (needsIdempotency) key = requireIdempotencyKey(req);
    if (matched.route.prepare) auth = await matched.route.prepare({ body, user, query: url.searchParams, params: matched.params });
  } catch (error) {
    sendError(res, error);
    return;
  }

  const ctx = { req, query: url.searchParams, params: matched.params, body, user, key, auth };

  try {
    const result = await S.withLock(async () => {
      if (!needsIdempotency) return matched.route.handler(ctx);
      const bodyHash = S.hashBody(body);
      const existing = M.index.receiptsByKey.get(M.receiptKey(user.id, key, req.method, pathname));
      if (existing) {
        if (existing.body_hash !== bodyHash) {
          throw errors.idempotencyKeyReuse('this Idempotency-Key was already used with a different request body');
        }
        return { status: 200, body: existing.response, replay: true };
      }
      const created = matched.route.handler(ctx);
      if (created.status >= 200 && created.status < 300) {
        storeReceipt(user.id, key, req.method, pathname, bodyHash, created.status, created.body);
      }
      return created;
    });
    if (result.status === 204) {
      sendNoContent(res);
      return;
    }
    sendJson(res, result.status, result.body);
  } catch (error) {
    sendError(res, error);
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => sendError(res, error));
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  server.requestTimeout = 0;
  return server;
}

module.exports = { createServer, matchRoute, parseBody, requireIdempotencyKey, bearerToken, X, ST };
