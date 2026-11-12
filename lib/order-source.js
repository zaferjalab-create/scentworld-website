// Where did an order come from? (website, Facebook, Instagram, Google, a Stripe in-person sale...)
//
// Website orders: the first page a visitor opens is looked at once. If they arrived from Facebook,
// Instagram, Google (search or ads), TikTok, LinkedIn, one of our emails or another site, that is
// remembered in a small first-party cookie (30 days, last click wins). When they pay, checkout copies
// it into the Stripe session, and the order records it. Visitors who type the address or use a
// bookmark leave the remembered source alone, and a visit with no clue is simply "website".
//
// In-person sales: card-reader payments taken in the Stripe app never touch the website, so they are
// pulled from Stripe and saved as orders with source 'in_person' (importInPersonSales).

const COOKIE = 'sw_src';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const LABELS = {
  website: 'Website',
  facebook: 'Facebook',
  instagram: 'Instagram',
  google: 'Google search',
  google_ads: 'Google Ads',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  email: 'Email',
  other: 'Other site',
  in_person: 'In person (Stripe)',
};
const label = key => LABELS[key] || LABELS.website;

const hostOf = ref => { try { return new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } };
const isHost = (h, ...names) => names.some(n => h === n || h.endsWith('.' + n));

// -> { source, detail } or null when the visit gives no clue (direct visit, our own pages)
function classify({ query = {}, referer = '', userAgent = '', siteHost = '' } = {}) {
  const q = k => String(query[k] == null ? '' : query[k]).toLowerCase().slice(0, 60);
  const ua = String(userAgent || '');
  const refHost = hostOf(referer);
  const fromInstagram = /Instagram/i.test(ua) || isHost(refHost, 'instagram.com');
  const fromFacebook = /FBAN|FBAV|FB_IAB/.test(ua) || isHost(refHost, 'facebook.com', 'fb.com', 'fb.me', 'messenger.com');

  const utm = q('utm_source');
  if (utm) {
    const medium = q('utm_medium'), campaign = String(query.utm_campaign || '').slice(0, 40);
    const d = [medium, campaign].filter(Boolean).join(' / ');
    if (/^(ig|instagram)/.test(utm)) return { source: 'instagram', detail: d };
    if (/^(fb|facebook|meta)/.test(utm)) return { source: fromInstagram ? 'instagram' : 'facebook', detail: d };
    if (utm.startsWith('google')) return { source: /cpc|ppc|paid|ads/.test(medium) ? 'google_ads' : 'google', detail: d };
    if (utm.startsWith('tiktok')) return { source: 'tiktok', detail: d };
    if (utm.startsWith('linkedin')) return { source: 'linkedin', detail: d };
    if (/mail|newsletter|resend|campaign/.test(utm) || medium === 'email') return { source: 'email', detail: d || utm };
    return { source: 'other', detail: utm };
  }
  if (query.gclid || query.gbraid || query.wbraid) return { source: 'google_ads', detail: '' };
  if (fromInstagram) return { source: 'instagram', detail: '' };
  if (fromFacebook || query.fbclid) return { source: 'facebook', detail: '' };
  if (!refHost) return null;
  if (siteHost && (refHost === siteHost || refHost === siteHost.replace(/^www\./, ''))) return null;
  if (refHost.endsWith('scentworld.ca') || /^(localhost|127\.)/.test(refHost)) return null;
  if (/(^|\.)google\.[a-z.]+$/.test(refHost)) return { source: 'google', detail: '' };
  if (isHost(refHost, 'tiktok.com')) return { source: 'tiktok', detail: '' };
  if (isHost(refHost, 'linkedin.com', 'lnkd.in')) return { source: 'linkedin', detail: '' };
  return { source: 'other', detail: refHost.slice(0, 60) };
}

function readCookie(req) {
  const m = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!m) return null;
  let v = '';
  try { v = decodeURIComponent(m.slice(COOKIE.length + 1)); } catch (e) { return null; }
  const [source, ...rest] = v.split('|');
  if (!LABELS[source] || source === 'in_person') return null;
  return { source, detail: rest.join('|').slice(0, 80) };
}

// Express middleware: only real page views (not API calls, images or the admin area) can set the cookie.
function trackSource(adminBase) {
  return (req, res, next) => {
    try {
      if (req.method === 'GET' && !req.path.startsWith('/api/') && !(adminBase && req.path.startsWith(adminBase)) && /text\/html/.test(req.headers.accept || '')) {
        const hit = classify({ query: req.query, referer: req.get('referer'), userAgent: req.get('user-agent'), siteHost: req.hostname });
        if (hit) {
          res.cookie(COOKIE, hit.source + '|' + hit.detail, { maxAge: MAX_AGE_MS, httpOnly: true, sameSite: 'lax', secure: req.secure });
        }
      }
    } catch (e) { /* tracking must never break a page */ }
    next();
  };
}

// What checkout stores on the Stripe session: { source, source_detail }
function sourceForCheckout(req) {
  const c = readCookie(req);
  return c ? { source: c.source, source_detail: c.detail || '' } : { source: 'website', source_detail: '' };
}

// Pull card-reader (in-person) payments from Stripe into the orders table. Safe to repeat: a payment
// that is already saved is skipped. Website checkouts are ignored (they are card-not-present).
const IN_PERSON_TYPES = ['card_present', 'interac_present'];
async function importInPersonSales(stripe, db, { days = 30, maxPages = 5 } = {}) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const have = db.prepare('SELECT 1 FROM orders WHERE stripe_payment_intent = ?');
  const insert = db.prepare(`INSERT INTO orders (order_number, customer_name, customer_email, shipping_country, subtotal, tax, shipping_cost, total,
      stripe_payment_intent, payment_status, status, source, notes, created_at)
    VALUES (?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?, 'in_person', ?, datetime(?, 'unixepoch'))`);
  let imported = 0, seen = 0, startingAfter;
  for (let page = 0; page < maxPages; page++) {
    const list = await stripe.paymentIntents.list({ created: { gte: since }, limit: 100, expand: ['data.latest_charge'], ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const pi of list.data) {
      seen++;
      const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      if (pi.status !== 'succeeded' || !ch || !IN_PERSON_TYPES.includes(ch.payment_method_details && ch.payment_method_details.type)) continue;
      if (have.get(pi.id)) continue;
      const total = (pi.amount_received || pi.amount || 0) / 100;
      const refunded = !!ch.refunded;
      const bd = ch.billing_details || {};
      insert.run('IP-' + pi.id.slice(-8).toUpperCase(), bd.name || 'In-person customer', null, total, total, pi.id,
        refunded ? 'refunded' : 'paid', refunded ? 'refunded' : 'delivered', pi.description || null, pi.created);
      imported++;
    }
    if (!list.has_more || !list.data.length) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return { imported, seen };
}

module.exports = { LABELS, label, classify, readCookie, trackSource, sourceForCheckout, importInPersonSales };
