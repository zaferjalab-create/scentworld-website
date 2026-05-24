const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'data');
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

module.exports = db;
