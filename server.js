require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');
const bcrypt = require('bcryptjs');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'scent-world-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ═══════════════════════════════════════
// PUBLIC API ROUTES
// ═══════════════════════════════════════

// Contact / Quote Form
app.post('/api/contact', (req, res) => {
  try {
    const { first_name, last_name, email, phone, customer_type, product_interest, message } = req.body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ success: false, error: 'Name and email are required' });
    }
    const stmt = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone, customer_type, product_interest, message) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(first_name, last_name, email, phone || null, customer_type || null, product_interest || null, message || null);
    sendNotification('New Quote Request', `From: ${first_name} ${last_name} (${email})\nType: ${customer_type}\nInterest: ${product_interest}\n\n${message || 'No message'}`);
    res.json({ success: true, message: 'Quote request received. We\'ll be in touch within 24 hours.' });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Booking / Consultation
app.post('/api/booking', (req, res) => {
  try {
    const { first_name, last_name, email, phone, business_name, preferred_date, preferred_time, topic, message } = req.body;
    if (!first_name || !last_name || !email || !preferred_date || !preferred_time) {
      return res.status(400).json({ success: false, error: 'Please fill in all required fields' });
    }
    const stmt = db.prepare(`INSERT INTO bookings (first_name, last_name, email, phone, business_name, preferred_date, preferred_time, topic, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(first_name, last_name, email, phone || null, business_name || null, preferred_date, preferred_time, topic || null, message || null);
    sendNotification('New Booking Request', `From: ${first_name} ${last_name} (${email})\nDate: ${preferred_date} at ${preferred_time}\nBusiness: ${business_name || 'N/A'}\nTopic: ${topic || 'General'}\n\n${message || ''}`);
    res.json({ success: true, message: 'Consultation booked! We\'ll confirm your time slot within 24 hours.' });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ success: false, error: 'Something went wrong' });
  }
});

// Newsletter Subscribe
app.post('/api/subscribe', (req, res) => {
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

app.get('/api/products/:slug', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
  res.json({ success: true, product });
});

// ═══════════════════════════════════════
// STRIPE CHECKOUT
// ═══════════════════════════════════════

app.post('/api/checkout', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ success: false, error: 'No items in cart' });

    const lineItems = [];
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(item.id);
      if (!product || !product.price) return res.status(400).json({ success: false, error: `Product ${item.id} not available` });
      lineItems.push({
        price_data: {
          currency: 'cad',
          product_data: { name: product.name, description: product.short_desc || undefined },
          unit_amount: Math.round(product.price * 100),
        },
        quantity: item.quantity,
      });
    }

    const base = process.env.BASE_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: { allowed_countries: ['CA', 'US'] },
      success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#products`,
      metadata: { items: JSON.stringify(items.map(i => ({ id: i.id, qty: i.quantity }))) },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/checkout/verify', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ success: false, error: 'Missing session_id' });

    const existing = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(session_id);
    if (existing) return res.json({ success: true, paid: true, order_number: existing.order_number });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.json({ success: true, paid: false });

    const orderNumber = 'SW-' + Date.now().toString().slice(-8);
    const shipping = session.shipping_details;
    const name = shipping?.name || session.customer_details?.name || 'Customer';
    const email = session.customer_details?.email || '';

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
      session_id
    );

    const orderId = result.lastInsertRowid;
    if (session.metadata?.items) {
      for (const item of JSON.parse(session.metadata.items)) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
        if (p) db.prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, product_category, quantity, unit_price, total_price)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(orderId, p.id, p.name, p.category, item.qty, p.price, p.price * item.qty);
      }
    }

    sendNotification('New Order', `Order ${orderNumber}\nCustomer: ${name} (${email})\nTotal: $${session.amount_total / 100} CAD`);
    res.json({ success: true, paid: true, order_number: orderNumber });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════
// ADMIN AUTH
// ═══════════════════════════════════════

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  res.redirect('/admin/login.html');
}

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  req.session.adminId = admin.id;
  req.session.adminEmail = admin.email;
  res.json({ success: true, redirect: '/admin/' });
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
  const contacts = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status = "new" THEN 1 ELSE 0 END) as new_count FROM contacts').get();
  const bookings = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status = "pending" THEN 1 ELSE 0 END) as pending FROM bookings').get();
  const subscribers = db.prepare('SELECT COUNT(*) as total FROM subscribers WHERE status = "active"').get();
  const products = db.prepare('SELECT COUNT(*) as total FROM products WHERE active = 1').get();
  const orders = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(total), 0) as revenue FROM orders WHERE payment_status = "paid"').get();
  res.json({ success: true, stats: { contacts, bookings, subscribers, products, orders } });
});

// Contacts CRUD
app.get('/api/admin/contacts', requireAdmin, (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  res.json({ success: true, contacts });
});

app.patch('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?').run(status, notes, req.params.id);
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
  db.prepare('UPDATE bookings SET status = COALESCE(?, status), admin_notes = COALESCE(?, admin_notes) WHERE id = ?').run(status, admin_notes, req.params.id);
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

app.get('/api/admin/subscribers/export', requireAdmin, (req, res) => {
  const subscribers = db.prepare('SELECT email, first_name, status, created_at FROM subscribers ORDER BY created_at DESC').all();
  const csv = 'Email,Name,Status,Date\n' + subscribers.map(s => `${s.email},${s.first_name || ''},${s.status},${s.created_at}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
  res.send(csv);
});

// Products CRUD
app.get('/api/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY sort_order').all();
  res.json({ success: true, products });
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, slug, category, short_desc, full_desc, price, coverage, image_url, featured, active, sort_order } = req.body;
  if (!name || !slug || !category) return res.status(400).json({ success: false, error: 'Name, slug, and category required' });
  const stmt = db.prepare(`INSERT INTO products (name, slug, category, short_desc, full_desc, price, coverage, image_url, featured, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const result = stmt.run(name, slug, category, short_desc || null, full_desc || null, price || null, coverage || null, image_url || null, featured ? 1 : 0, active !== false ? 1 : 0, sort_order || 0);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, slug, category, short_desc, full_desc, price, coverage, image_url, featured, active, sort_order } = req.body;
  db.prepare(`UPDATE products SET name=?, slug=?, category=?, short_desc=?, full_desc=?, price=?, coverage=?, image_url=?, featured=?, active=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, slug, category, short_desc, full_desc, price, coverage, image_url, featured ? 1 : 0, active ? 1 : 0, sort_order || 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
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
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { current_password, new_password } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(current_password, admin.password_hash)) {
    return res.status(400).json({ success: false, error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  res.json({ success: true, message: 'Password updated' });
});

// Serve admin panel (protected)
app.get('/admin/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});
app.get('/admin/index.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Serve admin login (public)
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ═══════════════════════════════════════
// EMAIL NOTIFICATIONS (optional)
// ═══════════════════════════════════════

async function sendNotification(subject, text) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: `"Scent World Canada" <${process.env.SMTP_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
      subject: `[Scent World] ${subject}`,
      text: text
    });
  } catch (err) {
    console.error('Email notification failed:', err.message);
  }
}

// ═══════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🌿 Scent World Canada`);
  console.log(`   Website:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin/login.html`);
  console.log(`   API:      http://localhost:${PORT}/api/products\n`);
});
