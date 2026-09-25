// Post-purchase review-request emails, sent ~10 days after an order.
const db = require('../database');
const { resendEmail, escapeHtml } = require('./email');


// Email each customer ~10 days after purchase, inviting them to review the
// products they bought (deep-linked to each product's review form). Runs daily;
// every order is emailed at most once, tracked by review_request_sent_at.
const REVIEW_REQUEST_DELAY_DAYS = 10;
async function sendReviewRequests() {
  if (!process.env.RESEND_API_KEY) return; // email disabled — don't mark orders sent
  let orders;
  try {
    orders = db.prepare(`
      SELECT id, order_number, customer_name, customer_email
      FROM orders
      WHERE payment_status = 'paid'
        AND review_request_sent_at IS NULL
        AND customer_email IS NOT NULL AND customer_email != ''
        AND created_at <= datetime('now', ?)
      ORDER BY created_at ASC LIMIT 50
    `).all(`-${REVIEW_REQUEST_DELAY_DAYS} days`);
  } catch (e) { console.error('review-request query error:', e.message); return; }
  if (!orders.length) return;

  const BASE = process.env.BASE_URL || 'https://www.scentworld.ca';
  const markSent = db.prepare('UPDATE orders SET review_request_sent_at = CURRENT_TIMESTAMP WHERE id = ?');

  for (const o of orders) {
    try {
      const items = db.prepare(`
        SELECT DISTINCT p.slug, COALESCE(p.name, oi.product_name) AS name
        FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
      `).all(o.id).filter(it => it.slug);
      if (!items.length) { markSent.run(o.id); continue; } // nothing linkable; don't retry forever

      const firstName = (o.customer_name || 'there').split(' ')[0];
      const links = items.map(it => `<a href="${BASE}/products/${encodeURIComponent(it.slug)}#reviews" style="color:#c9a55c;text-decoration:none">${escapeHtml(it.name)} →</a>`).join('<br>');
      const linksText = items.map(it => `${it.name}: ${BASE}/products/${it.slug}#reviews`).join('\n');
      const html = `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">How are you enjoying your order, ${escapeHtml(firstName)}?</h2>
          <p style="color:#ccc;line-height:1.7">It's been a little while since your order <strong style="color:#f5f0e8">#${escapeHtml(o.order_number)}</strong> arrived. We'd love to hear what you think — a quick review helps other customers and takes less than a minute.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 8px">Leave a review for:</p>
            <p style="color:#f5f0e8;margin:0;font-size:15px;line-height:1.9">${links}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">Thank you for choosing Scent World.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`;
      const text = `How are you enjoying your order, ${firstName}?\n\nIt's been a little while since order #${o.order_number} arrived. We'd love a quick review:\n\n${linksText}\n\nThank you,\nScent World Canada`;
      const ok = await resendEmail(o.customer_email, 'How are you enjoying your Scent World order?', html, text);
      if (ok) markSent.run(o.id); // only mark sent on actual delivery, so failures retry tomorrow
    } catch (err) {
      console.error(`review-request for order ${o.id} failed:`, err.message);
    }
  }
}

// Run shortly after boot (catch any already due), then once a day.
function scheduleReviewRequests() {
  setTimeout(sendReviewRequests, 90 * 1000);
  setInterval(sendReviewRequests, 24 * 60 * 60 * 1000);
}

module.exports = { sendReviewRequests, scheduleReviewRequests };
