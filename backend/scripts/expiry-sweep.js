/**
 * One-shot booking expiry sweep.
 *
 * Runs once, reports, and exits - the shape a Kubernetes CronJob wants. The
 * same logic previously lived only as a setInterval inside every API process,
 * which the project README listed as a known limitation.
 *
 * Moving it out is not just tidiness. With the sweep embedded in the API,
 * scaling to two replicas meant two schedulers competing over the same
 * bookings. The conditional-write transitions made that survivable, but it was
 * duplicated work owned by nobody. As a CronJob there is exactly one runner
 * and the API becomes genuinely stateless.
 *
 * Correctness still does not depend on there being one runner: every
 * transition matches on the booking still being PENDING_PAYMENT, so a slow run
 * overlapping the next one changes nothing twice.
 *
 * Exit codes matter here - a non-zero exit is how the Job reports failure and
 * triggers its backoff, so errors must not be swallowed.
 */
const bookingService = require('../src/services/bookingService');
const db = require('../src/config/db');
const logger = require('../src/utils/logger');

async function main() {
  await db.connect();

  const started = Date.now();
  const expired = await bookingService.expireUnfundedBookings();

  logger.info('Expiry sweep completed', {
    expired: expired.length,
    durationMs: Date.now() - started
  });

  await db.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error('Expiry sweep failed', { message: err.message });
    try {
      await db.disconnect();
    } catch {
      // Already failing; the exit code below is what the Job acts on.
    }
    process.exit(1);
  });
