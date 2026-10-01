'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/* Static files and the four screen routes.
 *
 * This is a file-serving path in an internet-facing service, so the URL is
 * treated as hostile input throughout. Every check that can be made without
 * touching the filesystem is made first, then the path is resolved and compared
 * against the root, then the real path is resolved again so a symlink that
 * leaves the root is refused even though the textual path looked contained.
 *
 * Nothing here is reached from inside the write mutex: serving a file is
 * synchronous with respect to the state and never touches it. */

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/* The four screen routes, and the same four files reached with the extension
 * still on the URL. Both spellings answer with the same bytes, so a bookmark
 * with or without .html gets the same page. */
const SCREENS = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/signup', 'signup.html'],
  ['/signup.html', 'signup.html'],
  ['/login', 'login.html'],
  ['/login.html', 'login.html'],
  ['/lookup', 'lookup.html'],
  ['/lookup.html', 'lookup.html'],
]);

/* Only these are served. An unrecognised extension is a miss rather than an
 * octet-stream answer, so nothing that lands in public/ by accident becomes
 * fetchable just by being there. */
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

function contentTypeFor(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) || null;
}

/** The file a request may be answered with, or null for a miss.
 *
 * Split out from serving so the decision can be probed without a socket.
 *
 * Order matters here. A NUL byte, a percent escape that will not decode, a
 * `..` segment and a backslash are all refused before any path is built, because
 * a path built from one of them is a path whose meaning is decided by
 * something other than this function. Only after that is a candidate joined to
 * the root, compared against the root for containment, and then handed to the
 * filesystem. */
function resolvePublic(pathname) {
  const screen = SCREENS.get(pathname);
  if (screen) return screen;

  if (pathname.includes('\0')) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* A path that will not decode is not a path this service recognises. */
    return null;
  }
  if (decoded.includes('\0')) return null;
  /* An encoded traversal decodes into an ordinary `..`, which is why the
   * segments are examined after decoding rather than before. */
  const segments = decoded.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return null;
    /* A backslash is an ordinary filename character on Linux and a separator
     * on Windows. Refusing it costs nothing here and removes the difference. */
    if (segment.includes('\\')) return null;
  }
  if (segments.length === 0) return null;
  /* An absolute path is not asked for in a URL, so a leading slash is a
   * request for something relative to the root, never for the root itself. */
  const file = segments[segments.length - 1];
  if (!contentTypeFor(file)) return null;

  const candidate = path.resolve(PUBLIC_DIR, ...segments);
  if (!containedIn(candidate, PUBLIC_DIR)) return null;
  return file;
}

function containedIn(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/** Answer with the bytes of one public file, or false when this request is not
 * for one and the caller should carry on to the API's own 404. */
async function serve(req, res, pathname) {
  if (req.method !== 'GET') return false;
  const file = resolvePublic(pathname);
  if (file === null) return false;

  const candidate = path.resolve(PUBLIC_DIR, file);
  if (!containedIn(candidate, PUBLIC_DIR)) return false;

  let real;
  try {
    /* realpath resolves every symlink, so a link inside public/ pointing at
     * /etc/passwd is caught here even though the requested path was contained. */
    real = await fs.realpath(candidate);
  } catch {
    return false;
  }
  const realRoot = await fs.realpath(PUBLIC_DIR).catch(() => PUBLIC_DIR);
  if (!containedIn(real, realRoot)) return false;

  const contentType = contentTypeFor(path.basename(real));
  if (contentType === null) return false;

  let body;
  try {
    const stat = await fs.stat(real);
    /* A directory is a miss, not a listing. Nothing under public/ is ever
     * enumerated. */
    if (!stat.isFile()) return false;
    body = await fs.readFile(real);
  } catch {
    return false;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    /* Matches every other answer this service gives. A static asset that can be
     * cached stale is worse during a stage than the bytes saved. */
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}

module.exports = { PUBLIC_DIR, SCREENS, CONTENT_TYPES, contentTypeFor, resolvePublic, serve };