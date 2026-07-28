const Court = require('../models/Court');
const Booking = require('../models/Booking');
const { BOOKING_STATUS } = require('../models/Booking');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const { sport, location, maxPrice, page = 1, limit = 20 } = req.query;

  const filter = { active: true };
  if (sport) filter.sport = sport;
  if (location) filter.location = new RegExp(location, 'i');
  if (maxPrice) filter.pricePerSlot = { $lte: Number(maxPrice) };

  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [courts, total] = await Promise.all([
    Court.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
    Court.countDocuments(filter)
  ]);

  res.json({ courts, total, page: Number(page), limit: Number(limit) });
});

const create = asyncHandler(async (req, res) => {
  const { name, venueName, location, sport, pricePerSlot, capacity } = req.body;

  if (!name || !venueName || !location || pricePerSlot === undefined) {
    throw ApiError.badRequest('name, venueName, location and pricePerSlot are required');
  }
  if (!Number.isInteger(pricePerSlot) || pricePerSlot < 0) {
    throw ApiError.badRequest('pricePerSlot must be a non-negative integer in fils');
  }

  const court = await Court.create({
    name,
    venueName,
    location,
    sport,
    pricePerSlot,
    capacity,
    owner: req.user.id
  });

  res.status(201).json({ court });
});

/** Slots already taken by a live booking, so the client can grey them out. */
const availability = asyncHandler(async (req, res) => {
  const court = await Court.findById(req.params.id);
  if (!court) throw ApiError.notFound('Court not found');

  const from = req.query.from ? new Date(req.query.from) : new Date();
  const to = req.query.to
    ? new Date(req.query.to)
    : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

  const taken = await Booking.find({
    court: court._id,
    status: { $in: [BOOKING_STATUS.PENDING_PAYMENT, BOOKING_STATUS.CONFIRMED] },
    slotStart: { $gte: from, $lte: to }
  }).select('slotStart slotEnd status');

  res.json({ court: court.id, from, to, unavailable: taken });
});

module.exports = { list, create, availability };
