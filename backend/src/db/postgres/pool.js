const { Pool } = require('pg');
const config = require('../../config/env');

/**
 * A single shared connection pool.
 *
 * PostgreSQL forks a backend process per connection, so connections are far
 * more expensive than in MySQL and opening one per request does not scale.
 * The pool caps them. Past roughly a few hundred, a server-side pooler such as
 * PgBouncer is the usual next step rather than raising `max` here.
 */
let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.postgresUrl,
      max: Number(process.env.PG_POOL_MAX || 10)
    });
  }
  return pool;
}

/** Convenience for one-shot statements that need no transaction. */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Runs `fn` inside a transaction on a dedicated client.
 *
 * Checking out one client for the whole unit of work is the point: BEGIN and
 * COMMIT are connection-scoped, so issuing them through the pool's convenience
 * `query` could route them to different backends and silently do nothing.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function end() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, query, withTransaction, end };
