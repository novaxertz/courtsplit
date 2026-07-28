const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

async function connect() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri);
  logger.info('MongoDB connected');
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.connection.close();
}

/**
 * Multi-document transactions require a replica set. Atlas provides one, a
 * bare local mongod does not, so the booking service degrades gracefully
 * rather than failing outright when sessions are unavailable.
 */
function supportsTransactions() {
  const { topology } = mongoose.connection.client;
  return Boolean(topology && topology.s && topology.s.description
    && topology.s.description.type !== 'Single');
}

module.exports = { connect, disconnect, supportsTransactions };
