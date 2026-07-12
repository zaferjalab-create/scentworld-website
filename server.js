require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const os = require('os');
const db = require('./database');
const bcrypt = require('bcryptjs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://js.stripe.com https://www.google-analytics.com https://cdnjs.cloudflare.com https://www.googleadservices.com https://googleads.g.doubleclick.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://www.google-analytics.com https://connect.facebook.net https://api.stripe.com https://www.googleadservices.com https://googleads.g.doubleclick.net",
  "frame-src https://js.stripe.com https://hooks.stripe.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
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
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',         // HTTPS-only when the connection is HTTPS (works via trust proxy)
    httpOnly: true,         // not readable by JS (blocks cookie theft via XSS)
    sameSite: 'lax',        // mitigates CSRF on admin mutations
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
    }

    // Success/cancel URLs must point at the site the customer is actually on.
    // The old fallback was http://localhost:3000 — if BASE_URL wasn't set in
    // the environment, Stripe sent customers to localhost after paying or
    // cancelling (dead page, and a different origin so the cart looked wiped).
    // Deriving from the request works in dev and prod with no env var needed
    // (trust proxy is set, so req.protocol is correct behind Railway).
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      // Let Stripe show every method enabled on the account for the customer's
      // device — card plus Apple Pay / Google Pay wallets on mobile. (Wallets
      // require the domain to be registered in the Stripe dashboard, which
      // Stripe Checkout does automatically for Checkout-hosted pages.)
      automatic_payment_methods: { enabled: true },
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: { allowed_countries: ['CA', 'US'] },
      allow_promotion_codes: true,   // customers can enter promo/discount codes
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#products`,
      metadata: { items: JSON.stringify(metaItems) },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
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

    const existing = db.prepare('SELECT order_number FROM orders WHERE stripe_session_id = ?').get(session_id);
    if (existing) return res.json({ success: true, paid: true, order_number: existing.order_number });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    const orderNumber = recordOrderFromSession(session);
    if (!orderNumber) return res.json({ success: true, paid: false });
    res.json({ success: true, paid: true, order_number: orderNumber });
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

// ═══════════════════════════════════════
// ADMIN AUTH
// ═══════════════════════════════════════

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  res.redirect(ADMIN_BASE + '/login.html');
}

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  // bcrypt.compare with a string guard (undefined password would throw).
  if (!admin || !(await bcrypt.compare(String(password || ''), admin.password_hash))) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  // Regenerate the session on login so a pre-set session id can't be reused
  // to ride the authenticated session (session fixation).
  req.session.regenerate(err => {
    if (err) {
      console.error('Session regenerate error:', err.message);
      return res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
    }
    req.session.adminId = admin.id;
    req.session.adminEmail = admin.email;
    res.json({ success: true, redirect: ADMIN_BASE + '/' });
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ success: true, email: req.session.adminEmail });
});

// ═══════════════════════════════════════
// ADMIN DATA ROUTES
// ═══════════════════════════════════════

// Dashboard stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const contacts = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count FROM contacts").get();
  const bookings = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending FROM bookings").get();
  const subscribers = db.prepare("SELECT COUNT(*) as total FROM subscribers WHERE status = 'active'").get();
  const products = db.prepare("SELECT COUNT(*) as total FROM products WHERE active = 1").get();
  const orders = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(total), 0) as revenue FROM orders WHERE payment_status = 'paid'").get();
  res.json({ success: true, stats: { contacts, bookings, subscribers, products, orders } });
});

// Contacts CRUD
app.get('/api/admin/contacts', requireAdmin, (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  res.json({ success: true, contacts });
});

app.patch('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?').run(status ?? null, notes ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Bookings CRUD
app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
  res.json({ success: true, bookings });
});

app.patch('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const { status, admin_notes } = req.body;
  db.prepare('UPDATE bookings SET status = COALESCE(?, status), admin_notes = COALESCE(?, admin_notes) WHERE id = ?').run(status ?? null, admin_notes ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Subscribers CRUD
app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
  res.json({ success: true, subscribers });
});

app.delete('/api/admin/subscribers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Quote every CSV field and neutralize formula-injection: a value beginning
// with = + - @ (or tab/CR) is prefixed with ' so Excel/Sheets treats it as text,
// not a live formula. Embedded quotes are doubled per RFC 4180.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
app.get('/api/admin/subscribers/export', requireAdmin, (req, res) => {
  const subscribers = db.prepare('SELECT email, first_name, status, created_at FROM subscribers ORDER BY created_at DESC').all();
  const csv = 'Email,Name,Status,Date\n' + subscribers.map(s =>
    [s.email, s.first_name || '', s.status, s.created_at].map(csvCell).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
  res.send(csv);
});

// Meta/Google product catalog feed (CSV format)
app.get('/catalog.csv', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order').all();
    const BASE = 'https://www.scentworld.ca';
    const csvHeader = [
      'id', 'title', 'description', 'availability', 'condition', 'price', 'link',
      'image_link', 'brand', 'google_product_category', 'product_type', 'sale_price',
      'inventory', 'gtin', 'mpn', 'shipping', 'currency'
    ].join(',');
    const rows = [csvHeader];

    for (const p of products) {
      // For products with sizes, output one row per size
      let variants = [{label: null, price: p.price}];
      if (p.sizes) {
        try {
          const sizes = typeof p.sizes === 'string' ? JSON.parse(p.sizes) : p.sizes;
          if (Array.isArray(sizes) && sizes.length) variants = sizes.map(s => ({label: s.label, price: s.price}));
        } catch (e) {}
      }
      for (const v of variants) {
        const id = v.label ? `${p.slug}-${v.label}` : p.slug;
        const title = (v.label ? `${p.name} (${v.label})` : p.name).replace(/"/g, '""');
        const desc = (p.short_desc || p.name).replace(/"/g, '""').replace(/\n/g, ' ');
        const link = `${BASE}/products/${p.slug}`;
        const img = p.image_url ? (p.image_url.startsWith('http') ? p.image_url : `${BASE}${p.image_url}`) : `${BASE}/images/logo.png`;
        const price = `${(v.price || p.price || 0).toFixed(2)} CAD`;
        const category = p.category === 'oils' ? 'Health & Beauty > Personal Care > Fragrance' :
                         p.category === 'diffusers' ? 'Home & Garden > Decor > Home Fragrance Accessories > Fragrance Oil Diffusers' :
                         'Home & Garden > Decor > Home Fragrance';
        const row = [
          `"${id}"`,
          `"${title}"`,
          `"${desc}"`,
          'in stock',
          'new',
          `"${price}"`,
          `"${link}"`,
          `"${img}"`,
          '"Scent World Canada"',
          `"${category}"`,
          `"${p.category}"`,
          '', // sale_price
          '100', // inventory
          '', // gtin
          `"${id}"`, // mpn
          '"CA::Standard:0.00 CAD"',
          'CAD'
        ];
        rows.push(row.join(','));
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(rows.join('\n'));
  } catch (err) {
    console.error('catalog.csv error:', err);
    res.status(500).send('Error generating catalog');
  }
});

// IndexNow ping for instant search engine notification (Bing, Yandex, DuckDuckGo, Yahoo)
app.post('/api/admin/indexnow-ping', requireAdmin, async (req, res) => {
  const key = '9680638d101d3b3e47877ed48d45e004';
  const urlList = req.body.urls || [
    'https://www.scentworld.ca/',
    'https://www.scentworld.ca/about.html',
    'https://www.scentworld.ca/blog.html',
    'https://www.scentworld.ca/industries/',
    'https://www.scentworld.ca/industries/hotels.html',
    'https://www.scentworld.ca/industries/spas.html',
    'https://www.scentworld.ca/industries/restaurants.html',
    'https://www.scentworld.ca/blog/hotel-lobby-signature-scent.html',
    'https://www.scentworld.ca/blog/science-of-scent-marketing.html',
    'https://www.scentworld.ca/blog/choosing-spa-diffuser.html',
    'https://www.scentworld.ca/blog/restaurant-scent-marketing.html',
    'https://www.scentworld.ca/blog/office-workplace-fragrance.html',
    'https://www.scentworld.ca/blog/custom-signature-scent-guide.html'
  ];
  try {
    const r = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'www.scentworld.ca',
        key,
        keyLocation: `https://www.scentworld.ca/${key}.txt`,
        urlList
      })
    });
    res.json({ success: true, status: r.status, statusText: r.statusText, urls_submitted: urlList.length });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Upload a product image (base64 encoded)
app.post('/api/admin/upload-image', requireAdmin, express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { filename, mimetype, data } = req.body;
    if (!filename || !data) return res.status(400).json({ success: false, error: 'Missing filename or data' });

    // Validate extension. SVG is intentionally excluded — SVGs can carry inline
    // <script> and would be served from our own origin, enabling stored XSS.
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExts.includes(ext)) {
      return res.status(400).json({ success: false, error: 'Only JPG, PNG, WEBP, GIF allowed' });
    }

    // Sanitize filename (remove path traversal, special chars)
    let safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');

    // Ensure directory exists
    const dir = path.join(__dirname, 'public', 'images', 'products');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Handle name conflicts: file.jpg → file_1.jpg, file_2.jpg, etc.
    let finalName = safeName;
    let counter = 1;
    const base = safeName.replace(ext, '');
    while (fs.existsSync(path.join(dir, finalName))) {
      finalName = `${base}_${counter}${ext}`;
      counter++;
    }

    // Decode base64 (strip data: prefix if present)
    const base64Data = data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Size check (max 10MB)
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'File too large (max 10MB)' });
    }

    // Verify the bytes actually are an image (don't trust the extension). Blocks
    // a renamed script/HTML polyglot from being stored under an image name.
    if (!looksLikeImage(buffer)) {
      return res.status(400).json({ success: false, error: 'File does not look like a valid image' });
    }

    // Write file
    fs.writeFileSync(path.join(dir, finalName), buffer);

    res.json({
      success: true,
      filename: finalName,
      url: `/images/products/${finalName}`,
      size: buffer.length
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

// Magic-number sniff for the image formats we accept (JPEG, PNG, GIF, WEBP).
function looksLikeImage(b) {
  if (!b || b.length < 12) return false;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return true;                       // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return true;       // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                        // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true;     // WEBP (RIFF….WEBP)
  return false;
}

// Delete a product image
app.delete('/api/admin/product-images/:filename', requireAdmin, (req, res) => {
  try {
    const name = path.basename(req.params.filename);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).json({ success: false, error: 'Invalid filename' });
    const filePath = path.join(__dirname, 'public', 'images', 'products', name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete image error:', err.message);
    res.status(500).json({ success: false, error: 'Could not delete image' });
  }
});

// List available product images
app.get('/api/admin/product-images', requireAdmin, (req, res) => {
  try {
    const dir = path.join(__dirname, 'public', 'images', 'products');
    if (!fs.existsSync(dir)) return res.json({ success: true, images: [] });
    // SVG intentionally excluded here too — we no longer accept SVG uploads.
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .sort()
      .map(f => ({ name: f, url: `/images/products/${f}` }));
    res.json({ success: true, images: files });
  } catch (err) {
    console.error('List images error:', err.message);
    res.json({ success: false, error: 'Could not list images' });
  }
});

// Products CRUD
app.get('/api/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY sort_order').all();
  res.json({ success: true, products });
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, slug, category, short_desc, full_desc, price, coverage, image_url, gallery_images, sizes, featured, active, sort_order,
          spec_coverage, spec_oil_capacity, spec_noise, spec_power, spec_dimensions, spec_weight, spec_warranty, box_contents } = req.body;
  if (!name || !slug || !category) return res.status(400).json({ success: false, error: 'Name, slug, and category required' });
  const gallery = Array.isArray(gallery_images) ? JSON.stringify(gallery_images) : (gallery_images || null);
  const sizesJson = Array.isArray(sizes) ? JSON.stringify(sizes) : (sizes || null);
  const boxJson = Array.isArray(box_contents) ? JSON.stringify(box_contents) : (box_contents || null);
  const stmt = db.prepare(`INSERT INTO products (name, slug, category, short_desc, full_desc, price, coverage, image_url, gallery_images, sizes,
    spec_coverage, spec_oil_capacity, spec_noise, spec_power, spec_dimensions, spec_weight, spec_warranty, box_contents,
    featured, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(name, slug, category, short_desc || null, full_desc || null, price || null, coverage || null, image_url || null, gallery, sizesJson,
    spec_coverage || null, spec_oil_capacity || null, spec_noise || null, spec_power || null, spec_dimensions || null, spec_weight || null, spec_warranty || null, boxJson,
    featured ? 1 : 0, active !== false ? 1 : 0, sort_order || 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, slug, category, short_desc, full_desc, price, coverage, image_url, gallery_images, sizes, featured, active, sort_order,
          spec_coverage, spec_oil_capacity, spec_noise, spec_power, spec_dimensions, spec_weight, spec_warranty, box_contents } = req.body;
  const gallery = Array.isArray(gallery_images) ? JSON.stringify(gallery_images) : (gallery_images || null);
  const sizesJson = Array.isArray(sizes) ? JSON.stringify(sizes) : (sizes || null);
  const boxJson = Array.isArray(box_contents) ? JSON.stringify(box_contents) : (box_contents || null);
  db.prepare(`UPDATE products SET name=?, slug=?, category=?, short_desc=?, full_desc=?, price=?, coverage=?, image_url=?, gallery_images=?, sizes=?,
              spec_coverage=?, spec_oil_capacity=?, spec_noise=?, spec_power=?, spec_dimensions=?, spec_weight=?, spec_warranty=?, box_contents=?,
              featured=?, active=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, slug, category, short_desc ?? null, full_desc ?? null, price ?? null, coverage ?? null, image_url ?? null, gallery, sizesJson,
         spec_coverage ?? null, spec_oil_capacity ?? null, spec_noise ?? null, spec_power ?? null, spec_dimensions ?? null, spec_weight ?? null, spec_warranty ?? null, boxJson,
         featured ? 1 : 0, active ? 1 : 0, sort_order || 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Test email
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const toEmail = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.json({ success: false, error: 'RESEND_API_KEY not set in Railway environment variables' });
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Scent World Canada <hello@scentworld.ca>',
        to: [toEmail],
        subject: '[Scent World] Test Email',
        text: `This is a test email from your Scent World website.\n\nIf you received this, email notifications are working!\n\nSent to: ${toEmail}`
      })
    });
    const data = await r.json();
    if (!r.ok) return res.json({ success: false, error: JSON.stringify(data), to: toEmail });
    res.json({ success: true, message: `Test email sent to ${toEmail}`, id: data.id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ success: true, settings });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(req.body)) {
    stmt.run(key, String(value));
  }
  res.json({ success: true });
});

// Orders
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json({ success: true, orders });
});

app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  res.json({ success: true, order, items });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// Admin password change
// ── Reviews (admin moderation) ──
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const reviews = db.prepare(`
    SELECT r.*, p.name AS product_name FROM reviews r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY r.approved ASC, r.created_at DESC
  `).all();
  res.json({ success: true, reviews });
});

app.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const { approved } = req.body;
  db.prepare('UPDATE reviews SET approved = ? WHERE id = ?').run(approved ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Testimonials (homepage Google-reviews section) ──
app.get('/api/admin/testimonials', requireAdmin, (req, res) => {
  res.json({ success: true, testimonials: db.prepare('SELECT * FROM testimonials ORDER BY sort_order, id').all() });
});

app.post('/api/admin/testimonials', requireAdmin, (req, res) => {
  const { stars, text, author_name, author_role, sort_order, active } = req.body;
  if (!text || !author_name) return res.status(400).json({ success: false, error: 'Text and author name are required' });
  db.prepare('INSERT INTO testimonials (stars, text, author_name, author_role, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Math.min(5, Math.max(1, parseInt(stars, 10) || 5)), text, author_name, author_role || null, parseInt(sort_order, 10) || 0, active === false ? 0 : 1);
  res.json({ success: true });
});

app.put('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  const { stars, text, author_name, author_role, sort_order, active } = req.body;
  if (!text || !author_name) return res.status(400).json({ success: false, error: 'Text and author name are required' });
  db.prepare('UPDATE testimonials SET stars = ?, text = ?, author_name = ?, author_role = ?, sort_order = ?, active = ? WHERE id = ?')
    .run(Math.min(5, Math.max(1, parseInt(stars, 10) || 5)), text, author_name, author_role || null, parseInt(sort_order, 10) || 0, active === false ? 0 : 1, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (typeof new_password !== 'string' || new_password.length < 8) {
    return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!admin || !(await bcrypt.compare(String(current_password || ''), admin.password_hash))) {
    return res.status(400).json({ success: false, error: 'Current password is incorrect' });
  }
  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  // Regenerate the session after a credential change so any other copy of the
  // old session id is invalidated; keep this browser logged in.
  const adminId = admin.id, adminEmail = admin.email;
  req.session.regenerate(err => {
    if (err) console.error('Session regenerate error:', err.message);
    else { req.session.adminId = adminId; req.session.adminEmail = adminEmail; }
    res.json({ success: true, message: 'Password updated' });
  });
});

// ═══════════════════════════════════════
// DATABASE BACKUP
// ═══════════════════════════════════════

// Take a consistent single-file snapshot of the DB, even while it's in use
// (VACUUM INTO checkpoints the WAL and writes a clean copy). Returns the temp
// path; caller is responsible for deleting it.
function snapshotDb() {
  const tmp = path.join(os.tmpdir(), `scentworld-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return tmp;
}

// On-demand: admin downloads a fresh backup file.
app.get('/api/admin/backup', requireAdmin, (req, res) => {
  let tmp;
  try {
    tmp = snapshotDb();
    const name = `scentworld-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.download(tmp, name, () => { if (tmp) fs.unlink(tmp, () => {}); });
  } catch (err) {
    console.error('Backup download error:', err.message);
    if (tmp) fs.unlink(tmp, () => {});
    res.status(500).json({ success: false, error: 'Backup failed' });
  }
});

// Encrypt a backup buffer with AES-256-GCM when BACKUP_PASSPHRASE is set, so the
// customer PII in the emailed attachment isn't readable if the inbox is breached.
// Output layout: salt(16) | iv(12) | authTag(16) | ciphertext. Decrypt with the
// bundled decrypt-backup.js. If no passphrase is set, returns the file as-is so
// backups never silently stop — set BACKUP_PASSPHRASE to enable encryption.
function maybeEncryptBackup(buf) {
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!pass) return { data: buf, ext: 'db', encrypted: false };
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { data: Buffer.concat([salt, iv, cipher.getAuthTag(), enc]), ext: 'db.enc', encrypted: true };
}

// Automatic: email the DB snapshot as an attachment via Resend. Off-box copy of
// order/customer data to the owner's own inbox. No-op if RESEND_API_KEY is unset.
async function emailBackup() {
  if (!process.env.RESEND_API_KEY) return;
  let tmp;
  try {
    tmp = snapshotDb();
    const { data, ext, encrypted } = maybeEncryptBackup(fs.readFileSync(tmp));
    const content = data.toString('base64');
    const date = new Date().toISOString().slice(0, 10);
    const to = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
    const encNote = encrypted
      ? ` This file is encrypted (AES-256-GCM); decrypt it with: node decrypt-backup.js scentworld-${date}.${ext} (requires BACKUP_PASSPHRASE).`
      : ' TIP: set BACKUP_PASSPHRASE in the environment to encrypt future backups.';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Scent World Canada <hello@scentworld.ca>',
        to: [to],
        subject: `[Scent World] Database backup ${date}`,
        text: `Automated database backup attached (scentworld-${date}.${ext}). Keep this email; it is your off-site copy of orders, customers and subscribers.${encNote}`,
        attachments: [{ filename: `scentworld-${date}.${ext}`, content }],
      }),
    });
    if (r.ok) console.log(`✅ DB backup emailed to ${to}`);
    else console.error('DB backup email failed:', JSON.stringify(await r.json()));
  } catch (err) {
    console.error('emailBackup error:', err.message);
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
}

// Schedule the first backup for the next 03:00 America/Halifax, then every 24h.
function scheduleDailyBackup() {
  const now = new Date();
  // 03:00 Halifax ≈ 06:00 or 07:00 UTC depending on DST; 06:00 UTC is close enough.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(() => { emailBackup(); setInterval(emailBackup, 24 * 60 * 60 * 1000); }, delay);
  console.log(`🗄  Daily DB backup scheduled — first run in ${Math.round(delay / 3600000)}h`);
}

// Serve admin panel (protected) — mounted under the secret ADMIN_BASE path.
app.get(ADMIN_BASE + '/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get(ADMIN_BASE + '/index.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Serve admin login + static assets under the secret path (login page itself is
// public, but only reachable if you know ADMIN_PATH). The old /admin/ path is not
// mounted, so it 404s like any unknown URL.
app.use(ADMIN_BASE, express.static(path.join(__dirname, 'admin')));

// ═══════════════════════════════════════
// EMAIL NOTIFICATIONS (optional)
// ═══════════════════════════════════════

// Returns true only if the email was actually accepted by Resend.
async function resendEmail(to, subject, html, text) {
  if (!process.env.RESEND_API_KEY) {
    console.error('EMAIL: RESEND_API_KEY not set — skipping email');
    return false;
  }
  console.log(`EMAIL: Sending "${subject}" to ${to}`);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Scent World Canada <hello@scentworld.ca>',
        to: [to],
        subject,
        html,
        text
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('EMAIL FAILED:', JSON.stringify(data));
      return false;
    }
    console.log('EMAIL SENT OK, id:', data.id);
    return true;
  } catch (err) {
    console.error('EMAIL ERROR:', err.message);
    return false;
  }
}

// Escape user-supplied text before embedding it in HTML emails, so a visitor's
// form input can't inject markup/links into the notifications we read.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Admin notification
async function sendNotification(subject, text) {
  const toEmail = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  await resendEmail(toEmail, `[Scent World] ${subject}`, `<pre style="font-family:sans-serif">${escapeHtml(text)}</pre>`, text);
}

// Customer confirmation email
async function sendConfirmation(toEmail, firstName, type, details) {
  const detailsHtml = escapeHtml(details).replace(/\n/g, '<br>');
  const templates = {
    quote: {
      subject: 'We received your quote request — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Thank you, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">We've received your quote request and will be in touch within <strong style="color:#f5f0e8">24 hours</strong>.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 4px">Your request summary:</p>
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">In the meantime, feel free to explore our <a href="https://www.scentworld.ca" style="color:#c9a55c">full collection</a>.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Thank you, ${firstName}!\n\nWe've received your quote request and will be in touch within 24 hours.\n\nYour request: ${details}\n\nScent World Canada\nhello@scentworld.ca`
    },
    booking: {
      subject: 'Consultation request confirmed — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Your consultation is requested, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">We've received your consultation request and will confirm your time slot within <strong style="color:#f5f0e8">24 hours</strong>.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 4px">Requested slot:</p>
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">We look forward to speaking with you.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Your consultation is requested, ${firstName}!\n\nWe'll confirm your time slot within 24 hours.\n\nRequested: ${details}\n\nScent World Canada\nhello@scentworld.ca`
    },
    order: {
      subject: 'Order confirmed — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Order Confirmed, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">Thank you for your order. We'll process and ship it soon.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">Questions? Reply to this email or contact us at <a href="mailto:support@scentworld.ca" style="color:#c9a55c">support@scentworld.ca</a></p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Order Confirmed, ${firstName}!\n\n${details}\n\nQuestions? Email support@scentworld.ca\n\nScent World Canada`
    }
  };
  const t = templates[type];
  if (!t) return;
  await resendEmail(toEmail, t.subject, t.html, t.text);
}

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
  // Thresholds tuned so every space-size filter option actually returns
  // products in the current catalog (300 / ~3,000 / 17,945 sq ft clusters).
  if (sq > 5000) return 'hvac';
  if (sq >= 3000) return 'commercial';
  if (sq >= 500) return 'large';
  return 'small';
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
  res.render('index', { products: withRatings(homepageProducts()), testimonials: getTestimonials() });
});

// Clean product detail URLs: /products/:slug (SSR)
app.get('/products/:slug', (req, res, next) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return next(); // falls through to 404
  const all = getActiveProducts();
  const related = all.filter(p => p.category === product.category && p.id !== product.id).slice(0, 4);
  const oils = all.filter(p => p.category === 'oils');
  const reviews = db.prepare('SELECT name, rating, text, created_at FROM reviews WHERE product_id = ? AND approved = 1 ORDER BY created_at DESC').all(product.id);
  const ratingAvg = reviews.length ? Math.round(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length * 10) / 10 : null;
  res.render('product-detail', { product, related, oils, all, reviews, ratingAvg });
});

// Legacy product page → 301 to clean URL
app.get(['/product', '/product.html'], (req, res) => {
  const slug = (req.query.slug || '').replace(/[^a-z0-9-]/gi, '');
  res.redirect(301, slug ? `/products/${slug}` : '/shop');
});

// /shop — all products with filters & sort
app.get(['/shop', '/shop.html'], (req, res) => {
  res.render('shop', { products: shopLocals(getActiveProducts()), q: null });
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
  res.render('shop', { products: shopLocals(products), q });
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
  app.get(paths, (req, res) => res.render(view));
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
// POST-PURCHASE REVIEW REQUESTS
// ═══════════════════════════════════════

// Email each customer ~10 days after purchase, inviting them to review the
// products they bought (deep-linked to each product's review form). Runs daily;
// every order is emailed at most once, tracked by review_request_sent_at.
const REVIEW_REQUEST_DELAY_DAYS = 10;
async function sendReviewRequests() {
  if (!process.env.RESEND_API_KEY) return; // email disabled — don't mark orders sent
  let orders;
  try {
    orders = db.prepare(`
      SELECT id, order_number, customer_name, customer_email
      FROM orders
      WHERE payment_status = 'paid'
        AND review_request_sent_at IS NULL
        AND customer_email IS NOT NULL AND customer_email != ''
        AND created_at <= datetime('now', ?)
      ORDER BY created_at ASC LIMIT 50
    `).all(`-${REVIEW_REQUEST_DELAY_DAYS} days`);
  } catch (e) { console.error('review-request query error:', e.message); return; }
  if (!orders.length) return;

  const BASE = process.env.BASE_URL || 'https://www.scentworld.ca';
  const markSent = db.prepare('UPDATE orders SET review_request_sent_at = CURRENT_TIMESTAMP WHERE id = ?');

  for (const o of orders) {
    try {
      const items = db.prepare(`
        SELECT DISTINCT p.slug, COALESCE(p.name, oi.product_name) AS name
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
      `).all(o.id).filter(it => it.slug);
      if (!items.length) { markSent.run(o.id); continue; } // nothing linkable; don't retry forever

      const firstName = (o.customer_name || 'there').split(' ')[0];
      const links = items.map(it => `<a href="${BASE}/products/${encodeURIComponent(it.slug)}#reviews" style="color:#c9a55c;text-decoration:none">${escapeHtml(it.name)} →</a>`).join('<br>');
      const linksText = items.map(it => `${it.name}: ${BASE}/products/${it.slug}#reviews`).join('\n');
      const html = `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">How are you enjoying your order, ${escapeHtml(firstName)}?</h2>
          <p style="color:#ccc;line-height:1.7">It's been a little while since your order <strong style="color:#f5f0e8">#${escapeHtml(o.order_number)}</strong> arrived. We'd love to hear what you think — a quick review helps other customers and takes less than a minute.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 8px">Leave a review for:</p>
            <p style="color:#f5f0e8;margin:0;font-size:15px;line-height:1.9">${links}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">Thank you for choosing Scent World.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`;
      const text = `How are you enjoying your order, ${firstName}?\n\nIt's been a little while since order #${o.order_number} arrived. We'd love a quick review:\n\n${linksText}\n\nThank you,\nScent World Canada`;
      const ok = await resendEmail(o.customer_email, 'How are you enjoying your Scent World order?', html, text);
      if (ok) markSent.run(o.id); // only mark sent on actual delivery, so failures retry tomorrow
    } catch (err) {
      console.error(`review-request for order ${o.id} failed:`, err.message);
    }
  }
}

// Run shortly after boot (catch any already due), then once a day.
function scheduleReviewRequests() {
  setTimeout(sendReviewRequests, 90 * 1000);
  setInterval(sendReviewRequests, 24 * 60 * 60 * 1000);
}

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🌿 Scent World Canada`);
  console.log(`   Website:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin/login.html`);
  console.log(`   API:      http://localhost:${PORT}/api/products\n`);
  scheduleDailyBackup();
  scheduleReviewRequests();
});
