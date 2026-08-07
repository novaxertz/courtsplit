const db = require('../db');
const logger = require('../utils/logger');

/**
 * Connection lifecycle, delegated to whichever adapter DB_ENGINE selected.
 *
 * Kept as a thin module so `server.js` does not need to know which engine is
 * configured, and so the readiness probe has one place to ask "is storage
 * actually reachable".
 */

/**
 * Connects, retrying with exponential backoff.
 *
 * Startup ordering is not guaranteed in a cluster: the API pod is frequently
 * scheduled before the database's DNS record resolves, and the first attempt
 * dies with ENOTFOUND. Exiting immediately technically works - Kubernetes
 * restarts the pod - but a handful of those trips CrashLoopBackOff, whose
 * exponential delay then holds up the whole rollout. Observed here: 5 restarts
 * before the first successful connect.
 *
 * Retrying in-process converges in seconds instead, and still fails the
 * container honestly if the database is genuinely unreachable.
 */
async function connect({ attempts = 8, baseDelayMs = 500 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await db.connection.connect();
      logger.info('Database connected', { engine: db.engine, attempt });
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 5000);
      logger.warn('Database connection failed, retrying', {
        engine: db.engine,
        attempt,
        retryInMs: delay,
        message: err.message
      });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

async function disconnect() {
  await db.connection.disconnect();
}

/**
 * Resolves when storage answers a real command; rejects otherwise.
 *
 * The timeout is not optional decoration. With the database down, the Mongo
 * driver waits out its full server-selection window (30s by default) before
 * giving up, so an unbounded ping makes the readiness endpoint hang instead of
 * answering. A probe that hangs still eventually fails, but it holds a
 * connection and a worker for the whole window on every attempt - under a 5s
 * probe interval those pile up faster than they drain.
 *
 * Failing fast is the correct behaviour: readiness only needs to know whether
 * storage responds *now*.
 */
async function ping({ timeoutMs = 2000 } = {}) {
  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`database ping exceeded ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([db.connection.ping(), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { connect, disconnect, ping };
