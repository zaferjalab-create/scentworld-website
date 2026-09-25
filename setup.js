require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcryptjs');

console.log('\n🌿 Scent World Canada — Setup\n');

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


// Default settings
const defaults = {
  'site_name': 'Scent World Canada',
  'site_email': 'hello@scentworld.ca',
  'site_phone': '(902) 707-0807',
  'site_address': 'Halifax, Nova Scotia, Canada',
  'shipping_threshold': '150',
  'currency': 'CAD',
};

const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaults)) {
  setSetting.run(key, value);
}
console.log('✅ Default settings initialized');

console.log('\n🚀 Setup complete! Run: npm start\n');
