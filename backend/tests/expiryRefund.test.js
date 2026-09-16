const test = require('node:test');
const assert = require('node:assert');

const db = require('./helpers/db');
const bookingService = require('../src/services/bookingService');
const payments = require('../src/services/payments');
const { BOOKING_STATUS, SHARE_STATUS } = require('../src/domain/status');

/**
 * Refund failures during expiry - engine-agnostic.
 *
 * The sweep claims a booking (PENDING_PAYMENT -> EXPIRED) before refunding it.
 * Previously a refund failure at that point left the booking EXPIRED with a
 * share still `paid`, and since only PENDING_PAYMENT bookings were candidates,
 * no later sweep ever looked at it again: the money was held for a slot that
 * would never happen. It also aborted the sweep, skipping every booking after
 * it. Found by running the one-shot CronJob script against a live stack.
 */

test.before(db.start);
test.after(db.stop);
test.beforeEach(db.clear);

const realRefund = payments.refund;
test.afterEach(() => {
  payments.refund = realRefund;
});

const MINUTE = 60 * 1000;
const later = (minutes) => new Date(Date.now() + minutes * MINUTE);

/** A booking past its funding deadline with the first `paid` shares settled. */
async function unfundedBooking(fixture, { paid, offsetHours = 0 }) {
  const booking = await bookingService.createBooking({
    courtId: fixture.court.id,
    organiserId: fixture.organiser.id,
    slotStart: new Date(fixture.slotStart.getTime() + offsetHours * 3600 * 1000),
    participantEmails: fixture.participantEmails
  });
  for (const share of booking.shares.slice(0, paid)) {
    // eslint-disable-next-line no-await-in-loop
    await bookingService.markSharePaid({ bookingId: booking.id, shareId: share.id });
  }
  await db.setFundingDeadline(booking.id, new Date(Date.now() - 1000));
  return db.repo.bookings.findById(booking.id);
}

/** Replaces the provider's refund, failing for the given payment refs. */
function failRefundsFor(refs) {
  const calls = [];
  payments.refund = async (args) => {
    calls.push(args.paymentRef);
    if (refs.includes(args.paymentRef)) throw new Error('provider unavailable');
    return realRefund(args);
  };
  return calls;
}

test('a failed refund is retried by a later sweep instead of being stranded', async () => {
  const fixture = await db.seed({ participants: 2 });
  const booking = await unfundedBooking(fixture, { paid: 2 });
  const [failing, succeeding] = booking.shares;

  const calls = failRefundsFor([failing.paymentRef]);
  await assert.rejects(() => bookingService.expireUnfundedBookings(new Date()), /could not be refunded/);

  let after = await db.repo.bookings.findById(booking.id);
  assert.strictEqual(after.status, BOOKING_STATUS.EXPIRED);
  const share = (b, s) => b.shares.find((x) => String(x.id) === String(s.id));
  assert.strictEqual(share(after, failing).status, SHARE_STATUS.PAID, 'the failed refund is still owed');
  assert.strictEqual(
    share(after, succeeding).status,
    SHARE_STATUS.REFUNDED,
    'a refund that went through must be recorded even though its sibling failed'
  );

  // Inside the grace window the booking may still be mid-refund on the worker
  // that claimed it, so an immediate sweep must leave it alone.
  calls.length = 0;
  await bookingService.expireUnfundedBookings(new Date());
  assert.deepStrictEqual(calls, [], 'no retry inside the grace window');

  // Provider recovered; a sweep after the grace window settles the rest.
  payments.refund = realRefund;
  const retryCalls = failRefundsFor([]);
  const settled = await bookingService.expireUnfundedBookings(later(6));
  assert.strictEqual(settled.length, 1);

  after = await db.repo.bookings.findById(booking.id);
  assert.ok(after.shares.filter((s) => s.paidAt).every((s) => s.status === SHARE_STATUS.REFUNDED));
  assert.strictEqual(share(after, failing).refundAmount, failing.amount);
  assert.deepStrictEqual(retryCalls, [failing.paymentRef], 'the already-refunded share is not refunded twice');

  // Nothing left owed: further sweeps are no-ops.
  assert.deepStrictEqual(await bookingService.expireUnfundedBookings(later(12)), []);
});

test('one booking failing to refund does not stop the sweep refunding the others', async () => {
  const fixture = await db.seed({ participants: 1 });
  const broken = await unfundedBooking(fixture, { paid: 1, offsetHours: 0 });
  const healthy = await unfundedBooking(fixture, { paid: 1, offsetHours: 1 });

  failRefundsFor([broken.shares[0].paymentRef]);
  const err = await bookingService.expireUnfundedBookings(new Date()).catch((e) => e);

  assert.ok(err instanceof Error, 'the sweep must report the failure so a CronJob run fails');
  assert.deepStrictEqual(err.failures.map((f) => f.bookingId), [broken.id]);

  const healthyAfter = await db.repo.bookings.findById(healthy.id);
  assert.strictEqual(healthyAfter.status, BOOKING_STATUS.EXPIRED);
  assert.strictEqual(healthyAfter.shares[0].status, SHARE_STATUS.REFUNDED, 'the healthy booking is refunded');

  const brokenAfter = await db.repo.bookings.findById(broken.id);
  assert.strictEqual(brokenAfter.status, BOOKING_STATUS.EXPIRED);
  assert.strictEqual(brokenAfter.shares[0].status, SHARE_STATUS.PAID);
});
