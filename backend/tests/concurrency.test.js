const test = require('node:test');
const assert = require('node:assert');

const db = require('./helpers/db');
const bookingService = require('../src/services/bookingService');
const { BOOKING_STATUS, SHARE_STATUS } = require('../src/domain/status');
const app = require('../src/app');

/**
 * Concurrency invariants - engine-agnostic.
 *
 * The booking service defends several properties with database-level
 * constructs rather than application checks. Those defences were previously
 * described only in comments; this suite asserts them.
 *
 * Every assertion is written against an *invariant* ("exactly one live booking
 * exists for the slot"), never a mechanism ("a partial unique index rejected
 * the write"). Invariants survive a change of storage engine; mechanisms do
 * not. Nothing in this file imports Mongoose, `pg`, or any driver - it reaches
 * storage only through the repository, which is why `DB_ENGINE=mongo` and
 * `DB_ENGINE=postgres` both run it unchanged.
 *
 * Concurrency is real despite Node being single-threaded: each service call
 * yields at its first `await`, so launching two before awaiting either means
 * both are in flight at the database simultaneously.
 */

test.before(db.start);
test.after(db.stop);
test.beforeEach(db.clear);

const shareById = (booking, shareId) => booking.shares.find((s) => String(s.id) === String(shareId));

// ---------------------------------------------------------------------------
// 1. Slot exclusivity
// ---------------------------------------------------------------------------
test('two racing bookings for the same slot yield exactly one winner', async () => {
  const { court, organiser, participantEmails, slotStart } = await db.seed();

  const attempt = () =>
    bookingService.createBooking({
      courtId: court.id,
      organiserId: organiser.id,
      slotStart,
      participantEmails
    });

  /**
   * `allSettled`, not `all`. We expect one rejection, and `Promise.all` would
   * reject immediately on it - discarding the other outcome and reporting a
   * raw error instead of letting us assert the shape of the race.
   */
  const results = await Promise.allSettled([attempt(), attempt()]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.strictEqual(fulfilled.length, 1, 'exactly one booking attempt should succeed');
  assert.strictEqual(rejected.length, 1, 'exactly one booking attempt should be refused');
  assert.strictEqual(
    rejected[0].reason.statusCode,
    409,
    'the losing attempt should surface as a clean 409 Conflict, not a raw driver error'
  );

  /**
   * The assertion that actually matters. Both API responses could be correct
   * while the stored state was wrong, so check the database itself.
   */
  const live = await db.repo.bookings.countLiveForSlot({ courtId: court.id, slotStart });
  assert.strictEqual(live, 1, 'the slot must hold exactly one live booking');
});

// ---------------------------------------------------------------------------
// 3. Duplicate settlement of a single share
// ---------------------------------------------------------------------------
/**
 * The same share settled twice at once.
 *
 * This is the webhook-replay case reduced to the service layer: two callbacks
 * for one payment arriving together. The conditional write must apply once.
 *
 * The booking here has two shares and only one is settled, so a correct system
 * also must NOT confirm - which is why the status assertion is as important as
 * the share count. A double-apply that also tripped confirmation would be a
 * booking marked fully funded while half the money was never collected.
 */
test('settling one share twice concurrently applies it once and does not confirm', async () => {
  const { court, organiser, participantEmails, slotStart } = await db.seed({ participants: 1 });
  const booking = await bookingService.createBooking({
    courtId: court.id,
    organiserId: organiser.id,
    slotStart,
    participantEmails
  });
  assert.strictEqual(booking.shares.length, 2, 'fixture should produce two shares');

  const target = booking.shares[0];
  await Promise.allSettled([
    bookingService.markSharePaid({ bookingId: booking.id, shareId: target.id }),
    bookingService.markSharePaid({ bookingId: booking.id, shareId: target.id })
  ]);

  const after = await db.repo.bookings.findById(booking.id);

  const paid = after.shares.filter((s) => s.status === SHARE_STATUS.PAID);
  assert.strictEqual(paid.length, 1, 'exactly one share should be paid');
  assert.strictEqual(String(paid[0].id), String(target.id), 'and it should be the targeted share');

  assert.strictEqual(
    after.status,
    BOOKING_STATUS.PENDING_PAYMENT,
    'a booking with an unpaid share must not be confirmed'
  );
});

// ---------------------------------------------------------------------------
// 5. Convergence on confirmation
// ---------------------------------------------------------------------------
/**
 * Every share settling at once.
 *
 * Both callbacks can observe "all shares are now paid" and both will attempt
 * the confirming transition. Only one may take effect: `confirmedAt` is the
 * moment the slot became the group's, and overwriting it later would corrupt
 * an audit trail and could re-fire confirmation side effects.
 *
 * Note what this does and does not prove. It shows the system converges on a
 * single confirmation under the interleavings that occur. As with the expiry
 * race below, it samples orderings rather than enumerating them.
 */
test('all shares settling at once confirms the booking exactly once', async () => {
  const { court, organiser, participantEmails, slotStart } = await db.seed({ participants: 1 });
  const booking = await bookingService.createBooking({
    courtId: court.id,
    organiserId: organiser.id,
    slotStart,
    participantEmails
  });

  const results = await Promise.allSettled(
    booking.shares.map((s) =>
      bookingService.markSharePaid({ bookingId: booking.id, shareId: s.id })
    )
  );
  assert.ok(
    results.every((r) => r.status === 'fulfilled'),
    'settling distinct shares should never throw'
  );

  const after = await db.repo.bookings.findById(booking.id);

  assert.strictEqual(after.status, BOOKING_STATUS.CONFIRMED, 'the booking should be confirmed');
  assert.ok(
    after.shares.every((s) => s.status === SHARE_STATUS.PAID),
    'every share should be paid'
  );
  assert.ok(after.confirmedAt, 'confirmedAt should be recorded');

  /**
   * Confirmation must be terminal with respect to the funding flow. Re-running
   * a settlement afterwards must not move the booking or re-stamp the time.
   */
  const stamp = new Date(after.confirmedAt).getTime();
  await bookingService.markSharePaid({
    bookingId: booking.id,
    shareId: booking.shares[0].id
  });
  const again = await db.repo.bookings.findById(booking.id);
  assert.strictEqual(again.status, BOOKING_STATUS.CONFIRMED, 'status should be unchanged');
  assert.strictEqual(
    new Date(again.confirmedAt).getTime(),
    stamp,
    'confirmedAt must not be overwritten by a late replay'
  );
});

// ---------------------------------------------------------------------------
// 4. Expiry racing the final payment
// ---------------------------------------------------------------------------
/**
 * The hard case: two *different* operations racing for the same booking.
 *
 * A booking one share short of fully funded, sitting on its funding deadline,
 * can be resolved two legitimate ways at the same instant. The final payment
 * arrives and it should confirm; the expiry sweep runs and it should expire and
 * refund. Both paths are individually correct. This asserts they are correct
 * together.
 *
 * Repeated rather than run once, because which side wins depends on
 * scheduling. Set RACE_ITERATIONS to raise the count.
 *
 * KNOWN LIMITATION, measured rather than assumed.
 *
 * This samples interleavings; it does not enumerate them. Removing the
 * booking-status guard from the share-settlement write - which should in
 * principle let a share be paid after expiry claimed the booking, stranding an
 * unrefunded payment - did NOT fail this test at 600 iterations on MongoDB
 * (434 confirmed / 166 expired, zero violations). The required interleaving
 * never arose under natural scheduling.
 *
 * So a pass means the invariant held for the orderings that occurred, not that
 * it always holds. Catching that class of bug needs a forced interleaving: a
 * seam that suspends expiry between claiming the booking and reading its
 * shares for refund. Worth adding; not yet done.
 *
 * SECOND LIMITATION, specific to PostgreSQL and worse than the first.
 *
 * The printed outcome counts show the distribution is not merely uneven, it is
 * degenerate: MongoDB produces a mix (11 confirmed / 14 expired at 25
 * iterations) while PostgreSQL produced 0 confirmed / 25 expired. Settlement on
 * Postgres opens a transaction and takes a `SELECT ... FOR UPDATE` before
 * writing, so it is reliably slower than the sweep's single UPDATE and loses
 * every time. The confirm-wins branch is therefore never exercised on Postgres
 * - the test passes while covering half of what it covers on Mongo.
 *
 * Treat the printed counts as part of the result, not decoration. A run of
 * 25/0 either way means this test verified one ordering.
 *
 * On PostgreSQL the fix is also more tractable: two connections can each hold
 * an open transaction while the test controls commit ordering, making both
 * branches reachable deterministically. Standalone MongoDB has no transaction
 * to hold open.
 */
test('expiry racing the final payment leaves exactly one coherent terminal state', async () => {
  const ITERATIONS = Number(process.env.RACE_ITERATIONS || 25);
  const outcomes = { CONFIRMED: 0, EXPIRED: 0 };

  for (let i = 0; i < ITERATIONS; i += 1) {
    /* eslint-disable no-await-in-loop */
    await db.clear();
    const { court, organiser, participantEmails, slotStart } = await db.seed({ participants: 1 });

    const booking = await bookingService.createBooking({
      courtId: court.id,
      organiserId: organiser.id,
      slotStart,
      participantEmails
    });

    // Settle the first share normally, leaving the booking one payment short.
    await bookingService.markSharePaid({
      bookingId: booking.id,
      shareId: booking.shares[0].id
    });

    // Push the deadline into the past so the sweep treats it as a candidate.
    await db.setFundingDeadline(booking.id, new Date(Date.now() - 1000));

    // The race. Neither is awaited before the other starts.
    await Promise.allSettled([
      bookingService.markSharePaid({ bookingId: booking.id, shareId: booking.shares[1].id }),
      bookingService.expireUnfundedBookings(new Date())
    ]);

    const final = await db.repo.bookings.findById(booking.id);

    assert.ok(
      [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EXPIRED].includes(final.status),
      `iteration ${i}: booking must reach a terminal state, got ${final.status}`
    );
    outcomes[final.status] += 1;

    if (final.status === BOOKING_STATUS.CONFIRMED) {
      assert.ok(
        final.shares.every((s) => s.status === SHARE_STATUS.PAID),
        `iteration ${i}: a confirmed booking must have every share paid`
      );
    } else {
      /**
       * The money-safety invariant. A share still sitting in `paid` on an
       * expired booking is a payment held for a slot that will never happen.
       */
      const stillHeld = final.shares.filter((s) => s.status === SHARE_STATUS.PAID);
      assert.strictEqual(
        stillHeld.length,
        0,
        `iteration ${i}: expired booking still holds ${stillHeld.length} unrefunded paid share(s)`
      );
    }
    /* eslint-enable no-await-in-loop */
  }

  // Not an assertion - just visibility into which orderings were exercised.
  console.log(`      [${db.engineName}] raced ${ITERATIONS}x ->`, outcomes);
});

// ---------------------------------------------------------------------------
// 2. Webhook replay, over real HTTP
// ---------------------------------------------------------------------------
/**
 * Boots the real Express app on an ephemeral port.
 *
 * The webhook route is mounted with `express.raw` ahead of the JSON parser,
 * because signature verification hashes the exact bytes received. Driving it
 * over HTTP rather than calling the controller with a stub req/res keeps that
 * raw-body wiring inside the test's coverage - a hand-rolled stub would happily
 * pass while the real route was misconfigured.
 */
function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

function deliver(url, event) {
  return fetch(`${url}/webhooks/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
}

function paymentSucceeded({ eventId, bookingId, shareId }) {
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    data: { object: { metadata: { bookingId, shareId } } }
  };
}

test('a replayed webhook is recorded and applied exactly once', async () => {
  const { court, organiser, participantEmails, slotStart } = await db.seed();
  const booking = await bookingService.createBooking({
    courtId: court.id,
    organiserId: organiser.id,
    slotStart,
    participantEmails
  });

  const share = booking.shares[0];
  const event = paymentSucceeded({
    eventId: 'evt_replay_fixture_1',
    bookingId: booking.id,
    shareId: String(share.id)
  });

  const http = await startServer();
  try {
    /**
     * Two simultaneous deliveries of the same event id. Providers retry until
     * they see a 2xx, and a slow first response is exactly how the same event
     * ends up in flight twice.
     */
    const responses = await Promise.all([deliver(http.url, event), deliver(http.url, event)]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    assert.ok(
      responses.every((r) => r.status === 200),
      'both deliveries must be acknowledged, or the provider will keep retrying forever'
    );

    const duplicates = bodies.filter((b) => b.duplicate === true);
    assert.strictEqual(duplicates.length, 1, 'exactly one delivery should be reported duplicate');

    const recorded = await db.repo.webhookEvents.countByEventId(event.id);
    assert.strictEqual(recorded, 1, 'the event must be recorded exactly once');

    // And the effect still happened - deduplication must not swallow the work.
    const after = await db.repo.bookings.findById(booking.id);
    assert.strictEqual(
      shareById(after, share.id).status,
      SHARE_STATUS.PAID,
      'the share should be marked paid'
    );
  } finally {
    await http.close();
  }
});

test('a webhook redelivered after the first completed is ignored', async () => {
  const { court, organiser, participantEmails, slotStart } = await db.seed();
  const booking = await bookingService.createBooking({
    courtId: court.id,
    organiserId: organiser.id,
    slotStart,
    participantEmails
  });

  const share = booking.shares[0];
  const event = paymentSucceeded({
    eventId: 'evt_replay_fixture_2',
    bookingId: booking.id,
    shareId: String(share.id)
  });

  const http = await startServer();
  try {
    /**
     * Sequential rather than concurrent: the ordinary retry case, where the
     * provider timed out waiting for the first acknowledgement and sent the
     * event again minutes later. Same constraint, no race - both paths must
     * reach the same state.
     */
    const first = await (await deliver(http.url, event)).json();
    const second = await (await deliver(http.url, event)).json();

    assert.strictEqual(first.duplicate, undefined, 'the first delivery is not a duplicate');
    assert.strictEqual(second.duplicate, true, 'the redelivery must be recognised');

    const recorded = await db.repo.webhookEvents.countByEventId(event.id);
    assert.strictEqual(recorded, 1, 'redelivery must not add a second ledger row');
  } finally {
    await http.close();
  }
});
