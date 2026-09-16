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

// Shape of an id issued by createPaymentIntent in ANY process.
const INTENT_ID = /^mock_pi_[0-9a-f]{16}$/;

/**
 * Intents live in this process's memory, but refunds are often issued from a
 * different process: the expiry CronJob, or another API replica. Stripe would
 * know the intent regardless, so a well-formed id this process has not seen is
 * treated as issued elsewhere. Malformed ids are still rejected.
 */
function refund({ paymentRef, amount }) {
  const intent = intents.get(paymentRef);
  if (!intent && !INTENT_ID.test(paymentRef || '')) {
    return Promise.reject(new Error(`Unknown payment intent: ${paymentRef}`));
  }
  if (!intent && amount === undefined) {
    return Promise.reject(new Error(`Refund amount required for foreign intent: ${paymentRef}`));
  }
  if (intent) intent.status = 'refunded';
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
