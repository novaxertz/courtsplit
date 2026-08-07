/**
 * Booking domain logic.
 *
 * Persistence is reached only through the repository in `src/db`, which is
 * selected by `DB_ENGINE`. Nothing below knows whether it is talking to
 * MongoDB or PostgreSQL: no model imports, no driver error codes, no query
 * syntax. That is what lets the same concurrency suite run on both engines.
 *
 * The concurrency design is unchanged from the document-only version. Every
 * state transition is still expressed as a conditional write that either
 * matches and applies, or matches nothing and is a no-op. Whether that
 * conditionality is enforced by a Mongo query filter or a SQL WHERE clause
 * plus a row lock is the adapter's problem, not this file's.
 */
const db = require('../db');
const { SlotTakenError } = require('../db/errors');
const { BOOKING_STATUS, SHARE_STATUS } = require('../domain/status');
const payments = require('./payments');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { splitAmount, percentageOf } = require('../utils/money');

async function resolveParticipants(emails) {
  const found = await db.users.findByEmails(emails);
  const byEmail = new Map(found.map((u) => [u.email, u]));
  const missing = emails.filter((e) => !byEmail.has(e));
  if (missing.length) {
    throw ApiError.badRequest('Some participants are not registered', { missing });
  }
  return emails.map((e) => byEmail.get(e));
}

/**
 * Creates a booking and one payment intent per participant.
 *
 * The slot is claimed immediately in PENDING_PAYMENT state so nobody else can
 * take it while the group pays. A partial unique constraint on
 * (court, slotStart) makes that claim atomic: if two groups submit
 * simultaneously the database rejects the second rather than both appearing to
 * succeed. The adapter raises SlotTakenError for whichever driver error its
 * engine produced.
 */
async function createBooking({ courtId, organiserId, slotStart, participantEmails }) {
  const court = await db.courts.findById(courtId);
  if (!court || !court.active) {
    throw ApiError.notFound('Court not found');
  }

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) {
    throw ApiError.badRequest('slotStart must be a valid ISO date');
  }
  if (start.getTime() <= Date.now()) {
    throw ApiError.badRequest('Cannot book a slot in the past');
  }

  const organiser = await db.users.findById(organiserId);
  if (!organiser) throw ApiError.notFound('Organiser not found');

  const emails = [...new Set([organiser.email, ...participantEmails.map((e) => e.toLowerCase())])];
  if (emails.length > court.capacity) {
    throw ApiError.badRequest(
      `This court holds ${court.capacity} players, ${emails.length} were provided`
    );
  }

  const participants = await resolveParticipants(emails);
  const amounts = splitAmount(court.pricePerSlot, participants.length);

  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fundingDeadline = new Date(
    Math.min(Date.now() + config.booking.fundingWindowMinutes * 60 * 1000, start.getTime())
  );

  let booking;
  try {
    booking = await db.bookings.create({
      courtId: court.id,
      organiserId: organiser.id,
      slotStart: start,
      slotEnd: end,
      totalAmount: court.pricePerSlot,
      currency: court.currency,
      fundingDeadline,
      shares: participants.map((user, i) => ({
        userId: user.id,
        email: user.email,
        amount: amounts[i]
      }))
    });
  } catch (err) {
    if (err instanceof SlotTakenError) {
      throw ApiError.conflict('That slot has already been booked');
    }
    throw err;
  }

  // One intent per share, so each participant pays only their own portion.
  const refs = await Promise.all(
    booking.shares.map(async (share) => {
      const intent = await payments.createPaymentIntent({
        amount: share.amount,
        currency: booking.currency,
        metadata: { bookingId: booking.id, shareId: share.id },
        idempotencyKey: `booking_${booking.id}_share_${share.id}`
      });
      return { shareId: share.id, paymentRef: intent.id };
    })
  );
  const withRefs = await db.bookings.attachPaymentRefs(booking.id, refs);

  logger.info('Booking created', { bookingId: booking.id, shares: booking.shares.length });
  return withRefs || booking;
}

/**
 * Marks one share paid and confirms the booking once every share has settled.
 *
 * The settlement is a single conditional write matching both the booking's
 * open state and the share's pending state. A duplicate webhook therefore
 * matches nothing on its second delivery and changes nothing, which keeps the
 * operation idempotent without an application-level lock.
 */
async function markSharePaid({ bookingId, shareId }) {
  const updated = await db.bookings.markSharePaidIfPending({
    bookingId,
    shareId,
    at: new Date()
  });

  if (!updated) {
    logger.debug('Share already settled or booking no longer pending', { bookingId, shareId });
    return db.bookings.findById(bookingId);
  }

  if (updated.shares.every((s) => s.status === SHARE_STATUS.PAID)) {
    // Guarded again on the open state so a concurrent expiry cannot be
    // overwritten. Null means expiry won the race; the booking stays expired.
    const confirmed = await db.bookings.confirmIfPending(updated.id, new Date());
    if (confirmed) {
      logger.info('Booking fully funded and confirmed', { bookingId: confirmed.id });
      return confirmed;
    }
  }

  return updated;
}

/**
 * Issues refunds for every paid share and records them.
 *
 * Returns the refreshed booking. The provider calls happen before the database
 * writes so a failed refund does not leave a share marked refunded that never
 * was; the idempotency key makes a retry safe.
 */
async function refundPaidShares(booking, percent = 100) {
  const paid = booking.shares.filter((s) => s.status === SHARE_STATUS.PAID);
  if (!paid.length) return booking;

  const refunds = [];
  await Promise.all(
    paid.map(async (share) => {
      const amount = percentageOf(share.amount, percent);
      if (amount <= 0) return;
      await payments.refund({
        paymentRef: share.paymentRef,
        amount,
        idempotencyKey: `refund_${booking.id}_${share.id}`
      });
      refunds.push({ shareId: share.id, amount, at: new Date() });
    })
  );

  if (!refunds.length) return booking;
  return (await db.bookings.applyRefunds(booking.id, refunds)) || booking;
}

/**
 * Expires bookings that were not fully funded before their deadline and
 * refunds whoever had already paid. The claim is a conditional transition, so
 * this is safe to run on a schedule and on more than one instance at once -
 * losers of the race simply skip the booking.
 */
async function expireUnfundedBookings(now = new Date()) {
  const candidateIds = await db.bookings.findExpiryCandidateIds(now);

  const expired = [];
  for (const candidateId of candidateIds) {
    // eslint-disable-next-line no-await-in-loop
    const claimed = await db.bookings.claimExpiredIfPending(candidateId, now);
    if (!claimed) continue; // another worker got there first

    // eslint-disable-next-line no-await-in-loop
    const settled = await refundPaidShares(claimed, 100);
    expired.push(settled);
    logger.info('Booking expired and refunded', { bookingId: claimed.id });
  }
  return expired;
}

/**
 * Cancels a booking. Refund percentage depends on how much notice was given,
 * mirroring how venues actually price late cancellations.
 */
async function cancelBooking({ bookingId, userId }) {
  const booking = await db.bookings.findById(bookingId);
  if (!booking) throw ApiError.notFound('Booking not found');
  if (String(booking.organiserId) !== String(userId)) {
    throw ApiError.forbidden('Only the organiser can cancel this booking');
  }
  if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.EXPIRED].includes(booking.status)) {
    throw ApiError.conflict(`Booking is already ${booking.status.toLowerCase()}`);
  }

  const hoursUntilStart =
    (new Date(booking.slotStart).getTime() - Date.now()) / (1000 * 60 * 60);
  const percent =
    hoursUntilStart >= config.booking.freeCancellationHours
      ? 100
      : config.booking.lateCancellationRefundPercent;

  const claimed = await db.bookings.claimTransition({
    bookingId: booking.id,
    from: booking.status,
    to: BOOKING_STATUS.CANCELLED,
    at: new Date()
  });
  if (!claimed) throw ApiError.conflict('Booking changed while cancelling, retry');

  const settled = await refundPaidShares(claimed, percent);

  logger.info('Booking cancelled', { bookingId: claimed.id, refundPercent: percent });
  return { booking: settled, refundPercent: percent };
}

module.exports = {
  createBooking,
  markSharePaid,
  expireUnfundedBookings,
  cancelBooking
};
