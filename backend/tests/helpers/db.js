/**
 * Engine-agnostic test harness.
 *
 * `DB_ENGINE` picks the backing store; everything the tests touch goes through
 * this module or through the repository, never through a driver. That is what
 * lets one concurrency suite run unchanged on both engines.
 *
 * IMPORTANT: these environment variables are set before anything under `src/`
 * is required. `src/config/env.js` reads them at import time and throws when
 * the selected engine's connection string is missing, so an earlier require
 * would abort the run before a single test executed.
 */
const ENGINE = process.env.DB_ENGINE || 'mongo';

process.env.DB_ENGINE = ENGINE;
process.env.JWT_SECRET ??= 'test-secret';
process.env.PAYMENT_PROVIDER ??= 'mock';
process.env.LOG_LEVEL ??= 'error';
// Placeholders so env.js validation passes; the engine helper overwrites the
// one it actually uses with a real connection string during start().
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/courtsplit-test';
process.env.POSTGRES_URL ??= 'postgres://postgres:dev@127.0.0.1:5433/courtsplit';

const engine = require(`./engines/${ENGINE}`);

let repo;

async function start() {
  await engine.start();
  // Required only after the engine is up, so the adapter connects to the
  // server this harness just started rather than the placeholder URL.
  repo = require('../../src/db').load(ENGINE);
  module.exports.repo = repo;
}

async function stop() {
  await engine.stop();
}

const clear = () => engine.clear();

/** Minimal fixture: a venue owner, an organiser, participants, and a court. */
async function seed({ participants = 1, capacity = 4, pricePerSlot = 10000 } = {}) {
  const owner = await engine.createUser({
    name: 'Venue Owner',
    email: 'owner@test.local',
    role: 'venue'
  });
  const organiser = await engine.createUser({
    name: 'Organiser',
    email: 'organiser@test.local'
  });

  const players = [];
  for (let i = 0; i < participants; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    players.push(
      await engine.createUser({ name: `Player ${i}`, email: `player${i}@test.local` })
    );
  }

  const court = await engine.createCourt({
    name: 'Court 1',
    venueName: 'Test Padel Club',
    location: 'Dubai',
    pricePerSlot,
    capacity,
    ownerId: owner.id
  });

  return {
    owner,
    organiser,
    players,
    court,
    participantEmails: players.map((p) => p.email),
    // Comfortably in the future so createBooking's past-slot guard never trips.
    // Milliseconds are zeroed: Postgres timestamptz keeps microsecond
    // precision while a JS Date carries milliseconds, and an equality lookup
    // on slot_start must match exactly.
    slotStart: new Date(Math.floor((Date.now() + 48 * 3600 * 1000) / 1000) * 1000)
  };
}

module.exports = {
  engineName: ENGINE,
  start,
  stop,
  clear,
  seed,
  repo,
  setFundingDeadline: (id, when) => engine.setFundingDeadline(id, when)
};
