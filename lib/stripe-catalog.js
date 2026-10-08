// Keeps a short list of quick-sale items in the Stripe product catalogue for
// the in-person point-of-sale app (which reads the Stripe catalogue):
//
//   Oil 100 ml / Oil 200 ml / Oil 500 ml   one item per bottle size — at a
//                                          stall "it's just oil", the owner
//                                          doesn't want to search 29 scents
//   Gift Oil Set                           CA$99
//
// Oil prices follow the website: each size uses the price most oils on sale
// carry for it (so a site-wide price change flows through on the next sync).
// Names only, no descriptions — that is how the owner wants them listed.
//
// Idempotent. Every product this module owns has an id starting "sw-"; any
// other active "sw-" product (e.g. the earlier one-product-per-oil layout) is
// archived, never deleted. Products the owner made by hand in the dashboard
// have Stripe-generated ids and are never touched. A changed price gets a new
// Stripe price (prices are immutable) and the old one is archived.
//
// Stripe lists products newest-first, so items are created last-to-first and
// the list then reads in the order below.
const PREFIX = 'sw-';
const TAX_CODE = 'txcd_99999999'; // General - Tangible Goods (same as the hand-made products)
const GIFT_SET_PRICE = 99;

// The usual price for each bottle size among the oils on sale.
function standardOilPrices(db) {
  const counts = {}; // label -> price -> how many oils
  const rows = db.prepare("SELECT sizes FROM products WHERE category = 'oils' AND active = 1").all();
  for (const { sizes } of rows) {
    let list = [];
    try { list = JSON.parse(sizes || '[]') || []; } catch (e) { /* skip */ }
    for (const s of list) {
      if (!s || !s.label || !(s.price > 0)) continue;
      (counts[s.label] = counts[s.label] || {})[s.price] = (counts[s.label][s.price] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([label, prices]) => ({ label, price: Number(Object.entries(prices).sort((a, b) => b[1] - a[1])[0][0]) }))
    .sort((a, b) => parseInt(a.label, 10) - parseInt(b.label, 10));
}

function catalogueItems(db, baseUrl) {
  const oilImage = `${baseUrl}/images/products/oil-main.png`;
  const items = standardOilPrices(db).map(({ label, price }) => {
    const ml = parseInt(label, 10);
    return { id: `${PREFIX}oil-${ml}ml`, name: `Oil ${ml} ml`, price, images: [oilImage] };
  });
  items.push({ id: `${PREFIX}gift-oil-set`, name: 'Gift Oil Set', price: GIFT_SET_PRICE, images: [] });
  return items;
}

async function syncStripeCatalogue(stripe, db, baseUrl) {
  const items = catalogueItems(db, baseUrl);
  const wanted = new Set(items.map(i => i.id));
  const out = { items: items.map(i => `${i.name} $${i.price}`), productsCreated: 0, productsUpdated: 0, pricesCreated: 0, pricesArchived: 0, productsArchived: 0 };

  for (const item of [...items].reverse()) {
    let product = null;
    try {
      product = await stripe.products.retrieve(item.id);
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
    }
    const fields = { name: item.name, tax_code: TAX_CODE, metadata: { source: 'scentworld-website' } };
    if (item.images.length) fields.images = item.images;
    if (!product) {
      product = await stripe.products.create({ id: item.id, ...fields });
      out.productsCreated++;
    } else if (!product.active || product.name !== item.name || product.description) {
      product = await stripe.products.update(item.id, { ...fields, description: '', active: true });
      out.productsUpdated++;
    }

    const amount = Math.round(item.price * 100);
    const existing = (await stripe.prices.list({ product: item.id, active: true, limit: 100 })).data;
    let price = existing.find(x => x.unit_amount === amount && x.currency === 'cad');
    if (!price) {
      price = await stripe.prices.create({ product: item.id, currency: 'cad', unit_amount: amount, tax_behavior: 'exclusive' });
      out.pricesCreated++;
    }
    const currentDefault = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
    if (currentDefault !== price.id) await stripe.products.update(item.id, { default_price: price.id });
    for (const old of existing) {
      if (old.id === price.id) continue;
      await stripe.prices.update(old.id, { active: false });
      out.pricesArchived++;
    }
  }

  // Archive anything else of ours that is still active (older layouts).
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.id.startsWith(PREFIX) && !wanted.has(product.id)) {
      await stripe.products.update(product.id, { active: false });
      out.productsArchived++;
    }
  }
  return out;
}

module.exports = { syncStripeCatalogue, catalogueItems };
