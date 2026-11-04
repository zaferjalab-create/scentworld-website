// Public product feed for Google Merchant Center / Meta catalog.
const express = require('express');
const db = require('../database');
const { shippingRules, shippingCost } = require('../lib/shipping');
const { COLLECTIONS } = require('../lib/collections');
const { CAMPAIGNS, activeCampaign, salePrice, feedSaleDates, halifaxDate } = require('../lib/promo');
const router = express.Router();

// Meta/Google product catalog feed (CSV format)
router.get('/catalog.csv', (req, res) => {
  try {
    const rules = shippingRules();
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort_order').all();
    const BASE = 'https://www.scentworld.ca';
    // Running campaign, or the next one, with its effective dates: Google
    // switches the sale price on and off at the exact times by itself.
    const today = halifaxDate();
    const campaign = activeCampaign() || CAMPAIGNS.find(c => c.start > today) || null;
    const saleDates = campaign ? feedSaleDates(campaign) : '';
    const running = !!activeCampaign();
    const csvHeader = [
      'id', 'title', 'description', 'availability', 'condition', 'price', 'link',
      'image_link', 'brand', 'google_product_category', 'product_type', 'sale_price',
      'inventory', 'gtin', 'mpn', 'shipping', 'currency',
      // Size variants of one product share item_group_id so Google Shopping
      // groups them (100/200/500 ml) instead of listing unrelated items.
      'item_group_id', 'size', 'sale_price_effective_date'
    ].join(',');
    const rows = [csvHeader];

    for (const p of products) {
      // For products with sizes, output one row per size
      let variants = [{label: null, price: p.price}];
      if (p.sizes) {
        try {
          const sizes = typeof p.sizes === 'string' ? JSON.parse(p.sizes) : p.sizes;
          if (Array.isArray(sizes) && sizes.length) variants = sizes.map(s => ({label: s.label, price: s.price, soldOut: !!s.sold_out}));
        } catch (e) {}
      }
      for (const v of variants) {
        const id = v.label ? `${p.slug}-${v.label}` : p.slug;
        const title = (v.label ? `${p.name} (${v.label})` : p.name).replace(/"/g, '""');
        const desc = (p.short_desc || p.name).replace(/"/g, '""').replace(/\n/g, ' ');
        const link = `${BASE}/products/${p.slug}`;
        const img = p.image_url ? (p.image_url.startsWith('http') ? p.image_url : `${BASE}${p.image_url}`) : `${BASE}/images/logo.png`;
        const regular = v.price || p.price || 0;
        const price = `${regular.toFixed(2)} CAD`;
        const pct = campaign && regular > 0 ? campaign.percent(p) : 0;
        const sale = pct > 0 ? `"${salePrice(regular, pct).toFixed(2)} CAD"` : '';
        const category = p.category === 'oils' ? 'Health & Beauty > Personal Care > Fragrance' :
                         p.category === 'diffusers' ? 'Home & Garden > Decor > Home Fragrance Accessories > Fragrance Oil Diffusers' :
                         'Home & Garden > Decor > Home Fragrance';
        const row = [
          `"${id}"`,
          `"${title}"`,
          `"${desc}"`,
          v.soldOut ? 'out of stock' : 'in stock',
          'new',
          `"${price}"`,
          `"${link}"`,
          `"${img}"`,
          '"Scent World Canada"',
          `"${category}"`,
          `"${p.category}${COLLECTIONS[p.collection] ? ' > ' + COLLECTIONS[p.collection] : ''}"`,
          sale, // sale_price (campaign, lib/promo.js)
          v.soldOut ? '0' : '100', // inventory
          '', // gtin
          `"${id}"`, // mpn
          `"CA::Standard:${shippingCost(running && pct > 0 ? salePrice(regular, pct) : regular, rules).toFixed(2)} CAD"`,
          'CAD',
          v.label ? `"${p.slug}"` : '',
          v.label ? `"${String(v.label).replace(/"/g, '""')}"` : '',
          sale ? `"${saleDates}"` : ''
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
