// Rows A1..A10.
import { GET, POST, PATCH, call, record } from './lib.mjs';
import { fixture, fresh, login, reset } from './fixtures.mjs';

const PUBLIC_ROUTES = [
  ['GET', '/health'],
  ['POST', '/_test/reset'],
  ['GET', '/_test/export'],
  ['POST', '/_test/import'],
  ['POST', '/auth/signup'],
  ['POST', '/auth/login'],
  ['GET', '/restaurants'],
  ['GET', '/restaurants/r_anker'],
  ['GET', '/availability?restaurant_id=r_anker&date=2026-12-10&party_size=2'],
];

export default async function run() {
  await fresh();

  // A1 signup shape
  const s = await POST('/auth/signup', { body: { email: 'ada2@example.com', password: 'correct horse', display_name: 'Ada Two' } });
  const keys = s.json ? Object.keys(s.json).sort() : [];
  record('A1', s.status === 201 && deep(keys, ['display_name', 'token', 'user_id']) && s.json.display_name === 'Ada Two' && s.json.user_id && s.json.token,
    `signup -> ${s.status} ${JSON.stringify(s.json)}`);

  // A2 login shape, and the same identity as the signup
  const l = await POST('/auth/login', { body: { email: 'ada2@example.com', password: 'correct horse' } });
  record('A2', l.status === 200 && deep(Object.keys(l.json).sort(), ['display_name', 'token', 'user_id']) && l.json.user_id === s.json.user_id && l.json.display_name === 'Ada Two' && l.json.token,
    `login -> ${l.status} ${JSON.stringify(l.json)}`);

  // A10 both work from a fresh reset
  await reset(fixture());
  const s2 = await POST('/auth/signup', { body: { email: 'ada3@example.com', password: 'correct horse', display_name: 'Ada Three' } });
  const l2 = await POST('/auth/login', { body: { email: 'ada3@example.com', password: 'correct horse' } });
  const seededL = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
  record('A10', s2.status === 201 && l2.status === 200 && seededL.status === 200, `signup ${s2.status}, login ${l2.status}, seeded login ${seededL.status}`);

  // A3 email already registered
  const dupe = await POST('/auth/signup', { body: { email: 'ada3@example.com', password: 'a different long password', display_name: 'Impostor' } });
  const dupeCase = await POST('/auth/signup', { body: { email: 'ADA3@example.com', password: 'another long password' } });
  record('A3', dupe.status === 409 && dupe.json?.error?.code === 'email_taken' && dupeCase.status === 409 && dupeCase.json?.error?.code === 'email_taken',
    `duplicate email -> ${dupe.status} ${dupe.json?.error?.code}; different case -> ${dupeCase.status} ${dupeCase.json?.error?.code}`);

  // A4 password shorter than 8 characters
  const short = await POST('/auth/signup', { body: { email: 'short@example.com', password: '1234567' } });
  const exact = await POST('/auth/signup', { body: { email: 'exact@example.com', password: '12345678' } });
  const shortLogin = await POST('/auth/login', { body: { email: 'exact@example.com', password: '1234567' } });
  record('A4', short.status === 422 && short.json?.error?.code === 'validation_failed' && exact.status === 201 && shortLogin.status === 401,
    `7 characters -> ${short.status} ${short.json?.error?.code}; 8 characters -> ${exact.status}; 7 characters on login -> ${shortLogin.status}`);

  // A5 email not of the form local@domain
  const badEmails = ['ada', 'ada@', '@example.com', 'a b@example.com', 'ada@example', 'ada@@example.com', 'ada@example.', 'ada@exam ple.com', '  ', 'ada example.com'];
  const badResults = [];
  for (const email of badEmails) {
    const r = await POST('/auth/signup', { body: { email, password: 'correct horse' } });
    badResults.push([email, r]);
  }
  const badWrong = badResults.filter(([, r]) => r.status !== 422 || r.json?.error?.code !== 'validation_failed');
  const goodEmails = ['a@b.co', 'first.last@sub.example.org', 'x+tag@example.com', 'upper@B.CO'];
  const goodResults = [];
  for (const email of goodEmails) {
    const r = await POST('/auth/signup', { body: { email, password: 'correct horse' } });
    goodResults.push([email, r]);
  }
  const goodWrong = goodResults.filter(([, r]) => r.status !== 201);
  const singleLabel = await POST('/auth/signup', { body: { email: 'user@localhost', password: 'correct horse' } });
  record('A5', badWrong.length === 0 && goodWrong.length === 0,
    `rejected wrongly: ${badWrong.map(([e, r]) => `${e} -> ${r.status}`).join('; ') || 'none'}; accepted wrongly: ${goodWrong.map(([e, r]) => `${e} -> ${r.status}`).join('; ') || 'none'}; single-label domain user@localhost -> ${singleLabel.status}`);

  // A6 wrong password or unknown email on login
  const wrongPw = await POST('/auth/login', { body: { email: 'ada@example.com', password: 'wrong password' } });
  const unknown = await POST('/auth/login', { body: { email: 'nobody@example.com', password: 'correct horse' } });
  record('A6', wrongPw.status === 401 && wrongPw.json?.error?.code === 'unauthenticated' && unknown.status === 401 && unknown.json?.error?.code === 'unauthenticated',
    `wrong password -> ${wrongPw.status} ${wrongPw.json?.error?.code}; unknown email -> ${unknown.status} ${unknown.json?.error?.code}`);

  // A7 the public routes answer without a token and nothing else does
  const publicHits = [];
  for (const [method, path] of PUBLIC_ROUTES) {
    const res = await call(method, path, { rawBody: method === 'POST' ? '{}' : undefined });
    if (res.status === 401) publicHits.push(`${method} ${path} -> 401`);
  }
  const protectedRoutes = [
    ['GET', '/reservations'], ['POST', '/reservations'], ['GET', '/reservations/ABCD1234'],
    ['PATCH', '/reservations/ABCD1234'], ['POST', '/reservations/ABCD1234/cancel'], ['POST', '/reservation-moves'],
  ];
  const protectedHits = [];
  for (const [method, path] of protectedRoutes) {
    const res = await call(method, path, { rawBody: method === 'POST' ? '{}' : undefined });
    if (res.status !== 401 || res.json?.error?.code !== 'unauthenticated') protectedHits.push(`${method} ${path} -> ${res.status} ${res.json?.error?.code}`);
  }
  record('A7', publicHits.length === 0 && protectedHits.length === 0,
    `public routes demanding a token: ${publicHits.join('; ') || 'none'}; protected routes not demanding one: ${protectedHits.join('; ') || 'none'}`);

  // A8 tokens do not expire and an account may hold several at once
  await fresh();
  const t1 = await login();
  const t2 = await login();
  const t3 = (await POST('/auth/signup', { body: { email: 'multi@example.com', password: 'correct horse' } })).json.token;
  const uses = [];
  for (const t of [t1, t2, t3]) {
    const r = await GET('/reservations', { token: t });
    uses.push(r.status);
  }
  const afterUse = [];
  for (const t of [t1, t2]) {
    const r = await GET('/reservations', { token: t });
    afterUse.push(r.status);
  }
  record('A8', uses.every((s) => s === 200) && afterUse.every((s) => s === 200) && t1 !== t2,
    `two logins and one signup token: ${uses.join(',')} then ${afterUse.join(',')}`);

  // A9 no plaintext password anywhere in the service's own output
  await fresh();
  const exportRes = await GET('/_test/export');
  const state = exportRes.json.state;
  const users = state.users || [];
  const noPlaintext = users.length > 0 && users.every((u) => typeof u.password_hash === 'string' && !u.password_hash.includes('correct horse') && u.password_hash.length > 20);
  const keysUsed = users.length ? Object.keys(users[0]).sort() : [];
  const leaks = JSON.stringify(state).includes('correct horse');
  record('A9', noPlaintext && !leaks && !keysUsed.includes('password'), `user records hold ${JSON.stringify(keysUsed)}, plaintext password present in the export: ${leaks}`);

  /* A9b the same question asked of a user created through the runtime signup
   * path, which A9 never reaches. A9 reads the user fixture, and a fixture
   * password is hashed while the fixture is being built, so A9 passes against a
   * service that stores a signup password verbatim. Nothing about that is visible
   * through the API: signup answers 201 and login answers 200 either way, so the
   * export is the only place the stored credential is observable.
   *
   * The password used here is deliberately unlike any other string in the suite,
   * so a hit names this row and not another. The three assertions the Foreman
   * asked for are kept in one row rather than three: the plaintext must be absent
   * from the whole export, what is stored must look like a hash rather than the
   * password, and the stored form must still verify. */
  const RUNTIME_PASSWORD = 'zz-runtime-only-9f3c1d7b';
  const RUNTIME_EMAIL = 'runtime-probe@example.com';
  await fresh();
  const signedUp = await POST('/auth/signup', { body: { email: RUNTIME_EMAIL, password: RUNTIME_PASSWORD, display_name: 'Runtime' } });
  const snapRes = await GET('/_test/export');
  const raw = snapRes.text;
  const snap = snapRes.json;
  const stored = ((snap && snap.state && snap.state.users) || []).find((u) => u.email === RUNTIME_EMAIL);
  const credential = stored && stored.password_hash;
  const leaksRuntime = raw.includes(RUNTIME_PASSWORD);
  const notPlaintext = typeof credential === 'string' && credential !== RUNTIME_PASSWORD && !credential.includes(RUNTIME_PASSWORD) && credential.length > 20;
  // A hash is either a tagged parameter string carrying cost parameters and a
  // salt, in any number of `$`-separated groups (scrypt's own encoding is
  // `scrypt$N$r$p$salt$key`), or a long hex digest. A password, with or without a
  // tag in front of it, is neither: the password here is a lower-case dictionary
  // of letters and digits, so it would otherwise sail through a length test.
  const looksHashed = typeof credential === 'string'
    && (/^[a-z][a-z0-9-]*(\$[\w+./=-]+){2,}$/i.test(credential) || /^[0-9a-f]{64,256}$/i.test(credential));
  const verifies = await POST('/auth/login', { body: { email: RUNTIME_EMAIL, password: RUNTIME_PASSWORD } });
  const wrongRefused = await POST('/auth/login', { body: { email: RUNTIME_EMAIL, password: `${RUNTIME_PASSWORD}-wrong` } });
  record('A9b', signedUp.status === 201 && !leaksRuntime && notPlaintext && looksHashed && verifies.status === 200 && wrongRefused.status === 401,
    `runtime signup ${signedUp.status}; the export for ${RUNTIME_EMAIL} contains the plaintext password: ${leaksRuntime}; the stored credential is ${typeof credential === 'string' ? `${credential.slice(0, 12)}... (${credential.length} chars, recognisably hashed: ${looksHashed})` : String(credential)}; the same password logs in ${verifies.status} and a near-miss is refused ${wrongRefused.status}`);
}

function deep(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
