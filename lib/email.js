// Outbound email via Resend: owner notifications and customer confirmations.
// Every send is a no-op (logged) when RESEND_API_KEY is unset.

// Returns true only if the email was actually accepted by Resend.
async function resendEmail(to, subject, html, text) {
  if (!process.env.RESEND_API_KEY) {
    console.error('EMAIL: RESEND_API_KEY not set — skipping email');
    return false;
  }
  console.log(`EMAIL: Sending "${subject}" to ${to}`);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Scent World Canada <hello@scentworld.ca>',
        to: [to],
        subject,
        html,
        text
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('EMAIL FAILED:', JSON.stringify(data));
      return false;
    }
    console.log('EMAIL SENT OK, id:', data.id);
    return true;
  } catch (err) {
    console.error('EMAIL ERROR:', err.message);
    return false;
  }
}

// Escape user-supplied text before embedding it in HTML emails, so a visitor's
// form input can't inject markup/links into the notifications we read.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Admin notification
async function sendNotification(subject, text) {
  const toEmail = process.env.NOTIFY_EMAIL || 'hello@scentworld.ca';
  await resendEmail(toEmail, `[Scent World] ${subject}`, `<pre style="font-family:sans-serif">${escapeHtml(text)}</pre>`, text);
}

// Customer confirmation email
async function sendConfirmation(toEmail, firstName, type, details) {
  const detailsHtml = escapeHtml(details).replace(/\n/g, '<br>');
  const templates = {
    quote: {
      subject: 'We received your quote request — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Thank you, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">We've received your quote request and will be in touch within <strong style="color:#f5f0e8">24 hours</strong>.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 4px">Your request summary:</p>
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">In the meantime, feel free to explore our <a href="https://www.scentworld.ca" style="color:#c9a55c">full collection</a>.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Thank you, ${firstName}!\n\nWe've received your quote request and will be in touch within 24 hours.\n\nYour request: ${details}\n\nScent World Canada\nhello@scentworld.ca`
    },
    booking: {
      subject: 'Consultation request confirmed — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Your consultation is requested, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">We've received your consultation request and will confirm your time slot within <strong style="color:#f5f0e8">24 hours</strong>.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#999;font-size:13px;margin:0 0 4px">Requested slot:</p>
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">We look forward to speaking with you.</p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Your consultation is requested, ${firstName}!\n\nWe'll confirm your time slot within 24 hours.\n\nRequested: ${details}\n\nScent World Canada\nhello@scentworld.ca`
    },
    order: {
      subject: 'Order confirmed — Scent World Canada',
      html: `
        <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#0b0908;color:#f5f0e8;padding:40px 32px">
          <div style="text-align:center;margin-bottom:32px">
            <div style="font-size:28px;font-weight:bold;color:#c9a55c;letter-spacing:3px">SCENT WORLD</div>
            <div style="font-size:11px;letter-spacing:4px;color:#999;margin-top:4px">CANADA</div>
          </div>
          <h2 style="color:#c9a55c;font-size:20px;margin-bottom:16px">Order Confirmed, ${firstName}!</h2>
          <p style="color:#ccc;line-height:1.7">Thank you for your order. We'll process and ship it soon.</p>
          <div style="background:#1a1614;border-left:3px solid #c9a55c;padding:16px 20px;margin:24px 0;border-radius:4px">
            <p style="color:#f5f0e8;margin:0;font-size:14px;line-height:1.7">${detailsHtml}</p>
          </div>
          <p style="color:#ccc;line-height:1.7">Questions? Reply to this email or contact us at <a href="mailto:support@scentworld.ca" style="color:#c9a55c">support@scentworld.ca</a></p>
          <hr style="border:none;border-top:1px solid #2a2420;margin:32px 0">
          <p style="color:#666;font-size:12px;text-align:center">Scent World Canada · hello@scentworld.ca · www.scentworld.ca</p>
        </div>`,
      text: `Order Confirmed, ${firstName}!\n\n${details}\n\nQuestions? Email support@scentworld.ca\n\nScent World Canada`
    }
  };
  const t = templates[type];
  if (!t) return;
  await resendEmail(toEmail, t.subject, t.html, t.text);
}

module.exports = { resendEmail, escapeHtml, sendNotification, sendConfirmation };
