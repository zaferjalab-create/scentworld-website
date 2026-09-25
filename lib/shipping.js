// Shipping rules, set by the owner in admin → Settings:
//   shipping_threshold  orders at or above this subtotal (CAD) ship free
//   shipping_flat_rate  flat CAD rate charged below the threshold
// With no rate set, everything ships free — the site's behaviour until the
// owner picks a rate. Used by checkout and by the Google/Meta product feed so
// the two always agree (Merchant Center disapproves mismatched shipping).
const db = require('../database');

function shippingRules() {
  const get = key => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) || {}).value;
  const threshold = parseFloat(get('shipping_threshold'));
  const rate = parseFloat(get('shipping_flat_rate'));
  return {
    threshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : 150,
    rate: Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : 0,
  };
}

// Shipping cost (CAD) for an order subtotal.
function shippingCost(subtotal, rules = shippingRules()) {
  if (!rules.rate || subtotal >= rules.threshold) return 0;
  return rules.rate;
}

// Stripe Checkout shipping option for an order subtotal.
function stripeShippingOption(subtotal, rules = shippingRules()) {
  const cost = shippingCost(subtotal, rules);
  return {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: Math.round(cost * 100), currency: 'cad' },
      display_name: cost ? 'Standard shipping' : 'Free shipping',
      // 1–2 business days processing + 3–8 in transit
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 4 },
        maximum: { unit: 'business_day', value: 10 },
      },
    },
  };
}

module.exports = { shippingRules, shippingCost, stripeShippingOption };
