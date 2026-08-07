const payments = require('../services/payments');
const db = require('../db');
const bookingService = require('../services/bookingService');
const logger = require('../utils/logger');

/**
 * Payment provider callback.
 *
 * Two safeguards matter here. The signature is verified before the payload is
 * trusted, because this endpoint is publicly reachable. Then the event id is
 * inserted behind a unique index: providers retry until they receive a 2xx, so
 * the same event routinely arrives more than once and must only take effect
 * the first time.
 */
async function handle(req, res) {
  let event;
  try {
    event = payments.constructEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    logger.warn('Rejected webhook with an invalid signature', { message: err.message });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // The adapter turns "already recorded" into `false` rather than an engine
  // specific duplicate-key error, so this branch is identical on both engines.
  const isNew = await db.webhookEvents.recordIfNew({ eventId: event.id, type: event.type });
  if (!isNew) {
    logger.debug('Duplicate webhook ignored', { eventId: event.id });
    return res.json({ received: true, duplicate: true });
  }

  if (event.type === 'payment_intent.succeeded') {
    const { bookingId, shareId } = event.data.object.metadata || {};
    if (bookingId && shareId) {
      await bookingService.markSharePaid({ bookingId, shareId });
    } else {
      logger.warn('payment_intent.succeeded without booking metadata', { eventId: event.id });
    }
  } else {
    logger.debug('Unhandled webhook type', { type: event.type });
  }

  // Always acknowledge once processed, otherwise the provider keeps retrying.
  return res.json({ received: true });
}

module.exports = { handle };
