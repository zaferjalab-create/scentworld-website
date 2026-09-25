// Public product feed for Google Merchant Center / Meta catalog.
const express = require('express');
const db = require('../database');
const { shippingRules, shippingCost } = require('../lib/shipping');
const router = express.Router();

// Meta/Google product catalog feed (CSV format)
router.get('/catalog.csv', (req, res) => {
  try {
    const rules = shippingRules();
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order').all();
    const BASE = 'https://www.scentworld.ca';
    const csvHeader = [
      'id', 'title', 'description', 'availability', 'condition', 'price', 'link',
      'image_link', 'brand', 'google_product_category', 'product_type', 'sale_price',
      'inventory', 'gtin', 'mpn', 'shipping', 'currency',
      // Size variants of one product share item_group_id so Google Shopping
      // groups them (100/200/500 ml) instead of listing unrelated items.
      'item_group_id', 'size'
    ].join(',');
    const rows = [csvHeader];

    for (const p of products) {
      // For products with sizes, output one row per size
      let variants = [{label: null, price: p.price}];
      if (p.sizes) {
        try {
          const sizes = typeof p.sizes === 'string' ? JSON.parse(p.sizes) : p.sizes;
          if (Array.isArray(sizes) && sizes.length) variants = sizes.map(s => ({label: s.label, price: s.price}));
        } catch (e) {}
      }
      for (const v of variants) {
        const id = v.label ? `${p.slug}-${v.label}` : p.slug;
        const title = (v.label ? `${p.name} (${v.label})` : p.name).replace(/"/g, '""');
        const desc = (p.short_desc || p.name).replace(/"/g, '""').replace(/\n/g, ' ');
        const link = `${BASE}/products/${p.slug}`;
        const img = p.image_url ? (p.image_url.startsWith('http') ? p.image_url : `${BASE}${p.image_url}`) : `${BASE}/images/logo.png`;
        const price = `${(v.price || p.price || 0).toFixed(2)} CAD`;
        const category = p.category === 'oils' ? 'Health & Beauty > Personal Care > Fragrance' :
                         p.category === 'diffusers' ? 'Home & Garden > Decor > Home Fragrance Accessories > Fragrance Oil Diffusers' :
                         'Home & Garden > Decor > Home Fragrance';
        const row = [
          `"${id}"`,
          `"${title}"`,
          `"${desc}"`,
          'in stock',
          'new',
          `"${price}"`,
          `"${link}"`,
          `"${img}"`,
          '"Scent World Canada"',
          `"${category}"`,
          `"${p.category}"`,
          '', // sale_price
          '100', // inventory
          '', // gtin
          `"${id}"`, // mpn
          `"CA::Standard:${shippingCost(v.price || p.price || 0, rules).toFixed(2)} CAD"`,
          'CAD',
          v.label ? `"${p.slug}"` : '',
          v.label ? `"${String(v.label).replace(/"/g, '""')}"` : ''
        ];
        rows.push(row.join(','));
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(rows.join('\n'));
  } catch (err) {
    console.error('catalog.csv error:', err);
    res.status(500).send('Error generating catalog');
  }
});

module.exports = router;
