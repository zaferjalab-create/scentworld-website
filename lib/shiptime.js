// ShipTime shipping: quote rates, buy a label and follow the parcel for a paid order.
//
// The owner presses the button in admin (Orders -> Details -> Shipping): nothing
// here buys a shipment by itself, because creating a shipment charges the
// ShipTime account. Docs: https://restapi.shiptime.com/v2/api-docs
//
// Credentials live only in the environment (never in the repo or the database):
//   SHIPTIME_CLIENT_ID, SHIPTIME_CLIENT_SECRET   production (OAuth client credentials)
//   SHIPTIME_API_URL                              default https://restapi.shiptime.com
//   SHIPTIME_BASIC_USER, SHIPTIME_BASIC_PASSWORD  sandbox only (Basic auth), with SHIPTIME_API_URL
//   SHIPTIME_FROM_NAME                            contact name printed on the label (default "Shipping")
//
// Amounts from ShipTime are in cents. Dates are yyyy-MM-dd.
const API_URL = () => (process.env.SHIPTIME_API_URL || 'https://restapi.shiptime.com').replace(/\/+$/, '');
const TZ = 'America/Halifax';

const configured = () => !!((process.env.SHIPTIME_CLIENT_ID && process.env.SHIPTIME_CLIENT_SECRET) ||
  (process.env.SHIPTIME_BASIC_USER && process.env.SHIPTIME_BASIC_PASSWORD));
const mode = () => (process.env.SHIPTIME_BASIC_USER ? 'sandbox' : 'live');

// ── authentication: production tokens last one hour and have no refresh token ──
let cached = null; // { token, exp }
async function authHeader(force = false) {
  if (process.env.SHIPTIME_BASIC_USER) {
    return 'Basic ' + Buffer.from(`${process.env.SHIPTIME_BASIC_USER}:${process.env.SHIPTIME_BASIC_PASSWORD || ''}`).toString('base64');
  }
  if (!force && cached && cached.exp > Date.now() + 60000) return 'Bearer ' + cached.token;
  const res = await fetch(API_URL() + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHIPTIME_CLIENT_ID || '',
      client_secret: process.env.SHIPTIME_CLIENT_SECRET || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`ShipTime sign-in failed (${res.status}). Check the Client ID and Secret in Railway.`);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return 'Bearer ' + cached.token;
}

async function call(method, path, body, { raw = false } = {}) {
  if (!configured()) throw new Error('ShipTime is not connected yet.');
  const go = async force => fetch(API_URL() + path, {
    method,
    headers: { Authorization: await authHeader(force), Accept: raw ? '*/*' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let res = await go(false);
  if (res.status === 401 && !process.env.SHIPTIME_BASIC_USER) res = await go(true); // token expired early: sign in again once
  if (raw) {
    if (!res.ok) throw new Error(`ShipTime answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = [data.message, ...(data.messages || []), data.error].filter(Boolean).join(' · ');
    throw new Error(`ShipTime: ${why || 'request failed (' + res.status + ')'}`);
  }
  return data;
}

// ── ship-from (the warehouse) ──
function shipFrom() {
  return {
    attention: process.env.SHIPTIME_FROM_NAME || 'Shipping',
    companyName: 'Scent World Canada',
    streetAddress: '6254 Almon Street',
    city: 'Halifax', state: 'NS', postalCode: 'B3L1V2', countryCode: 'CA',
    phone: '9027070807', email: 'hello@scentworld.ca',
    residential: false, notify: false,
  };
}

// ── packages ──
// Oils ship in a 10 x 5 x 7 in box at 2 lb (one box per bottle). Other products
// have no box saved yet, so the admin types the box in; that is deliberate
// rather than guessing a size and being billed a surcharge.
const OIL_BOX = { length: 10, width: 5, height: 7, weight: 2 };
function defaultPackages(items) {
  const packages = [];
  let unknown = [];
  for (const i of items) {
    if (i.product_category === 'oils') {
      for (let n = 0; n < Math.max(1, Number(i.quantity) || 1); n++) packages.push({ ...OIL_BOX, description: 'Fragrance oil' });
    } else unknown.push(i.product_name);
  }
  return { packages, needBox: unknown };
}

const PROVINCES = { 'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'MANITOBA': 'MB', 'NEW BRUNSWICK': 'NB', 'NEWFOUNDLAND AND LABRADOR': 'NL', 'NEWFOUNDLAND': 'NL',
  'NORTHWEST TERRITORIES': 'NT', 'NOVA SCOTIA': 'NS', 'NUNAVUT': 'NU', 'ONTARIO': 'ON', 'PRINCE EDWARD ISLAND': 'PE', 'QUEBEC': 'QC', 'QUÉBEC': 'QC',
  'SASKATCHEWAN': 'SK', 'YUKON': 'YT' };
const provinceCode = p => { const s = String(p || '').trim(); return s.length <= 3 ? s.toUpperCase() : (PROVINCES[s.toUpperCase()] || s); };

function shipTo(o) {
  return {
    attention: o.customer_name || 'Customer',
    companyName: o.customer_name || 'Customer',
    streetAddress: o.shipping_line1 || '',
    ...(o.shipping_line2 ? { streetAddress2: o.shipping_line2 } : {}),
    city: o.shipping_city || '', state: provinceCode(o.shipping_province),
    postalCode: String(o.shipping_postal || '').replace(/\s+/g, '').toUpperCase(),
    countryCode: o.shipping_country || 'CA',
    phone: String(o.customer_phone || '9027070807').replace(/[^\d+]/g, ''),
    ...(o.customer_email ? { email: o.customer_email } : {}),
    residential: true, notify: false,
  };
}

// First weekday on or after today, Halifax time (yyyy-MM-dd).
function nextShipDate(now = new Date()) {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now) + 'T12:00:00Z');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function cleanPackages(list) {
  const out = (Array.isArray(list) ? list : []).map(p => ({
    length: Number(p.length), width: Number(p.width), height: Number(p.height), weight: Number(p.weight),
    description: String(p.description || 'Scent World order').slice(0, 60),
  }));
  if (!out.length || out.length > 20) throw new Error('Add at least one box (up to 20).');
  for (const p of out) {
    if (![p.length, p.width, p.height, p.weight].every(n => Number.isFinite(n) && n > 0 && n < 500)) throw new Error('Each box needs a length, width, height and weight above zero.');
  }
  return out;
}

function rateRequest(order, packages, shipDate) {
  if ((order.shipping_country || 'CA') !== 'CA') {
    throw new Error('Orders outside Canada need a customs invoice. Create these in ShipTime directly, then use "Add tracking by hand" here.');
  }
  return {
    from: shipFrom(), to: shipTo(order),
    packageType: 'PACKAGE', unitOfMeasurement: 'IMPERIAL',
    shipDate: shipDate || nextShipDate(),
    lineItems: cleanPackages(packages),
    serviceOptions: [],
  };
}

const dollars = m => (m && Number.isFinite(m.amount) ? m.amount / 100 : null);

async function getRates(order, packages, shipDate) {
  const data = await call('POST', '/rest/rates', rateRequest(order, packages, shipDate));
  const rates = (data.availableRates || []).map(r => ({
    quoteId: r.quoteId, serviceId: r.serviceId, carrierId: r.carrierId,
    carrier: r.carrierName, service: r.serviceName,
    total: dollars(r.totalCharge), beforeTax: dollars(r.totalBeforeTaxes),
    transitDays: r.transitDays, transitDaysMax: r.transitDaysMax,
  })).sort((a, b) => (a.total ?? 1e9) - (b.total ?? 1e9));
  return { rates, messages: data.messages || [] };
}

// Buys the shipment (charges the ShipTime account) for the chosen quote.
async function createShipment(order, packages, shipDate, choice) {
  const req = rateRequest(order, packages, shipDate);
  const data = await call('POST', '/rest/shipments', {
    carrierId: choice.carrierId, serviceId: choice.serviceId, quoteId: choice.quoteId,
    rateRequest: req, ref1: order.order_number,
  });
  if (!data.shipId) throw new Error('ShipTime did not return a shipment number: ' + (data.messages || []).join(' · '));
  return {
    shipId: data.shipId, tracking: (data.trackingNumbers || [])[0] || null,
    trackingUrl: data.carrierTrackingUrl || null, messages: data.messages || [],
  };
}

const label = shipId => call('GET', `/rest/shipments/${encodeURIComponent(shipId)}/label`, null, { raw: true });
const track = shipId => call('GET', `/rest/track/${encodeURIComponent(shipId)}`);
const shipmentDetail = shipId => call('GET', `/rest/shipments/${encodeURIComponent(shipId)}`);

// Brings open shipments up to date; a delivered parcel marks the order delivered.
async function refreshOpenShipments(db) {
  if (!configured()) return { checked: 0, delivered: 0 };
  const open = db.prepare(`SELECT id, shiptime_ship_id FROM orders WHERE shiptime_ship_id > 0
    AND COALESCE(shipment_status, '') NOT IN ('DELIVERED', 'CANCELLED') ORDER BY id DESC LIMIT 100`).all();
  let delivered = 0;
  for (const o of open) {
    try {
      const t = await track(o.shiptime_ship_id);
      const st = t.trackingRecord && t.trackingRecord.currentStatus;
      if (!st) continue;
      db.prepare('UPDATE orders SET shipment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(st, o.id);
      if (st === 'DELIVERED') { db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ? AND status = 'shipped'").run(o.id); delivered++; }
    } catch (err) { console.error('ShipTime refresh', o.id, err.message); }
  }
  return { checked: open.length, delivered };
}

function scheduleShipmentRefresh(db, everyMs = 60 * 60 * 1000) {
  if (process.env.NODE_ENV === 'test') return;
  setInterval(() => { refreshOpenShipments(db).catch(err => console.error('ShipTime refresh error:', err.message)); }, everyMs).unref();
}

module.exports = { configured, mode, getRates, createShipment, label, track, shipmentDetail, refreshOpenShipments, scheduleShipmentRefresh,
  defaultPackages, cleanPackages, nextShipDate, shipFrom, shipTo, provinceCode, OIL_BOX };
