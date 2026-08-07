const mongoose = require('mongoose');

// Shared with the service layer and the PostgreSQL adapter.
const { BOOKING_STATUS, SHARE_STATUS } = require('../domain/status');

/** One participant's portion of a booking. */
const shareSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(SHARE_STATUS),
      default: SHARE_STATUS.PENDING
    },
    paymentRef: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundAmount: { type: Number, default: 0 }
  },
  { _id: true }
);

const bookingSchema = new mongoose.Schema(
  {
    court: { type: mongoose.Schema.Types.ObjectId, ref: 'Court', required: true },
    organiser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'AED' },
    status: {
      type: String,
      enum: Object.values(BOOKING_STATUS),
      default: BOOKING_STATUS.PENDING_PAYMENT,
      index: true
    },
    shares: {
      type: [shareSchema],
      validate: [(v) => v.length > 0, 'A booking needs at least one share']
    },
    // Every share must be paid before this instant or the booking expires and
    // paid shares are refunded.
    fundingDeadline: { type: Date, required: true, index: true },
    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null }
  },
  { timestamps: true }
);

/**
 * Double-booking guard enforced by the database rather than application code.
 * A partial unique index means only live bookings (pending or confirmed)
 * occupy a slot; expired and cancelled ones free it again.
 */
bookingSchema.index(
  { court: 1, slotStart: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [BOOKING_STATUS.PENDING_PAYMENT, BOOKING_STATUS.CONFIRMED] }
    }
  }
);

bookingSchema.virtual('paidAmount').get(function paidAmount() {
  return this.shares
    .filter((s) => s.status === SHARE_STATUS.PAID)
    .reduce((sum, s) => sum + s.amount, 0);
});

bookingSchema.virtual('isFullyFunded').get(function isFullyFunded() {
  return this.shares.every((s) => s.status === SHARE_STATUS.PAID);
});

bookingSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.__v;
    delete ret.id;
    return ret;
  }
});

module.exports = mongoose.model('Booking', bookingSchema);
module.exports.BOOKING_STATUS = BOOKING_STATUS;
module.exports.SHARE_STATUS = SHARE_STATUS;
