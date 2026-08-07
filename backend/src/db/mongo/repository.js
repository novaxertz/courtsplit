/**
 * MongoDB persistence adapter.
 *
 * Wraps the original Mongoose models behind the repository contract and
 * returns plain domain objects rather than Mongoose documents. That boundary is
 * what lets bookingService be written once and run on either engine: the
 * service manipulates ordinary objects and never learns what stored them.
 *
 * The concurrency semantics are unchanged from the original implementation -
 * every state transition is still a single conditional write.
 */
const mongoose = require('mongoose');

const Booking = require('../../models/Booking');
const { BOOKING_STATUS, SHARE_STATUS } = require('../../models/Booking');
const Court = require('../../models/Court');
const User = require('../../models/User');
const WebhookEvent = require('../../models/WebhookEvent');
const { SlotTakenError } = require('../errors');

const LIVE_STATUSES = [BOOKING_STATUS.PENDING_PAYMENT, BOOKING_STATUS.CONFIRMED];

const id = (value) => (value === null || value === undefined ? null : value.toString());

function toShare(doc) {
  return {
    id: id(doc._id),
    userId: id(doc.user),
    email: doc.email,
    amount: doc.amount,
    status: doc.status,
    paymentRef: doc.paymentRef,
    paidAt: doc.paidAt,
    refundedAt: doc.refundedAt,
    refundAmount: doc.refundAmount
  };
}

function toBooking(doc) {
  if (!doc) return null;
  return {
    id: id(doc._id),
    courtId: id(doc.court),
    organiserId: id(doc.organiser),
    slotStart: doc.slotStart,
    slotEnd: doc.slotEnd,
    totalAmount: doc.totalAmount,
    currency: doc.currency,
    status: doc.status,
    fundingDeadline: doc.fundingDeadline,
    confirmedAt: doc.confirmedAt,
    cancelledAt: doc.cancelledAt,
    expiredAt: doc.expiredAt,
    shares: doc.shares.map(toShare)
  };
}

const courts = {
  async findById(courtId) {
    const doc = await Court.findById(courtId);
    if (!doc) return null;
    return {
      id: id(doc._id),
      capacity: doc.capacity,
      pricePerSlot: doc.pricePerSlot,
      currency: doc.currency,
      active: doc.active
    };
  }
};

const users = {
  async findById(userId) {
    const doc = await User.findById(userId);
    return doc ? { id: id(doc._id), email: doc.email } : null;
  },

  async findByEmails(emails) {
    const docs = await User.find({ email: { $in: emails } });
    return docs.map((d) => ({ id: id(d._id), email: d.email }));
  }
};

const bookings = {
  async create(data) {
    try {
      const doc = await Booking.create({
        court: data.courtId,
        organiser: data.organiserId,
        slotStart: data.slotStart,
        slotEnd: data.slotEnd,
        totalAmount: data.totalAmount,
        currency: data.currency,
        status: BOOKING_STATUS.PENDING_PAYMENT,
        fundingDeadline: data.fundingDeadline,
        shares: data.shares.map((s) => ({ user: s.userId, email: s.email, amount: s.amount }))
      });
      return toBooking(doc);
    } catch (err) {
      // 11000 is MongoDB's duplicate key error - the partial unique index on
      // (court, slotStart) rejected a second live booking for the slot.
      if (err.code === 11000) throw new SlotTakenError();
      throw err;
    }
  },

  async findById(bookingId) {
    if (!mongoose.isValidObjectId(bookingId)) return null;
    return toBooking(await Booking.findById(bookingId));
  },

  async attachPaymentRefs(bookingId, refs) {
    const doc = await Booking.findById(bookingId);
    if (!doc) return null;
    for (const { shareId, paymentRef } of refs) {
      const share = doc.shares.id(shareId);
      if (share) share.paymentRef = paymentRef;
    }
    await doc.save();
    return toBooking(doc);
  },

  /**
   * Settles one share, conditional on the booking still being open AND the
   * share still being pending. Returns null when nothing matched, which is how
   * a replayed callback becomes a no-op instead of a double credit.
   */
  async markSharePaidIfPending({ bookingId, shareId, at }) {
    if (!mongoose.isValidObjectId(bookingId)) return null;
    const doc = await Booking.findOneAndUpdate(
      {
        _id: bookingId,
        status: BOOKING_STATUS.PENDING_PAYMENT,
        shares: { $elemMatch: { _id: shareId, status: SHARE_STATUS.PENDING } }
      },
      { $set: { 'shares.$.status': SHARE_STATUS.PAID, 'shares.$.paidAt': at } },
      { new: true }
    );
    return toBooking(doc);
  },

  /** Confirms only from the open state, so a concurrent expiry cannot be overwritten. */
  async confirmIfPending(bookingId, at) {
    const doc = await Booking.findOneAndUpdate(
      { _id: bookingId, status: BOOKING_STATUS.PENDING_PAYMENT },
      { $set: { status: BOOKING_STATUS.CONFIRMED, confirmedAt: at } },
      { new: true }
    );
    return toBooking(doc);
  },

  async findExpiryCandidateIds(now) {
    const docs = await Booking.find(
      { status: BOOKING_STATUS.PENDING_PAYMENT, fundingDeadline: { $lte: now } },
      { _id: 1 }
    );
    return docs.map((d) => id(d._id));
  },

  /** Atomically claims a booking for expiry. Null means another worker won. */
  async claimExpiredIfPending(bookingId, at) {
    const doc = await Booking.findOneAndUpdate(
      { _id: bookingId, status: BOOKING_STATUS.PENDING_PAYMENT },
      { $set: { status: BOOKING_STATUS.EXPIRED, expiredAt: at } },
      { new: true }
    );
    return toBooking(doc);
  },

  /** Generic guarded transition, used by cancellation. */
  async claimTransition({ bookingId, from, to, at }) {
    const field = to === BOOKING_STATUS.CANCELLED ? 'cancelledAt' : 'expiredAt';
    const doc = await Booking.findOneAndUpdate(
      { _id: bookingId, status: from },
      { $set: { status: to, [field]: at } },
      { new: true }
    );
    return toBooking(doc);
  },

  /** Records refunds already executed against the payment provider. */
  async applyRefunds(bookingId, refunds) {
    const doc = await Booking.findById(bookingId);
    if (!doc) return null;
    for (const { shareId, amount, at } of refunds) {
      const share = doc.shares.id(shareId);
      if (!share) continue;
      share.status = SHARE_STATUS.REFUNDED;
      share.refundedAt = at;
      share.refundAmount = amount;
    }
    await doc.save();
    return toBooking(doc);
  },

  async countLiveForSlot({ courtId, slotStart }) {
    return Booking.countDocuments({
      court: courtId,
      slotStart,
      status: { $in: LIVE_STATUSES }
    });
  }
};

const webhookEvents = {
  /** True when this delivery is the first; false when it is a replay. */
  async recordIfNew({ eventId, type }) {
    try {
      await WebhookEvent.create({ eventId, type });
      return true;
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  },

  async countByEventId(eventId) {
    return WebhookEvent.countDocuments({ eventId });
  }
};

module.exports = { engine: 'mongo', courts, users, bookings, webhookEvents };
