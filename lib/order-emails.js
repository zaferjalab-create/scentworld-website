// Order emails: the owner's packing notification and the customer's
// confirmation details. Built from the saved order + its items, so both always
// say exactly what the admin panel says.
const { resendEmail, escapeHtml } = require('./email');

const money = n => '$' + Number(n || 0).toFixed(2);
const COUNTRY = { CA: 'Canada', US: 'United States' };

function addressLines(o) {
  return [
    o.customer_name,
    o.shipping_line1,
    o.shipping_line2,
    [o.shipping_city, o.shipping_province, o.shipping_postal].filter(Boolean).join(' '),
    COUNTRY[o.shipping_country] || o.shipping_country,
  ].filter(Boolean);
}

function placedAt(o) {
  const d = o.created_at ? new Date(String(o.created_at).replace(' ', 'T') + (String(o.created_at).includes('Z') ? '' : 'Z')) : new Date();
  return d.toLocaleString('en-CA', { timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' });
}

function stripeLink(o) {
  return o.stripe_payment_intent ? `https://dashboard.stripe.com/payments/${o.stripe_payment_intent}` : null;
}

// Plain-text version (also used in tests).
function ownerOrderText(o, items) {
  const lines = [
    `NEW ORDER ${o.order_number} — ${placedAt(o)}`,
    '',
    'TO PACK',
    ...(items.length ? items.map(i => `  ${i.quantity} × ${i.product_name}   ${money(i.total_price)}`) : ['  (items not recorded — see Stripe)']),
    '',
    'SHIP TO',
    ...addressLines(o).map(l => '  ' + l),
    '',
    'CUSTOMER',
    `  Email: ${o.customer_email || '—'}`,
    `  Phone: ${o.customer_phone || '—'}`,
    '',
    'PAYMENT (paid)',
    `  Subtotal ${money(o.subtotal)} · Shipping ${o.shipping_cost ? money(o.shipping_cost) : 'Free'} · Tax (GST/HST) ${money(o.tax)} · Total ${money(o.total)} CAD`,
  ];
  if (stripeLink(o)) lines.push(`  Stripe: ${stripeLink(o)}`);
  lines.push('', 'Mark it Shipped in the website admin (Orders) once it is on its way.');
  return lines.join('\n');
}

function ownerOrderHtml(o, items) {
  const td = 'padding:6px 10px;border-bottom:1px solid #eee';
  const rows = items.map(i => `<tr><td style="${td}">${escapeHtml(String(i.quantity))} ×</td><td style="${td}"><strong>${escapeHtml(i.product_name)}</strong></td><td style="${td};text-align:right">${money(i.total_price)}</td></tr>`).join('')
    || `<tr><td style="${td}" colspan="3">(items not recorded — see Stripe)</td></tr>`;
  const link = stripeLink(o);
  return `<div style="font-family:Arial,sans-serif;max-width:620px;color:#222">
  <h2 style="margin:0 0 4px">New order ${escapeHtml(o.order_number)}</h2>
  <div style="color:#777;font-size:13px;margin-bottom:18px">${escapeHtml(placedAt(o))} · ${money(o.total)} CAD · paid</div>
  <h3 style="margin:18px 0 6px;font-size:14px;letter-spacing:1px">TO PACK</h3>
  <table style="border-collapse:collapse;width:100%;font-size:15px">${rows}</table>
  <h3 style="margin:22px 0 6px;font-size:14px;letter-spacing:1px">SHIP TO</h3>
  <div style="font-size:15px;line-height:1.5;background:#f6f3ee;padding:12px 14px;border-radius:4px">${addressLines(o).map(escapeHtml).join('<br>')}</div>
  <h3 style="margin:22px 0 6px;font-size:14px;letter-spacing:1px">CUSTOMER</h3>
  <div style="font-size:15px;line-height:1.6">Email: <a href="mailto:${escapeHtml(o.customer_email || '')}">${escapeHtml(o.customer_email || '—')}</a><br>Phone: ${o.customer_phone ? `<a href="tel:${escapeHtml(o.customer_phone)}">${escapeHtml(o.customer_phone)}</a>` : '—'}</div>
  <h3 style="margin:22px 0 6px;font-size:14px;letter-spacing:1px">PAYMENT</h3>
  <div style="font-size:14px;line-height:1.6">Subtotal ${money(o.subtotal)} · Shipping ${o.shipping_cost ? money(o.shipping_cost) : 'Free'} · Tax (GST/HST) ${money(o.tax)}<br><strong>Total ${money(o.total)} CAD</strong></div>
  ${link ? `<p style="margin-top:20px"><a href="${link}" style="background:#c9a55c;color:#111;padding:10px 16px;text-decoration:none;border-radius:4px;font-weight:bold">Open in Stripe</a></p>` : ''}
  <p style="color:#777;font-size:12px;margin-top:24px">Mark it Shipped in the website admin (Orders) once it is on its way.</p>
</div>`;
}

async function notifyOwnerOfOrder(o, items) {
  const to = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  const what = items.map(i => `${i.quantity}× ${i.product_name}`).join(', ') || 'order';
  const subject = `[Scent World] New order ${o.order_number} — ${what} — ${money(o.total)}`;
  await resendEmail(to, subject.slice(0, 180), ownerOrderHtml(o, items), ownerOrderText(o, items));
}

// The "details" block of the customer's confirmation email.
function customerOrderDetails(o, items, deliveryEstimate) {
  return [
    `Order #${o.order_number}`,
    '',
    ...items.map(i => `${i.quantity} × ${i.product_name} — ${money(i.total_price)}`),
    '',
    `Subtotal: ${money(o.subtotal)}`,
    `Shipping: ${o.shipping_cost ? money(o.shipping_cost) : 'Free'}`,
    `Tax (GST/HST): ${money(o.tax)}`,
    `Total: ${money(o.total)} CAD`,
    '',
    'Shipping to:',
    ...addressLines(o),
    '',
    `Estimated delivery: ${deliveryEstimate}`,
    '',
    "We'll process and ship your order within 1–2 business days, and you'll receive tracking by email.",
  ].join('\n');
}

module.exports = { notifyOwnerOfOrder, ownerOrderText, customerOrderDetails, addressLines };
