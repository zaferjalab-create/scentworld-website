require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const db = require('./database');
// STRIPE_API_URL lets the test suite point the SDK at a local fake Stripe
// that records exactly what checkout sends (unset in production).
const stripeApi = process.env.STRIPE_API_URL ? new URL(process.env.STRIPE_API_URL) : null;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, stripeApi
  ? { host: stripeApi.hostname, port: stripeApi.port, protocol: stripeApi.protocol.replace(':', '') }
  : undefined);
const { resendEmail, escapeHtml, sendNotification, sendConfirmation } = require('./lib/email');
const { scheduleDailyBackup } = require('./lib/backup');
const { scheduleReviewRequests } = require('./lib/review-requests');
const { stripeShippingOption, shippingRules } = require('./lib/shipping');

const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// A real session secret should be set in the environment. The old hardcoded
// fallback let anyone who read the public repo forge an admin session cookie.
// If none is set we generate a random one at startup rather than crashing —
// the site stays up, but sessions reset on every restart until SESSION_SECRET
// is configured, so admins get logged out on redeploy. Set it in Railway.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('⚠ SESSION_SECRET not set — using a random ephemeral secret. ' +
    'Set SESSION_SECRET in the environment so admin sessions survive restarts.');
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}

// The admin panel + login page live under a configurable, secret path segment
// so they aren't sitting at the obvious /admin/ for bots to find. Set ADMIN_PATH
// to a random string in the environment (NOT in this public repo). Falls back to
// 'admin' if unset. Only URL-safe characters are allowed.
let ADMIN_PATH = process.env.ADMIN_PATH || 'admin';
if (!/^[a-zA-Z0-9_-]+$/.test(ADMIN_PATH)) {
  console.warn(`⚠ ADMIN_PATH "${ADMIN_PATH}" has invalid characters — falling back to 'admin'.`);
  ADMIN_PATH = 'admin';
}
if (ADMIN_PATH === 'admin') {
  console.warn('⚠ ADMIN_PATH not set — admin panel is at the default /admin/. Set ADMIN_PATH to a secret string to hide it.');
}
const ADMIN_BASE = '/' + ADMIN_PATH;

// Product images shipped in the repo live in public/images/products. Images
// uploaded through the admin panel go to data/uploads instead: data/ is the
// Railway volume, while public/ is rebuilt from git on every deploy, so
// uploads saved there were wiped by the next push. Both folders are served
// under the same /images/products/ URL.
const REPO_IMG_DIR = path.join(__dirname, 'public', 'images', 'products');
const UPLOAD_IMG_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
if (!fs.existsSync(UPLOAD_IMG_DIR)) fs.mkdirSync(UPLOAD_IMG_DIR, { recursive: true });

// Railway terminates TLS at its proxy; trust it so secure cookies work and
// rate limiting sees the real client IP (via X-Forwarded-For) instead of the proxy.
app.set('trust proxy', 1);

// EJS server-side templating (shared header/footer partials)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Content-Security-Policy. The site relies on inline scripts/styles (GTM,
// Facebook Pixel, Stripe.js, inline handlers) so 'unsafe-inline' is required
// until those are externalized — but the high-value directives below still
// harden the page: no plugins (object-src none), can't be reframed
// (frame-ancestors self), forms can only post to us (form-action self), and
// <base> can't be hijacked (base-uri self). Third-party origins are whitelisted.
// Google origins follow Google's published CSP guidance for GA4 + Google Ads
// (gtag posts hits to *.google-analytics.com, analytics.google.com,
// www.google.<ccTLD> and several doubleclick hosts — missing any of them
// silently drops analytics / conversion pings).
const GOOGLE_CONNECT = 'https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://*.googletagmanager.com https://www.google.com https://www.google.ca https://www.googleadservices.com https://googleads.g.doubleclick.net https://*.g.doubleclick.net https://ad.doubleclick.net https://pagead2.googlesyndication.com';
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://*.googletagmanager.com https://connect.facebook.net https://js.stripe.com https://*.google-analytics.com https://cdnjs.cloudflare.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://www.google.com https://www.google.ca",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  `connect-src 'self' ${GOOGLE_CONNECT} https://connect.facebook.net https://www.facebook.com https://api.stripe.com`,
  "frame-src https://js.stripe.com https://hooks.stripe.com https://td.doubleclick.net https://*.googletagmanager.com https://www.facebook.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.facebook.com",
  "frame-ancestors 'self'",
].join('; ');

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// gzip/deflate responses — HTML pages are 100-170KB uncompressed.
app.use(compression());

// Health check for Railway (railway.toml healthcheckPath) and uptime monitors:
// a deploy only goes live once this answers, and it proves the DB is readable.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    // version = deployed git commit (Railway sets RAILWAY_GIT_COMMIT_SHA), so a
    // deploy can be confirmed from outside.
    const version = (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7);
    res.set('Cache-Control', 'no-store').json({ ok: true, version });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

// ── Stripe webhook ──
// MUST be registered before express.json(): signature verification needs the
// raw, unparsed request body. This is the authoritative order-creation path —
// Stripe calls it server-to-server on checkout.session.completed, so an order
// is recorded even if the customer closes the tab and never loads the success
// page. Requires STRIPE_WEBHOOK_SECRET (from the Stripe dashboard endpoint).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('⚠ Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — ignoring.');
    return res.status(500).send('Webhook not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const orderNumber = recordOrderFromSession(event.data.object);
      if (orderNumber) console.log(`✅ Order recorded via webhook: ${orderNumber}`);
    }
  } catch (err) {
    console.error('Stripe webhook handler error:', err.message);
    // 500 tells Stripe to retry later rather than dropping the order.
    return res.status(500).send('Handler error');
  }
  res.json({ received: true });
});

// Body parsers. The global limit is deliberately small so ordinary endpoints
// can't be fed huge payloads. Only the base64 image-upload route needs a large
// body, and it sets its own 20mb express.json() inline, so we skip the global
// parser for that path.
const jsonSmall = express.json({ limit: '100kb' });
app.use((req, res, next) => {
  if (req.path === '/api/admin/upload-image') return next();
  jsonSmall(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
// Express 5 leaves req.body undefined when a request has no body (Express 4
// gave {}); keep the old behaviour so `const { x } = req.body` never throws.
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
// Images/fonts are cached for 30 days: uploads never overwrite an existing
// filename, so a URL's content doesn't change (give a replaced repo image a
// new filename). Everything else (CSS/JS) revalidates hourly.
const STATIC_OPTS = {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/\.(png|jpe?g|webp|gif|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  },
};
app.use(express.static(path.join(__dirname, 'public'), STATIC_OPTS));
app.use('/images/products', express.static(UPLOAD_IMG_DIR, STATIC_OPTS));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',         // HTTPS-only when the connection is HTTPS (works via trust proxy)
    httpOnly: true,         // not readable by JS (blocks cookie theft via XSS)
    sameSite: 'strict',     // admin-only cookie; never sent on cross-site requests (CSRF)
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// CSRF defence for the admin API — the only cookie-authenticated area. The
// session cookie is SameSite=Strict, and state-changing requests must come from
// our own origin: browsers always send Origin (or Referer) on a cross-site
// POST/PUT/DELETE, so a request forged from another site is rejected here.
// Requests with neither header are non-browser clients, which carry no session
// cookie, so the normal admin auth check still stops them.
app.use('/api/admin', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next();
  let host = null;
  try { host = new URL(source).host; } catch (e) { /* malformed -> blocked */ }
  if (host && host === req.get('host')) return next();
  return res.status(403).json({ success: false, error: 'Cross-site request blocked' });
});

// ═══════════════════════════════════════
// RATE LIMITERS
// ═══════════════════════════════════════

// Strict limiter for the admin login — blunts credential brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count
  message: { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Looser limiter for public form submissions — stops spam floods.
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,                  // 30 submissions per IP per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many submissions. Please try again later.' },
});

// ═══════════════════════════════════════
// PUBLIC API ROUTES
// ═══════════════════════════════════════

// Contact / Quote Form
app.post('/api/contact', formLimiter, (req, res) => {
  try {
    const { first_name, last_name, email, phone, customer_type, product_interest, message } = req.body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }
    const stmt = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone, customer_type, product_interest, message) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(first_name, last_name, email, phone || null, customer_type || null, product_interest || null, message || null);
    sendNotification('New Quote Request', `From: ${first_name} ${last_name} (${email})\nType: ${customer_type}\nInterest: ${product_interest}\n\n${message || 'No message'}`);
    sendConfirmation(email, first_name, 'quote', `Interest: ${product_interest || 'General'}\nType: ${customer_type || 'N/A'}`);
    res.json({ success: true, message: 'Quote request received. We\'ll be in touch within 24 hours.' });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Booking / Consultation
app.post('/api/booking', formLimiter, (req, res) => {
  try {
    const { first_name, last_name, email, phone, business_name, preferred_date, preferred_time, topic, message } = req.body;
    if (!first_name || !last_name || !email || !preferred_date || !preferred_time) {
      return res.status(400).json({ success: false, error: 'Please fill in all required fields' });
    }
    const stmt = db.prepare(`INSERT INTO bookings (first_name, last_name, email, phone, business_name, preferred_date, preferred_time, topic, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(first_name, last_name, email, phone || null, business_name || null, preferred_date, preferred_time, topic || null, message || null);
    sendNotification('New Booking Request', `From: ${first_name} ${last_name} (${email})\nDate: ${preferred_date} at ${preferred_time}\nBusiness: ${business_name || 'N/A'}\nTopic: ${topic || 'General'}\n\n${message || ''}`);
    sendConfirmation(email, first_name, 'booking', `${preferred_date} at ${preferred_time}\nTopic: ${topic || 'General Consultation'}`);
    res.json({ success: true, message: 'Consultation booked! We\'ll confirm your time slot within 24 hours.' });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Newsletter Subscribe
app.post('/api/subscribe', formLimiter, (req, res) => {
  try {
    const { email, first_name } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
    const existing = db.prepare('SELECT id, status FROM subscribers WHERE email = ?').get(email);
    if (existing) {
      if (existing.status === 'unsubscribed') {
        db.prepare('UPDATE subscribers SET status = ?, first_name = COALESCE(?, first_name) WHERE id = ?').run('active', first_name || null, existing.id);
        return res.json({ success: true, message: 'Welcome back! You\'ve been re-subscribed.' });
      }
      return res.json({ success: true, message: 'You\'re already subscribed!' });
    }
    db.prepare('INSERT INTO subscribers (email, first_name) VALUES (?, ?)').run(email, first_name || null);
    res.json({ success: true, message: 'Welcome to the Scent World inner circle!' });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Get products (public)
app.get('/api/products', (req, res) => {
  const { category } = req.query;
  let products;
  if (category) {
    products = db.prepare('SELECT * FROM products WHERE active = 1 AND category = ? ORDER BY sort_order').all(category);
  } else {
    products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order').all();
  }
  res.json({ success: true, products });
});

// Submit a product review (held for admin approval)
app.post('/api/reviews', formLimiter, (req, res) => {
  try {
    const { product_id, name, rating, text } = req.body;
    const pid = parseInt(product_id, 10);
    const stars = parseInt(rating, 10);
    const cleanName = String(name || '').trim().slice(0, 60);
    const cleanText = String(text || '').trim().slice(0, 2000);
    if (!pid || !cleanName || !stars || stars < 1 || stars > 5) {
      return res.status(400).json({ success: false, error: 'Name and a 1–5 star rating are required' });
    }
    const product = db.prepare('SELECT id, name FROM products WHERE id = ? AND active = 1').get(pid);
    if (!product) return res.status(400).json({ success: false, error: 'Product not found' });
    db.prepare('INSERT INTO reviews (product_id, name, rating, text) VALUES (?, ?, ?, ?)').run(pid, cleanName, stars, cleanText || null);
    sendNotification('New Product Review (pending approval)', `Product: ${product.name}\nFrom: ${cleanName}\nRating: ${stars}/5\n\n${cleanText || '(no text)'}\n\nApprove it in the admin dashboard → Reviews.`);
    res.json({ success: true, message: 'Thank you! Your review will appear once approved.' });
  } catch (err) {
    console.error('Review error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

app.get('/api/products/:slug', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
  res.json({ success: true, product });
});

// ═══════════════════════════════════════
// STRIPE CHECKOUT
// ═══════════════════════════════════════

// Estimated delivery range: 1–2 business days processing + 3–8 business days transit
function addBusinessDays(from, n) {
  const d = new Date(from);
  while (n > 0) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n--; }
  return d;
}
function deliveryEstimate() {
  const now = new Date();
  const f = d => d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'America/Halifax' });
  return `${f(addBusinessDays(now, 4))} – ${f(addBusinessDays(now, 10))}`;
}

app.post('/api/checkout', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ success: false, error: 'No items in cart' });
    if (items.length > 50) return res.status(400).json({ success: false, error: 'Too many items in cart' });

    const lineItems = [];
    const metaItems = [];
    let subtotal = 0;
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.id);
      if (!product) return res.status(400).json({ success: false, error: `Product ${item.id} not available` });
      // Clamp quantity to a sane positive integer so a tampered cart can't send
      // Stripe a huge, zero, negative, or non-numeric quantity.
      const qty = Math.floor(Number(item.quantity));
      if (!Number.isFinite(qty) || qty < 1 || qty > 100) {
        return res.status(400).json({ success: false, error: 'Invalid quantity' });
      }
      item.quantity = qty;
      // Resolve price from size variant if provided, otherwise use product default
      let unitPrice = product.price;
      let productName = product.name;
      if (item.size) {
        try {
          const sizes = product.sizes ? JSON.parse(product.sizes) : null;
          if (Array.isArray(sizes)) {
            const match = sizes.find(s => s.label === item.size);
            if (match) {
              unitPrice = match.price;
              productName = `${product.name} — ${match.label}`;
            }
          }
        } catch (e) {}
      }
      if (!unitPrice) return res.status(400).json({ success: false, error: `No price for product ${item.id}` });
      lineItems.push({
        price_data: {
          currency: 'cad',
          product_data: { name: productName, description: product.short_desc || undefined },
          unit_amount: Math.round(unitPrice * 100),
        },
        quantity: item.quantity,
      });
      metaItems.push({ id: item.id, qty: item.quantity, s: item.size || undefined, p: unitPrice });
      subtotal += unitPrice * item.quantity;
    }

    // Success/cancel URLs must point at the site the customer is actually on.
    // The old fallback was http://localhost:3000 — if BASE_URL wasn't set in
    // the environment, Stripe sent customers to localhost after paying or
    // cancelling (dead page, and a different origin so the cart looked wiped).
    // Deriving from the request works in dev and prod with no env var needed
    // (trust proxy is set, so req.protocol is correct behind Railway).
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      // No payment_method_types: hosted Checkout then offers every method
      // enabled in the Stripe dashboard (card, Apple Pay, Google Pay…).
      // NOTE: do not add automatic_payment_methods here — that is a
      // PaymentIntents option, not a Checkout Session one, and Stripe rejects
      // the whole request ("unknown parameter"), which broke checkout.
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: { allowed_countries: ['CA', 'US'] },
      // Free at/above the admin threshold, flat rate below it (lib/shipping.js).
      shipping_options: [stripeShippingOption(subtotal)],
      allow_promotion_codes: true,   // customers can enter promo/discount codes
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#products`,
      metadata: { items: JSON.stringify(metaItems) },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    // A failing checkout means no sales at all — alert the owner right away.
    alertError('checkout', err);
    res.status(500).json({ success: false, error: 'Could not start checkout. Please try again.' });
  }
});

// Records the order + line items and sends confirmation emails for a PAID
// Stripe session. Idempotent and safe to call from BOTH the browser success
// page and the Stripe webhook — the UNIQUE(stripe_session_id) constraint is the
// gate, so an order (and its emails) is created exactly once even if both fire.
// Returns the order_number, or null if the session isn't paid yet.
function recordOrderFromSession(session) {
  if (session.payment_status !== 'paid') return null;

  const existing = db.prepare('SELECT order_number FROM orders WHERE stripe_session_id = ?').get(session.id);
  if (existing) return existing.order_number;

  const orderNumber = 'SW-' + Date.now().toString().slice(-8);
  const shipping = session.shipping_details;
  const name = shipping?.name || session.customer_details?.name || 'Customer';
  const email = session.customer_details?.email || '';

  let orderId;
  try {
    const result = db.prepare(`
      INSERT INTO orders (order_number, customer_name, customer_email, shipping_line1, shipping_city,
        shipping_province, shipping_postal, shipping_country, subtotal, total, stripe_session_id, payment_status, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'confirmed')
    `).run(
      orderNumber, name, email,
      shipping?.address?.line1 || null, shipping?.address?.city || null,
      shipping?.address?.state || null, shipping?.address?.postal_code || null,
      shipping?.address?.country || 'CA',
      session.amount_subtotal / 100, session.amount_total / 100,
      session.id
    );
    orderId = result.lastInsertRowid;
  } catch (e) {
    // A concurrent verify/webhook call already inserted this session — reuse it.
    const row = db.prepare('SELECT order_number FROM orders WHERE stripe_session_id = ?').get(session.id);
    if (row) return row.order_number;
    throw e;
  }

  if (session.metadata?.items) {
    for (const item of JSON.parse(session.metadata.items)) {
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
      if (!p) continue;
      const unitPrice = item.p || p.price;
      const itemName = item.s ? `${p.name} — ${item.s}` : p.name;
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_category, quantity, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, p.id, itemName, p.category, item.qty, unitPrice, unitPrice * item.qty);
    }
  }

  sendNotification('New Order', `Order ${orderNumber}\nCustomer: ${name} (${email})\nTotal: $${session.amount_total / 100} CAD`);
  sendConfirmation(email, name.split(' ')[0], 'order', `Order #${orderNumber}\nTotal: $${session.amount_total / 100} CAD\nEstimated delivery: ${deliveryEstimate()}\n\nWe'll process and ship your order within 1–2 business days, and you'll receive tracking by email.`);
  return orderNumber;
}

app.get('/api/checkout/verify', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ success: false, error: 'Missing session_id' });

    const existing = db.prepare('SELECT order_number, total FROM orders WHERE stripe_session_id = ?').get(session_id);
    if (existing) return res.json({ success: true, paid: true, order_number: existing.order_number, total: existing.total });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    const orderNumber = recordOrderFromSession(session);
    if (!orderNumber) return res.json({ success: true, paid: false });
    res.json({ success: true, paid: true, order_number: orderNumber, total: session.amount_total / 100 });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ success: false, error: 'Could not verify payment. Please contact us if you were charged.' });
  }
});

// Order status lookup — customer enters order number + the email on the order.
// Requiring both (and rate limiting) prevents order-number enumeration.
app.post('/api/order-lookup', formLimiter, (req, res) => {
  const orderNumber = String(req.body.order_number || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!orderNumber || !email) {
    return res.status(400).json({ success: false, error: 'Please enter your order number and email.' });
  }
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ? AND lower(customer_email) = ?').get(orderNumber, email);
  if (!order) {
    return res.status(404).json({ success: false, error: 'No order found with that number and email. Double-check both, or contact us.' });
  }
  const items = db.prepare('SELECT product_name, quantity, total_price FROM order_items WHERE order_id = ?').all(order.id);
  res.json({
    success: true,
    order: {
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      created_at: order.created_at,
      total: order.total,
      city: order.shipping_city || null,
      province: order.shipping_province || null,
      items: items.map(i => ({ name: i.product_name, qty: i.quantity, total: i.total_price })),
    },
  });
});

// Product feed + admin panel/API (see routes/). Mounted here so route order
// relative to the public API above and the pages below is unchanged.
app.use(require('./routes/catalog'));
app.use(require('./routes/admin')({ ADMIN_BASE, loginLimiter, REPO_IMG_DIR, UPLOAD_IMG_DIR }));


// ═══════════════════════════════════════
// SERVER-RENDERED PAGES (shared EJS partials)
// ═══════════════════════════════════════

// ── Product helpers ──
function getActiveProducts() {
  return db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order').all();
}
function parseCoverageSqft(p) {
  // Bucket on whichever field carries a sq-ft figure. spec_coverage may hold a
  // metric value (e.g. "400–800 m³"), so fall through to the sq-ft coverage.
  for (const src of [p.coverage, p.spec_coverage]) {
    const m = String(src || '').replace(/,/g, '').match(/([\d.]+)\s*sq\s*ft/i);
    if (m) return parseFloat(m[1]);
  }
  return null;
}
function coverageBucket(p) {
  // Name-only HVAC check — descriptions now mention "HVAC-ready/compatible" for
  // mid-size units, which shouldn't force them into the whole-building bucket.
  if (/hvac/i.test(p.name)) return 'hvac';
  const sq = parseCoverageSqft(p);
  if (sq == null) return '';
  // Grouped by the top of the device's range, matching the finder labels:
  // up to 500 / 500–3,000 / 3,000–5,000 / 5,000+ sq ft. (S20 300–500 -> small,
  // S30 & S100 -> large, S200 / L200 / S300 -> commercial.)
  if (sq > 5000) return 'hvac';
  if (sq > 3000) return 'commercial';
  if (sq > 500) return 'large';
  return 'small';
}
// Size groups that currently have at least one active product. The homepage
// finder and the shop size filter hide the others instead of leading shoppers
// to an empty results page (e.g. while the 3,000–5,000 sq ft units are hidden).
function sizeBuckets() {
  return [...new Set(getActiveProducts().map(coverageBucket).filter(Boolean))];
}
function getSalesCounts() {
  try {
    const rows = db.prepare('SELECT product_id, SUM(quantity) AS sold FROM order_items GROUP BY product_id').all();
    return Object.fromEntries(rows.map(r => [r.product_id, r.sold]));
  } catch (e) { return {}; }
}
function getRatings() {
  try {
    const rows = db.prepare('SELECT product_id, ROUND(AVG(rating), 1) AS avg, COUNT(*) AS count FROM reviews WHERE approved = 1 GROUP BY product_id').all();
    return Object.fromEntries(rows.map(r => [r.product_id, { avg: r.avg, count: r.count }]));
  } catch (e) { return {}; }
}
function withRatings(products) {
  const ratings = getRatings();
  return products.map(p => ({ ...p, rating_avg: ratings[p.id]?.avg || null, rating_count: ratings[p.id]?.count || 0 }));
}
function shopLocals(products) {
  const sales = getSalesCounts();
  return withRatings(products).map(p => ({ ...p, _bucket: coverageBucket(p), _sold: sales[p.id] || 0 }));
}
// Curated homepage grid: show every non-oil product plus a taste of the oils
// (the full 56-oil catalog lives on /shop) so the homepage stays a highlights
// reel, not an endless scroll.
function homepageProducts() {
  const all = getActiveProducts();
  const oils = all.filter(p => p.category === 'oils').slice(0, 8);
  const oilIds = new Set(oils.map(p => p.id));
  return all.filter(p => p.category !== 'oils' || oilIds.has(p.id));
}
function getTestimonials() {
  try {
    return db.prepare('SELECT * FROM testimonials WHERE active = 1 ORDER BY sort_order, id').all();
  } catch (e) { return []; }
}

// Homepage — products rendered server-side
// ?cart=open is legacy; redirect to / so Google doesn't flag it as a redirect page
app.get('/', (req, res) => {
  if (req.query.cart === 'open') return res.redirect(301, '/');
  res.render('index', { products: withRatings(homepageProducts()), testimonials: getTestimonials(), buckets: sizeBuckets() });
});

// Clean product detail URLs: /products/:slug (SSR)
app.get('/products/:slug', (req, res, next) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) {
    // A hidden (inactive) product sends visitors to its category in the shop
    // instead of a dead-end 404. 302 = temporary, so Google keeps the URL and the
    // page simply returns when the product is re-activated in the admin.
    const hidden = db.prepare('SELECT category FROM products WHERE slug = ? AND active = 0').get(req.params.slug);
    if (hidden) return res.redirect(302, `/shop?filter=${encodeURIComponent(hidden.category)}`);
    return next(); // unknown slug -> 404
  }
  const all = getActiveProducts();
  const related = all.filter(p => p.category === product.category && p.id !== product.id).slice(0, 4);
  const oils = all.filter(p => p.category === 'oils');
  const reviews = db.prepare('SELECT name, rating, text, created_at FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY created_at DESC').all(product.id);
  const ratingAvg = reviews.length ? Math.round(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length * 10) / 10 : null;
  res.render('product-detail', { product, related, oils, all, reviews, ratingAvg, shipping: shippingRules() });
});

// Legacy product page → 301 to clean URL
app.get(['/product', '/product.html'], (req, res) => {
  const slug = (req.query.slug || '').replace(/[^a-z0-9-]/gi, '');
  res.redirect(301, slug ? `/products/${slug}` : '/shop');
});

// /shop — all products with filters & sort
app.get(['/shop', '/shop.html'], (req, res) => {
  res.render('shop', { products: shopLocals(getActiveProducts()), q: null, buckets: sizeBuckets() });
});

// /wishlist — client-rendered saved items (from localStorage)
app.get('/wishlist', (req, res) => res.render('wishlist'));

// /track — order status lookup
app.get(['/track', '/track-order'], (req, res) => res.render('track'));

// /compare — side-by-side diffuser comparison
app.get('/compare', (req, res) => {
  const diffusers = withRatings(getActiveProducts().filter(p => p.category === 'diffusers'))
    .map(p => ({ ...p, _bucket: coverageBucket(p) }));
  res.render('compare', { products: diffusers });
});

// /search — name + description search
app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  let products = [];
  if (q) {
    const like = `%${q}%`;
    products = db.prepare(
      `SELECT * FROM products WHERE active = 1 AND (name LIKE ? OR short_desc LIKE ? OR full_desc LIKE ?) ORDER BY sort_order`
    ).all(like, like, like);
  }
  res.render('shop', { products: shopLocals(products), q, buckets: sizeBuckets() });
});

// Live search suggestions (JSON) for the header type-ahead. Returns a few
// matching products with just what the dropdown needs.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ success: true, results: [] });
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT slug, name, price, image_url, category FROM products
     WHERE active = 1 AND (name LIKE ? OR short_desc LIKE ?)
     ORDER BY sort_order LIMIT 6`
  ).all(like, like);
  const CAT = { diffusers: 'Diffuser', oils: 'Fragrance Oil', home_car: 'Home & Car', aerosol: 'Aerosol' };
  res.json({
    success: true,
    results: rows.map(p => ({
      slug: p.slug, name: p.name,
      price: p.price != null ? Number(p.price) : null,
      image_url: p.image_url || '/images/placeholder.svg',
      category: CAT[p.category] || p.category,
    })),
  });
});

// Dynamic sitemap.xml (DB-driven)
app.get('/sitemap.xml', (req, res) => {
  const BASE = 'https://www.scentworld.ca';
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ['/', '1.0', 'weekly'], ['/shop', '0.9', 'weekly'], ['/about.html', '0.8', 'monthly'],
    ['/blog.html', '0.9', 'weekly'], ['/industries/', '0.9', 'monthly'],
    ['/industries/hotels.html', '0.8', 'monthly'], ['/industries/spas.html', '0.8', 'monthly'],
    ['/industries/restaurants.html', '0.8', 'monthly'],
    ['/blog/hotel-lobby-signature-scent.html', '0.7', 'monthly'],
    ['/blog/science-of-scent-marketing.html', '0.7', 'monthly'],
    ['/blog/choosing-spa-diffuser.html', '0.7', 'monthly'],
    ['/blog/restaurant-scent-marketing.html', '0.7', 'monthly'],
    ['/blog/office-workplace-fragrance.html', '0.7', 'monthly'],
    ['/blog/custom-signature-scent-guide.html', '0.7', 'monthly'],
    ['/shipping.html', '0.5', 'monthly'], ['/refund.html', '0.5', 'monthly'],
    ['/terms.html', '0.4', 'yearly'], ['/privacy-policy.html', '0.4', 'yearly'],
  ];
  for (const p of getActiveProducts()) urls.push([`/products/${p.slug}`, '0.8', 'weekly']);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(([loc, pri, freq]) =>
      `  <url><loc>${BASE}${loc}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`
    ).join('\n') + '\n</urlset>';
  res.type('application/xml').send(xml);
});

const PAGE_VIEWS = {
  '/about': 'about',
  '/blog': 'blog',
  '/success': 'success',
  '/terms': 'terms',
  '/privacy-policy': 'privacy-policy',
  '/shipping': 'shipping',
  '/refund': 'refund',
  '/industries': 'industries/index',
  '/industries/hotels': 'industries/hotels',
  '/industries/spas': 'industries/spas',
  '/industries/restaurants': 'industries/restaurants',
  '/blog/hotel-lobby-signature-scent': 'blog/hotel-lobby-signature-scent',
  '/blog/science-of-scent-marketing': 'blog/science-of-scent-marketing',
  '/blog/choosing-spa-diffuser': 'blog/choosing-spa-diffuser',
  '/blog/restaurant-scent-marketing': 'blog/restaurant-scent-marketing',
  '/blog/office-workplace-fragrance': 'blog/office-workplace-fragrance',
  '/blog/custom-signature-scent-guide': 'blog/custom-signature-scent-guide',
};
for (const [route, view] of Object.entries(PAGE_VIEWS)) {
  const paths = route === '/' ? ['/'] : [route, route + '.html'];
  if (route === '/industries') paths.push('/industries/');
  if (route === '/blog') paths.push('/blog/');
  app.get(paths, (req, res) => res.render(view, { shipping: shippingRules() }));
}
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// ═══════════════════════════════════════
// 404 HANDLER (must be last)
// ═══════════════════════════════════════
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.status(404).render('404');
});

// ═══════════════════════════════════════
// ERROR HANDLING + ALERTS
// ═══════════════════════════════════════
// Unexpected errors are logged and emailed to the ops inbox (ALERT_EMAIL, else
// BACKUP_EMAIL, else NOTIFY_EMAIL) — kept off the order/quote inbox. At most one
// email per distinct error per hour, so a crash loop can't flood the inbox.
const alertLastSent = new Map();
function alertError(where, err) {
  const detail = (err && err.stack) || String(err);
  console.error(`✖ ${where}:`, detail);
  const key = where + '|' + String((err && err.message) || err).slice(0, 200);
  const now = Date.now();
  if (alertLastSent.get(key) > now - 60 * 60 * 1000) return;
  alertLastSent.set(key, now);
  const to = process.env.ALERT_EMAIL || process.env.BACKUP_EMAIL || process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  resendEmail(to, `[Scent World] Site error: ${where}`,
    `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(detail)}</pre>`, detail).catch(() => {});
}

// Last-resort Express error handler. Client errors (bad JSON, oversized body)
// keep their 4xx status and don't alert; anything else is a real fault.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) alertError(`${req.method} ${req.path}`, err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ success: false, error: status >= 500 ? 'Something went wrong' : 'Bad request' });
  }
  res.status(status).send(status >= 500 ? 'Something went wrong on our side — please try again in a moment.' : 'Bad request');
});

process.on('unhandledRejection', err => alertError('unhandledRejection', err));
// After an uncaught exception the process state is unreliable: alert, give the
// email a moment to send, then exit so Railway restarts a clean instance.
process.on('uncaughtException', err => {
  alertError('uncaughtException', err);
  setTimeout(() => process.exit(1), 3000).unref();
});

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════

// Bind the port unless running under the test suite (NODE_ENV=test), which
// imports the app and listens on an ephemeral port itself. (A require.main
// check is not reliable: some launchers start node through a wrapper.)
if (process.env.NODE_ENV !== 'test') app.listen(PORT, () => {
  console.log(`\n🌿 Scent World Canada`);
  console.log(`   Website:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin/login.html`);
  console.log(`   API:      http://localhost:${PORT}/api/products\n`);
  scheduleDailyBackup();
  scheduleReviewRequests();
});

module.exports = app;
