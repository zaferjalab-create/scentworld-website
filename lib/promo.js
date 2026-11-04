// Holiday promotion calendar (owner-approved, November 4, 2026).
//
// One schedule drives every price a customer sees: product pages, listings,
// search, the cart, Stripe Checkout, the Google/Meta feed and the in-person
// Stripe catalogue (lib/stripe-catalog.js). Each campaign runs from 12:00 a.m.
// on its first day to 11:59 p.m. on its last day, Halifax time; between
// campaigns everything is at the regular price.
//
// While a campaign is on, the discount is applied automatically (no code), so
// Stripe promotion codes are switched off at checkout and the WELCOME10 popup
// is replaced by the campaign poster: offers can't be combined.
// Rentals and subscriptions are quoted by hand and are never on the website.
const TZ = 'America/Halifax';

const CAMPAIGNS = [
  {
    id: 'november', name: 'November Sale', start: '2026-11-04', end: '2026-11-09',
    percent: () => 25,
    bar: '25% off everything · November 4–9 · Discount applied automatically at checkout',
    poster: '/images/promo/november-sale.jpg',
    posterAlt: 'Scent World Canada November Sale: 25% off, November 4 to 9',
  },
  {
    id: 'black-friday', name: 'Black Friday to Cyber Monday', start: '2026-11-27', end: '2026-11-30',
    percent: () => 25,
    bar: 'Black Friday to Cyber Monday · 25% off everything · Ends November 30',
    poster: null, // add the Black Friday poster before Nov 27
    posterAlt: 'Scent World Canada Black Friday to Cyber Monday: 25% off, November 27 to 30',
  },
  {
    id: 'christmas', name: 'Christmas Gifting', start: '2026-12-01', end: '2026-12-24',
    // 20% off S100, S200, the car diffuser gift set and every fragrance oil;
    // 15% off S20, S30, S300 and the car diffuser.
    percent: p => (p.category === 'oils' || ['s100', 's200', 'car-gift-set'].includes(p.slug) ? 20 : 15),
    bar: 'Christmas Gifting · Up to 20% off · Until December 24',
    poster: null, // add the Christmas poster before Dec 1
    posterAlt: 'Scent World Canada Christmas Gifting: up to 20% off, December 1 to 24',
  },
];

// PROMO_NOW (tests only) pins the clock so campaign dates can be checked.
const clock = () => (process.env.PROMO_NOW ? new Date(process.env.PROMO_NOW) : new Date());

const halifaxDate = (now = clock()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

function activeCampaign(now = clock()) {
  const today = halifaxDate(now);
  return CAMPAIGNS.find(c => today >= c.start && today <= c.end) || null;
}

const salePrice = (price, percent) => Math.round(price * (100 - percent)) / 100;

// A product row as the customer should see it right now. During a campaign
// `price` and every size price are the sale price; the regular prices ride
// along as regular_price so pages can strike them through. `sizes` keeps its
// type (JSON string or array) so lib/sizes.js and the views work unchanged.
function promoProduct(p, now = clock()) {
  const c = activeCampaign(now);
  if (!p || !c) return p;
  const pct = c.percent(p);
  if (!(pct > 0)) return p;
  const out = { ...p, promo_pct: pct, promo_name: c.name };
  if (p.price > 0) { out.regular_price = p.price; out.price = salePrice(p.price, pct); }
  if (p.sizes) {
    let list = null;
    try { list = typeof p.sizes === 'string' ? JSON.parse(p.sizes) : p.sizes; } catch (e) { list = null; }
    if (Array.isArray(list)) {
      const sized = list.map(s => (s && s.price > 0 ? { ...s, regular_price: s.price, price: salePrice(s.price, pct) } : s));
      out.sizes = typeof p.sizes === 'string' ? JSON.stringify(sized) : sized;
    }
  }
  return out;
}

// Effective-date string for the product feed (ISO 8601 interval, Halifax offset).
function feedSaleDates(c) {
  const off = d => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${d}T12:00:00Z`)).find(x => x.type === 'timeZoneName').value; // "GMT-04:00"
    return parts.replace('GMT', '') || '+00:00';
  };
  return `${c.start}T00:00${off(c.start)}/${c.end}T23:59${off(c.end)}`;
}

module.exports = { clock, CAMPAIGNS, activeCampaign, promoProduct, salePrice, feedSaleDates, halifaxDate };
