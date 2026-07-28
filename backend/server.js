const app = require('./src/app');
const config = require('./src/config/env');
const db = require('./src/config/db');
const expiryJob = require('./src/jobs/expireBookings');
const logger = require('./src/utils/logger');

async function start() {
  await db.connect();
  expiryJob.start();

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
