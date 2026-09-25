// Admin panel + admin API. Mounted at the site root by server.js, so every
// path below is the full URL. All data routes require an admin session.
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { snapshotDb } = require('../lib/backup');

module.exports = function adminRoutes({ ADMIN_BASE, loginLimiter, REPO_IMG_DIR, UPLOAD_IMG_DIR }) {
  const router = express.Router();

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

router.post('/api/admin/login', loginLimiter, async (req, res) => {
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

router.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

router.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ success: true, email: req.session.adminEmail });
});

// ═══════════════════════════════════════
// ADMIN DATA ROUTES
// ═══════════════════════════════════════

// Dashboard stats
router.get('/api/admin/stats', requireAdmin, (req, res) => {
  const contacts = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count FROM contacts").get();
  const bookings = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending FROM bookings").get();
  const subscribers = db.prepare("SELECT COUNT(*) as total FROM subscribers WHERE status = 'active'").get();
  const products = db.prepare("SELECT COUNT(*) as total FROM products WHERE active = 1").get();
  const orders = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(total), 0) as revenue FROM orders WHERE payment_status = 'paid'").get();
  res.json({ success: true, stats: { contacts, bookings, subscribers, products, orders } });
});

// Contacts CRUD
router.get('/api/admin/contacts', requireAdmin, (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
  res.json({ success: true, contacts });
});

router.patch('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  const { status, notes } = req.body;
  db.prepare('UPDATE contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?').run(status ?? null, notes ?? null, req.params.id);
  res.json({ success: true });
});

router.delete('/api/admin/contacts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Bookings CRUD
router.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all();
  res.json({ success: true, bookings });
});

router.patch('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  const { status, admin_notes } = req.body;
  db.prepare('UPDATE bookings SET status = COALESCE(?, status), admin_notes = COALESCE(?, admin_notes) WHERE id = ?').run(status ?? null, admin_notes ?? null, req.params.id);
  res.json({ success: true });
});

router.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Subscribers CRUD
router.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC').all();
  res.json({ success: true, subscribers });
});

router.delete('/api/admin/subscribers/:id', requireAdmin, (req, res) => {
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
router.get('/api/admin/subscribers/export', requireAdmin, (req, res) => {
  const subscribers = db.prepare('SELECT email, first_name, status, created_at FROM subscribers ORDER BY created_at DESC').all();
  const csv = 'Email,Name,Status,Date\n' + subscribers.map(s =>
    [s.email, s.first_name || '', s.status, s.created_at].map(csvCell).join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
  res.send(csv);
});

// IndexNow ping for instant search engine notification (Bing, Yandex, DuckDuckGo, Yahoo)
router.post('/api/admin/indexnow-ping', requireAdmin, async (req, res) => {
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
router.post('/api/admin/upload-image', requireAdmin, express.json({ limit: '20mb' }), (req, res) => {
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

    const dir = UPLOAD_IMG_DIR;
    const taken = n => fs.existsSync(path.join(UPLOAD_IMG_DIR, n)) || fs.existsSync(path.join(REPO_IMG_DIR, n));

    // Handle name conflicts: file.jpg → file_1.jpg, file_2.jpg, etc.
    let finalName = safeName;
    let counter = 1;
    const base = safeName.replace(ext, '');
    while (taken(finalName)) {
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
router.delete('/api/admin/product-images/:filename', requireAdmin, (req, res) => {
  try {
    const name = path.basename(req.params.filename);
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).json({ success: false, error: 'Invalid filename' });
    const filePath = path.join(UPLOAD_IMG_DIR, name);
    if (!fs.existsSync(filePath)) {
      // Repo-shipped images come back on every deploy, so deleting them here would be a no-op.
      if (fs.existsSync(path.join(REPO_IMG_DIR, name))) {
        return res.status(400).json({ success: false, error: 'Built-in image — remove it from the code repository instead' });
      }
      return res.status(404).json({ success: false, error: 'File not found' });
    }
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete image error:', err.message);
    res.status(500).json({ success: false, error: 'Could not delete image' });
  }
});

// List available product images
router.get('/api/admin/product-images', requireAdmin, (req, res) => {
  try {
    const names = new Set();
    for (const d of [REPO_IMG_DIR, UPLOAD_IMG_DIR]) {
      if (fs.existsSync(d)) fs.readdirSync(d).forEach(n => names.add(n));
    }
    // SVG intentionally excluded here too — we no longer accept SVG uploads.
    const files = [...names]
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
router.get('/api/admin/products', requireAdmin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY sort_order').all();
  res.json({ success: true, products });
});

router.post('/api/admin/products', requireAdmin, (req, res) => {
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

router.put('/api/admin/products/:id', requireAdmin, (req, res) => {
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

router.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Test email
router.post('/api/admin/test-email', requireAdmin, async (req, res) => {
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
router.get('/api/admin/settings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json({ success: true, settings });
});

router.put('/api/admin/settings', requireAdmin, (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(req.body)) {
    stmt.run(key, String(value));
  }
  res.json({ success: true });
});

// Orders
router.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json({ success: true, orders });
});

router.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ success: false, error: 'Not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  res.json({ success: true, order, items });
});

router.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// Admin password change
// ── Reviews (admin moderation) ──
router.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const reviews = db.prepare(`
    SELECT r.*, p.name AS product_name FROM reviews r
    LEFT JOIN products p ON p.id = r.product_id
    ORDER BY r.approved ASC, r.created_at DESC
  `).all();
  res.json({ success: true, reviews });
});

router.patch('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const { approved } = req.body;
  db.prepare('UPDATE reviews SET approved = ? WHERE id = ?').run(approved ? 1 : 0, req.params.id);
  res.json({ success: true });
});

router.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Testimonials (homepage Google-reviews section) ──
router.get('/api/admin/testimonials', requireAdmin, (req, res) => {
  res.json({ success: true, testimonials: db.prepare('SELECT * FROM testimonials ORDER BY sort_order, id').all() });
});

router.post('/api/admin/testimonials', requireAdmin, (req, res) => {
  const { stars, text, author_name, author_role, sort_order, active } = req.body;
  if (!text || !author_name) return res.status(400).json({ success: false, error: 'Text and author name are required' });
  db.prepare('INSERT INTO testimonials (stars, text, author_name, author_role, sort_order, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Math.min(5, Math.max(1, parseInt(stars, 10) || 5)), text, author_name, author_role || null, parseInt(sort_order, 10) || 0, active === false ? 0 : 1);
  res.json({ success: true });
});

router.put('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  const { stars, text, author_name, author_role, sort_order, active } = req.body;
  if (!text || !author_name) return res.status(400).json({ success: false, error: 'Text and author name are required' });
  db.prepare('UPDATE testimonials SET stars = ?, text = ?, author_name = ?, author_role = ?, sort_order = ?, active = ? WHERE id = ?')
    .run(Math.min(5, Math.max(1, parseInt(stars, 10) || 5)), text, author_name, author_role || null, parseInt(sort_order, 10) || 0, active === false ? 0 : 1, req.params.id);
  res.json({ success: true });
});

router.delete('/api/admin/testimonials/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/api/admin/change-password', requireAdmin, async (req, res) => {
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

// On-demand: admin downloads a fresh backup file.
router.get('/api/admin/backup', requireAdmin, (req, res) => {
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

// Serve admin panel (protected) — mounted under the secret ADMIN_BASE path.
router.get(ADMIN_BASE + '/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});
router.get(ADMIN_BASE + '/index.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

// Serve admin login + static assets under the secret path (login page itself is
// public, but only reachable if you know ADMIN_PATH). The old /admin/ path is not
// mounted, so it 404s like any unknown URL.
router.use(ADMIN_BASE, express.static(path.join(__dirname, '..', 'admin')));

  return router;
};
