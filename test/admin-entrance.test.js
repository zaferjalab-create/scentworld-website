// scentworld.ca/admin is the easy way in, while the panel itself stays under
// the secret ADMIN_PATH (as in production). Sign-ins are emailed to the owner
// and survive restarts; a password change signs every other device out.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-entrance-test-'));
const SECRET = 'hidden-test-path';
const ADMIN_EMAIL = 'entrance-admin@example.com';
const ADMIN_PASSWORD = 'test-only-password-123';
Object.assign(process.env, {
  DATA_DIR, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PATH: SECRET,
  SESSION_SECRET: 'test-session-secret', STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', RESEND_API_KEY: 're_test_dummy', NODE_ENV: 'test',
});

// Capture emails to Resend; everything else goes through untouched.
const emails = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    emails.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 'test' }) };
  }
  return realFetch(url, init);
};

const quiet = console.log;
console.log = () => {};
require('../setup');
const app = require('../server');
console.log = quiet;
const db = require('../database');

let server, BASE;
before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  global.fetch = realFetch;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const login = password => fetch(BASE + '/api/admin/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password }),
});
const cookieOf = r => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

test('/admin shows the sign-in form without revealing the secret path', async () => {
  for (const p of ['/admin', '/admin/']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.ok(html.includes('loginForm'), 'it is the login page');
    assert.ok(!html.includes(SECRET), 'secret path not in the page');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  const panel = await fetch(BASE + `/${SECRET}/`, { redirect: 'manual' });
  assert.equal(panel.status, 302, 'panel still needs a session');
});

test('signing in: alert emailed, stays signed in 30 days, /admin goes to the panel', async () => {
  const r = await login(ADMIN_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).redirect, `/${SECRET}/`);
  const cookie = cookieOf(r);
  const setCookie = r.headers.getSetCookie().join(';');
  const days = (new Date(setCookie.match(/Expires=([^;]+)/i)[1]) - Date.now()) / 86400000;
  assert.ok(days > 29 && days <= 30, `cookie lasts ~30 days (${days.toFixed(1)})`);

  await new Promise(res => setTimeout(res, 50));
  const alert = emails.find(e => e.subject.includes('Admin sign-in'));
  assert.ok(alert, 'sign-in alert sent');
  assert.deepEqual(alert.to, [process.env.NOTIFY_EMAIL || 'hello@scentworld.ca']);
  assert.ok(alert.text.includes(ADMIN_EMAIL) && alert.text.includes('IP:'));

  const go = await fetch(BASE + '/admin', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), `/${SECRET}/`);
  assert.equal((await fetch(BASE + `/${SECRET}/`, { headers: { Cookie: cookie } })).status, 200);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n >= 1, 'session saved in the database');
});

test('wrong password: no alert, no session; changing the password signs other devices out', async () => {
  const before = emails.length;
  assert.equal((await login('wrong-password')).status, 401);
  assert.equal(emails.length, before, 'failed attempts are not emailed');

  const phone = cookieOf(await login(ADMIN_PASSWORD));
  const laptop = cookieOf(await login(ADMIN_PASSWORD));
  const json = { Accept: 'application/json' };
  assert.equal((await fetch(BASE + '/api/admin/check', { headers: { ...json, Cookie: phone } })).status, 200);
  const change = await fetch(BASE + '/api/admin/change-password', {
    method: 'POST', headers: { ...json, 'Content-Type': 'application/json', Origin: BASE, Cookie: laptop },
    body: JSON.stringify({ current_password: ADMIN_PASSWORD, new_password: 'a-new-pass-789' }),
  });
  assert.equal(change.status, 200);
  const laptopNow = cookieOf(change) || laptop;
  assert.equal((await fetch(BASE + '/api/admin/check', { headers: { ...json, Cookie: phone } })).status, 401, 'other device signed out');
  assert.equal((await fetch(BASE + '/api/admin/check', { headers: { ...json, Cookie: laptopNow } })).status, 200, 'this device stays in');
});
