const db = require('../db');
const bookingService = require('../services/bookingService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const create = asyncHandler(async (req, res) => {
  const { courtId, slotStart, participantEmails = [] } = req.body;

  if (!courtId || !slotStart) {
    throw ApiError.badRequest('courtId and slotStart are required');
  }
  if (!Array.isArray(participantEmails)) {
    throw ApiError.badRequest('participantEmails must be an array');
  }

  const booking = await bookingService.createBooking({
    courtId,
    organiserId: req.user.id,
    slotStart,
    participantEmails
  });

  res.status(201).json({ booking });
});

/** Bookings where the caller is the organiser or one of the payers. */
const listMine = asyncHandler(async (req, res) => {
  const bookings = await db.bookings.listForUser(req.user.id);
  res.json({ bookings });
});

const getOne = asyncHandler(async (req, res) => {
  const booking = await db.bookings.findByIdWithDetails(req.params.id);
  if (!booking) throw ApiError.notFound('Booking not found');

  // Domain objects carry ids as strings on both engines, so the membership
  // check is a plain comparison rather than ObjectId juggling.
  const involved =
    booking.organiserId === req.user.id ||
    booking.shares.some((s) => s.userId === req.user.id);
  if (!involved) throw ApiError.forbidden('You are not part of this booking');

  res.json({ booking });
});

const cancel = asyncHandler(async (req, res) => {
  const result = await bookingService.cancelBooking({
    bookingId: req.params.id,
    userId: req.user.id
  });
  res.json(result);
});

module.exports = { create, listMine, getOne, cancel };
