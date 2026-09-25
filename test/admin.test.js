// Exercises every admin API endpoint end-to-end so a refactor (moving routes
// between files) can't silently break a button in the admin panel.
// Uses its own throwaway DATA_DIR + admin, like server.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-admin-test-'));
const ADMIN_EMAIL = 'test-admin@example.com';
const ADMIN_PASSWORD = 'test-only-password-123';
Object.assign(process.env, {
  DATA_DIR, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PATH: 'admin',
  SESSION_SECRET: 'test-session-secret', STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', RESEND_API_KEY: '', NODE_ENV: 'test',
});

const quiet = console.log;
console.log = () => {};
require('../setup');
const app = require('../server');
console.log = quiet;
const db = require('../database');

let server, BASE, cookie;
before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Cookie: cookie, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}
const ok = async (method, p, body) => {
  const r = await api(method, p, body);
  assert.equal(r.status, 200, `${method} ${p} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
};

test('admin panel page + session check', async () => {
  assert.equal((await fetch(BASE + '/admin/', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await ok('GET', '/api/admin/check')).email, ADMIN_EMAIL);
  const anon = await fetch(BASE + '/admin/');
  assert.equal(anon.redirected || anon.url.endsWith('login.html'), true, 'anonymous is sent to login');
});

test('dashboard stats and read-only lists', async () => {
  const s = await ok('GET', '/api/admin/stats');
  assert.ok(s.stats.products.total > 0);
  for (const p of ['/api/admin/contacts', '/api/admin/bookings', '/api/admin/subscribers', '/api/admin/orders',
    '/api/admin/reviews', '/api/admin/testimonials', '/api/admin/products', '/api/admin/settings']) {
    assert.equal((await ok('GET', p)).success, true, p);
  }
});

test('contacts, bookings and subscribers: create via public forms, then manage', async () => {
  const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post('/api/contact', { first_name: 'Ann', last_name: 'Lee', email: 'ann@example.com', message: 'Quote please' })).status, 200);
  assert.equal((await post('/api/booking', { first_name: 'Bob', last_name: 'Ray', email: 'bob@example.com', preferred_date: '2026-10-01', preferred_time: '10:00' })).status, 200);
  assert.equal((await post('/api/subscribe', { email: '=cmd@example.com' })).status, 200);

  const [c] = (await ok('GET', '/api/admin/contacts')).contacts;
  await ok('PATCH', `/api/admin/contacts/${c.id}`, { status: 'replied', notes: 'called back' });
  assert.equal(db.prepare('SELECT status FROM contacts WHERE id = ?').get(c.id).status, 'replied');
  await ok('DELETE', `/api/admin/contacts/${c.id}`);

  const [b] = (await ok('GET', '/api/admin/bookings')).bookings;
  await ok('PATCH', `/api/admin/bookings/${b.id}`, { status: 'confirmed', admin_notes: 'ok' });
  await ok('DELETE', `/api/admin/bookings/${b.id}`);

  const csv = await api('GET', '/api/admin/subscribers/export');
  assert.equal(csv.status, 200);
  const text = Buffer.from(csv.data).toString();
  assert.ok(text.includes(`"'=cmd@example.com"`), 'formula-injection neutralised in export');
  const [sub] = (await ok('GET', '/api/admin/subscribers')).subscribers;
  await ok('DELETE', `/api/admin/subscribers/${sub.id}`);
});

test('products CRUD', async () => {
  const created = await ok('POST', '/api/admin/products', { name: 'Test Diffuser', slug: 'test-diffuser', category: 'diffusers', price: 123, active: 1 });
  assert.equal(created.success, true);
  const row = db.prepare("SELECT * FROM products WHERE slug = 'test-diffuser'").get();
  await ok('PUT', `/api/admin/products/${row.id}`, { ...row, price: 150, gallery_images: ['/images/products/oil-main.webp'] });
  assert.equal(db.prepare('SELECT price FROM products WHERE id = ?').get(row.id).price, 150);
  assert.equal((await fetch(BASE + '/products/test-diffuser')).status, 200);
  await ok('DELETE', `/api/admin/products/${row.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products WHERE id = ?').get(row.id).n, 0);
  assert.equal((await api('POST', '/api/admin/products', { name: 'x' })).status, 400, 'validation');
});

test('settings, orders, reviews and testimonials', async () => {
  await ok('PUT', '/api/admin/settings', { site_phone: '(902) 000-0000' });
  assert.equal((await ok('GET', '/api/admin/settings')).settings.site_phone, '(902) 000-0000');

  const o = db.prepare("INSERT INTO orders (order_number, customer_name, customer_email, subtotal, total, payment_status, status) VALUES ('SW-T1','T','t@example.com',10,10,'paid','confirmed')").run();
  assert.equal((await ok('GET', `/api/admin/orders/${o.lastInsertRowid}`)).success, true);
  await ok('PATCH', `/api/admin/orders/${o.lastInsertRowid}`, { status: 'shipped' });
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o.lastInsertRowid).status, 'shipped');

  const rv = await fetch(BASE + '/api/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: 1, name: 'Cam', rating: 5, text: 'Lovely' }) });
  assert.equal(rv.status, 200);
  const [review] = (await ok('GET', '/api/admin/reviews')).reviews;
  await ok('PATCH', `/api/admin/reviews/${review.id}`, { approved: 1 });
  await ok('DELETE', `/api/admin/reviews/${review.id}`);

  await ok('POST', '/api/admin/testimonials', { stars: 5, text: 'Great', author_name: 'Dee', author_role: 'Spa owner', sort_order: 1, active: 1 });
  const t = (await ok('GET', '/api/admin/testimonials')).testimonials.find(x => x.author_name === 'Dee');
  await ok('PUT', `/api/admin/testimonials/${t.id}`, { ...t, text: 'Great!' });
  await ok('DELETE', `/api/admin/testimonials/${t.id}`);
});

test('backup download is a valid SQLite file', async () => {
  const r = await api('GET', '/api/admin/backup');
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.data).subarray(0, 15).toString(), 'SQLite format 3');
});

test('test-email endpoint responds without crashing (email disabled in tests)', async () => {
  // IndexNow is deliberately not exercised: it pings real search engines.
  const e = await api('POST', '/api/admin/test-email', {});
  assert.ok([200, 400, 500].includes(e.status));
  assert.equal(typeof e.data.success, 'boolean');
});

test('change password: validates, then works, then old password fails', async () => {
  assert.equal((await api('POST', '/api/admin/change-password', { current_password: 'wrong', new_password: 'another-pass-123' })).status, 400, 'wrong current password');
  assert.equal((await api('POST', '/api/admin/change-password', { current_password: ADMIN_PASSWORD, new_password: 'short' })).status, 400);
  await ok('POST', '/api/admin/change-password', { current_password: ADMIN_PASSWORD, new_password: 'brand-new-pass-456' });
  const oldLogin = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  assert.equal(oldLogin.status, 401);
});

test('shipping: $12.99 under $150 by default; rate editable (or cleared) in admin', async () => {
  const { shippingCost, stripeShippingOption } = require('../lib/shipping');
  // the change-password test above rotated the session; log in with the new password
  const relog = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: 'brand-new-pass-456' }) });
  assert.equal(relog.status, 200);
  cookie = relog.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  // owner's default: $12.99 below $150, free at/above
  assert.equal(shippingCost(49), 12.99);
  assert.equal(shippingCost(150), 0);
  assert.ok((await (await fetch(BASE + '/catalog.csv')).text()).includes('CA::Standard:12.99 CAD'));
  const page = await (await fetch(BASE + '/shipping')).text();
  assert.ok(page.includes('$12.99 CAD'), 'shipping policy shows the rate');

  await ok('PUT', '/api/admin/settings', { shipping_threshold: '150', shipping_flat_rate: '14.95' });
  assert.equal(shippingCost(49), 14.95);
  assert.equal(shippingCost(149.99), 14.95);
  assert.equal(shippingCost(150), 0, 'free at the threshold');
  const opt = stripeShippingOption(49).shipping_rate_data;
  assert.equal(opt.fixed_amount.amount, 1495);
  assert.equal(opt.display_name, 'Standard shipping');
  assert.equal(stripeShippingOption(200).shipping_rate_data.fixed_amount.amount, 0);

  const feed = await (await fetch(BASE + '/catalog.csv')).text();
  const oil100 = feed.split('\n').find(l => l.includes('-100ml"'));
  const s200 = feed.split('\n').find(l => l.startsWith('"s200"'));
  assert.ok(oil100.includes('CA::Standard:14.95 CAD'), 'feed charges shipping under the threshold');
  assert.ok(s200.includes('CA::Standard:0.00 CAD'), 'feed ships free at/above the threshold');

  await ok('PUT', '/api/admin/settings', { shipping_flat_rate: '' }); // cleared = free
  assert.equal(shippingCost(49), 0);
  assert.ok((await (await fetch(BASE + '/shipping')).text()).includes('Free shipping</strong> on all orders</li>'));
  await ok('PUT', '/api/admin/settings', { shipping_flat_rate: '12.99' });
});
