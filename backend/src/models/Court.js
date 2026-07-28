const mongoose = require('mongoose');

const courtSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    venueName: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    sport: {
      type: String,
      enum: ['padel', 'tennis', 'football', 'basketball'],
      default: 'padel',
      index: true
    },
    // Slot price in fils (1 AED = 100 fils). Money is stored as an integer of
    // the smallest currency unit to avoid floating point rounding.
    pricePerSlot: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'AED' },
    capacity: { type: Number, required: true, min: 2, default: 4 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

courtSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Court', courtSchema);
