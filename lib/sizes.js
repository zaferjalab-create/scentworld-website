// Size variants (fragrance oils: 100 / 200 / 500 ml) live as JSON on
// products.sizes: [{ label, price, sold_out? }]. A sold-out size stays listed
// and is shown as "Sold out", but can't be added to the cart or checked out.
// Mark or clear it in admin -> Products -> Sizes ("sold_out": true).

function parseSizes(json) {
  try {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    return Array.isArray(s) && s.length ? s : null;
  } catch (e) { return null; }
}

const inStock = sizes => (sizes || []).filter(s => !s.sold_out);

// Listing view of a product (homepage, shop, related items): the cheapest size
// still in stock is the "from" price and what a one-click Add to Cart adds.
function withStock(p) {
  const sizes = parseSizes(p.sizes);
  if (!sizes) return p;
  const open = inStock(sizes);
  const pick = (open.length ? open : sizes).reduce((a, b) => (b.price < a.price ? b : a));
  return { ...p, price: pick.price, default_size: open.length ? pick.label : null, sold_out: !open.length };
}

module.exports = { parseSizes, inStock, withStock };
