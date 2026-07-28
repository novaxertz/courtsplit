const express = require('express');
const cors = require('cors');
const routes = require('./routes');
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

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'courtsplit-api', uptime: process.uptime() })
);

app.use(routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
