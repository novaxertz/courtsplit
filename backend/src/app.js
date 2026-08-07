const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const db = require('./config/db');
const webhookController = require('./controllers/webhookController');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(cors());

/**
 * The webhook route is mounted before the JSON body parser and given a raw
 * body parser instead. Signature verification hashes the exact bytes the
 * provider sent, and re-serialising parsed JSON would not reproduce them.
 */
app.post(
  '/webhooks/payments',
  express.raw({ type: 'application/json' }),
  webhookController.handle
);

app.use(express.json());

/**
 * Liveness: is this process alive and able to answer at all?
 *
 * Deliberately checks nothing external. A liveness probe failing tells the
 * orchestrator to KILL the container, so it must not depend on a database -
 * a brief database outage would otherwise trigger a restart storm across every
 * replica at once, turning a recoverable dependency blip into an outage.
 *
 * Served at /livez, not /healthz. ingress-nginx defines its own /healthz
 * location in the default server block and answers it directly, so a request
 * through the ingress never reaches this handler - it returns an empty
 * text/html 200 from nginx instead. Kubelet probes hit the pod IP directly and
 * were unaffected, which is exactly what made the collision easy to miss.
 * /livez also matches the convention the Kubernetes control plane itself uses.
 */
app.get('/livez', (_req, res) =>
  res.json({ status: 'ok', service: 'courtsplit-api', uptime: process.uptime() })
);

/**
 * Readiness: can this instance serve a real request right now?
 *
 * This one does touch storage, because a pod that cannot reach its database
 * must be pulled out of the load balancer rather than handed traffic. Failing
 * readiness removes the pod from Service endpoints; it does not restart it, so
 * the instance rejoins automatically once storage recovers.
 */
app.get('/readyz', async (_req, res) => {
  try {
    await db.ping();
    res.json({ status: 'ready', engine: process.env.DB_ENGINE || 'mongo' });
  } catch (err) {
    res.status(503).json({ status: 'not-ready', reason: err.message });
  }
});

// Retained so existing clients and the previous README keep working.
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'courtsplit-api', uptime: process.uptime() })
);

app.use(routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
