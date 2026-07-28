const crypto = require('crypto');

/**
 * In-memory payment provider used when no Stripe keys are configured, so the
 * project runs immediately after cloning. It mirrors the Stripe provider's
 * interface exactly; only the transport differs.
 */
const intents = new Map();

function createPaymentIntent({ amount, currency, metadata }) {
  const id = `mock_pi_${crypto.randomBytes(8).toString('hex')}`;
  const intent = {
    id,
    amount,
    currency,
    metadata,
    status: 'requires_payment_method',
    clientSecret: `${id}_secret`
  };
  intents.set(id, intent);
  return Promise.resolve(intent);
}

/** Stands in for the customer completing checkout on the client. */
function confirmPaymentIntent(id) {
  const intent = intents.get(id);
  if (!intent) {
    return Promise.reject(new Error(`Unknown payment intent: ${id}`));
  }
  intent.status = 'succeeded';
  return Promise.resolve(intent);
}

function refund({ paymentRef, amount }) {
  const intent = intents.get(paymentRef);
  if (!intent) {
    return Promise.reject(new Error(`Unknown payment intent: ${paymentRef}`));
  }
  intent.status = 'refunded';
  return Promise.resolve({
    id: `mock_re_${crypto.randomBytes(6).toString('hex')}`,
    paymentRef,
    amount: amount ?? intent.amount,
    status: 'succeeded'
  });
}

/**
 * The mock has no signing secret, so the payload is returned as-is. The
 * verification step is preserved in the interface because the webhook route
 * must behave identically for both providers.
 */
function constructEvent(rawBody) {
  const parsed = JSON.parse(rawBody.toString());
  return {
    id: parsed.id || `mock_evt_${crypto.randomBytes(6).toString('hex')}`,
    type: parsed.type,
    data: parsed.data
  };
}

module.exports = {
  name: 'mock',
  createPaymentIntent,
  confirmPaymentIntent,
  refund,
  constructEvent
};
