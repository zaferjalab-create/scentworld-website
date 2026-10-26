// Admin sessions kept in the SQLite database (on the Railway volume), so
// signing in survives deploys and restarts. The default in-memory store
// forgot every session on each deploy and never pruned expired ones.
const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.prune();
    setInterval(() => this.prune(), 6 * 60 * 60 * 1000).unref();
  }

  expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  }

  prune() {
    try { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch (e) { /* db closing */ }
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), this.expiry(sess));
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiry(sess), sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb(null); } catch (e) { cb(e); }
  }
}

module.exports = { SqliteSessionStore };
