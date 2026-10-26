// Owner alerts must not be sent "from" the inbox they go to: Microsoft 365
// junks outside mail spoofing hello@scentworld.ca, which hid a real order.
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.RESEND_API_KEY = 're_test_dummy';
delete process.env.NOTIFY_EMAIL;
const { notifyOwnerOfOrder } = require('../lib/order-emails');
const { notifyBooking } = require('../lib/lead-emails');

async function captureSends(fn) {
  const sent = [];
  const realFetch = global.fetch, realLog = console.log;
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 'test' }) };
  };
  console.log = () => {};
  try { await fn(); } finally { global.fetch = realFetch; console.log = realLog; }
  return sent;
}

test('order alert: from alerts@, to hello@, Reply goes to the customer', async () => {
  const order = { order_number: 'SW-1', customer_name: 'Asha O', customer_email: 'asha@example.com',
    subtotal: 65, shipping_cost: 12.99, tax: 0, total: 75.59 };
  const [mail, ...rest] = await captureSends(() => notifyOwnerOfOrder(order, [{ quantity: 1, product_name: 'Oud Oil — 100ml', total_price: 65 }]));
  assert.equal(rest.length, 0);
  assert.deepEqual(mail.to, ['hello@scentworld.ca']);
  assert.ok(!mail.from.includes('hello@scentworld.ca'), 'sender differs from the recipient inbox');
  assert.equal(mail.reply_to, 'asha@example.com');
  assert.ok(mail.subject.includes('SW-1') && mail.text.includes('Oud Oil'));
});

test('optional NOTIFY_EMAIL_COPY gets a second copy; booking Reply goes to the customer', async () => {
  process.env.NOTIFY_EMAIL_COPY = 'owner-phone@example.com';
  try {
    const sent = await captureSends(() => notifyBooking({ first_name: 'Bo', email: 'bo@example.com', phone: '902-555-0100' }));
    assert.deepEqual(sent.map(m => m.to[0]), ['hello@scentworld.ca', 'owner-phone@example.com']);
    assert.ok(sent.every(m => m.reply_to === 'bo@example.com'));
  } finally { delete process.env.NOTIFY_EMAIL_COPY; }
});
