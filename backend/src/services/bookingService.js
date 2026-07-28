const Booking = require('../models/Booking');
const { BOOKING_STATUS, SHARE_STATUS } = require('../models/Booking');
const Court = require('../models/Court');
const User = require('../models/User');
const payments = require('./payments');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { splitAmount, percentageOf } = require('../utils/money');

async function resolveParticipants(emails) {
  const users = await User.find({ email: { $in: emails } });
  const byEmail = new Map(users.map((u) => [u.email, u]));
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
 * take it while the group pays. A unique partial index on (court, slotStart)
 * makes that claim atomic: if two groups submit simultaneously, the database
 * rejects the second rather than both appearing to succeed.
 */
async function createBooking({ courtId, organiserId, slotStart, participantEmails }) {
  const court = await Court.findById(courtId);
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

  const organiser = await User.findById(organiserId);
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
    Math.min(
      Date.now() + config.booking.fundingWindowMinutes * 60 * 1000,
      start.getTime()
    )
  );

  let booking;
  try {
    booking = await Booking.create({
      court: court._id,
      organiser: organiser._id,
      slotStart: start,
      slotEnd: end,
      totalAmount: court.pricePerSlot,
      currency: court.currency,
      status: BOOKING_STATUS.PENDING_PAYMENT,
      fundingDeadline,
      shares: participants.map((user, i) => ({
        user: user._id,
        email: user.email,
        amount: amounts[i]
      }))
    });
  } catch (err) {
    // 11000 is MongoDB's duplicate key error - the slot was claimed first.
    if (err.code === 11000) {
      throw ApiError.conflict('That slot has already been booked');
    }
    throw err;
  }

  // One intent per share, so each participant pays only their own portion.
  await Promise.all(
    booking.shares.map(async (share) => {
      const intent = await payments.createPaymentIntent({
        amount: share.amount,
        currency: booking.currency,
        metadata: { bookingId: booking.id, shareId: share._id.toString() },
        idempotencyKey: `booking_${booking.id}_share_${share._id}`
      });
      share.paymentRef = intent.id;
    })
  );
  await booking.save();

  logger.info('Booking created', { bookingId: booking.id, shares: booking.shares.length });
  return booking;
}

/**
 * Marks one share paid and confirms the booking once every share has settled.
 *
 * The update is expressed as a single conditional write matching the share's
 * pending state. A duplicate webhook therefore matches nothing on its second
 * delivery and changes no state, which keeps the operation idempotent without
 * needing a lock.
 */
async function markSharePaid({ bookingId, shareId }) {
  const updated = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      status: BOOKING_STATUS.PENDING_PAYMENT,
      shares: { $elemMatch: { _id: shareId, status: SHARE_STATUS.PENDING } }
    },
    {
      $set: {
        'shares.$.status': SHARE_STATUS.PAID,
        'shares.$.paidAt': new Date()
      }
    },
    { new: true }
  );

  if (!updated) {
    logger.debug('Share already settled or booking no longer pending', { bookingId, shareId });
    return Booking.findById(bookingId);
  }

  if (updated.shares.every((s) => s.status === SHARE_STATUS.PAID)) {
    // Guarded again on status so a concurrent expiry cannot be overwritten.
    const confirmed = await Booking.findOneAndUpdate(
      { _id: updated._id, status: BOOKING_STATUS.PENDING_PAYMENT },
      { $set: { status: BOOKING_STATUS.CONFIRMED, confirmedAt: new Date() } },
      { new: true }
    );
    if (confirmed) {
      logger.info('Booking fully funded and confirmed', { bookingId: confirmed.id });
      return confirmed;
    }
  }

  return updated;
}

async function refundShares(booking, percent = 100) {
  const paid = booking.shares.filter((s) => s.status === SHARE_STATUS.PAID);
  await Promise.all(
    paid.map(async (share) => {
      const amount = percentageOf(share.amount, percent);
      if (amount <= 0) return;
      await payments.refund({
        paymentRef: share.paymentRef,
        amount,
        idempotencyKey: `refund_${booking.id}_${share._id}`
      });
      share.status = SHARE_STATUS.REFUNDED;
      share.refundedAt = new Date();
      share.refundAmount = amount;
    })
  );
  return booking;
}

/**
 * Expires bookings that were not fully funded before their deadline and
 * refunds whoever had already paid. Written as a conditional transition so it
 * is safe to run on a schedule and on more than one instance at once.
 */
async function expireUnfundedBookings(now = new Date()) {
  const candidates = await Booking.find({
    status: BOOKING_STATUS.PENDING_PAYMENT,
    fundingDeadline: { $lte: now }
  });

  const expired = [];
  for (const candidate of candidates) {
    const claimed = await Booking.findOneAndUpdate(
      { _id: candidate._id, status: BOOKING_STATUS.PENDING_PAYMENT },
      { $set: { status: BOOKING_STATUS.EXPIRED, expiredAt: now } },
      { new: true }
    );
    if (!claimed) continue; // another worker got there first

    await refundShares(claimed, 100);
    await claimed.save();
    expired.push(claimed);
    logger.info('Booking expired and refunded', { bookingId: claimed.id });
  }
  return expired;
}

/**
 * Cancels a booking. Refund percentage depends on how much notice was given,
 * mirroring how venues actually price late cancellations.
 */
async function cancelBooking({ bookingId, userId }) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.organiser.toString() !== userId) {
    throw ApiError.forbidden('Only the organiser can cancel this booking');
  }
  if ([BOOKING_STATUS.CANCELLED, BOOKING_STATUS.EXPIRED].includes(booking.status)) {
    throw ApiError.conflict(`Booking is already ${booking.status.toLowerCase()}`);
  }

  const hoursUntilStart = (booking.slotStart.getTime() - Date.now()) / (1000 * 60 * 60);
  const percent =
    hoursUntilStart >= config.booking.freeCancellationHours
      ? 100
      : config.booking.lateCancellationRefundPercent;

  const claimed = await Booking.findOneAndUpdate(
    { _id: booking._id, status: booking.status },
    { $set: { status: BOOKING_STATUS.CANCELLED, cancelledAt: new Date() } },
    { new: true }
  );
  if (!claimed) throw ApiError.conflict('Booking changed while cancelling, retry');

  await refundShares(claimed, percent);
  await claimed.save();

  logger.info('Booking cancelled', { bookingId: claimed.id, refundPercent: percent });
  return { booking: claimed, refundPercent: percent };
}

module.exports = {
  createBooking,
  markSharePaid,
  expireUnfundedBookings,
  cancelBooking
};
