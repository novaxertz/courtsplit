/**
 * Domain status vocabulary.
 *
 * Lifted out of the Mongoose model so the service layer and the PostgreSQL
 * adapter can share it without either importing the other's persistence
 * library. The string values are deliberately identical to the ones already
 * stored, so this is a refactor with no data migration.
 */

const BOOKING_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
};

const SHARE_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  REFUNDED: 'refunded'
};

const LIVE_BOOKING_STATUSES = [BOOKING_STATUS.PENDING_PAYMENT, BOOKING_STATUS.CONFIRMED];

module.exports = { BOOKING_STATUS, SHARE_STATUS, LIVE_BOOKING_STATUSES };
