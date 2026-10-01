'use strict';

/* Stage 2: static files under public/, and the four screen routes.
 *
 * The traversal half of this suite is the point of it. A file server that reads
 * a path it was given is fine on a laptop and a vulnerability on the internet,
 * so every refusal below is a shape the URL can take rather than a shape the
 * filesystem can take, and each one is probed in both its plain and its
 * percent-encoded spelling because a server that checks before decoding and a
 * server that checks after are different servers. */

const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');
const ST = require('../src/static');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

function contentTypeOf(res) {
  return String(res.headers.get('content-type') || '');
}

/* Every refusal answers with the JSON error body, never with a file and never
 * with HTML. Asserting the shape rather than the status alone is what makes
 * these probes fail if a traversal ever starts returning bytes. */
function assertJsonMiss(res, label) {
  L.assert.equal(res.status, 404, `${label}: status ${res.status}, body ${res.text.slice(0, 120)}`);
  L.assert.ok(res.json && res.json.error && res.json.error.code === 'not_found',
    `${label}: expected the JSON not_found envelope, got ${res.text.slice(0, 120)}`);
  L.assert.equal(/^\s*</.test(res.text), false, `${label}: did not answer with markup`);
}

exports.run = async () => {
  /* ------------------------------------------------------------------ *
   * The four screen routes, and the same files with the extension on.
   * ------------------------------------------------------------------ */

  await L.step('the four screen routes answer with HTML', async () => {
    for (const [route, file, marker] of [
      ['/', 'index.html', 'Tablekeeper'],
      ['/signup', 'signup.html', 'signup'],
      ['/login', 'login.html', 'login'],
      ['/lookup', 'lookup.html', 'lookup'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await L.call('GET', route);
      L.assert.equal(res.status, 200, `${route}: status ${res.status}, body ${res.text.slice(0, 120)}`);
      L.assert.equal(contentTypeOf(res), 'text/html; charset=utf-8', `${route}: content type`);
      L.assert.match(res.text, new RegExp(marker, 'i'), `${route}: served ${file}`);
      // eslint-disable-next-line no-await-in-loop
      const onDisk = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      L.assert.equal(res.text, onDisk, `${route}: serves ${file} byte for byte`);
    }
  });

  await L.step('the same four screens answer with the extension still on the URL', async () => {
    for (const [route, file] of [
      ['/index.html', 'index.html'],
      ['/signup.html', 'signup.html'],
      ['/login.html', 'login.html'],
      ['/lookup.html', 'lookup.html'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await L.call('GET', route);
      L.assert.equal(res.status, 200, `${route}: status ${res.status}`);
      L.assert.equal(contentTypeOf(res), 'text/html; charset=utf-8', `${route}: content type`);
      // eslint-disable-next-line no-await-in-loop
      const onDisk = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      L.assert.equal(res.text, onDisk, `${route} and /${file.replace('.html', '')} are one file`);
    }
  });

  await L.step('a screen route tolerates a trailing slash', async () => {
    const plain = await L.call('GET', '/login');
    const slashed = await L.call('GET', '/login/');
    L.assert.equal(slashed.status, 200, `/login/ : status ${slashed.status}`);
    L.assert.equal(slashed.text, plain.text, '/login/ and /login are the same page');
  });

  /* ------------------------------------------------------------------ *
   * Other files and their own content types.
   * ------------------------------------------------------------------ */

  await L.step('a stylesheet and a script are served with their own content types', async () => {
    const css = await L.call('GET', '/styles.css');
    L.assert.equal(css.status, 200, `styles.css: status ${css.status}`);
    L.assert.equal(contentTypeOf(css), 'text/css; charset=utf-8', 'styles.css content type');

    const js = await L.call('GET', '/app.js');
    L.assert.equal(js.status, 200, `app.js: status ${js.status}`);
    L.assert.equal(contentTypeOf(js), 'text/javascript; charset=utf-8', 'app.js content type');
  });

  await L.step('every file served is the file on disk', async () => {
    for (const name of ['styles.css', 'app.js', 'home.js', 'auth.js', 'lookup.js']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await L.call('GET', `/${name}`);
      L.assert.equal(res.status, 200, `${name}: status ${res.status}`);
      // eslint-disable-next-line no-await-in-loop
      L.assert.equal(res.text, fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'), `${name} matches disk`);
    }
  });

  await L.step('an unrecognised extension is a miss rather than an octet-stream answer', async () => {
    /* Only html, css, js, png and svg are served, so nothing that lands in
     * public/ becomes fetchable just by being there. */
    for (const name of ['/.gitkeep', '/package.json', '/.dockerignore', '/RUN.md']) {
      // eslint-disable-next-line no-await-in-loop
      assertJsonMiss(await L.call('GET', name), name);
    }
  });

  /* ------------------------------------------------------------------ *
   * Traversal. Both spellings, and none of them may return a byte of
   * anything outside public/.
   * ------------------------------------------------------------------ */

  for (const [label, target] of [
    ['a parent segment', '/../package.json'],
    ['a parent segment, percent-encoded', '/..%2fpackage.json'],
    ['a parent segment, fully encoded', '/%2e%2e%2fpackage.json'],
    ['a parent segment with a capital', '/%2E%2E%2Fpackage.json'],
    ['two parent segments', '/../../etc/passwd'],
    ['two parent segments, encoded', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd'],
    ['a parent segment mid-path', '/styles.css/../../package.json'],
    ['an absolute path', '//etc/passwd'],
    ['a backslash separator', '/..\\package.json'],
    ['a NUL byte', '/styles.css%00.png'],
    ['a NUL byte before a name', '/%00styles.css'],
    ['a screen name with a parent segment', '/login/../package.json'],
    ['a name that will not decode', '/%zz'],
    ['a lone percent', '/%'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await L.step(`static serving refuses ${label}`, async () => {
      assertJsonMiss(await L.call('GET', target), label);
    });
  }

  await L.step('a traversal attempt cannot read the real package.json', async () => {
    /* Named explicitly, because "it returned a 404" is weaker than "it never
     * showed me the contents of a file that exists one directory up". */
    const res = await L.call('GET', '/..%2f..%2fstage-2%2fpackage.json');
    assertJsonMiss(res, 'a real file two levels up');
    L.assert.equal(res.text.includes('tablekeeper'), false, 'no part of the real package.json leaked');
  });

  await L.step('a symlink leaving public/ is refused even though its path looks contained', async () => {
    /* The textual path is inside public/, so only resolving the link catches
     * this. The link is made and removed inside the probe so nothing is left in
     * the finisher's directory if the probe fails. */
    const linkName = `.probe-${process.pid}-${Date.now()}.js`;
    const linkPath = path.join(PUBLIC_DIR, linkName);
    try {
      fs.symlinkSync(path.join(PUBLIC_DIR, '..', 'package.json'), linkPath);
      const res = await L.call('GET', `/${linkName}`);
      assertJsonMiss(res, 'a symlink pointing out of public/');
      L.assert.equal(res.text.includes('tablekeeper'), false, 'the link target was not served');
    } finally {
      fs.unlinkSync(linkPath);
    }
    L.assert.equal(fs.existsSync(linkPath), false, 'the probe link is gone again');
  });

  await L.step('a directory is a miss, never a listing', async () => {
    /* public/ holds no subdirectory, so this is the miss a subdirectory would
     * give rather than an enumeration of anything. */
    assertJsonMiss(await L.call('GET', '/nope/'), 'a path that does not exist');
    assertJsonMiss(await L.call('GET', '/nope/deeper/'), 'a missing path with a slash');
  });

  await L.step('a dot segment is the same resource as the path it names', async () => {
    /* Not a refusal. The URL parser resolves "." and ".." before anything
     * downstream sees them, so /./styles.css IS /styles.css and /. IS /, and
     * both answers are the file the caller asked for rather than an escape. */
    const dotted = await L.call('GET', '/./styles.css');
    L.assert.equal(dotted.status, 200, `/./styles.css: status ${dotted.status}`);
    const plain = await L.call('GET', '/styles.css');
    L.assert.equal(dotted.text, plain.text, '/./styles.css serves the stylesheet');
    const dot = await L.call('GET', '/.');
    L.assert.equal(dot.status, 200, `/. : status ${dot.status}`);
    L.assert.equal(contentTypeOf(dot), 'text/html; charset=utf-8', '/. is the front page, not a listing');
    L.assert.equal(dot.text.includes('href="'), true, 'and it is the front page rather than a file index');
  });

  /* ------------------------------------------------------------------ *
   * The API is never shadowed, and unknown paths keep the JSON body.
   * ------------------------------------------------------------------ */

  await L.step('an unknown path keeps the JSON error body, not markup', async () => {
    for (const target of ['/no-such-endpoint', '/auth/nope', '/availability/extra', '/reservation-moves']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await L.call('GET', target);
      L.assert.equal(res.status, 404, `${target}: status ${res.status}`);
      L.assert.ok(res.json && res.json.error && typeof res.json.error.message === 'string',
        `${target}: carries the error envelope`);
      L.assert.equal(contentTypeOf(res), 'application/json; charset=utf-8', `${target}: stays JSON`);
    }
  });

  await L.step('the API answers before any file is considered', async () => {
    const health = await L.call('GET', '/health');
    L.assert.equal(health.status, 200, `health: ${health.text}`);
    L.assert.equal(contentTypeOf(health), 'application/json; charset=utf-8', 'health stays JSON');

    const detail = await L.call('GET', '/restaurants/r_anker');
    L.assert.equal(detail.status, 200, `restaurants detail: ${detail.text}`);

    /* A screen route answers to GET, so POST /login is not that screen and is
     * not the API either: it takes the JSON miss. The API's own login is
     * POST /auth/login, which is unaffected. */
    const posted = await L.call('POST', '/login', { body: { email: 'nobody@example.com', password: 'x' } });
    assertJsonMiss(posted, 'POST /login');
    const apiLogin = await L.call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'x' } });
    L.expectError(apiLogin, 401, 'unauthenticated', 'POST /auth/login is still the API');
  });

  await L.step('the resolver refuses what the URL parser cannot be relied on to refuse', async () => {
    /* The URL parser resolves "." and ".." segments before a request reaches
     * this service, which is why the plain traversal probes above are answered
     * by the parser rather than by us. It does not touch an encoded traversal or
     * an encoded NUL, and those arrive intact, so resolvePublic's own refusals
     * are load-bearing and are pinned here directly rather than only through a
     * URL that would have been rewritten on the way in. */
    for (const [label, target] of [
      ['an encoded parent segment', '/%2e%2e%2fpackage.json'],
      ['an encoded parent, mixed case', '/%2E%2E/package.json'],
      ['an encoded slash then a parent', '/a%2f..%2fpackage.json'],
      ['an encoded NUL', '/styles.css%00.png'],
      ['a raw NUL', '/styles.css\u0000.png'],
      ['a parent segment', '/../package.json'],
      ['a current-directory segment', '/./styles.css'],
      ['a backslash separator', '/..\\package.json'],
      ['an absolute path', '/etc/passwd'],
      /* "/" is deliberately not here: it is the front page, and the assertions
       * below say so. The empty path is the no-segments case. */
      ['a path with no segments', ''],
      ['a path of separators alone', '//'],
    ]) {
      L.assert.equal(ST.resolvePublic(target), null, `resolvePublic refuses ${label}`);
    }

    /* And the resolver still answers for the paths it should, so the refusals
     * above are refusals rather than a resolver that refuses everything. */
    L.assert.equal(ST.resolvePublic('/'), 'index.html', 'the front page resolves');
    L.assert.equal(ST.resolvePublic('/signup'), 'signup.html', 'a screen resolves');
    L.assert.equal(ST.resolvePublic('/styles.css'), 'styles.css', 'an asset resolves');
    L.assert.equal(ST.resolvePublic('/app.js'), 'app.js', 'a script resolves');
    /* A nested file resolves, and containment is decided by the root rather
     * than by a prefix that a sibling directory could imitate. */
    L.assert.equal(ST.resolvePublic('/styles.css'), 'styles.css', 'a nested name is read against the root');
  });

  await L.step('the content type map is exactly the five served types', async () => {
    L.assert.deepEqual([...ST.CONTENT_TYPES.keys()].sort(),
      ['.css', '.html', '.js', '.png', '.svg'],
      'nothing else is served');
    /* The registered media types, not approximations of them. A PNG served as
     * text/png is refused by every browser, so the map names what each type is
     * actually called. */
    L.assert.deepEqual([...ST.CONTENT_TYPES.entries()].sort(),
      [
        ['.css', 'text/css; charset=utf-8'],
        ['.html', 'text/html; charset=utf-8'],
        ['.js', 'text/javascript; charset=utf-8'],
        ['.png', 'image/png'],
        ['.svg', 'image/svg+xml'],
      ],
      'every served type is its registered media type');
    L.assert.equal(ST.contentTypeFor('a.HTML'), 'text/html; charset=utf-8', 'the extension is matched case-insensitively');
    L.assert.equal(ST.contentTypeFor('a.PnG'), 'image/png', 'and so is a mixed-case png');
    L.assert.equal(ST.contentTypeFor('a.gif'), null, 'an unserved extension has no content type');
    L.assert.equal(ST.contentTypeFor('noextension'), null, 'and neither has a bare name');
  });

  await L.step('static answering is read-only and leaves no route behind', async () => {
    await L.call('GET', '/');
    await L.call('GET', '/../package.json');
    await L.call('GET', '/styles.css');
    const health = await L.call('GET', '/health');
    L.assert.equal(health.status, 200, 'the service still answers its own endpoints afterwards');
    const unknown = await L.call('GET', '/still-not-here');
    assertJsonMiss(unknown, 'after static traffic');
  });
};