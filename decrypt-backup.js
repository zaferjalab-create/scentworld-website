// Decrypt an emailed .db.enc backup produced when BACKUP_PASSPHRASE is set.
//
// Usage (from this folder):
//   BACKUP_PASSPHRASE=your-passphrase node decrypt-backup.js scentworld-2026-07-04.db.enc
//
// Writes the plain SQLite file next to it (same name without ".enc").
// The passphrase must match the BACKUP_PASSPHRASE the server used to encrypt.

const crypto = require('crypto');
const fs = require('fs');

const pass = process.env.BACKUP_PASSPHRASE;
const inFile = process.argv[2];

if (!pass || !inFile) {
  console.error('Usage: BACKUP_PASSPHRASE=<passphrase> node decrypt-backup.js <file.db.enc>');
  process.exit(1);
}

try {
  const buf = fs.readFileSync(inFile);
  // Layout: salt(16) | iv(12) | authTag(16) | ciphertext
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const key = crypto.scryptSync(pass, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  const outFile = inFile.replace(/\.enc$/, '') || 'backup.db';
  fs.writeFileSync(outFile, out);
  console.log('Decrypted ->', outFile);
} catch (err) {
  console.error('Decryption failed (wrong passphrase or corrupt file):', err.message);
  process.exit(1);
}
