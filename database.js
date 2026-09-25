const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// DATA_DIR lets the test suite use a throwaway folder; production uses ./data
// (the Railway volume).
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'scentworld.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better performance
db.exec('PRAGMA journal_mode = WAL');

// Create tables
db.exec(`
  -- Contact / Quote Requests
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    customer_type TEXT,
    product_interest TEXT,
    message TEXT,
    status TEXT DEFAULT 'new',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Bookings / Consultations
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    business_name TEXT,
    preferred_date TEXT NOT NULL,
    preferred_time TEXT NOT NULL,
    timezone TEXT DEFAULT 'America/Halifax',
    topic TEXT,
    message TEXT,
    status TEXT DEFAULT 'pending',
    admin_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Newsletter Subscribers
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    first_name TEXT,
    source TEXT DEFAULT 'website',
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Products (catalog)
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL,
    short_desc TEXT,
    full_desc TEXT,
    price REAL,
    currency TEXT DEFAULT 'CAD',
    coverage TEXT,
    image_url TEXT,
    featured INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Orders
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    customer_name TEXT,
    customer_email TEXT,
    customer_phone TEXT,
    shipping_line1 TEXT,
    shipping_city TEXT,
    shipping_province TEXT,
    shipping_postal TEXT,
    shipping_country TEXT DEFAULT 'CA',
    subtotal REAL,
    tax REAL DEFAULT 0,
    shipping_cost REAL DEFAULT 0,
    total REAL NOT NULL,
    currency TEXT DEFAULT 'CAD',
    status TEXT DEFAULT 'confirmed',
    payment_status TEXT DEFAULT 'paid',
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Order Items
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER,
    product_name TEXT NOT NULL,
    product_category TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL
  );

  -- Admin users
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Site settings (key-value store)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: Add gallery_images column if it doesn't exist
try {
  db.exec('ALTER TABLE products ADD COLUMN gallery_images TEXT');
  console.log('✅ Added gallery_images column');
} catch (e) {
  // Column already exists, ignore
}

// Migration: product spec fields + what's-in-the-box (Phase 2)
// All nullable — product pages render blank-tolerant rows.
try {
  const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  const newCols = [
    ['spec_coverage', 'TEXT'],      // e.g. "Up to 3,230 sq ft / 300 m²"
    ['spec_oil_capacity', 'TEXT'],  // e.g. "500 ml"
    ['spec_noise', 'TEXT'],         // e.g. "< 35 dB"
    ['spec_power', 'TEXT'],         // e.g. "100–240V AC"
    ['spec_dimensions', 'TEXT'],    // e.g. "20 × 20 × 30 cm"
    ['spec_weight', 'TEXT'],        // e.g. "2.4 kg"
    ['spec_warranty', 'TEXT'],      // e.g. "1-year limited warranty"
    ['box_contents', 'TEXT'],       // JSON array of strings
  ];
  let added = 0;
  for (const [name, type] of newCols) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
      added++;
    }
  }
  if (added > 0) console.log(`✅ Added ${added} product spec columns`);
} catch (e) {
  console.error('❌ spec columns migration error:', e.message);
}

// Migration: Add sizes column for product variants (e.g. 100ml/200ml/500ml)
try {
  // Check if column exists first
  const cols = db.prepare("PRAGMA table_info(products)").all();
  const hasSizes = cols.some(c => c.name === 'sizes');
  if (!hasSizes) {
    db.exec('ALTER TABLE products ADD COLUMN sizes TEXT');
    console.log('✅ Added sizes column to products table');
  } else {
    console.log('ℹ sizes column already exists');
  }
} catch (e) {
  console.error('❌ sizes migration error:', e.message);
}

// ── Core product catalog (single source of truth) ──
// Inserted before the product migrations below so they always find the rows,
// even on a brand-new database. INSERT OR IGNORE + fill-only-if-empty updates
// mean existing rows (and anything edited in the admin) are never overwritten.
try {
  const products = [
    { name: 'S20 Nano Diffuser', slug: 's20', category: 'diffusers', short_desc: 'Compact nano diffuser for personal spaces of 300–500 sq ft.', price: 199.00, coverage: '300–500 sq ft', sort_order: 1, image_url: '/images/products/S20-Black.webp' },
    { name: 'S30 Nano Diffuser', slug: 's30', category: 'diffusers', short_desc: 'Mid-size nano diffuser with programmable timer. Coverage 500–1,500 sq ft.', price: 349.00, coverage: '500–1,500 sq ft', sort_order: 2, image_url: '/images/products/S30-Black.webp' },
    { name: 'S100 Commercial Diffuser', slug: 's100', category: 'diffusers', short_desc: 'Professional-grade cold-air diffuser for commercial spaces of 1,500–3,000 sq ft.', price: 599.00, coverage: '1,500–3,000 sq ft', sort_order: 3, image_url: '/images/products/S100.webp' },
    { name: 'S200 Commercial Diffuser', slug: 's200', category: 'diffusers', short_desc: 'High-capacity nano diffuser for commercial environments of 3,000–4,000 sq ft.', price: 899.00, coverage: '3,000–4,000 sq ft', sort_order: 4, image_url: '/images/products/S200.webp' },
    { name: 'L100 Luxury Diffuser', slug: 'l100', category: 'diffusers', short_desc: 'Premium luxury diffuser with elegant design and smart controls.', price: 749.00, coverage: '1,500–3,000 sq ft', sort_order: 5, image_url: '/images/products/SW110.webp' },
    { name: 'L100 AD Display Diffuser', slug: 'l100-ad', category: 'diffusers', short_desc: 'Luxury diffuser with built-in digital display for branding.', price: 999.00, coverage: '1,500–3,000 sq ft', sort_order: 6, image_url: '/images/products/SW114.webp' },
    { name: 'L200 Luxury Diffuser', slug: 'l200', category: 'diffusers', short_desc: 'Top-tier luxury diffuser with diamond-pattern design for premium venues.', price: 1299.00, coverage: '4,000–5,000 sq ft', sort_order: 7, image_url: '/images/products/SW127.webp' },
    { name: 'Car Scent Diffuser', slug: 'car-diffuser', category: 'home_car', short_desc: 'Premium car diffuser with USB-C power and nano mist technology.', price: 149.00, coverage: 'Vehicle interior', sort_order: 8, image_url: '/images/products/Car-Scent-Diffuser.webp' },
    { name: 'Car Diffuser Gift Set', slug: 'car-gift-set', category: 'home_car', short_desc: 'Car diffuser with 5 curated fragrance oils in luxury packaging.', price: 249.00, coverage: 'Vehicle interior', sort_order: 9, featured: 1, image_url: '/images/products/H1_02.jpg' },
    { name: 'Fresh Blossom Oil', slug: 'fresh-blossom', category: 'oils', short_desc: 'Light floral blend with notes of spring blossoms and green leaves.', price: 49.00, coverage: null, sort_order: 10, image_url: '/images/products/SW101-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
    { name: 'White Tea Oil', slug: 'white-tea', category: 'oils', short_desc: 'Clean, calming white tea fragrance perfect for spas and wellness spaces.', price: 49.00, coverage: null, sort_order: 11, image_url: '/images/products/SW102-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
    { name: 'Oud Oil', slug: 'oud', category: 'oils', short_desc: 'Rich, warm oud blend — a signature Middle Eastern luxury fragrance.', price: 59.00, coverage: null, sort_order: 12, image_url: '/images/products/SW103-430x430-1.webp', sizes: '[{"label":"100ml","price":59},{"label":"200ml","price":109},{"label":"500ml","price":229}]' },
    { name: 'Vienna Oil', slug: 'vienna', category: 'oils', short_desc: 'Sophisticated European-inspired blend with warm amber undertones.', price: 49.00, coverage: null, sort_order: 13, image_url: '/images/products/SW104-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
    { name: 'Spark Honey Oil', slug: 'spark-honey', category: 'oils', short_desc: 'Sweet and vibrant honey-citrus blend for energizing spaces.', price: 49.00, coverage: null, sort_order: 14, image_url: '/images/products/SW106-430x430-1.webp', sizes: '[{"label":"100ml","price":49},{"label":"200ml","price":89},{"label":"500ml","price":189}]' },
    { name: 'Gold Aerosol Spray', slug: 'aerosol-gold', category: 'aerosol', short_desc: 'Premium aerosol spray with fine mist and long-lasting Gold fragrance.', price: 30.00, coverage: 'Room spray', sort_order: 15, image_url: '/images/products/SW500.webp' },
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
} catch (e) {
  console.error('❌ core product seed error:', e.message);
}

// Always seed default sizes for oil products on every startup (idempotent)
try {
  const defaultOilSizes = JSON.stringify([
    {label: '100ml', price: 49},
    {label: '200ml', price: 89},
    {label: '500ml', price: 189}
  ]);
  const oudSizes = JSON.stringify([
    {label: '100ml', price: 59},
    {label: '200ml', price: 109},
    {label: '500ml', price: 229}
  ]);
  const updates = [
    ['fresh-blossom', defaultOilSizes],
    ['white-tea', defaultOilSizes],
    ['vienna', defaultOilSizes],
    ['spark-honey', defaultOilSizes],
    ['oud', oudSizes]
  ];
  const stmt = db.prepare("UPDATE products SET sizes = ? WHERE slug = ? AND (sizes IS NULL OR sizes = '')");
  let updated = 0;
  for (const [slug, sizes] of updates) {
    const r = stmt.run(sizes, slug);
    updated += r.changes;
  }
  if (updated > 0) console.log(`✅ Populated default sizes on ${updated} oil products`);
} catch (e) {
  console.error('❌ sizes seed error:', e.message);
}

// Migration: Convert m² to sq ft in product coverage
try {
  const conversions = [
    ['Up to 28m²', 'Up to 300 sq ft'],
    ['Up to 267m²', 'Up to 2,870 sq ft'],
    ['Up to 300m²', 'Up to 3,230 sq ft'],
    ['Up to 1,667m²', 'Up to 17,945 sq ft']
  ];
  let updated = 0;
  const stmt = db.prepare('UPDATE products SET coverage = ? WHERE coverage = ?');
  for (const [oldVal, newVal] of conversions) {
    const result = stmt.run(newVal, oldVal);
    updated += result.changes;
  }
  if (updated > 0) console.log(`✅ Converted ${updated} product coverage values from m² to sq ft`);

  // Also update short_desc that contains m²
  const descUpdates = [
    ['Compact nano diffuser for personal spaces up to 28m².', 'Compact nano diffuser for personal spaces up to 300 sq ft.'],
    ['Mid-size nano diffuser with programmable timer. Coverage up to 267m².', 'Mid-size nano diffuser with programmable timer. Coverage up to 2,870 sq ft.'],
    ['Professional-grade cold-air diffuser for commercial spaces up to 300m².', 'Professional-grade cold-air diffuser for commercial spaces up to 3,230 sq ft.'],
    ['High-capacity nano diffuser for large commercial environments up to 1,667m².', 'High-capacity nano diffuser for large commercial environments up to 17,945 sq ft.']
  ];
  const descStmt = db.prepare('UPDATE products SET short_desc = ? WHERE short_desc = ?');
  for (const [oldVal, newVal] of descUpdates) {
    descStmt.run(newVal, oldVal);
  }
} catch (e) {
  console.log('Coverage migration warning:', e.message);
}

// Migration: product reviews + editable testimonials (Phase 4)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      text TEXT,
      approved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS testimonials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stars INTEGER DEFAULT 5,
      text TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_role TEXT,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Seed testimonials with the previously hard-coded homepage entries (once)
  const count = db.prepare('SELECT COUNT(*) AS c FROM testimonials').get().c;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO testimonials (stars, text, author_name, author_role, sort_order) VALUES (5, ?, ?, ?, ?)');
    ins.run("Working with Scent World Canada transformed our lobby into an unforgettable sensory experience. Guests now ask us about the fragrance the moment they walk in — it's become part of our brand identity.", 'Michelle R.', 'General Manager · Boutique Hotel', 1);
    ins.run('The team designed a custom scent for our wellness centre that perfectly captures the calm and elegance we wanted. Our clients consistently mention how relaxing the atmosphere feels — it\'s been a game-changer.', 'Amélie L.', 'Owner · Day Spa & Wellness', 2);
    ins.run('Professional from quote to installation. The diffusion system is whisper-quiet and the fragrance throughout our restaurant is beautifully balanced. Highly recommend for any hospitality business.', 'David C.', 'Executive Chef · Fine Dining', 3);
    console.log('✅ Seeded 3 testimonials');
  }
} catch (e) {
  console.error('❌ reviews/testimonials migration error:', e.message);
}

// Migration: track whether a post-purchase review-request email has been sent
// for an order, so the daily job never emails the same customer twice.
try {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!cols.includes('review_request_sent_at')) {
    db.exec('ALTER TABLE orders ADD COLUMN review_request_sent_at DATETIME');
    console.log('✅ Added orders.review_request_sent_at column');
  }
} catch (e) {
  console.error('❌ review_request column migration error:', e.message);
}

// Aerosol products are part of the core catalog above. The live DB once had
// them deactivated; re-activate them one time only (settings flag), so a later
// deactivation from the admin panel isn't reverted on every deploy.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'reactivated_aerosols'").get();
  if (!done) {
    const r = db.prepare("UPDATE products SET active = 1 WHERE slug IN ('aerosol-gold', 'aerosol-dispenser') AND active = 0").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('reactivated_aerosols', '1')").run();
    if (r.changes > 0) console.log(`✅ Re-activated ${r.changes} aerosol products`);
  }
} catch (e) {
  console.error('❌ aerosol re-activation error:', e.message);
}

// Migration: fragrance-oil country of origin (Turkey / Italy / Spain)
try {
  const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
  if (!cols.includes('origin')) {
    db.exec('ALTER TABLE products ADD COLUMN origin TEXT');
    console.log('✅ Added products.origin column');
  }
} catch (e) {
  console.error('❌ origin column migration error:', e.message);
}

// Seed the 2026 fragrance-oil catalog. All oils share the same packaging and the
// standard 100/200/500 ml pricing. Origin code: t = Turkey, i = Italy, s = Spain.
// Idempotent: INSERT OR IGNORE by slug, and origin/sizes back-filled for the few
// oils that already existed (white-tea, oud, vienna, spark-honey).
try {
  const ORIGIN = { t: 'Turkey', i: 'Italy', s: 'Spain' };
  const OIL_SIZES = JSON.stringify([{ label: '100ml', price: 49 }, { label: '200ml', price: 89 }, { label: '500ml', price: 189 }]);
  // [listNumber, displayName, originCode]
  const OILS = [
    [1, 'Sense', 'i'], [2, 'For You', 'i'], [3, 'Platinum', 'i'], [4, 'Gold', 'i'], [5, 'Sole', 't'],
    [6, 'Harmoney', 's'], [7, 'Green Tea', 'i'], [8, 'Luxury', 'i'], [9, 'Chanel', 's'], [10, 'Assala', 'i'],
    [11, 'Sensitive', 'i'], [12, 'Passion', 'i'], [13, 'Melano', 'i'], [14, 'Carpex', 'i'], [15, 'Adress', 's'],
    [16, 'Spark Honey', 't'], [17, 'Latinya', 't'], [18, 'Lacco', 't'], [19, 'Pacivictus', 't'], [20, 'Pearl', 'i'],
    [21, 'Amber', 't'], [22, 'Beauty', 't'], [23, 'Oud', 'i'], [24, 'Huboss', 't'], [25, 'Classic Oud', 'i'],
    [26, 'Vienna', 's'], [27, 'Flowers', 't'], [28, 'Crestal', 'i'], [29, 'Arabian Rose', 'i'], [30, 'Wooden', 'i'],
    [31, 'White Tea', 't'], [32, 'Al Haramain', 'i'],
    [36, 'Lavender', 't'], [37, 'Secret', 't'], [38, 'Aldehddy', 't'], [39, 'Kalemat', 't'], [40, 'Up-Parilt', 't'],
    [41, 'Garden', 'i'], [42, 'Jasmine', 't'], [43, 'Gardenia', 't'], [44, 'Lemon Grass', 'i'], [45, 'Tropical', 't'],
    [46, 'Fema', 't'], [47, 'Peel', 'i'],
    [51, 'Cinnamon', 't'], [52, 'Blue', 't'], [53, 'Love', 'i'], [54, 'Crazy Love', 't'], [55, 'Eucalyptus', 't'],
    [56, 'Black', 't'], [57, 'Melody', 't'], [58, 'Mango', 'i'], [59, 'Lime', 't'], [60, 'Juniper', 'i'], [62, 'Defne', 't'],
  ];
  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ins = db.prepare(`INSERT OR IGNORE INTO products
    (name, slug, category, short_desc, price, coverage, image_url, sizes, origin, active, sort_order)
    VALUES (?, ?, 'oils', ?, 49, NULL, '/images/placeholder.svg', ?, ?, 1, ?)`);
  const updOrigin = db.prepare("UPDATE products SET origin = ? WHERE slug = ? AND (origin IS NULL OR origin = '')");
  const updSizes = db.prepare("UPDATE products SET sizes = ? WHERE slug = ? AND (sizes IS NULL OR sizes = '')");
  let added = 0;
  for (const [num, name, code] of OILS) {
    const slug = slugify(name);
    const origin = ORIGIN[code] || null;
    const desc = `Signature fragrance oil${origin ? ' — sourced from ' + origin : ''}. Available in 100 ml, 200 ml and 500 ml.`;
    const r = ins.run(name + ' Oil', slug, desc, OIL_SIZES, origin, 100 + num);
    if (r.changes > 0) added++;
    updOrigin.run(origin, slug);   // back-fill origin on any that already existed
    updSizes.run(OIL_SIZES, slug);
  }
  if (added > 0) console.log(`✅ Seeded ${added} fragrance oils`);

  // Trademark-safe naming: recognizable brand/house names become "Inspired by …".
  // Guarded so it applies once and doesn't clobber later admin renames.
  const INSPIRED = { chanel: 'Inspired by Chanel', 'al-haramain': 'Inspired by Al Haramain', kalemat: 'Inspired by Kalemat' };
  const rn = db.prepare("UPDATE products SET name = ? WHERE slug = ? AND name NOT LIKE 'Inspired by%'");
  for (const [slug, name] of Object.entries(INSPIRED)) rn.run(name, slug);

  // Shared packaging photos for every oil: main = white-background bottle,
  // gallery = the three sizes. Only touches oils still on the placeholder or an
  // old SW-numbered image, so any custom image set later via the admin survives.
  const OIL_MAIN = '/images/products/oil-main.webp';
  const OIL_TRIO = '/images/products/oil-trio.webp';
  db.prepare(`UPDATE products SET image_url = ? WHERE category = 'oils'
    AND (image_url IS NULL OR image_url != ?)`).run(OIL_MAIN, OIL_MAIN);
  db.prepare(`UPDATE products SET gallery_images = ? WHERE category = 'oils'
    AND (gallery_images IS NULL OR gallery_images != ?)`).run(JSON.stringify([OIL_TRIO]), JSON.stringify([OIL_TRIO]));
} catch (e) {
  console.error('❌ oil catalog seed error:', e.message);
}

// Fill real product descriptions for the oils we have write-ups for (from the
// ScentWorld oil docs). Only fills oils that don't yet have a full_desc, so any
// description edited later via the admin is preserved.
try {
  const oilContent = require('./oil-content.json');
  const upd = db.prepare("UPDATE products SET short_desc = ?, full_desc = ? WHERE slug = ? AND category = 'oils' AND (full_desc IS NULL OR full_desc = '')");
  let n = 0;
  for (const [slug, c] of Object.entries(oilContent)) {
    n += upd.run(c.short, c.full, slug).changes;
  }
  if (n > 0) console.log(`✅ Filled ${n} oil descriptions`);
} catch (e) {
  console.error('❌ oil descriptions error:', e.message);
}

// Fill diffuser device descriptions + real technical specs (from the ScentWorld
// device docs) and the car-diffuser / gift-set photos. Descriptions/specs only
// fill where empty; car photos replace old png/jpg images with the new webp.
try {
  const diff = require('./diffuser-content.json');
  const setIfEmpty = (col, val, slug) => {
    if (val == null) return;
    db.prepare(`UPDATE products SET ${col} = ? WHERE slug = ? AND (${col} IS NULL OR ${col} = '')`).run(val, slug);
  };
  let n = 0;
  for (const [slug, c] of Object.entries(diff)) {
    if (c.full) {
      n += db.prepare("UPDATE products SET short_desc = ?, full_desc = ? WHERE slug = ? AND (full_desc IS NULL OR full_desc = '')").run(c.short, c.full, slug).changes;
      // Also refresh descriptions still carrying metric coverage (m² / m³) in
      // either the short or the full text.
      db.prepare(`UPDATE products SET short_desc = ?, full_desc = ? WHERE slug = ? AND (
        short_desc LIKE '%m³%' OR short_desc LIKE '%m²%' OR short_desc LIKE '%m3%' OR short_desc LIKE '%m2%' OR
        full_desc LIKE '%m³%' OR full_desc LIKE '%m²%' OR full_desc LIKE '%m3%' OR full_desc LIKE '%m2%')`).run(c.short, c.full, slug);
    }
    setIfEmpty('spec_coverage', c.spec_coverage, slug);
    // Convert any metric coverage (m² / m³) already stored to the sq-ft value.
    if (c.spec_coverage) {
      db.prepare("UPDATE products SET spec_coverage = ? WHERE slug = ? AND (spec_coverage LIKE '%m³%' OR spec_coverage LIKE '%m²%' OR spec_coverage LIKE '%m3%' OR spec_coverage LIKE '%m2%')").run(c.spec_coverage, slug);
    }
    setIfEmpty('spec_oil_capacity', c.spec_oil_capacity, slug);
    setIfEmpty('spec_noise', c.spec_noise, slug);
    setIfEmpty('spec_power', c.spec_power, slug);
    setIfEmpty('spec_dimensions', c.spec_dimensions, slug);
    setIfEmpty('spec_weight', c.spec_weight, slug);
    if (c.box) setIfEmpty('box_contents', JSON.stringify(c.box), slug);
    if (c.image) db.prepare("UPDATE products SET image_url = ? WHERE slug = ? AND (image_url IS NULL OR image_url NOT LIKE '%.webp')").run(c.image, slug);
    if (c.gallery) db.prepare("UPDATE products SET gallery_images = ? WHERE slug = ? AND (gallery_images IS NULL OR gallery_images = '' OR gallery_images = '[]')").run(JSON.stringify(c.gallery), slug);
  }
  if (n > 0) console.log(`✅ Filled ${n} diffuser descriptions`);
} catch (e) {
  console.error('❌ diffuser content error:', e.message);
}

// Product display order: Diffusers → Aerosol → Home & Car → Fragrance Oils.
// Diffusers keep their existing 1–7; aerosol/car set explicitly; oils pushed last.
try {
  db.prepare("UPDATE products SET sort_order = 8  WHERE slug = 'aerosol-gold'").run();
  db.prepare("UPDATE products SET sort_order = 9  WHERE slug = 'aerosol-dispenser'").run();
  db.prepare("UPDATE products SET sort_order = 10 WHERE slug = 'car-diffuser'").run();
  db.prepare("UPDATE products SET sort_order = 11 WHERE slug = 'car-gift-set'").run();
  db.prepare("UPDATE products SET sort_order = sort_order + 100 WHERE category = 'oils' AND sort_order < 100").run();
} catch (e) {
  console.error('❌ sort order error:', e.message);
}

// Hide the placeholder diffusers that don't have real photos/devices yet (owner
// will re-activate later). One-time, guarded by a settings flag so a later
// re-activation via the admin is never overwritten on the next deploy.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'hid_placeholder_diffusers'").get();
  if (!done) {
    const r = db.prepare("UPDATE products SET active = 0 WHERE slug IN ('s100','l100','l100-ad','l200')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('hid_placeholder_diffusers', '1')").run();
    if (r.changes) console.log(`✅ Hid ${r.changes} placeholder diffusers (re-activate anytime in admin)`);
  }
} catch (e) {
  console.error('❌ hide diffusers error:', e.message);
}

// Product photos were converted to WebP (same image, 85-98% smaller). Point
// any stored image_url / gallery entry at the .webp twin. Only exact old paths
// are rewritten, so admin-chosen images are untouched; the originals stay in
// the repo so old links keep working. Idempotent — safe on every start.
try {
  const WEBP_FROM = ['C300.jpg', 'Car-Scent-Diffuser.png', 'H3_03.jpg', 'oil-main.png', 'oil-trio.png',
    'S100.png', 'S20-Black.png', 'S20-White.jpg', 'S200.jpeg', 'S30-Black.jpeg', 'S300.jpeg',
    'SW110.png', 'SW114.png', 'SW127.png', 'SW500.jpg'];
  let n = 0;
  for (const f of WEBP_FROM) {
    const from = '/images/products/' + f;
    const to = '/images/products/' + f.replace(/\.(png|jpe?g)$/i, '.webp');
    n += db.prepare('UPDATE products SET image_url = ? WHERE image_url = ?').run(to, from).changes;
    n += db.prepare("UPDATE products SET gallery_images = replace(gallery_images, ?, ?) WHERE gallery_images LIKE '%' || ? || '%'")
      .run('"' + from + '"', '"' + to + '"', '"' + from + '"').changes;
  }
  if (n) console.log(`✅ Switched ${n} product image fields to WebP`);
} catch (e) {
  console.error('❌ webp migration error:', e.message);
}

// Coverage ladder set by the owner (2026-09-24): S20 300–500 sq ft up to the
// S300 at 5,000 sq ft, with the range divided between the devices in between.
// Applied once (settings flag) so later edits in the admin panel are kept. In
// descriptions only the old coverage phrase is swapped, preserving any other
// wording edited in the admin. The S300 value is picked up from
// diffuser-content.json when that product is added.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'coverage_ladder_v1'").get();
  if (!done) {
    const LADDER = {
      "s20": "300–500 sq ft",
      "s30": "500–1,500 sq ft",
      "s100": "1,500–3,000 sq ft",
      "l100": "1,500–3,000 sq ft",
      "l100-ad": "1,500–3,000 sq ft",
      "s200": "3,000–4,000 sq ft",
      "l200": "4,000–5,000 sq ft",
      "s300": "4,000–5,000 sq ft"
    };
    const PHRASES = {
      s20: [['up to 300 sq ft', '300–500 sq ft']],
      s30: [['1,435–2,870 sq ft', '500–1,500 sq ft'], ['up to 2,870 sq ft', '500–1,500 sq ft']],
      s100: [['spaces up to 3,230 sq ft', 'spaces of 1,500–3,000 sq ft']],
      s200: [['covering up to 17,945 sq ft', 'covering 3,000–4,000 sq ft'], ['up to 17,945 sq ft', '3,000–4,000 sq ft']],
    };
    let n = 0;
    for (const [slug, cov] of Object.entries(LADDER)) {
      n += db.prepare('UPDATE products SET coverage = ?, spec_coverage = ? WHERE slug = ?').run(cov, cov, slug).changes;
      for (const [from, to] of PHRASES[slug] || []) {
        db.prepare('UPDATE products SET short_desc = replace(short_desc, ?, ?), full_desc = replace(full_desc, ?, ?) WHERE slug = ?')
          .run(from, to, from, to, slug);
      }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('coverage_ladder_v1', '1')").run();
    if (n) console.log(`✅ Applied coverage ladder to ${n} diffusers`);
  }
} catch (e) {
  console.error('❌ coverage ladder error:', e.message);
}

module.exports = db;
