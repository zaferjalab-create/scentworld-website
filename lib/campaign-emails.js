// Holiday campaign emails to newsletter subscribers, sent through Resend like
// every other email from the site (no outside newsletter service).
//
// Nothing here sends by itself. The owner previews each email in the admin
// (Subscribers -> Email campaigns), sends a test to the business inbox, and
// presses Send. Each campaign can be sent once.
//
// Canada's anti-spam law (CASL) needs three things in every marketing email,
// and each one is here: who is sending it (name + mailing address), consent
// (only people who signed up, status "active"), and an unsubscribe link that
// works (GET/POST /unsubscribe in server.js, plus the one-click header).
const crypto = require('crypto');
const { resendEmail, escapeHtml, sendOwnerAlert } = require('./email');
const { CAMPAIGNS, salePrice, activeCampaign, clock } = require('./promo');
const { parseSizes, inStock } = require('./sizes');

const BASE = 'https://www.scentworld.ca';
const ADDRESS = 'Scent World Canada · 6156 Quinpool Road, Halifax, NS B3L 1A3';
const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The three approved emails. `campaign` is the lib/promo.js campaign whose
// prices the email quotes; `sendOn` is the day it is meant to go out.
const CAMPAIGN_EMAILS = [
  {
    id: 'black-friday-launch', name: 'Black Friday launch', campaign: 'black-friday', sendOn: '2026-11-27',
    subject: 'Black Friday is here: 25% off everything until Monday',
    preheader: '25% off diffusers, car diffusers and fragrance oils, November 27 to 30.',
    eyebrow: 'Black Friday · Cyber Monday', headline: '25% off everything',
    intro: 'Our biggest offer of the year runs from Friday, November 27 to Cyber Monday, November 30. Every product on scentworld.ca is 25% off, and the discount is applied automatically at checkout. No code needed.',
    hero: '/images/promo/black-friday.jpg', button: 'Shop Black Friday',
  },
  {
    id: 'cyber-monday-last-day', name: 'Cyber Monday (last day)', campaign: 'black-friday', sendOn: '2026-11-30',
    subject: 'Last day: 25% off everything ends tonight',
    preheader: 'Cyber Monday is the final day. The offer ends at 11:59 p.m. Halifax time.',
    eyebrow: 'Cyber Monday · Final day', headline: '25% off ends tonight',
    intro: 'Today, Monday, November 30, is the last day of our Black Friday to Cyber Monday offer. Every product on scentworld.ca is 25% off until 11:59 p.m. Halifax time, applied automatically at checkout.',
    hero: '/images/promo/black-friday.jpg', button: 'Shop before midnight',
  },
  {
    id: 'christmas-launch', name: 'Christmas launch', campaign: 'christmas', sendOn: '2026-12-01',
    subject: 'Christmas gifting: up to 20% off until December 24',
    preheader: '20% off S100, S200, the car diffuser gift set and fragrance oils; 15% off S20, S30, S300 and the car diffuser.',
    eyebrow: 'Christmas Gifting', headline: 'Up to 20% off, December 1 to 24',
    intro: 'Thoughtful gifts for homes, cars and businesses. From December 1 to 24, take 20% off the S100 and S200 diffusers, the car diffuser gift set and our fragrance oils, and 15% off the S20, S30 and S300 diffusers and the car diffuser. The discount is applied automatically at checkout.',
    hero: '/images/promo/christmas.jpg', button: 'Shop Christmas gifts',
  },
];

// Per-install secret for unsubscribe links, kept in the settings table so the
// links keep working across restarts and deploys.
function unsubSecret(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unsub_secret'").get();
  if (row && row.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('unsub_secret', ?)").run(secret);
  return secret;
}
const unsubToken = (db, sub) =>
  crypto.createHmac('sha256', unsubSecret(db)).update(`${sub.id}:${String(sub.email).toLowerCase()}`).digest('base64url').slice(0, 32);
const unsubUrl = (db, sub) => `${BASE}/unsubscribe?s=${sub.id}&t=${unsubToken(db, sub)}`;

// Marks the subscriber unsubscribed if the link is genuine. Returns true/false.
function unsubscribe(db, id, token) {
  const sub = db.prepare('SELECT id, email FROM subscribers WHERE id = ?').get(parseInt(id, 10) || 0);
  if (!sub || typeof token !== 'string') return false;
  const want = Buffer.from(unsubToken(db, sub)), got = Buffer.from(token);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  db.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE id = ?").run(sub.id);
  return true;
}

// Sale prices for the email, straight from the product table and the campaign
// calendar, so the email can never quote a price the website won't charge.
function priceLines(db, campaign) {
  const rows = db.prepare('SELECT name, slug, category, price, sizes FROM products WHERE active = 1 ORDER BY sort_order').all();
  const lines = [];
  for (const p of rows.filter(r => r.category !== 'oils' && r.price > 0)) {
    const pct = campaign.percent(p);
    lines.push({ name: p.name, url: `${BASE}/products/${p.slug}`, was: p.price, now: salePrice(p.price, pct), pct });
  }
  // Oils: one line, the lowest in-stock price (sold-out sizes are never quoted).
  let best = null;
  for (const p of rows.filter(r => r.category === 'oils')) {
    for (const s of inStock(parseSizes(p.sizes) || [])) {
      if (s.price > 0 && (!best || s.price < best.was)) best = { was: s.price, label: s.label, pct: campaign.percent(p) };
    }
  }
  if (best) {
    lines.push({ name: `Undiluted premium fragrance oils (${best.label}), limited quantities`, url: `${BASE}/shop?filter=oils`,
      was: best.was, now: salePrice(best.was, best.pct), pct: best.pct, from: true });
  }
  return lines;
}

function renderCampaignEmail(db, id, sub) {
  const e = CAMPAIGN_EMAILS.find(x => x.id === id);
  if (!e) return null;
  const campaign = CAMPAIGNS.find(c => c.id === e.campaign);
  const lines = priceLines(db, campaign);
  const unsub = sub ? unsubUrl(db, sub) : `${BASE}/unsubscribe`;
  const hello = sub && sub.first_name ? `Hi ${escapeHtml(sub.first_name)},` : 'Hello,';
  const rows = lines.map(l => `
        <tr>
          <td style="padding:10px 14px 10px 0;border-bottom:1px solid #2a2420;font-size:15px"><a href="${l.url}" style="color:#f5f0e8;text-decoration:none">${escapeHtml(l.name)}</a></td>
          <td style="padding:10px 0;border-bottom:1px solid #2a2420;text-align:right;white-space:nowrap;font-size:15px">
            <span style="color:#8c8377;text-decoration:line-through;font-size:13px">${money(l.was)}</span>
            &nbsp;<strong style="color:#c9a55c">${l.from ? 'from ' : ''}${money(l.now)}</strong></td>
        </tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(e.subject)}</title></head>
<body style="margin:0;padding:0;background:#0b0908">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(e.preheader)}</div>
<div style="font-family:Georgia,'Times New Roman',serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8">
  <div style="text-align:center;padding:28px 24px 18px">
    <div style="font-size:26px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
    <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px;font-family:Arial,sans-serif">CANADA</div>
  </div>
  <a href="${BASE}/shop"><img src="${BASE}${e.hero}" width="600" alt="${escapeHtml(e.eyebrow + ': ' + e.headline)}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a>
  <div style="padding:28px 28px 8px">
    <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#c9a55c">${escapeHtml(e.eyebrow)}</div>
    <h1 style="font-size:26px;line-height:1.25;margin:10px 0 16px;color:#f5f0e8;font-weight:normal">${escapeHtml(e.headline)}</h1>
    <p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#cdc5b8;margin:0 0 6px">${hello}</p>
    <p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#cdc5b8;margin:0 0 20px">${escapeHtml(e.intro)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif">${rows}
    </table>
    <p style="font-family:Arial,sans-serif;font-size:12px;color:#8c8377;margin:10px 0 0">Prices in CAD, before tax. Free shipping on orders over $150.</p>
    <div style="text-align:center;margin:28px 0 8px">
      <a href="${BASE}/shop" style="display:inline-block;background:#c9a55c;color:#0b0908;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:15px 34px">${escapeHtml(e.button)}</a>
    </div>
    <p style="font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#958e85;margin:22px 0 0">Offers can't be combined. Not valid on rentals or subscriptions. Shopping in person? Reply to this email or call 902-707-0807 and we'll apply the discount for you.</p>
  </div>
  <div style="padding:22px 28px 30px;border-top:1px solid #2a2420;margin-top:24px;font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#7d766c;text-align:center">
    ${ADDRESS}<br>
    <a href="mailto:hello@scentworld.ca" style="color:#958e85">hello@scentworld.ca</a> · <a href="${BASE}" style="color:#958e85">www.scentworld.ca</a><br>
    You are receiving this because you signed up for Scent World Canada emails at scentworld.ca.<br>
    <a href="${unsub}" style="color:#c9a55c">Unsubscribe</a>
  </div>
</div></body></html>`;
  const text = [
    `${e.eyebrow}: ${e.headline}`, '',
    sub && sub.first_name ? `Hi ${sub.first_name},` : 'Hello,', '', e.intro, '',
    ...lines.map(l => `- ${l.name}: ${l.from ? 'from ' : ''}${money(l.now)} (regular ${money(l.was)})`), '',
    'Prices in CAD, before tax. Free shipping on orders over $150.',
    `Shop: ${BASE}/shop`, '',
    "Offers can't be combined. Not valid on rentals or subscriptions. Shopping in person? Reply to this email or call 902-707-0807 and we'll apply the discount for you.", '',
    ADDRESS, 'hello@scentworld.ca · www.scentworld.ca',
    'You are receiving this because you signed up for Scent World Canada emails at scentworld.ca.',
    `Unsubscribe: ${unsub}`,
  ].join('\n');
  return { subject: e.subject, html, text, unsub };
}

const sentKey = id => `campaign_email:${id}`;
function campaignStatus(db, id) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(sentKey(id));
  try { return row ? JSON.parse(row.value) : null; } catch (err) { return null; }
}
const activeSubscribers = db => db.prepare("SELECT id, email, first_name FROM subscribers WHERE status = 'active' ORDER BY id").all();

// ── Scheduling ──
// The owner approves an email once in admin ("Schedule"). The site then sends it
// itself at 8:00 a.m. Halifax time on its day (checked every few minutes), so it
// doesn't depend on anyone being signed in. Safety rules:
//   - only while its campaign is running (a Black Friday email never goes out
//     in the gap after Nov 30);
//   - not if it is more than a day late (server down for days): it is marked
//     "missed" and the owner is told instead;
//   - once, and never to people who unsubscribed (sendCampaign handles both).
const SEND_HOUR = 8; // Halifax time
const schedKey = id => `campaign_schedule:${id}`;
function getSchedule(db, id) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(schedKey(id));
  try { return row ? JSON.parse(row.value) : null; } catch (err) { return null; }
}
const putSchedule = (db, id, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(schedKey(id), JSON.stringify(v));
function schedule(db, id) {
  const e = CAMPAIGN_EMAILS.find(x => x.id === id);
  if (!e) throw new Error('Unknown campaign email');
  if (campaignStatus(db, id)) throw new Error('This campaign email has already been sent');
  putSchedule(db, id, { state: 'scheduled', approvedAt: new Date().toISOString(), sendOn: e.sendOn, hour: SEND_HOUR });
}
function cancelSchedule(db, id) { db.prepare('DELETE FROM settings WHERE key = ?').run(schedKey(id)); }

// Halifax wall clock for `now`: { date: 'yyyy-mm-dd', hour }
function halifaxClock(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Halifax', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Sends whatever is scheduled and due. Returns what it did (used by the timer and the tests).
async function runDue(db, now = clock(), opts = {}) {
  const hc = halifaxClock(now);
  const done = [];
  for (const e of CAMPAIGN_EMAILS) {
    const sch = getSchedule(db, e.id);
    if (!sch || sch.state !== 'scheduled' || campaignStatus(db, e.id)) continue;
    const late = daysBetween(e.sendOn, hc.date);
    if (late < 0 || (late === 0 && hc.hour < SEND_HOUR)) continue; // not time yet
    const camp = CAMPAIGNS.find(c => c.id === e.campaign);
    const running = activeCampaign(now);
    if (late > 1 || !running || running.id !== camp.id) {
      putSchedule(db, e.id, { ...sch, state: 'missed', checkedAt: new Date().toISOString() });
      await sendOwnerAlert(`[Scent World] Email NOT sent: ${e.name}`,
        `<p>The scheduled email "${escapeHtml(e.name)}" was not sent because it is no longer its day (planned for ${e.sendOn}).</p><p>Open Admin, Subscribers, Email campaigns if you still want to send it by hand.</p>`,
        `The scheduled email "${e.name}" was not sent because it is no longer its day (planned for ${e.sendOn}). Open Admin > Subscribers > Email campaigns if you still want to send it by hand.`).catch(() => {});
      done.push({ id: e.id, result: 'missed' });
      continue;
    }
    putSchedule(db, e.id, { ...sch, state: 'sending', startedAt: new Date().toISOString() });
    try {
      const status = await sendCampaign(db, e.id, opts);
      putSchedule(db, e.id, { ...sch, state: 'sent' });
      await sendOwnerAlert(`[Scent World] Email sent: ${e.name}`, `<p>"${escapeHtml(e.name)}" went to ${status.sent} subscriber(s)${status.failed ? `, ${status.failed} failed` : ''}.</p>`,
        `"${e.name}" went to ${status.sent} subscriber(s)${status.failed ? `, ${status.failed} failed` : ''}.`).catch(() => {});
      done.push({ id: e.id, result: 'sent', ...status });
    } catch (err) {
      putSchedule(db, e.id, { ...sch, state: 'error', error: err.message });
      done.push({ id: e.id, result: 'error', error: err.message });
    }
  }
  return done;
}
let timer = null;
function scheduleCampaignEmails(db, everyMs = 5 * 60 * 1000) {
  if (process.env.NODE_ENV === 'test' || timer) return;
  timer = setInterval(() => { runDue(db).catch(err => console.error('Scheduled campaign email error:', err.message)); }, everyMs);
  timer.unref();
}

function listCampaignEmails(db) {
  const recipients = activeSubscribers(db).length;
  return CAMPAIGN_EMAILS.map(e => ({ id: e.id, name: e.name, subject: e.subject, sendOn: e.sendOn, sendHour: SEND_HOUR, recipients, status: campaignStatus(db, e.id), schedule: getSchedule(db, e.id) }));
}

// One email to one address (the admin "send a test to me" button, and each
// subscriber in a real send). Returns true if Resend accepted it.
function sendOne(db, id, sub, to) {
  const m = renderCampaignEmail(db, id, sub);
  return resendEmail(to, m.subject, m.html, m.text, sub ? {
    headers: { 'List-Unsubscribe': `<${m.unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  } : {});
}

// Sends a campaign to every active subscriber, once. Throttled to stay under
// Resend's rate limit; progress is saved so the admin can show it.
async function sendCampaign(db, id, { delayMs = 600 } = {}) {
  if (!CAMPAIGN_EMAILS.some(e => e.id === id)) throw new Error('Unknown campaign email');
  if (campaignStatus(db, id)) throw new Error('This campaign email has already been sent');
  const subs = activeSubscribers(db);
  const status = { startedAt: new Date().toISOString(), total: subs.length, sent: 0, failed: 0, finishedAt: null };
  const save = () => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(sentKey(id), JSON.stringify(status));
  save(); // claimed before the first send, so a second click can't start a duplicate run
  for (const sub of subs) {
    // unsubscribed while the run was going? skip
    const still = db.prepare("SELECT 1 FROM subscribers WHERE id = ? AND status = 'active'").get(sub.id);
    if (!still) continue;
    const ok = await sendOne(db, id, sub, sub.email).catch(() => false);
    if (ok) status.sent++; else status.failed++;
    save();
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  status.finishedAt = new Date().toISOString();
  save();
  return status;
}

module.exports = { CAMPAIGN_EMAILS, renderCampaignEmail, listCampaignEmails, sendOne, sendCampaign, unsubscribe, unsubUrl, campaignStatus, schedule, cancelSchedule, getSchedule, runDue, scheduleCampaignEmails };
