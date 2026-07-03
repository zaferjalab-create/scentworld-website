require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcryptjs');

console.log('\\n🌿 Scent World Canada — Setup\\n');

// Create admin user — ONLY on first run. Never reset an existing admin's
// password on deploy (setup.js runs every deploy via railway.toml), otherwise
// any password change in the dashboard is silently reverted on the next push.
const email = process.env.ADMIN_EMAIL || 'admin@scentworld.ca';

const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
if (!existing) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('❌ No admin exists and ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD in the environment, then redeploy to create the admin user.');
  } else {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)').run(email, hash, 'Admin');
    console.log(`✅ Admin user created: ${email}`);
  }
} else {
  console.log(`ℹ Admin already exists (${email}) — password left unchanged. Change it from the dashboard.`);
}

// Seed products
const products = [
  { name: 'S20 Nano Diffuser', slug: 's20', category: 'diffusers', short_desc: 'Compact nano diffuser for personal spaces up to 300 sq ft.', price: 199.00, coverage: 'Up to 300 sq ft', sort_order: 1, image_url: '/images/products/S20-Black.png' },
  { name: 'S30 Nano Diffuser', slug: 's30', category: 'diffusers', short_desc: 'Mid-size nano diffuser with programmable timer. Coverage up to 2,870 sq ft.', price: 349.00, coverage: 'Up to 2,870 sq ft', sort_order: 2, image_url: '/images/products/S30-Black.jpeg' },
  { name: 'S100 Commercial Diffuser', slug: 's100', category: 'diffusers', short_desc: 'Professional-grade cold-air diffuser for commercial spaces up to 3,230 sq ft.', price: 599.00, coverage: 'Up to 3,230 sq ft', sort_order: 3, image_url: '/images/products/S100.png' },
  { name: 'S200 Commercial Diffuser', slug: 's200', category: 'diffusers', short_desc: 'High-capacity nano diffuser for large commercial environments up to 17,945 sq ft.', price: 899.00, coverage: 'Up to 17,945 sq ft', sort_order: 4, image_url: '/images/products/S200.jpeg' },
  { name: 'L100 Luxury Diffuser', slug: 'l100', category: 'diffusers', short_desc: 'Premium luxury diffuser with elegant design and smart controls.', price: 749.00, coverage: 'Up to 3,230 sq ft', sort_order: 5, image_url: '/images/products/SW110.png' },
  { name: 'L100 AD Display Diffuser', slug: 'l100-ad', category: 'diffusers', short_desc: 'Luxury diffuser with built-in digital display for branding.', price: 999.00, coverage: 'Up to 3,230 sq ft', sort_order: 6, image_url: '/images/products/SW114.png' },
  { name: 'L200 Luxury Diffuser', slug: 'l200', category: 'diffusers', short_desc: 'Top-tier luxury diffuser with diamond-pattern design for premium venues.', price: 1299.00, coverage: 'Up to 17,945 sq ft', sort_order: 7, image_url: '/images/products/SW127.png' },
  { name: 'Car Scent Diffuser', slug: 'car-diffuser', category: 'home_car', short_desc: 'Premium car diffuser with USB-C power and nano mist technology.', price: 149.00, coverage: 'Vehicle interior', sort_order: 8, image_url: '/images/products/Car-Scent-Diffuser.png' },
  { name: 'Car Diffuser Gift Set', slug: 'car-gift-set', category: 'home_car', short_desc: 'Car diffuser with 5 curated fragrance oils in luxury packaging.', price: 249.00, coverage: 'Vehicle interior', sort_order: 9, featured: 1, image_url: '/images/products/H1_02.jpg' },
  { name: 'Fresh Blossom Oil', slug: 'fresh-blossom', category: 'oils', short_desc: 'Light floral blend with notes of spring blossoms and green leaves.', price: 49.00, coverage: null, sort_order: 10, image_url: '/images/products/SW101-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
  { name: 'White Tea Oil', slug: 'white-tea', category: 'oils', short_desc: 'Clean, calming white tea fragrance perfect for spas and wellness spaces.', price: 49.00, coverage: null, sort_order: 11, image_url: '/images/products/SW102-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
  { name: 'Oud Oil', slug: 'oud', category: 'oils', short_desc: 'Rich, warm oud blend — a signature Middle Eastern luxury fragrance.', price: 59.00, coverage: null, sort_order: 12, image_url: '/images/products/SW103-430x430-1.webp', sizes: '[{"label":"100ml","price":59},{"label":"200ml","price":109},{"label":"500ml","price":229}]' },
  { name: 'Vienna Oil', slug: 'vienna', category: 'oils', short_desc: 'Sophisticated European-inspired blend with warm amber undertones.', price: 49.00, coverage: null, sort_order: 13, image_url: '/images/products/SW104-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
  { name: 'Spark Honey Oil', slug: 'spark-honey', category: 'oils', short_desc: 'Sweet and vibrant honey-citrus blend for energizing spaces.', price: 49.00, coverage: null, sort_order: 14, image_url: '/images/products/SW106-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
  { name: 'Gold Aerosol Spray', slug: 'aerosol-gold', category: 'aerosol', short_desc: 'Premium aerosol spray with fine mist and long-lasting Gold fragrance.', price: 30.00, coverage: 'Room spray', sort_order: 15, image_url: '/images/products/SW500.jpg' },
  { name: 'Aerosol Dispenser Unit', slug: 'aerosol-dispenser', category: 'aerosol', short_desc: 'Programmable automatic aerosol dispenser for consistent ambient scenting.', price: 89.00, coverage: 'Single room', sort_order: 16, image_url: '/images/products/C002.jpg' },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO products (name, slug, category, short_desc, price, coverage, sort_order, featured, image_url, sizes)
  VALUES (@name, @slug, @category, @short_desc, @price, @coverage, @sort_order, @featured, @image_url, @sizes)
`);

// Also update image_url and sizes for existing rows that have NULL (so re-seeding refreshes after DB resets)
const updateImage = db.prepare("UPDATE products SET image_url = ? WHERE slug = ? AND (image_url IS NULL OR image_url = '')");
const updateSizes = db.prepare("UPDATE products SET sizes = ? WHERE slug = ? AND (sizes IS NULL OR sizes = '')");

let count = 0, updatedImages = 0, updatedSizes = 0;
for (const p of products) {
  p.featured = p.featured || 0;
  p.image_url = p.image_url || null;
  p.sizes = p.sizes || null;
  const result = insert.run(p);
  if (result.changes > 0) count++;
  if (p.image_url) {
    const u = updateImage.run(p.image_url, p.slug);
    if (u.changes > 0) updatedImages++;
  }
  if (p.sizes) {
    const u = updateSizes.run(p.sizes, p.slug);
    if (u.changes > 0) updatedSizes++;
  }
}
console.log(`✅ ${count} products seeded, ${updatedImages} images filled, ${updatedSizes} sizes filled`);

// Default settings
const defaults = {
  'site_name': 'Scent World Canada',
  'site_email': 'hello@scentworld.ca',
  'site_phone': '+1 (902) 555-1234',
  'site_address': 'Halifax, Nova Scotia, Canada',
  'shipping_threshold': '150',
  'currency': 'CAD',
};

const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) {
  setSetting.run(key, value);
}
console.log('✅ Default settings initialized');

console.log('\\n🚀 Setup complete! Run: npm start\\n');
