require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  // Which persistence adapter to load. "mongo" keeps the original document
  // model; "postgres" uses the relational adapter in src/db/postgres.
  dbEngine: process.env.DB_ENGINE || 'mongo',
  mongoUri: process.env.MONGO_URI || '',
  postgresUrl: process.env.POSTGRES_URL || '',
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  payments: {
    // "stripe" uses the real Stripe test API; "mock" runs without any keys so
    // the project is runnable straight after clone.
    provider: process.env.PAYMENT_PROVIDER || 'mock',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },
  booking: {
    // A booking must be fully funded this many minutes after creation,
    // otherwise it expires and every paid share is refunded.
    fundingWindowMinutes: Number(process.env.FUNDING_WINDOW_MINUTES || 60),
    // Free cancellation up to this many hours before the slot starts.
    freeCancellationHours: Number(process.env.FREE_CANCELLATION_HOURS || 24),
    // Refund percentage when cancelling inside the free window.
    lateCancellationRefundPercent: Number(process.env.LATE_CANCELLATION_REFUND_PERCENT || 50)
  }
};

if (config.payments.provider === 'stripe' && !config.payments.stripeSecretKey) {
  throw new Error('PAYMENT_PROVIDER is "stripe" but STRIPE_SECRET_KEY is not set');
}

// Only the selected engine's connection string is required, so a Postgres
// deployment does not need a MONGO_URI and vice versa.
if (config.dbEngine === 'mongo' && !config.mongoUri) {
  throw new Error('DB_ENGINE is "mongo" but MONGO_URI is not set');
}
if (config.dbEngine === 'postgres' && !config.postgresUrl) {
  throw new Error('DB_ENGINE is "postgres" but POSTGRES_URL is not set');
}

module.exports = config;
