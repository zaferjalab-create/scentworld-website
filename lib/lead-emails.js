// Owner notifications for consultation bookings and quote requests: every
// field the customer gave, laid out so the owner can call or reply straight
// from the email. (The old one-line notices dropped the phone number.)
const { resendEmail, escapeHtml } = require('./email');

const v = x => (x == null || String(x).trim() === '' ? null : String(x).trim());

// "2026-10-24" -> "Saturday, October 24, 2026" (date-only, no timezone shift)
function niceDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return v(d) || '—';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function rowsText(rows) {
  return rows.map(([k, val]) => `${k}: ${val == null ? '—' : val}`).join('\n');
}

function rowsHtml(rows) {
  const td = 'padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #eee';
  return `<table style="border-collapse:collapse;font-size:15px">${rows.map(([k, val, html]) =>
    `<tr><td style="${td};color:#777;white-space:nowrap">${escapeHtml(k)}</td><td style="${td}">${html || (val == null ? '—' : escapeHtml(String(val)))}</td></tr>`).join('')}</table>`;
}

function contactRows(p) {
  const email = v(p.email), phone = v(p.phone);
  return [
    ['Name', `${v(p.first_name) || ''} ${v(p.last_name) || ''}`.trim() || null],
    ['Email', email, email && `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`],
    ['Phone', phone, phone && `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>`],
  ];
}

function wrapHtml(title, subtitle, rows, message) {
  return `<div style="font-family:Arial,sans-serif;max-width:620px;color:#222">
  <h2 style="margin:0 0 4px">${escapeHtml(title)}</h2>
  <div style="color:#777;font-size:13px;margin-bottom:16px">${escapeHtml(subtitle)}</div>
  ${rowsHtml(rows)}
  <h3 style="margin:20px 0 6px;font-size:14px;letter-spacing:1px">THEIR MESSAGE</h3>
  <div style="font-size:15px;line-height:1.5;background:#f6f3ee;padding:12px 14px;border-radius:4px;white-space:pre-wrap">${message ? escapeHtml(message) : '<span style="color:#999">(no message)</span>'}</div>
  <p style="color:#777;font-size:12px;margin-top:22px">Reply to this customer directly from their email address above. Also listed in the website admin.</p>
</div>`;
}

function bookingEmail(b) {
  const rows = [
    ...contactRows(b),
    ['Business', v(b.business_name)],
    ['Requested time', `${niceDate(b.preferred_date)} at ${v(b.preferred_time) || '—'} (Halifax time)`],
    ['Topic', v(b.topic) || 'General consultation'],
    ['Type of space', v(b.space_type)],
    ['Size of space', v(b.space_size)],
  ];
  const who = `${v(b.first_name) || ''} ${v(b.last_name) || ''}`.trim();
  return {
    subject: `[Scent World] Consultation request — ${who}${v(b.business_name) ? ' (' + v(b.business_name) + ')' : ''} — ${niceDate(b.preferred_date)} ${v(b.preferred_time) || ''}`.trim(),
    text: `NEW CONSULTATION REQUEST\n\n${rowsText(rows)}\n\nTHEIR MESSAGE\n${v(b.message) || '(no message)'}\n`,
    html: wrapHtml('New consultation request', 'Confirm the time with the customer, then mark it Confirmed in the admin (Consultations).', rows, v(b.message)),
  };
}

function quoteEmail(c) {
  const rows = [
    ...contactRows(c),
    ['Customer type', v(c.customer_type)],
    ['Interested in', v(c.product_interest)],
  ];
  const who = `${v(c.first_name) || ''} ${v(c.last_name) || ''}`.trim();
  return {
    subject: `[Scent World] Quote request — ${who}${v(c.product_interest) ? ' — ' + v(c.product_interest) : ''}`,
    text: `NEW QUOTE REQUEST\n\n${rowsText(rows)}\n\nTHEIR MESSAGE\n${v(c.message) || '(no message)'}\n`,
    html: wrapHtml('New quote request', 'They were promised a reply within 24 hours.', rows, v(c.message)),
  };
}

async function send(mail) {
  const to = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  await resendEmail(to, mail.subject.slice(0, 180), mail.html, mail.text);
}

module.exports = {
  bookingEmail, quoteEmail, niceDate,
  notifyBooking: b => send(bookingEmail(b)),
  notifyQuote: c => send(quoteEmail(c)),
};
