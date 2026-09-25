// Database backups: consistent snapshots, optional AES-256-GCM encryption
// (BACKUP_PASSPHRASE), and the nightly emailed off-site copy (BACKUP_EMAIL).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../database');


// Take a consistent single-file snapshot of the DB, even while it's in use
// (VACUUM INTO checkpoints the WAL and writes a clean copy). Returns the temp
// path; caller is responsible for deleting it.
function snapshotDb() {
  const tmp = path.join(os.tmpdir(), `scentworld-backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return tmp;
}

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
    // Backups can go to a dedicated inbox (BACKUP_EMAIL) so the daily archive
    // doesn't clutter the address that gets order/quote notifications.
    // Falls back to NOTIFY_EMAIL, then the site default.
    const to = process.env.BACKUP_EMAIL || process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
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

module.exports = { snapshotDb, maybeEncryptBackup, emailBackup, scheduleDailyBackup };
