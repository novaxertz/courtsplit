const app = require('./src/app');
const config = require('./src/config/env');
const db = require('./src/config/db');
const expiryJob = require('./src/jobs/expireBookings');
const logger = require('./src/utils/logger');

async function start() {
  await db.connect();

  /**
   * The in-process sweep is now opt-out.
   *
   * Under Kubernetes a CronJob owns this (deploy/k8s/40-ingress.yaml) and the
   * API sets EXPIRY_SWEEP_IN_PROCESS=false, so replicas do not each run their
   * own scheduler. It stays on by default for `npm run dev` and plain
   * `docker run`, where there is nothing else to trigger it.
   */
  if (process.env.EXPIRY_SWEEP_IN_PROCESS !== 'false') {
    expiryJob.start();
  } else {
    logger.info('In-process expiry sweep disabled; expecting an external scheduler');
  }

  const server = app.listen(config.port, () =>
    logger.info(`CourtSplit API listening on :${config.port}`, {
      env: config.env,
      paymentProvider: config.payments.provider
    })
  );

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await db.disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Failed to start', { message: err.message });
  process.exit(1);
});
