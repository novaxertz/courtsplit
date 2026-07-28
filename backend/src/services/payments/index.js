const config = require('../../config/env');
const mockProvider = require('./mockProvider');
const logger = require('../../utils/logger');

/**
 * Selecting the provider behind a shared interface keeps Stripe out of the
 * booking logic. The domain code asks for a payment intent or a refund and
 * never learns which processor fulfilled it.
 */
function load() {
  if (config.payments.provider === 'stripe') {
    // Required lazily so the dependency is only needed when actually used.
    return require('./stripeProvider');
  }
  logger.warn('Using the mock payment provider - no real charges will occur');
  return mockProvider;
}

module.exports = load();
