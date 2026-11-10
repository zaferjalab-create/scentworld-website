// Order emails: the owner's packing notification and the customer's
// confirmation details. Built from the saved order + its items, so both always
// say exactly what the admin panel says.
const { sendOwnerAlert, escapeHtml, resendEmail } = require('./email');

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
  const what = items.map(i => `${i.quantity}× ${i.product_name}`).join(', ') || 'order';
  const subject = `[Scent World] New order ${o.order_number} — ${what} — ${money(o.total)}`;
  return sendOwnerAlert(subject, ownerOrderHtml(o, items), ownerOrderText(o, items), o.customer_email);
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

// "Your order has shipped" email with the tracking link. Returns { subject, html, text }.
function shippedEmail(o, carrier, tracking, url) {
  const first = escapeHtml((o.customer_name || 'there').split(' ')[0]);
  const safeUrl = /^https:\/\//.test(url || '') ? url : null;
  const trackLine = [carrier, tracking].filter(Boolean).join(' · ');
  const html = `
    <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
        <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
      </div>
      <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Your order is on its way, ${first}!</h2>
      <p style="color:#ccc;line-height:1.7">Order <strong style="color:#f5f0e8">#${escapeHtml(o.order_number)}</strong> has shipped.</p>
      ${tracking ? `<div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
        <p style="color:#999;font-size:13px;margin:0 0 4px">Tracking number</p>
        <p style="color:#f5f0e8;margin:0;font-size:16px">${escapeHtml(trackLine)}</p>
        ${safeUrl ? `<p style="margin:14px 0 0"><a href="${escapeHtml(safeUrl)}" style="background:#c9a55c;color:#0b0908;padding:10px 18px;text-decoration:none;font-weight:bold;font-family:Arial,sans-serif;font-size:13px;letter-spacing:1px">TRACK YOUR PARCEL</a></p>` : ''}
      </div>` : ''}
      <p style="color:#ccc;line-height:1.7">You can also check your order any time at <a href="https://www.scentworld.ca/track" style="color:#c9a55c">scentworld.ca/track</a>. Questions? Reply to this email.</p>
      <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
      <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · 6156 Quinpool Road, Halifax, NS · hello@scentworld.ca · www.scentworld.ca</p>
    </div>`;
  const text = [`Your order is on its way, ${(o.customer_name || 'there').split(' ')[0]}!`, '', `Order #${o.order_number} has shipped.`,
    tracking ? `Tracking: ${trackLine}` : '', safeUrl ? `Track your parcel: ${safeUrl}` : '', '',
    'Check your order any time at https://www.scentworld.ca/track', '', 'Scent World Canada · hello@scentworld.ca'].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  return { subject: `Your Scent World order #${o.order_number} has shipped`, html, text };
}
async function sendShippedEmail(o, carrier, tracking, url) {
  if (!o.customer_email) return false;
  const m = shippedEmail(o, carrier, tracking, url);
  return resendEmail(o.customer_email, m.subject, m.html, m.text);
}

module.exports = { notifyOwnerOfOrder, ownerOrderText, customerOrderDetails, addressLines, shippedEmail, sendShippedEmail };
