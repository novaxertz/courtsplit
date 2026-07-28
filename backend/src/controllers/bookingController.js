const Booking = require('../models/Booking');
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
  const bookings = await Booking.find({
    $or: [{ organiser: req.user.id }, { 'shares.user': req.user.id }]
  })
    .populate('court', 'name venueName location sport')
    .sort({ slotStart: 1 });

  res.json({ bookings });
});

const getOne = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id)
    .populate('court', 'name venueName location sport')
    .populate('organiser', 'name email');

  if (!booking) throw ApiError.notFound('Booking not found');

  const involved =
    booking.organiser._id.toString() === req.user.id ||
    booking.shares.some((s) => s.user.toString() === req.user.id);
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
