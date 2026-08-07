/**
 * PostgreSQL test engine.
 *
 * Expects a reachable server (see docker-compose / the README). Applies the
 * schema on start, so a fresh database is usable with no manual setup.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'postgres://postgres:dev@127.0.0.1:5433/courtsplit';
const SCHEMA = path.join(__dirname, '../../../src/db/postgres/schema.sql');

let pool;

module.exports = {
  name: 'postgres',

  async start() {
    process.env.POSTGRES_URL = process.env.POSTGRES_URL || DEFAULT_URL;
    pool = require('../../../src/db/postgres/pool');
    await pool.query(fs.readFileSync(SCHEMA, 'utf8'));
  },

  async stop() {
    await pool.end();
  },

  /**
   * TRUNCATE ... RESTART IDENTITY CASCADE rather than DELETE: it is far faster
   * (no per-row work, no dead tuples for autovacuum to reclaim later) and it
   * resets the identity sequences so ids stay small and readable across runs.
   * CASCADE is required because booking_shares has a foreign key to bookings.
   */
  async clear() {
    await pool.query(
      'TRUNCATE bookings, booking_shares, courts, users, webhook_events RESTART IDENTITY CASCADE'
    );
  },

  async createUser({ name, email, role = 'player' }) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id, email`,
      [name, email, role]
    );
    return { id: String(rows[0].id), email: rows[0].email };
  },

  async createCourt({ name, venueName, location, pricePerSlot, capacity, ownerId }) {
    const { rows } = await pool.query(
      `INSERT INTO courts (name, venue_name, location, sport, price_per_slot, capacity, owner_id)
       VALUES ($1, $2, $3, 'padel', $4, $5, $6) RETURNING id`,
      [name, venueName, location, pricePerSlot, capacity, ownerId]
    );
    return { id: String(rows[0].id) };
  },

  async setFundingDeadline(bookingId, when) {
    await pool.query('UPDATE bookings SET funding_deadline = $2 WHERE id = $1', [
      bookingId,
      when
    ]);
  }
};
