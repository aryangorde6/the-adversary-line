'use strict';

const L = require('./lib');

exports.run = async () => {
  await L.step('seeded user can log in immediately', async () => {
    await L.reset(L.FIXTURE);
    const res = await L.call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'correct horse' } });
    L.assert.equal(res.status, 200, res.text);
    L.assert.equal(res.json.user_id, 'u_ada');
    L.assert.equal(res.json.display_name, 'Ada');
    L.assert.equal(typeof res.json.token, 'string');
    L.assert.ok(res.json.token.length > 0);
  });

  await L.step('wrong password and unknown email are 401 unauthenticated', async () => {
    L.expectError(
      await L.call('POST', '/auth/login', { body: { email: 'ada@example.com', password: 'nope' } }),
      401, 'unauthenticated', 'wrong password',
    );
    L.expectError(
      await L.call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'whatever' } }),
      401, 'unauthenticated', 'unknown email',
    );
  });

  await L.step('signup returns 201 with a usable token', async () => {
    await L.reset(L.FIXTURE);
    const res = await L.call('POST', '/auth/signup', {
      body: { email: 'cara@example.com', password: 'longenough1', display_name: 'Cara' },
    });
    L.assert.equal(res.status, 201, res.text);
    L.assert.equal(res.json.display_name, 'Cara');
    const whoami = await L.call('GET', '/reservations', { token: res.json.token });
    L.assert.equal(whoami.status, 200);
  });

  await L.step('duplicate email is 409 email_taken', async () => {
    await L.reset(L.FIXTURE);
    L.expectError(
      await L.call('POST', '/auth/signup', { body: { email: 'ada@example.com', password: 'longenough1' } }),
      409, 'email_taken', 'duplicate email',
    );
    const other = await L.call('POST', '/auth/signup', { body: { email: 'ADA@example.com', password: 'longenough1' } });
    L.assert.equal(other.status, 409, 'email comparison must ignore case');
  });

  await L.step('short password is 422 validation_failed', async () => {
    L.expectError(
      await L.call('POST', '/auth/signup', { body: { email: 'd@example.com', password: 'short' } }),
      422, 'validation_failed', 'short password',
    );
  });

  await L.step('malformed email is 422 validation_failed', async () => {
    for (const email of ['no-at-sign', 'a@b', 'a b@example.com', '@example.com', 'a@']) {
      L.expectError(
        await L.call('POST', '/auth/signup', { body: { email, password: 'longenough1' } }),
        422, 'validation_failed', `email ${email}`,
      );
    }
  });

  await L.step('passwords are never stored in plaintext', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    const dump = await L.call('GET', '/_test/export');
    L.assert.equal(dump.status, 200);
    L.assert.ok(!dump.text.includes('correct horse'), 'plaintext password leaked into the export');
    L.assert.ok(!dump.text.includes('"password"'), 'plaintext password field leaked into the export');
  });

  await L.step('an account may hold several valid tokens at once', async () => {
    await L.reset(L.FIXTURE);
    const first = await L.login('ada@example.com', 'correct horse');
    const second = await L.login('ada@example.com', 'correct horse');
    L.assert.notEqual(first, second);
    const a = await L.call('GET', '/reservations', { token: first });
    const b = await L.call('GET', '/reservations', { token: second });
    L.assert.equal(a.status, 200);
    L.assert.equal(b.status, 200);
  });

  await L.step('reset clears tokens issued before it', async () => {
    await L.reset(L.FIXTURE);
    const token = await L.login('ada@example.com', 'correct horse');
    L.assert.equal((await L.call('GET', '/reservations', { token })).status, 200);
    await L.reset(L.FIXTURE);
    L.expectError(await L.call('GET', '/reservations', { token }), 401, 'unauthenticated', 'token after reset');
  });
};
