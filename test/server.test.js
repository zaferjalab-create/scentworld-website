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

// Fake Stripe API: records checkout-session requests and answers like Stripe.
const http = require('http');
const stripeCalls = [];
// In-memory Stripe product catalogue for the oil sync (lib/stripe-catalog.js).
const fakeProducts = new Map(), fakePrices = new Map();
function fakeCatalogue(method, url, params) {
  const u = new URL(url, 'http://x');
  // flat fields + metadata[key] -> { metadata: { key } }
  const obj = () => {
    const o = {};
    for (const [k, v] of params) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m) (o.metadata = o.metadata || {})[m[1]] = v;
      else if (!k.includes('[')) o[k] = v;
    }
    return o;
  };
  const patch = target => {
    const o = obj();
    if ('active' in o) o.active = o.active === 'true';
    return Object.assign(target, o);
  };
  let m;
  if ((m = /^\/v1\/products\/([^/]+)$/.exec(u.pathname))) {
    const p = fakeProducts.get(m[1]);
    if (!p) return { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such product' } } };
    if (method === 'POST') patch(p);
    return { body: p };
  }
  if (u.pathname === '/v1/products') {
    if (method === 'POST') {
      const p = { object: 'product', active: true, default_price: null, ...obj() };
      fakeProducts.set(p.id, p);
      return { body: p };
    }
    return { body: { object: 'list', has_more: false, data: [...fakeProducts.values()].filter(p => p.active) } };
  }
  if ((m = /^\/v1\/prices\/([^/]+)$/.exec(u.pathname))) {
    const pr = fakePrices.get(m[1]);
    if (method === 'POST') {
      // like Stripe: a product's default price cannot be archived
      if (params.get('active') === 'false' && fakeProducts.get(pr.product)?.default_price === pr.id) {
        return { status: 400, body: { error: { type: 'invalid_request_error', message: 'This price cannot be archived because it is the default price of its product.' } } };
      }
      patch(pr);
    }
    return { body: pr };
  }
  if (u.pathname === '/v1/prices') {
    if (method === 'POST') {
      const pr = { object: 'price', id: 'price_' + (fakePrices.size + 1), type: 'one_time', active: true, metadata: {}, ...obj(), unit_amount: Number(params.get('unit_amount')) };
      fakePrices.set(pr.id, pr);
      return { body: pr };
    }
    const product = u.searchParams.get('product'), onlyActive = u.searchParams.get('active') === 'true';
    return { body: { object: 'list', has_more: false, data: [...fakePrices.values()].filter(x => x.product === product && (!onlyActive || x.active)) } };
  }
  return null;
}
let stripeTaxOff = false; // simulate Stripe Tax being deactivated on the account
const fakeStripe = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    stripeCalls.push({ path: req.url, params });
    res.setHeader('Content-Type', 'application/json');
    if (stripeTaxOff && params.get('automatic_tax[enabled]') === 'true') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Stripe Tax has not been activated on your account.' } }));
    }
    const catalogue = fakeCatalogue(req.method, req.url, params);
    if (catalogue) { res.statusCode = catalogue.status || 200; return res.end(JSON.stringify(catalogue.body)); }
    res.end(JSON.stringify({ id: 'cs_test_fake', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_fake' }));
  });
}).listen(0);
const STRIPE_API_URL = 'http://127.0.0.1:' + fakeStripe.address().port;

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
  STRIPE_API_URL,
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
  fakeStripe.close();
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

test('product structured data: one priced variant per size (ids match the feed) + shipping that matches checkout', async () => {
  const ld = async slug => {
    const html = await (await get('/products/' + slug)).text();
    const blocks = html.split('<script type="application/ld+json">').slice(1).map(b => JSON.parse(b.split('</script>')[0]));
    return blocks.find(b => b['@type'] === 'Product' || b['@type'] === 'ProductGroup');
  };
  const oil = db.prepare("SELECT slug FROM products WHERE category = 'oils' AND active = 1 AND sizes IS NOT NULL LIMIT 1").get();
  const group = await ld(oil.slug);
  assert.equal(group['@type'], 'ProductGroup');
  assert.equal(group.productGroupID, oil.slug, 'group id = feed item_group_id');
  assert.ok(!group.offers && group.hasVariant.length > 1, 'no price-less top-level product');
  const feed = await (await get('/catalog.csv')).text();
  for (const v of group.hasVariant) {
    assert.equal(v['@type'], 'Product');
    assert.ok(feed.includes(`"${v.sku}",`), `variant sku ${v.sku} is a feed id`);
    assert.equal(v.offers['@type'], 'Offer');
    assert.ok(Number(v.offers.price) > 0);
    const expected = Number(v.offers.price) < 150 ? '12.99' : '0.00';
    assert.equal(v.offers.shippingDetails.shippingRate.value, expected, `shipping for ${v.offers.price}`);
  }
  const s200 = await ld('s200'); // single price, $899 -> ships free
  assert.equal(s200['@type'], 'Product');
  assert.equal(s200.sku, 's200');
  assert.equal(s200.offers.shippingDetails.shippingRate.value, '0.00');
});

test('product videos: gallery video + VideoObject, homepage reel, cached range-served files', async () => {
  const { productVideos } = require('../lib/videos');
  assert.ok(productVideos.s20 && productVideos.s20.loop === '/videos/s20-loop.mp4', 'videos found by filename');

  const s20 = await (await get('/products/s20')).text();
  assert.ok(s20.includes('id="mainVideo" src="/videos/s20.mp4"'), 'gallery video');
  assert.ok(s20.includes('"@type":"VideoObject"'), 'video structured data');
  const oil = db.prepare("SELECT slug FROM products WHERE category = 'oils' AND active = 1 LIMIT 1").get();
  assert.ok(!(await (await get('/products/' + oil.slug)).text()).includes('id="mainVideo"'), 'no video, no player');

  const home = await (await get('/')).text();
  assert.ok(home.includes('id="in-action"') && home.includes('data-src="/videos/s20-loop.mp4"'), 'homepage reel');
  assert.ok(home.includes('/js/video-fx.js'), 'card hover script');

  const r = await get('/videos/s20-loop.mp4', { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206, 'range requests (needed by Safari/iOS)');
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.match(r.headers.get('cache-control'), /max-age=2592000/);
});

test('hidden products redirect to their shop category; robots skips the API', async () => {
  // l100 is a hidden (not deleted) diffuser
  const r = await get('/products/l100', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/shop?filter=diffusers');
  assert.equal((await get('/products/no-such-thing')).status, 404);
  assert.ok((await (await get('/robots.txt')).text()).includes('Disallow: /api/'));
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
  // 3,000-5,000 sq ft units: s200 (3,000–4,000), s300 and l200 (4,000–5,000)
  const commercial = ['s200', 's300', 'l200'];
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
    db.prepare("UPDATE products SET active = 1 WHERE slug IN ('s200', 's300')").run();
  }
  assert.ok((await (await get('/')).text()).includes('/shop?size=small'));
});

test('October 2026 catalogue: 29 oils in five collections, S100 + S300 on sale', async () => {
  const { COLLECTIONS, OIL_LINEUP } = require('../lib/collections');
  const oils = db.prepare("SELECT slug, collection FROM products WHERE category = 'oils' AND active = 1 ORDER BY sort_order").all();
  assert.equal(oils.length, 29);
  assert.deepEqual(oils.map(o => o.slug), Object.values(OIL_LINEUP).flat(), 'sheet order, grouped by collection');
  assert.ok(oils.every(o => COLLECTIONS[o.collection]), 'every oil has a collection');
  assert.equal(db.prepare("SELECT count(*) c FROM products WHERE category = 'oils' AND active = 1 AND (full_desc IS NULL OR full_desc = '')").get().c, 0, 'no oil without a description');

  const shop = await (await get('/shop')).text();
  assert.ok(shop.includes('id="collBar"') && shop.includes('data-collection="hotel"'), 'collection filter');
  assert.ok(shop.includes('Hotel Collection') && shop.includes('The Business Collection'));
  assert.ok(!shop.includes('/products/juniper'), 'retired oils are not listed');
  assert.equal((await get('/products/juniper', { redirect: 'manual' })).status, 302, 'retired oil pages redirect to the shop');
  assert.ok((await (await get('/products/white-tea')).text()).includes('/shop?collection=hotel'));

  const diffusers = db.prepare("SELECT slug, price FROM products WHERE category = 'diffusers' AND active = 1 ORDER BY sort_order").all();
  assert.deepEqual(diffusers.map(d => d.slug), ['s20', 's30', 's100', 's200', 's300']);
  assert.equal(diffusers.find(d => d.slug === 's100').price, 699);
  assert.equal(diffusers.find(d => d.slug === 's300').price, 1199);
  const s300 = await (await get('/products/s300')).text();
  assert.ok(s300.includes('800 ml') && s300.includes('4,000–5,000 sq ft'));
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
  id, payment_status: 'paid', amount_subtotal: 19900, amount_total: 22686,
  total_details: { amount_tax: 2786, amount_shipping: 0, amount_discount: 0 },
  customer_details: { email: 'buyer@example.com', name: 'Test Buyer' },
  shipping_details: { name: 'Test Buyer', address: { line1: '1 Test St', city: 'Halifax', state: 'NS', postal_code: 'B3H 0A1', country: 'CA' } },
  metadata: { items: JSON.stringify([{ id: 1, qty: 1 }]) },
});

test('health check answers and bad JSON gets a clean 400 (no crash, no alert)', async () => {
  const h = await get('/healthz');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  const r = await fetch(BASE + '/api/subscribe', { method: 'POST', body: '{not json', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).success, false);
  assert.equal((await get('/healthz')).status, 200, 'server still up');
});

test('checkout sends Stripe a valid session: real prices, shipping option, no invalid params', async () => {
  const oil = db.prepare("SELECT id FROM products WHERE category = 'oils' AND active = 1 LIMIT 1").get();
  const r = await postJson('/api/checkout', { items: [{ id: oil.id, quantity: 2, size: '100ml' }] });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  assert.ok(data.url.startsWith('https://checkout.stripe.com/'), data.url);
  const call = stripeCalls.find(c => c.path === '/v1/checkout/sessions');
  assert.ok(call, 'a checkout session was requested');
  const p = call.params;
  const keys = [...p.keys()];
  // automatic_payment_methods is a PaymentIntents option; Checkout rejects it.
  assert.ok(!keys.some(k => k.startsWith('automatic_payment_methods')), 'no invalid params');
  assert.equal(p.get('mode'), 'payment');
  assert.equal(p.get('line_items[0][price_data][currency]'), 'cad');
  assert.equal(p.get('line_items[0][price_data][unit_amount]'), '4900', 'price comes from the server, not the cart');
  assert.equal(p.get('line_items[0][quantity]'), '2');
  assert.equal(p.get('shipping_options[0][shipping_rate_data][type]'), 'fixed_amount');
  assert.equal(p.get('allow_promotion_codes'), 'true');
  assert.ok(p.get('success_url').includes('/success.html?session_id={CHECKOUT_SESSION_ID}'));
  // GST/HST: Stripe Tax on, prices and shipping are tax-exclusive
  assert.equal(p.get('automatic_tax[enabled]'), 'true');
  assert.equal(p.get('line_items[0][price_data][tax_behavior]'), 'exclusive');
  assert.equal(p.get('shipping_options[0][shipping_rate_data][tax_behavior]'), 'exclusive');
});

test('checkout still works (without tax) if Stripe Tax is switched off', async () => {
  const oil = db.prepare("SELECT id FROM products WHERE category = 'oils' AND active = 1 LIMIT 1").get();
  const before = stripeCalls.length;
  stripeTaxOff = true;
  try {
    const r = await postJson('/api/checkout', { items: [{ id: oil.id, quantity: 1, size: '100ml' }] });
    assert.equal(r.status, 200, 'customer can still check out');
    const calls = stripeCalls.slice(before);
    assert.equal(calls.length, 2, 'one rejected attempt, one retry');
    assert.equal(calls[1].params.get('automatic_tax[enabled]'), null, 'retry has no tax');
  } finally {
    stripeTaxOff = false;
  }
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
  assert.equal(rows[0].total, 226.86);
  assert.equal(rows[0].subtotal, 199);
  assert.equal(rows[0].tax, 27.86, 'HST recorded on the order');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(rows[0].id);
  assert.equal(items.length, 1);

  // verify endpoint (success page) returns the order + total for the Ads conversion
  const v = await (await get('/api/checkout/verify?session_id=' + sid)).json();
  assert.equal(v.paid, true);
  assert.equal(v.order_number, rows[0].order_number);
  assert.equal(v.total, 226.86);

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


test('Stripe catalogue sync: Oil 100/200/500 ml + Gift Oil Set, idempotent, older layout archived', async () => {
  const { syncStripeCatalogue } = require('../lib/stripe-catalog');
  const api = new URL(STRIPE_API_URL);
  const fake = require('stripe')('sk_test_dummy', { host: api.hostname, port: api.port, protocol: 'http' });
  const run = () => syncStripeCatalogue(fake, db, 'https://www.scentworld.ca');
  const priceOf = id => [...fakePrices.values()].filter(x => x.product === id && x.active).map(x => x.unit_amount);

  // leftovers: an older one-product-per-oil item of ours, and a product the owner made by hand
  fakeProducts.set('sw-oil-white-tea', { id: 'sw-oil-white-tea', object: 'product', active: true, name: 'White Tea Oil' });
  fakeProducts.set('prod_handmade', { id: 'prod_handmade', object: 'product', active: true, name: 'S20' });

  const first = await run();
  assert.deepEqual(first.items, ['Oil 100 ml $49.00', 'Oil 200 ml $89.00', 'Oil 500 ml $189.00', 'Gift Oil Set $99.00']);
  assert.deepEqual([first.productsCreated, first.pricesCreated, first.productsArchived], [4, 4, 1]);
  assert.deepEqual(['sw-oil-100ml', 'sw-oil-200ml', 'sw-oil-500ml', 'sw-gift-oil-set'].map(priceOf), [[4900], [8900], [18900], [9900]]);
  const p100 = fakeProducts.get('sw-oil-100ml');
  assert.equal(p100.name, 'Oil 100 ml');
  assert.ok(!p100.description, 'no description');
  assert.ok([...fakePrices.values()].every(x => x.currency === 'cad' && x.tax_behavior === 'exclusive'));
  assert.equal(fakeProducts.get('sw-oil-white-tea').active, false, 'old per-oil product archived');
  assert.equal(fakeProducts.get('prod_handmade').active, true, 'hand-made Stripe products are never touched');
  // created last-to-first, so Stripe's newest-first list reads 100, 200, 500, gift set
  assert.deepEqual([...fakeProducts.keys()].slice(-4), ['sw-gift-oil-set', 'sw-oil-500ml', 'sw-oil-200ml', 'sw-oil-100ml']);

  const again = await run();
  assert.deepEqual([again.productsCreated, again.pricesCreated, again.pricesArchived, again.productsArchived], [0, 0, 0, 0], 'second run changes nothing');

  // a site-wide price change (most oils now $55 for 100 ml) makes a new price and archives the old
  const saved = db.prepare("SELECT id, sizes FROM products WHERE category = 'oils' AND active = 1").all();
  try {
    for (const r of saved) db.prepare('UPDATE products SET sizes = ? WHERE id = ?').run(r.sizes.replace('"100ml","price":49', '"100ml","price":55'), r.id);
    const third = await run();
    assert.deepEqual([third.pricesCreated, third.pricesArchived], [1, 1]);
    assert.deepEqual(priceOf('sw-oil-100ml'), [5500]);
  } finally {
    for (const r of saved) db.prepare('UPDATE products SET sizes = ? WHERE id = ?').run(r.sizes, r.id);
  }
});

test('scheduled Stripe sale: 25% off every product for 4-7 Nov (Halifax time), then back to regular', async () => {
  const { syncStripeCatalogue, saleSettings } = require('../lib/stripe-catalog');
  const api = new URL(STRIPE_API_URL);
  const fake = require('stripe')('sk_test_dummy', { host: api.hostname, port: api.port, protocol: 'http' });
  const at = iso => new Date(iso);
  const run = iso => syncStripeCatalogue(fake, db, 'https://www.scentworld.ca', at(iso));
  const active = id => [...fakePrices.values()].filter(x => x.product === id && x.active).map(x => x.unit_amount);

  // the owner's default: 25%, 2026-11-04 .. 2026-11-07, inclusive, in Halifax time (UTC-4 until the clocks change on Nov 1, then UTC-4/-3...)
  assert.deepEqual([saleSettings(db, at('2026-11-03T20:00:00-04:00')).active, saleSettings(db, at('2026-11-04T00:30:00-04:00')).active], [false, true]);
  assert.deepEqual([saleSettings(db, at('2026-11-07T23:30:00-04:00')).active, saleSettings(db, at('2026-11-08T00:30:00-04:00')).active], [true, false]);
  assert.equal(saleSettings(db, at('2026-11-05T12:00:00-04:00')).state, 'sale:25:2026-11-04:2026-11-07');

  // a product the owner made by hand: S300 at $1,199.00
  fakeProducts.clear(); fakePrices.clear();
  fakePrices.set('price_s300', { id: 'price_s300', object: 'price', type: 'one_time', product: 'prod_s300', active: true, currency: 'cad', unit_amount: 119900, tax_behavior: 'exclusive', metadata: {} });
  fakeProducts.set('prod_s300', { id: 'prod_s300', object: 'product', active: true, name: 'S300', default_price: 'price_s300' });

  const before = await run('2026-10-20T12:00:00-03:00');
  assert.equal(before.sale, 'off');
  assert.deepEqual([active('sw-oil-100ml'), active('prod_s300')], [[4900], [119900]], 'regular prices before the sale');

  const during = await run('2026-11-05T12:00:00-04:00');
  assert.equal(during.sale, '25% off until 2026-11-07');
  assert.deepEqual(during.items, ['Oil 100 ml $36.75', 'Oil 200 ml $66.75', 'Oil 500 ml $141.75', 'Gift Oil Set $74.25']);
  assert.deepEqual([active('sw-oil-100ml'), active('sw-gift-oil-set'), active('prod_s300')], [[3675], [7425], [89925]], 'exactly one (discounted) active price per product');
  assert.equal(during.saleApplied, 1);
  assert.equal(fakeProducts.get('prod_s300').default_price !== 'price_s300', true);
  assert.equal(fakePrices.get('price_s300').active, false, 'regular price is parked, not deleted');

  const again = await run('2026-11-06T09:00:00-04:00');
  assert.deepEqual([again.pricesCreated, again.pricesArchived, again.saleApplied, again.saleRemoved], [0, 0, 0, 0], 'no churn while the sale runs');

  const after = await run('2026-11-08T08:00:00-04:00');
  assert.equal(after.sale, 'off');
  assert.equal(after.saleRemoved, 1);
  assert.deepEqual([active('sw-oil-100ml'), active('sw-gift-oil-set'), active('prod_s300')], [[4900], [9900], [119900]], 'regular prices are back');
  assert.equal(fakeProducts.get('prod_s300').default_price, 'price_s300', 'the original price object is restored');
  assert.equal(after.pricesCreated, 0, 'old regular prices are re-used, not duplicated');

  // cancelling in admin (empty percentage) = no sale even inside the dates
  const pct = db.prepare("SELECT value FROM settings WHERE key = 'sale_percent'").get().value;
  try {
    db.prepare("UPDATE settings SET value = '' WHERE key = 'sale_percent'").run();
    assert.equal((await run('2026-11-05T12:00:00-04:00')).sale, 'off');
    assert.deepEqual(active('prod_s300'), [119900]);
  } finally {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'sale_percent'").run(pct);
  }
});

test('aerosol range is off sale: no products, no filter button, old pages redirect', async () => {
  assert.equal(db.prepare("SELECT count(*) c FROM products WHERE category = 'aerosol' AND active = 1").get().c, 0);
  for (const page of ['/', '/shop']) {
    const html = await (await get(page)).text();
    assert.ok(!html.includes('data-cat="aerosol"'), page + ' has no aerosol filter');
    assert.ok(!html.includes('/products/aerosol-'), page + ' links to no aerosol product');
  }
  const r = await get('/products/aerosol-gold', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.ok(!(await (await get('/catalog.csv')).text()).includes('aerosol'), 'not in the product feed');
});
