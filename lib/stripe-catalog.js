// Keeps the Stripe product catalogue ready for the in-person point-of-sale app
// (which reads the Stripe catalogue). Two jobs:
//
// 1. Quick-sale items owned by this module (ids start "sw-"):
//      Oil 100 ml / Oil 200 ml / Oil 500 ml   one item per bottle size — at a
//                                             stall "it's just oil", the owner
//                                             doesn't want to search 29 scents
//      Gift Oil Set                           CA$99
//    Oil prices follow the website: each size uses the price most oils on sale
//    carry for it. Names only, no descriptions. Any other active "sw-" product
//    (older layouts) is archived, never deleted.
//
// 2. A scheduled percentage sale on EVERY active Stripe product, including the
//    ones the owner made by hand in the dashboard (settings sale_percent,
//    sale_start, sale_end — dates inclusive, Halifax time). While the sale is
//    on, each product's only active price is the discounted one, so the app
//    shows a single price and no coupon has to be applied at the till. When it
//    ends, the regular price is switched back on. Stripe prices are immutable,
//    so "changing" a price means: make/reactivate the wanted price, make it the
//    product's default, archive the other. Sale prices are tagged with metadata
//    (sw_sale, sw_regular) so the regular price can always be restored.
//
// Idempotent: safe to run any number of times. Hand-made products are only
// ever touched for the sale, and only their default one-time price.
const PREFIX = 'sw-';
const TAX_CODE = 'txcd_99999999'; // General - Tangible Goods (same as the hand-made products)
const GIFT_SET_PRICE = 99;
const TZ = 'America/Halifax';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The sale window from admin Settings. `state` changes exactly when Stripe
// needs updating, which is what the scheduler in server.js watches.
function saleSettings(db, now = new Date()) {
  const get = key => String((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value || '').trim();
  const percent = parseFloat(get('sale_percent'));
  const start = get('sale_start'), end = get('sale_end');
  const valid = percent > 0 && percent < 100 && DATE.test(start) && DATE.test(end) && start <= end;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const active = valid && today >= start && today <= end;
  return { percent: valid ? percent : 0, start, end, valid, active, state: active ? `sale:${percent}:${start}:${end}` : 'regular' };
}

const discounted = (cents, percent) => Math.round(cents * (100 - percent) / 100);
const idOf = x => (typeof x === 'string' ? x : x && x.id) || null;

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

async function syncStripeCatalogue(stripe, db, baseUrl, now = new Date()) {
  const sale = saleSettings(db, now);
  const items = catalogueItems(db, baseUrl);
  const wanted = new Set(items.map(i => i.id));
  const out = {
    sale: sale.active ? `${sale.percent}% off until ${sale.end}` : 'off',
    items: [], productsCreated: 0, productsUpdated: 0, pricesCreated: 0, pricesArchived: 0, productsArchived: 0,
    saleApplied: 0, saleRemoved: 0, skipped: [],
  };
  const allPrices = async product => (await stripe.prices.list({ product, limit: 100 })).data.filter(x => !x.type || x.type === 'one_time');
  const activate = async price => (price.active ? price : stripe.prices.update(price.id, { active: true }));

  // ── 1. our own quick-sale items ──
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

    const regular = Math.round(item.price * 100);
    const amount = sale.active ? discounted(regular, sale.percent) : regular;
    const existing = await allPrices(item.id);
    let price = existing.find(x => x.unit_amount === amount && x.currency === 'cad');
    if (price) {
      price = await activate(price);
    } else {
      price = await stripe.prices.create({
        product: item.id, currency: 'cad', unit_amount: amount, tax_behavior: 'exclusive',
        ...(sale.active ? { nickname: `Sale -${sale.percent}%`, metadata: { sw_sale: '1' } } : {}),
      });
      out.pricesCreated++;
    }
    if (idOf(product.default_price) !== price.id) await stripe.products.update(item.id, { default_price: price.id });
    for (const old of existing) {
      if (old.id === price.id || !old.active) continue;
      await stripe.prices.update(old.id, { active: false });
      out.pricesArchived++;
    }
    out.items.unshift(`${item.name} $${(amount / 100).toFixed(2)}`); // loop runs last-to-first
  }

  // ── 2. every other active product: archive our leftovers, apply/remove the sale ──
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.id.startsWith(PREFIX)) {
      if (!wanted.has(product.id)) {
        await stripe.products.update(product.id, { active: false });
        out.productsArchived++;
      }
      continue;
    }
    const prices = await allPrices(product.id);
    const live = prices.filter(x => x.active);
    const current = prices.find(x => x.id === idOf(product.default_price)) || (live.length === 1 ? live[0] : null);
    const onSale = !!(current && current.metadata && current.metadata.sw_sale === '1');
    const regular = onSale ? prices.find(x => x.id === current.metadata.sw_regular) : current;
    if (!current || !regular) {
      if (sale.active || onSale) out.skipped.push(product.name);
      continue;
    }

    if (sale.active) {
      const amount = discounted(regular.unit_amount, sale.percent);
      if (onSale && current.unit_amount === amount && current.active) continue; // already applied
      let salePrice = prices.find(x => x.metadata && x.metadata.sw_sale === '1' && x.metadata.sw_regular === regular.id && x.unit_amount === amount);
      if (salePrice) {
        salePrice = await activate(salePrice);
      } else {
        salePrice = await stripe.prices.create({
          product: product.id, currency: regular.currency, unit_amount: amount,
          ...(['exclusive', 'inclusive'].includes(regular.tax_behavior) ? { tax_behavior: regular.tax_behavior } : {}),
          nickname: `Sale -${sale.percent}%`, metadata: { sw_sale: '1', sw_regular: regular.id },
        });
      }
      await stripe.products.update(product.id, { default_price: salePrice.id });
      for (const old of new Map([[current.id, current], [regular.id, regular]]).values()) {
        if (old.id !== salePrice.id && old.active) await stripe.prices.update(old.id, { active: false });
      }
      out.saleApplied++;
    } else if (onSale) {
      await activate(regular);
      await stripe.products.update(product.id, { default_price: regular.id });
      await stripe.prices.update(current.id, { active: false });
      out.saleRemoved++;
    }
  }
  return out;
}

module.exports = { syncStripeCatalogue, catalogueItems, saleSettings };
