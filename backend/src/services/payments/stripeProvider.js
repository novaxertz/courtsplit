const Stripe = require('stripe');
const config = require('../../config/env');

const stripe = new Stripe(config.payments.stripeSecretKey);

/**
 * The idempotency key ensures a retried request reuses the original intent
 * rather than charging a second time.
 */
function createPaymentIntent({ amount, currency, metadata, idempotencyKey }) {
  return stripe.paymentIntents
    .create(
      {
        amount,
        currency: currency.toLowerCase(),
        metadata,
        automatic_payment_methods: { enabled: true }
      },
      idempotencyKey ? { idempotencyKey } : undefined
    )
    .then((intent) => ({
      id: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      metadata: intent.metadata,
      status: intent.status,
      clientSecret: intent.client_secret
    }));
}

function refund({ paymentRef, amount, idempotencyKey }) {
  return stripe.refunds
    .create(
      { payment_intent: paymentRef, ...(amount ? { amount } : {}) },
      idempotencyKey ? { idempotencyKey } : undefined
    )
    .then((r) => ({
      id: r.id,
      paymentRef,
      amount: r.amount,
      status: r.status
    }));
}

/**
 * Verifies the Stripe signature before trusting the payload. Without this the
 * webhook endpoint is a public URL that anyone could POST "payment succeeded"
 * to and confirm a booking they never paid for.
 */
function constructEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.payments.stripeWebhookSecret
  );
}

module.exports = {
  name: 'stripe',
  createPaymentIntent,
  refund,
  constructEvent
};
