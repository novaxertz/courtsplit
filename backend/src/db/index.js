const config = require('../config/env');

/**
 * Selects the persistence adapter.
 *
 * The rest of the application imports this module and never a concrete
 * adapter, so swapping engines is a configuration change (`DB_ENGINE`) rather
 * than a code change. Both adapters expose the same methods and return the
 * same plain domain objects.
 *
 * Required lazily so that loading this module does not pull in `pg` on a Mongo
 * deployment, or Mongoose models on a Postgres one.
 */
function load(engine = config.dbEngine) {
  switch (engine) {
    case 'postgres':
      return require('./postgres/repository');
    case 'mongo':
      return require('./mongo/repository');
    default:
      throw new Error(`Unknown DB_ENGINE "${engine}" (expected "mongo" or "postgres")`);
  }
}

module.exports = load();
module.exports.load = load;
