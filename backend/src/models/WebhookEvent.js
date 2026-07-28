const mongoose = require('mongoose');

/**
 * Payment providers deliver webhooks at least once, so the same event can
 * arrive more than once. Recording every processed event id behind a unique
 * index makes replay handling a cheap insert that either succeeds the first
 * time or fails as a duplicate.
 */
const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true },
    processedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
