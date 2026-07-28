const bookingService = require('../services/bookingService');
const logger = require('../utils/logger');

const INTERVAL_MS = Number(process.env.EXPIRY_SWEEP_INTERVAL_MS || 60_000);

/**
 * Periodically expires bookings that were never fully funded.
 *
 * The sweep is deliberately idempotent: each booking is claimed with a
 * conditional update, so running it more often than necessary, or on several
 * instances at once, cannot double-refund anyone.
 */
function start() {
  const timer = setInterval(async () => {
    try {
      const expired = await bookingService.expireUnfundedBookings();
      if (expired.length) {
        logger.info('Expiry sweep completed', { expired: expired.length });
      }
    } catch (err) {
      logger.error('Expiry sweep failed', { message: err.message });
    }
  }, INTERVAL_MS);

  timer.unref();
  logger.info('Booking expiry sweep scheduled', { intervalMs: INTERVAL_MS });
  return timer;
}

module.exports = { start };
