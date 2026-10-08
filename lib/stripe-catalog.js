// Mirrors the fragrance oils on sale into the Stripe product catalogue, so the
// in-person point-of-sale app (which reads the Stripe catalogue) can sell them.
//
//   one Stripe product per oil      id  sw-oil-<slug>
//   one Stripe price per size       nickname = size label, tax-exclusive CAD
//
// Idempotent: products are looked up by id and prices by size + amount, so it
// can run any number of times. A changed price gets a new Stripe price (Stripe
// prices are immutable) and the old one is archived. Oils that left the range
// are archived, never deleted. Only ever touches sw-oil-* products — the
// diffusers the owner added by hand in the dashboard are left alone.
//
// Stripe lists products newest-first, so oils are created in reverse site
// order: the list then reads top-to-bottom in collection order.
const { COLLECTIONS } = require('./collections');

const PREFIX = 'sw-oil-';
const TAX_CODE = 'txcd_99999999'; // General - Tangible Goods (same as the hand-made products)

function oilSizes(p) {
  try {
    const s = JSON.parse(p.sizes || 'null');
    if (Array.isArray(s) && s.length) return s.filter(x => x && x.label && x.price > 0);
  } catch (e) { /* fall through */ }
  return p.price > 0 ? [{ label: 'Standard', price: p.price }] : [];
}

async function syncOilsToStripe(stripe, db, baseUrl) {
  const oils = db.prepare("SELECT * FROM products WHERE category = 'oils' AND active = 1 ORDER BY sort_order DESC, id DESC").all();
  const wanted = new Set(oils.map(p => PREFIX + p.slug));
  const out = { oils: oils.length, productsCreated: 0, productsUpdated: 0, pricesCreated: 0, pricesArchived: 0, productsArchived: 0 };

  for (const p of oils) {
    const id = PREFIX + p.slug;
    const collection = COLLECTIONS[p.collection] || '';
    const fields = {
      name: p.name,
      description: [collection, p.short_desc].filter(Boolean).join(' — ') || undefined,
      images: [`${baseUrl}/images/products/oil-main.png`],
      tax_code: TAX_CODE,
      metadata: { source: 'scentworld-website', slug: p.slug, collection },
    };

    let product = null;
    try {
      product = await stripe.products.retrieve(id);
    } catch (err) {
      if (err.code !== 'resource_missing') throw err;
    }
    if (!product) {
      product = await stripe.products.create({ id, ...fields });
      out.productsCreated++;
    } else if (!product.active || product.name !== fields.name || product.description !== fields.description) {
      product = await stripe.products.update(id, { ...fields, active: true });
      out.productsUpdated++;
    }

    const existing = (await stripe.prices.list({ product: id, active: true, limit: 100 })).data;
    const sizes = oilSizes(p);
    const keep = new Set();
    let firstPriceId = null;
    for (const size of sizes) {
      const amount = Math.round(size.price * 100);
      let price = existing.find(x => x.nickname === size.label && x.unit_amount === amount && x.currency === 'cad');
      if (!price) {
        price = await stripe.prices.create({
          product: id, currency: 'cad', unit_amount: amount, nickname: size.label,
          tax_behavior: 'exclusive', metadata: { size: size.label },
        });
        out.pricesCreated++;
      }
      keep.add(price.id);
      if (!firstPriceId) firstPriceId = price.id;
    }
    // The smallest size is the product's default (headline) price.
    const currentDefault = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
    if (firstPriceId && currentDefault !== firstPriceId) {
      await stripe.products.update(id, { default_price: firstPriceId });
    }
    for (const old of existing) {
      if (keep.has(old.id)) continue;
      await stripe.prices.update(old.id, { active: false });
      out.pricesArchived++;
    }
  }

  // Archive our own oil products that are no longer on sale.
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.id.startsWith(PREFIX) && !wanted.has(product.id)) {
      await stripe.products.update(product.id, { active: false });
      out.productsArchived++;
    }
  }
  return out;
}

module.exports = { syncOilsToStripe };
