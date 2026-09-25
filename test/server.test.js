// End-to-end tests for the storefront. Run with: npm test
//
// Each run uses a throwaway data folder (fresh SQLite DB + uploads) and a
// throwaway admin account, so it never touches ./data or real credentials.
// Env is set BEFORE requiring the app; dotenv never overrides existing vars,
// and RESEND_API_KEY='' keeps the order/notification emails from sending.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
const ADMIN_EMAIL = 'test-admin@example.com';
const ADMIN_PASSWORD = 'test-only-password-123';
const WEBHOOK_SECRET = 'whsec_test_secret';
Object.assign(process.env, {
  DATA_DIR,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ADMIN_PATH: 'admin',
  SESSION_SECRET: 'test-session-secret',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RESEND_API_KEY: '',
  NODE_ENV: 'test',
});

const quiet = console.log;
console.log = () => {}; // setup/seed chatter
require('../setup');      // seeds products + creates the throwaway admin
const app = require('../server');
console.log = quiet;
const db = require('../database');
const stripe = require('stripe')('sk_test_dummy');

let server, BASE;
before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  db.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const get = (p, opts = {}) => fetch(BASE + p, opts);
const postJson = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
});

// ── Pages ──────────────────────────────────────────────
test('main pages render', async () => {
  for (const p of ['/', '/shop', '/products/s20', '/compare', '/track', '/wishlist', '/about', '/sitemap.xml', '/catalog.csv']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await get('/products/does-not-exist')).status, 404);
});

test('security headers and a CSP that allows GA4 + Google Ads collection', async () => {
  const r = await get('/');
  const csp = r.headers.get('content-security-policy');
  for (const host of ['https://analytics.google.com', 'https://*.google-analytics.com', 'https://www.google.com', 'https://ad.doubleclick.net']) {
    assert.ok(csp.includes(host), `connect-src should allow ${host}`);
  }
  assert.ok(!csp.includes('unsafe-eval'), 'no eval allowed in scripts');
  assert.match(r.headers.get('strict-transport-security'), /max-age=/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('HTML is gzip-compressed; images get a long cache header', async () => {
  const http = require('http');
  const { port } = server.address();
  const enc = await new Promise((resolve, reject) => {
    http.get({ port, path: '/', headers: { 'Accept-Encoding': 'gzip' } }, res => {
      res.resume(); resolve(res.headers['content-encoding']);
    }).on('error', reject);
  });
  assert.equal(enc, 'gzip');
  const img = await get('/images/products/oil-main.webp');
  assert.equal(img.status, 200);
  assert.match(img.headers.get('cache-control'), /max-age=2592000/);
});

test('product images are WebP and all resolve', async () => {
  const { products } = await (await get('/api/products')).json();
  assert.ok(products.length > 10);
  for (const p of products) {
    if (!p.image_url) continue;
    assert.equal((await get(p.image_url, { method: 'HEAD' })).status, 200, p.image_url);
  }
  const oil = products.find(p => p.category === 'oils');
  assert.match(oil.image_url, /\.webp$/);
});

test('size finder shows a size group only when it has active products', async () => {
  // 3,000-5,000 sq ft units: s100 / l100 / l100-ad (3,230 sq ft)
  const commercial = ['s100', 'l100', 'l100-ad'];
  const setActive = v => commercial.forEach(slug => db.prepare('UPDATE products SET active = ? WHERE slug = ?').run(v, slug));
  const tile = async () => (await (await get('/')).text()).includes('/shop?size=commercial');
  try {
    setActive(0);
    assert.equal(await tile(), false, 'no commercial products -> no empty tile');
    assert.ok(!(await (await get('/shop')).text()).includes('value="commercial"'), 'shop filter option hidden too');
    setActive(1);
    assert.equal(await tile(), true, 'tile comes back when re-activated');
  } finally {
    setActive(0);
  }
  assert.ok((await (await get('/')).text()).includes('/shop?size=small'));
});

test('product feed has variant grouping and well-formed rows', async () => {
  const lines = (await (await get('/catalog.csv')).text()).trim().split('\n');
  const cols = l => { let n = 1, q = false; for (const c of l) { if (c === '"') q = !q; else if (c === ',' && !q) n++; } return n; };
  assert.ok(lines[0].includes('item_group_id'));
  const width = cols(lines[0]);
  for (const l of lines.slice(1)) assert.equal(cols(l), width, l.slice(0, 60));
});

// ── Stripe webhook → order recording ───────────────────
function signedWebhook(session) {
  const payload = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed', data: { object: session } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return fetch(BASE + '/api/stripe/webhook', {
    method: 'POST', body: payload,
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
  });
}
const paidSession = id => ({
  id, payment_status: 'paid', amount_subtotal: 19900, amount_total: 19900,
  customer_details: { email: 'buyer@example.com', name: 'Test Buyer' },
  shipping_details: { name: 'Test Buyer', address: { line1: '1 Test St', city: 'Halifax', state: 'NS', postal_code: 'B3H 0A1', country: 'CA' } },
  metadata: { items: JSON.stringify([{ id: 1, qty: 1 }]) },
});

test('health check answers and bad JSON gets a clean 400 (no crash, no alert)', async () => {
  const h = await get('/healthz');
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  const r = await fetch(BASE + '/api/subscribe', { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).success, false);
  assert.equal((await get('/healthz')).status, 200, 'server still up');
});

test('webhook rejects unsigned requests', async () => {
  const r = await fetch(BASE + '/api/stripe/webhook', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
});

test('paid checkout webhook records exactly one order, even when replayed', async () => {
  const sid = 'cs_test_' + Date.now();
  assert.equal((await signedWebhook(paidSession(sid))).status, 200);
  assert.equal((await signedWebhook(paidSession(sid))).status, 200); // Stripe retries
  const rows = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').all(sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 199);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(rows[0].id);
  assert.equal(items.length, 1);

  // verify endpoint (success page) returns the order + total for the Ads conversion
  const v = await (await get('/api/checkout/verify?session_id=' + sid)).json();
  assert.equal(v.paid, true);
  assert.equal(v.order_number, rows[0].order_number);
  assert.equal(v.total, 199);

  // order lookup needs number + matching email
  const ok = await postJson('/api/order-lookup', { order_number: rows[0].order_number, email: 'buyer@example.com' });
  assert.equal(ok.status, 200);
  const wrong = await postJson('/api/order-lookup', { order_number: rows[0].order_number, email: 'someone@else.com' });
  assert.equal(wrong.status, 404);
});

test('unpaid session does not create an order', async () => {
  const sid = 'cs_test_unpaid_' + Date.now();
  await signedWebhook({ ...paidSession(sid), payment_status: 'unpaid' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE stripe_session_id = ?').get(sid).n, 0);
});

test('verify endpoint requires a session id', async () => {
  assert.equal((await get('/api/checkout/verify')).status, 400);
});

// ── Admin image uploads (persist on the data volume) ───
async function login() {
  const r = await postJson('/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(r.status, 200);
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

test('admin routes reject anonymous requests', async () => {
  const r = await postJson('/api/admin/upload-image', { filename: 'x.png', data: 'AAAA' });
  assert.equal(r.status, 401);
  const bad = await postJson('/api/admin/login', { email: ADMIN_EMAIL, password: 'wrong' });
  assert.equal(bad.status, 401);
});

test('admin upload lands in the data volume, is served, listed and deletable', async () => {
  const cookie = await login();
  const png = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
  const up = await (await postJson('/api/admin/upload-image',
    { filename: 'Test Upload.png', mimetype: 'image/png', data: png.toString('base64') }, { Cookie: cookie })).json();
  assert.equal(up.success, true);
  assert.equal(up.filename, 'Test_Upload.png');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'uploads', 'Test_Upload.png')), 'saved to DATA_DIR/uploads');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'images', 'products', 'Test_Upload.png')), 'not in public/');
  assert.equal((await get(up.url)).status, 200);

  // name clash with a repo image gets a new name instead of shadowing it
  const clash = await (await postJson('/api/admin/upload-image',
    { filename: 'oil-main.webp', mimetype: 'image/png', data: png.toString('base64') }, { Cookie: cookie })).json();
  assert.equal(clash.filename, 'oil-main_1.webp');

  const list = await (await get('/api/admin/product-images', { headers: { Cookie: cookie } })).json();
  const names = list.images.map(i => i.name);
  assert.ok(names.includes('Test_Upload.png') && names.includes('oil-main.webp'), 'lists uploads + repo images');

  const del = await fetch(BASE + '/api/admin/product-images/Test_Upload.png', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 200);
  assert.equal((await get(up.url)).status, 404);
  const delRepo = await fetch(BASE + '/api/admin/product-images/oil-main.webp', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(delRepo.status, 400, 'built-in images cannot be deleted from the panel');
});

test('admin API blocks cross-site requests but allows same-origin', async () => {
  const cookie = await login();
  const evil = await postJson('/api/admin/upload-image', { filename: 'x.png', data: 'AAAA' },
    { Cookie: cookie, Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const own = await fetch(BASE + '/api/admin/product-images/nope.png',
    { method: 'DELETE', headers: { Cookie: cookie, Origin: BASE } });
  assert.equal(own.status, 404, 'same-origin request passes the CSRF check');
  const login2 = await postJson('/api/admin/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { Origin: BASE });
  assert.equal(login2.status, 200, 'login from our own page still works');
  assert.match(login2.headers.getSetCookie().join(';'), /SameSite=Strict/i);
});

test('upload rejects non-images disguised with an image extension', async () => {
  const cookie = await login();
  const r = await postJson('/api/admin/upload-image',
    { filename: 'evil.png', data: Buffer.from('<script>alert(1)</script> padding').toString('base64') }, { Cookie: cookie });
  assert.equal(r.status, 400);
});

