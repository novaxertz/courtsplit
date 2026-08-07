/**
 * Persistence errors the domain layer is allowed to know about.
 *
 * Each adapter translates its own driver error into one of these, so
 * bookingService never sees a MongoDB error code (11000) or a PostgreSQL
 * SQLSTATE (23505). Without this the service would need a branch per engine,
 * which is precisely the coupling the repository layer exists to remove.
 */

class SlotTakenError extends Error {
  constructor() {
    super('That slot has already been booked');
    this.name = 'SlotTakenError';
  }
}

module.exports = { SlotTakenError };
