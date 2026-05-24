require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcryptjs');

console.log('\\n🌿 Scent World Canada — Setup\\n');

// Create admin user
const email = process.env.ADMIN_EMAIL || 'admin@scentworld.ca';
const password = process.env.ADMIN_PASSWORD || 'changeme123';
const hash = bcrypt.hashSync(password, 10);

const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email);
if (!existing) {
  db.prepare('INSERT INTO admins (email, password_hash, name) VALUES (?, ?, ?)').run(email, hash, 'Admin');
  console.log(`✅ Admin user created: ${email}`);
} else {
  db.prepare('UPDATE admins SET password_hash = ? WHERE email = ?').run(hash, email);
  console.log(`✅ Admin password updated: ${email}`);
}

// Seed products
const products = [
  { name: 'S20 Nano Diffuser', slug: 's20', category: 'diffusers', short_desc: 'Compact nano diffuser for personal spaces up to 300 sq ft.', price: 199.00, coverage: 'Up to 300 sq ft', sort_order: 1 },
  { name: 'S30 Nano Diffuser', slug: 's30', category: 'diffusers', short_desc: 'Mid-size nano diffuser with programmable timer. Coverage up to 2,870 sq ft.', price: 349.00, coverage: 'Up to 2,870 sq ft', sort_order: 2 },
  { name: 'S100 Commercial Diffuser', slug: 's100', category: 'diffusers', short_desc: 'Professional-grade cold-air diffuser for commercial spaces up to 3,230 sq ft.', price: 599.00, coverage: 'Up to 3,230 sq ft', sort_order: 3 },
  { name: 'S200 Commercial Diffuser', slug: 's200', category: 'diffusers', short_desc: 'High-capacity nano diffuser for large commercial environments up to 17,945 sq ft.', price: 899.00, coverage: 'Up to 17,945 sq ft', sort_order: 4 },
  { name: 'L100 Luxury Diffuser', slug: 'l100', category: 'diffusers', short_desc: 'Premium luxury diffuser with elegant design and smart controls.', price: 749.00, coverage: 'Up to 3,230 sq ft', sort_order: 5 },
  { name: 'L100 AD Display Diffuser', slug: 'l100-ad', category: 'diffusers', short_desc: 'Luxury diffuser with built-in digital display for branding.', price: 999.00, coverage: 'Up to 3,230 sq ft', sort_order: 6 },
  { name: 'L200 Luxury Diffuser', slug: 'l200', category: 'diffusers', short_desc: 'Top-tier luxury diffuser with diamond-pattern design for premium venues.', price: 1299.00, coverage: 'Up to 17,945 sq ft', sort_order: 7 },
  { name: 'Car Scent Diffuser', slug: 'car-diffuser', category: 'home_car', short_desc: 'Premium car diffuser with USB-C power and nano mist technology.', price: 149.00, coverage: 'Vehicle interior', sort_order: 8 },
  { name: 'Car Diffuser Gift Set', slug: 'car-gift-set', category: 'home_car', short_desc: 'Car diffuser with 5 curated fragrance oils in luxury packaging.', price: 249.00, coverage: 'Vehicle interior', sort_order: 9, featured: 1 },
  { name: 'Fresh Blossom Oil', slug: 'fresh-blossom', category: 'oils', short_desc: 'Light floral blend with notes of spring blossoms and green leaves.', price: 49.00, coverage: null, sort_order: 10 },
  { name: 'White Tea Oil', slug: 'white-tea', category: 'oils', short_desc: 'Clean, calming white tea fragrance perfect for spas and wellness spaces.', price: 49.00, coverage: null, sort_order: 11 },
  { name: 'Oud Oil', slug: 'oud', category: 'oils', short_desc: 'Rich, warm oud blend — a signature Middle Eastern luxury fragrance.', price: 59.00, coverage: null, sort_order: 12 },
  { name: 'Vienna Oil', slug: 'vienna', category: 'oils', short_desc: 'Sophisticated European-inspired blend with warm amber undertones.', price: 49.00, coverage: null, sort_order: 13 },
  { name: 'Spark Honey Oil', slug: 'spark-honey', category: 'oils', short_desc: 'Sweet and vibrant honey-citrus blend for energizing spaces.', price: 49.00, coverage: null, sort_order: 14 },
  { name: 'Gold Aerosol Spray', slug: 'aerosol-gold', category: 'aerosol', short_desc: 'Premium aerosol spray with fine mist and long-lasting Gold fragrance.', price: 30.00, coverage: 'Room spray', sort_order: 15 },
  { name: 'Aerosol Dispenser Unit', slug: 'aerosol-dispenser', category: 'aerosol', short_desc: 'Programmable automatic aerosol dispenser for consistent ambient scenting.', price: 89.00, coverage: 'Single room', sort_order: 16 },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO products (name, slug, category, short_desc, price, coverage, sort_order, featured)
  VALUES (@name, @slug, @category, @short_desc, @price, @coverage, @sort_order, @featured)
`);

let count = 0;
for (const p of products) {
  p.featured = p.featured || 0;
  const result = insert.run(p);
  if (result.changes > 0) count++;
}
console.log(`✅ ${count} products seeded`);

// Default settings
const defaults = {
  'site_name': 'Scent World Canada',
  'site_email': 'info@scentworld.ca',
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
