// Shipping services behind the admin Orders -> Shipping screen: ShipTime and ParcelHub.
// Each one that has its credentials set in Railway is "connected"; rates are asked from
// every connected service at once and shown in one list, so the owner picks the cheapest
// (or the fastest) and buys that label. Buying always charges the chosen service's account
// and only happens from the admin button (see routes/admin.js).
const shiptime = require('./shiptime');
const parcelhub = require('./parcelhub');

const PROVIDERS = {
  shiptime: { id: 'shiptime', name: 'ShipTime', account: 'ShipTime account', mod: shiptime },
  parcelhub: { id: 'parcelhub', name: 'ParcelHub', account: 'ParcelHub wallet', mod: parcelhub },
};
const get = id => PROVIDERS[id] || null;

const list = () => Object.values(PROVIDERS).map(p => ({ id: p.id, name: p.name, account: p.account, connected: p.mod.configured(), mode: p.mod.mode() }));
const connected = () => Object.values(PROVIDERS).filter(p => p.mod.configured());

// Quotes from every connected service at once. One service failing does not hide the others.
async function getRates(order, packages, shipDate) {
  const active = connected();
  if (!active.length) throw new Error('No shipping service is connected yet. Add the ShipTime or ParcelHub credentials in Railway.');
  const results = await Promise.allSettled(active.map(p => p.mod.getRates(order, packages, shipDate)));
  const rates = [], messages = [], errors = [];
  results.forEach((r, i) => {
    const p = active[i];
    if (r.status === 'fulfilled') {
      for (const q of r.value.rates) rates.push({ ...q, provider: p.id, providerName: p.name });
      for (const m of r.value.messages || []) messages.push(`${p.name}: ${m}`);
    } else errors.push({ provider: p.id, message: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
  });
  if (!rates.length && errors.length === active.length) throw new Error(errors.map(e => e.message).join(' | '));
  // Compare like with like: price before tax (ParcelHub quotes before tax; ShipTime gives both).
  rates.sort((a, b) => (a.beforeTax ?? a.total ?? 1e9) - (b.beforeTax ?? b.total ?? 1e9));
  return { rates, messages, errors };
}

function provider(id) {
  const p = get(id);
  if (!p) throw new Error('Unknown shipping service.');
  if (!p.mod.configured()) throw new Error(`${p.name} is not connected.`);
  return p;
}

const createShipment = (id, order, packages, shipDate, choice) => provider(id).mod.createShipment(order, packages, shipDate, choice);

// The label file and its content type (PDF normally; images are passed through).
async function label(id, ref) {
  const buf = await provider(id).mod.label(ref);
  const head = buf.subarray(0, 8).toString('latin1');
  const type = head.startsWith('%PDF') ? 'application/pdf' : head.startsWith('\x89PNG') ? 'image/png' : head.startsWith('GIF8') ? 'image/gif' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'application/pdf';
  return { data: buf, type };
}

// Same shape from both services: { currentStatus, history: [{ name, status, location, time }] }
async function track(id, ref) {
  const p = provider(id);
  if (id === 'parcelhub') { const t = await p.mod.track(ref); return { currentStatus: t.currentStatus, history: t.history.slice().reverse() }; }
  const t = await p.mod.track(ref);
  const rec = t.trackingRecord || {};
  return { currentStatus: rec.currentStatus || null,
    history: (rec.history || []).slice().reverse().map(h => ({ name: h.name, status: h.status, location: h.location, time: h.timestamp || h.time })) };
}

// Brings open shipments up to date; a delivered parcel marks the order delivered.
async function refreshOpenShipments(db) {
  let checked = 0, delivered = 0;
  for (const p of connected()) {
    const open = db.prepare(`SELECT id, shipment_ref FROM orders WHERE shipping_provider = ? AND shipment_ref IS NOT NULL
      AND COALESCE(shipment_status, '') NOT IN ('DELIVERED', 'CANCELLED') ORDER BY id DESC LIMIT 100`).all(p.id);
    for (const o of open) {
      checked++;
      try {
        const t = await track(p.id, o.shipment_ref);
        if (!t.currentStatus) continue;
        db.prepare('UPDATE orders SET shipment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.currentStatus, o.id);
        if (t.currentStatus === 'DELIVERED') { db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ? AND status = 'shipped'").run(o.id); delivered++; }
      } catch (err) { console.error(`${p.name} refresh`, o.id, err.message); }
    }
  }
  return { checked, delivered };
}

function scheduleShipmentRefresh(db, everyMs = 60 * 60 * 1000) {
  if (process.env.NODE_ENV === 'test') return;
  setInterval(() => { refreshOpenShipments(db).catch(err => console.error('Shipment refresh error:', err.message)); }, everyMs).unref();
}

module.exports = { PROVIDERS, list, connected, getRates, createShipment, label, track, refreshOpenShipments, scheduleShipmentRefresh,
  defaultPackages: shiptime.defaultPackages, nextShipDate: shiptime.nextShipDate };
