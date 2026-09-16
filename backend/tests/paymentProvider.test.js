const test = require('node:test');
const assert = require('node:assert');

process.env.MONGO_URI ||= 'mongodb://localhost:27017/courtsplit-test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.PAYMENT_PROVIDER = 'mock';

const mock = require('../src/services/payments/mockProvider');

test('creates an intent carrying the booking metadata', async () => {
  const intent = await mock.createPaymentIntent({
    amount: 2500,
    currency: 'AED',
    metadata: { bookingId: 'b1', shareId: 's1' }
  });

  assert.ok(intent.id.startsWith('mock_pi_'));
  assert.strictEqual(intent.amount, 2500);
  assert.strictEqual(intent.status, 'requires_payment_method');
  assert.strictEqual(intent.metadata.bookingId, 'b1');
});

test('confirming an intent moves it to succeeded', async () => {
  const intent = await mock.createPaymentIntent({ amount: 100, currency: 'AED', metadata: {} });
  const confirmed = await mock.confirmPaymentIntent(intent.id);
  assert.strictEqual(confirmed.status, 'succeeded');
});

test('refund returns the requested amount', async () => {
  const intent = await mock.createPaymentIntent({ amount: 4000, currency: 'AED', metadata: {} });
  const refund = await mock.refund({ paymentRef: intent.id, amount: 2000 });
  assert.strictEqual(refund.amount, 2000);
  assert.strictEqual(refund.status, 'succeeded');
});

test('unknown intents are rejected rather than silently ignored', async () => {
  await assert.rejects(() => mock.confirmPaymentIntent('mock_pi_missing'));
  await assert.rejects(() => mock.refund({ paymentRef: 'mock_pi_missing' }));
});

test('refunds an intent issued by another process, e.g. the expiry CronJob', async () => {
  const refund = await mock.refund({ paymentRef: 'mock_pi_0123456789abcdef', amount: 1500 });
  assert.strictEqual(refund.amount, 1500);
  assert.strictEqual(refund.status, 'succeeded');
});

test('constructEvent parses a provider payload', () => {
  const payload = Buffer.from(
    JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } })
  );
  const event = mock.constructEvent(payload);
  assert.strictEqual(event.id, 'evt_1');
  assert.strictEqual(event.type, 'payment_intent.succeeded');
});
