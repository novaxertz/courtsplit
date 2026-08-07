const test = require('node:test');
const assert = require('node:assert');

const db = require('./helpers/db');
const bookingService = require('../src/services/bookingService');

/**
 * Read-path parity.
 *
 * The write path was ported first and the two list/detail reads kept calling
 * Mongoose directly, so `DB_ENGINE=postgres` returned 500 on GET /bookings.
 * These assert that both adapters answer the same questions with the same
 * shape - membership, ordering, and the attached court/organiser summaries.
 *
 * Like the concurrency suite, nothing here names an engine.
 */

test.before(db.start);
test.after(db.stop);
test.beforeEach(db.clear);

async function makeBooking({ hoursOut }) {
  const fixture = await db.seed({ participants: 1 });
  const slotStart = new Date(
    Math.floor((Date.now() + hoursOut * 3600 * 1000) / 1000) * 1000
  );
  const booking = await bookingService.createBooking({
    courtId: fixture.court.id,
    organiserId: fixture.organiser.id,
    slotStart,
    participantEmails: fixture.participantEmails
  });
  return { ...fixture, booking, slotStart };
}

test('listForUser returns bookings the caller organised, with the court attached', async () => {
  const { organiser, court, booking } = await makeBooking({ hoursOut: 48 });

  const rows = await db.repo.bookings.listForUser(organiser.id);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, booking.id);
  assert.strictEqual(rows[0].courtId, court.id);
  // The summary is what the mobile client renders, so it must survive the port.
  assert.strictEqual(rows[0].court.name, 'Court 1');
  assert.strictEqual(rows[0].court.venueName, 'Test Padel Club');
  assert.strictEqual(rows[0].court.location, 'Dubai');
  assert.ok(rows[0].shares.length >= 2, 'shares should be loaded alongside');
});

test('listForUser also returns bookings where the caller only holds a share', async () => {
  const { players, booking } = await makeBooking({ hoursOut: 48 });
  const participant = players[0];

  const rows = await db.repo.bookings.listForUser(participant.id);

  assert.strictEqual(rows.length, 1, 'a payer sees the booking too, not just the organiser');
  assert.strictEqual(rows[0].id, booking.id);
});

test('listForUser returns nothing for an uninvolved user', async () => {
  const { owner } = await makeBooking({ hoursOut: 48 });

  // The venue owner is neither organiser nor payer on this booking.
  const rows = await db.repo.bookings.listForUser(owner.id);

  assert.deepStrictEqual(rows, []);
});

test('listForUser orders by slot start ascending', async () => {
  // Two bookings on one court, different slots, created out of order.
  const fixture = await db.seed({ participants: 1 });
  const at = (h) => new Date(Math.floor((Date.now() + h * 3600 * 1000) / 1000) * 1000);

  const later = await bookingService.createBooking({
    courtId: fixture.court.id,
    organiserId: fixture.organiser.id,
    slotStart: at(72),
    participantEmails: fixture.participantEmails
  });
  const sooner = await bookingService.createBooking({
    courtId: fixture.court.id,
    organiserId: fixture.organiser.id,
    slotStart: at(24),
    participantEmails: fixture.participantEmails
  });

  const rows = await db.repo.bookings.listForUser(fixture.organiser.id);

  assert.deepStrictEqual(
    rows.map((r) => r.id),
    [sooner.id, later.id],
    'soonest slot first, regardless of creation order'
  );
});

test('findByIdWithDetails attaches court and organiser', async () => {
  const { organiser, booking } = await makeBooking({ hoursOut: 48 });

  const found = await db.repo.bookings.findByIdWithDetails(booking.id);

  assert.strictEqual(found.id, booking.id);
  assert.strictEqual(found.organiserId, organiser.id);
  assert.strictEqual(found.organiser.email, 'organiser@test.local');
  assert.strictEqual(found.organiser.name, 'Organiser');
  assert.strictEqual(found.court.sport, 'padel');
  assert.ok(found.shares.every((s) => typeof s.userId === 'string'));
});

test('findByIdWithDetails returns null for an unknown or malformed id', async () => {
  await db.seed({ participants: 1 });

  assert.strictEqual(await db.repo.bookings.findByIdWithDetails('999999'), null);
  // A value that is not a valid identifier on either engine must not throw.
  assert.strictEqual(await db.repo.bookings.findByIdWithDetails('not-an-id'), null);
});
