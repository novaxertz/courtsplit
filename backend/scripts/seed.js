/**
 * Populates a few users and courts so the API can be exercised immediately
 * after setup. Safe to re-run: existing records are left untouched.
 *
 *   node scripts/seed.js
 */
const db = require('../src/config/db');
const User = require('../src/models/User');
const Court = require('../src/models/Court');
const logger = require('../src/utils/logger');

const USERS = [
  { name: 'Ibrahim Ansar', email: 'ibrahim@example.com', role: 'venue' },
  { name: 'Sam Reed', email: 'sam@example.com', role: 'player' },
  { name: 'Alex Novak', email: 'alex@example.com', role: 'player' },
  { name: 'Priya Menon', email: 'priya@example.com', role: 'player' }
];

const COURTS = [
  {
    name: 'Court 1',
    venueName: 'Marina Padel Club',
    location: 'Dubai Marina',
    sport: 'padel',
    pricePerSlot: 24000,
    capacity: 4
  },
  {
    name: 'Court 2',
    venueName: 'Marina Padel Club',
    location: 'Dubai Marina',
    sport: 'padel',
    pricePerSlot: 20000,
    capacity: 4
  },
  {
    name: 'Pitch A',
    venueName: 'Al Quoz Sports Hall',
    location: 'Al Quoz',
    sport: 'football',
    pricePerSlot: 45000,
    capacity: 10
  }
];

async function seed() {
  await db.connect();

  const users = [];
  for (const spec of USERS) {
    let user = await User.findOne({ email: spec.email });
    if (!user) {
      user = await User.create({
        ...spec,
        passwordHash: await User.hashPassword('password123')
      });
      logger.info('Created user', { email: user.email });
    }
    users.push(user);
  }

  const owner = users[0];
  for (const spec of COURTS) {
    const exists = await Court.findOne({ name: spec.name, venueName: spec.venueName });
    if (!exists) {
      await Court.create({ ...spec, owner: owner._id });
      logger.info('Created court', { name: spec.name, venue: spec.venueName });
    }
  }

  logger.info('Seed complete. All demo users share the password "password123".');
  await db.disconnect();
}

seed().catch((err) => {
  logger.error('Seed failed', { message: err.message });
  process.exit(1);
});
