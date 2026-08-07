/**
 * MongoDB test engine: an in-memory mongod, so the suite needs no Docker.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let server;

module.exports = {
  name: 'mongo',

  async start() {
    server = await MongoMemoryServer.create();
    process.env.MONGO_URI = server.getUri();
    await mongoose.connect(process.env.MONGO_URI);

    const Booking = require('../../../src/models/Booking');
    const Court = require('../../../src/models/Court');
    const User = require('../../../src/models/User');
    const WebhookEvent = require('../../../src/models/WebhookEvent');

    /**
     * Mongoose builds indexes in the background after connecting. Without this
     * await the partial unique index on (court, slotStart) may not exist when
     * the first race runs - both bookings would succeed and the test would
     * fail while the application code was in fact correct.
     */
    await Promise.all([Booking.init(), Court.init(), User.init(), WebhookEvent.init()]);
  },

  async stop() {
    await mongoose.disconnect();
    await server?.stop();
  },

  /**
   * `deleteMany`, not `dropDatabase`: dropping would also drop the indexes we
   * just waited for, and Mongoose would not rebuild them. The suite would then
   * pass or fail depending on test order.
   */
  async clear() {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((c) => c.deleteMany({}))
    );
  },

  async createUser({ name, email, role = 'player' }) {
    const User = require('../../../src/models/User');
    const doc = await User.create({ name, email, passwordHash: 'not-a-real-hash', role });
    return { id: doc._id.toString(), email: doc.email };
  },

  async createCourt({ name, venueName, location, pricePerSlot, capacity, ownerId }) {
    const Court = require('../../../src/models/Court');
    const doc = await Court.create({
      name,
      venueName,
      location,
      sport: 'padel',
      pricePerSlot,
      capacity,
      owner: ownerId
    });
    return { id: doc._id.toString() };
  },

  async setFundingDeadline(bookingId, when) {
    const Booking = require('../../../src/models/Booking');
    await Booking.updateOne({ _id: bookingId }, { $set: { fundingDeadline: when } });
  }
};
