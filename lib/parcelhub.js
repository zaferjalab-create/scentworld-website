// ParcelHub shipping (a second option beside ShipTime): quote, buy a label, follow the parcel.
// Used through lib/carriers.js. Docs: https://docs.parcelhub.ca/api (spec: https://docs.parcelhub.ca/openapi.json)
//
// Buying a label charges the ParcelHub wallet, so it only happens from the admin
// button, once per order (the order is claimed first, and the purchase carries an
// Idempotency-Key so a retry can never buy a second label).
//
// Credentials live only in the environment:
//   PARCELHUB_CLIENT_ID, PARCELHUB_CLIENT_SECRET   an API key with Full access (Account -> API keys)
//   PARCELHUB_API_URL                              default https://api.parcelhub.ca
// Amounts are in cents. Rates are before tax; the charged price includes tax.
const shiptime = require('./shiptime'); // shared parcel rules: ship-from, box defaults, address clean-up

const API_URL = () => (process.env.PARCELHUB_API_URL || 'https://api.parcelhub.ca').replace(/\/+$/, '');
const env = k => String(process.env[k] || '').trim();
const configured = () => !!(env('PARCELHUB_CLIENT_ID') && env('PARCELHUB_CLIENT_SECRET'));
const mode = () => 'live';

// ── sign-in: the key is exchanged for a token that lasts about 15 minutes ──
let cached = null; // { token, exp }
const reason = data => (data && data.error && (data.error.message || data.error.code)) || (data && data.message) || '';

async function token(force = false) {
  if (!force && cached && cached.exp > Date.now() + 30000) return cached.token;
  const res = await fetch(API_URL() + '/v1/api-clients/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env('PARCELHUB_CLIENT_ID'), client_secret: env('PARCELHUB_CLIENT_SECRET') }),
  });
  const data = await res.json().catch(() => ({}));
  const t = data && data.data && data.data.access_token;
  if (!res.ok || !t) {
    throw new Error(`ParcelHub sign-in failed (${res.status}${reason(data) ? ': ' + reason(data) : ''}). Check the Client ID and Secret in Railway.`);
  }
  const exp = Date.parse(data.data.expires_at);
  cached = { token: t, exp: Number.isFinite(exp) ? exp : Date.now() + 10 * 60 * 1000 };
  return t;
}

async function call(method, path, body, headers = {}) {
  if (!configured()) throw new Error('ParcelHub is not connected yet.');
  const go = async force => fetch(API_URL() + path, {
    method,
    headers: { Authorization: 'Bearer ' + await token(force), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let res = await go(false);
  if (res.status === 401) res = await go(true); // token expired early: sign in again once
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const why = reason(data);
    const wallet = res.status === 409 && /insufficient_funds/.test(why) ? 'Your ParcelHub wallet does not cover this label. Top it up in ParcelHub and try again.' : '';
    throw new Error(`ParcelHub: ${wallet || why || 'request failed (' + res.status + ')'}`);
  }
  return data.data;
}

async function checkConnection() {
  const id = env('PARCELHUB_CLIENT_ID'), secret = env('PARCELHUB_CLIENT_SECRET');
  const raw = k => String(process.env[k] || '');
  const info = { configured: configured(), mode: mode(), clientIdLength: id.length, secretLength: secret.length,
    spaceInClientId: raw('PARCELHUB_CLIENT_ID') !== id || /\s/.test(id), spaceInSecret: raw('PARCELHUB_CLIENT_SECRET') !== secret || /\s/.test(secret) };
  if (!info.configured) return { ...info, ok: false, error: 'PARCELHUB_CLIENT_ID and PARCELHUB_CLIENT_SECRET are not both set in Railway.' };
  try { cached = null; await token(true); return { ...info, ok: true }; } catch (err) { return { ...info, ok: false, error: err.message }; }
}

// ── request shapes ──
const postal = p => { const s = String(p || '').replace(/\s+/g, '').toUpperCase(); return /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : s; };
function address(a) {
  return {
    name: a.attention || a.companyName || 'Customer',
    ...(a.companyName && a.companyName !== a.attention ? { company: a.companyName } : {}),
    street: a.streetAddress, ...(a.streetAddress2 ? { line2: a.streetAddress2 } : {}),
    city: a.city, state: a.state, postal_code: postal(a.postalCode), country: a.countryCode,
    ...(a.phone ? { phone: a.phone } : {}), ...(a.email ? { email: a.email } : {}),
    is_residential: !!a.residential,
  };
}
const pkgs = list => shiptime.cleanPackages(list).map(p => ({
  length: p.length, width: p.width, height: p.height, weight: p.weight, dimension_unit: 'in', weight_unit: 'lb',
}));
function parties(order) {
  if ((order.shipping_country || 'CA') !== 'CA') {
    throw new Error('Orders outside Canada need a customs declaration. Create these in ParcelHub directly, then use "Add tracking by hand" here.');
  }
  return { from: address(shiptime.shipFrom()), to: address(shiptime.shipTo(order)) };
}

// Where a customer can follow the parcel, for the carriers ParcelHub resells (best effort; none if unknown).
const TRACK_URLS = {
  canada_post: n => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  purolator: n => `https://www.purolator.com/en/shipping/tracker?pin=${n}`,
  ups: n => `https://www.ups.com/track?tracknum=${n}`,
  fedex: n => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
};
const trackUrl = (carrier, number) => (TRACK_URLS[carrier] && number ? TRACK_URLS[carrier](encodeURIComponent(number)) : null);

async function getRates(order, packages, shipDate) {
  const body = { ...parties(order), packages: pkgs(packages), ship_date: shipDate || shiptime.nextShipDate() };
  const d = await call('POST', '/v1/rates', body);
  const rates = (d.items || []).map(r => ({
    quoteId: d.quote_id, serviceId: r.service_code, carrierId: r.carrier,
    carrier: r.carrier_display_name || r.carrier, service: r.service_name,
    total: Number.isFinite(r.amount_cents) ? r.amount_cents / 100 : null,
    beforeTax: Number.isFinite(r.amount_cents) ? r.amount_cents / 100 : null, taxExtra: true,
    transitDays: r.estimated_days != null ? r.estimated_days : null, transitDaysMax: null,
    dropOff: r.pickup_supported === false,
  })).sort((a, b) => (a.total ?? 1e9) - (b.total ?? 1e9));
  // Carriers that could not take this parcel (this is where dangerous-goods limits show up).
  const messages = (d.carriers_with_no_options || []).map(c => `${c.carrier_display_name || c.carrier}: ${c.reason}`);
  return { rates, messages };
}

// Buys the label (charges the wallet). `choice` is the rate the owner picked.
async function createShipment(order, packages, shipDate, choice) {
  const body = {
    carrier: choice.carrierId, service_code: choice.serviceId, service_name: choice.service || choice.serviceId,
    ...(choice.quoteId ? { quote_id: choice.quoteId } : {}),
    ...parties(order), packages: pkgs(packages),
    reference_number: order.order_number, email_notifications: false,
    ship_date: shipDate || shiptime.nextShipDate(),
  };
  const key = `sw-${order.order_number}-${choice.quoteId || 'q'}-${choice.serviceId}`.slice(0, 120);
  const s = await call('POST', '/v1/shipments', body, { 'Idempotency-Key': key });
  if (!s || !s.id) throw new Error('ParcelHub did not return a shipment number.');
  let tracking = s.tracking_number || null;
  if (!tracking) { try { tracking = (await call('GET', `/v1/shipments/${encodeURIComponent(s.id)}/label`)).tracking_number || null; } catch (err) { /* the number can arrive later */ } }
  return {
    shipId: s.id, tracking, trackingUrl: trackUrl(choice.carrierId, tracking), messages: [],
    cost: Number.isFinite(s.final_rate_cents) ? s.final_rate_cents / 100 : null,
  };
}

// The label comes as a short-lived link (about 15 minutes): fetch it now and hand back the file.
async function label(shipId) {
  const l = await call('GET', `/v1/shipments/${encodeURIComponent(shipId)}/label`);
  if (!l || !l.url) throw new Error('ParcelHub did not return a label link.');
  const target = new URL(l.url, API_URL());
  let res = await fetch(target);
  if ((res.status === 401 || res.status === 403) && target.origin === new URL(API_URL()).origin) {
    res = await fetch(target, { headers: { Authorization: 'Bearer ' + await token() } });
  }
  if (!res.ok) throw new Error(`ParcelHub label download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Newest event decides: delivered / in transit / label made. Wording on the events is the carrier's own.
function normalizeTracking(items) {
  const events = (items || []).map(e => ({
    name: e.event_description || e.event_code || '', code: e.event_code || '', location: e.location || '',
    time: e.occurred_at || '', stamp: Date.parse(e.occurred_at) || 0,
  })).sort((a, b) => a.stamp - b.stamp);
  const text = e => `${e.code} ${e.name}`;
  const delivered = events.some(e => /\bdelivered\b/i.test(text(e)) && !/(not|un|failed)\s*delivered|attempt/i.test(text(e)));
  const currentStatus = delivered ? 'DELIVERED' : events.length ? 'IN_TRANSIT' : 'MANIFESTED';
  return { currentStatus, history: events.map(e => ({ name: e.name, status: e.code, location: e.location, time: e.time })) };
}
const track = async shipId => normalizeTracking((await call('GET', `/v1/shipments/${encodeURIComponent(shipId)}/tracking`)).items);

module.exports = { configured, mode, checkConnection, getRates, createShipment, label, track, normalizeTracking, trackUrl };
