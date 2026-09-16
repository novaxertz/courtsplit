const test = require('node:test');
const assert = require('node:assert');

const db = require('./helpers/db');
const bookingService = require('../src/services/bookingService');

/**
 * GET /courts/:id/availability, over real HTTP.
 *
 * The court controller still queries Mongoose models directly rather than the
 * repository, so this only runs on MongoDB.
 */
const mongoOnly = { skip: db.engineName !== 'mongo' && 'court controller is not ported to the repository' };

test.before(db.start);
test.after(db.stop);
test.beforeEach(db.clear);

test('availability lists slots held by live bookings', mongoOnly, async () => {
  const app = require('../src/app');
  const { court, organiser, participantEmails, slotStart } = await db.seed();
  await bookingService.createBooking({
    courtId: court.id,
    organiserId: organiser.id,
    slotStart,
    participantEmails
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/courts/${court.id}/availability`);
    assert.strictEqual(res.status, 200, 'a court with a live booking must not 500');

    const body = await res.json();
    assert.strictEqual(body.unavailable.length, 1);
    assert.strictEqual(new Date(body.unavailable[0].slotStart).getTime(), slotStart.getTime());
  } finally {
    await new Promise((done) => server.close(done));
  }
});
