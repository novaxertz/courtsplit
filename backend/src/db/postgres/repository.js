/**
 * PostgreSQL persistence adapter.
 *
 * Implements the same contract as the Mongo adapter and returns the same plain
 * domain objects, so bookingService is identical on both engines.
 *
 * The interesting difference is where atomicity comes from. In MongoDB a
 * booking and its shares are one document, so a single findOneAndUpdate can
 * guard on the parent's status and mutate a child in one indivisible step.
 * Relationally they are two tables, so the same guarantee needs an explicit
 * row lock on the parent inside a transaction. See markSharePaidIfPending.
 */
const { query, withTransaction } = require('./pool');
const { SlotTakenError } = require('../errors');

const UNIQUE_VIOLATION = '23505';

const BOOKING_COLUMNS = `
  id, court_id, organiser_id, slot_start, slot_end, total_amount, currency,
  status, funding_deadline, confirmed_at, cancelled_at, expired_at
`;

function toShare(row) {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    email: row.email,
    amount: Number(row.amount),
    status: row.status,
    paymentRef: row.payment_ref,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    refundAmount: Number(row.refund_amount)
  };
}

function toBooking(row, shareRows) {
  if (!row) return null;
  return {
    id: String(row.id),
    courtId: String(row.court_id),
    organiserId: String(row.organiser_id),
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    // BIGINT arrives from node-postgres as a string, because a 64-bit integer
    // does not always fit a JS number. These amounts are fils and stay far
    // below 2^53, so Number() is safe here - but the cast must be deliberate,
    // or money silently becomes string concatenation somewhere downstream.
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    status: row.status,
    fundingDeadline: row.funding_deadline,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
    expiredAt: row.expired_at,
    shares: (shareRows || []).map(toShare)
  };
}

async function loadShares(client, bookingId) {
  const { rows } = await client.query(
    `SELECT id, user_id, email, amount, status, payment_ref, paid_at, refunded_at, refund_amount
       FROM booking_shares WHERE booking_id = $1 ORDER BY id`,
    [bookingId]
  );
  return rows;
}

async function loadBooking(client, bookingId) {
  const { rows } = await client.query(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [bookingId]
  );
  if (!rows[0]) return null;
  return toBooking(rows[0], await loadShares(client, bookingId));
}

const numericId = (value) => (/^\d+$/.test(String(value)) ? String(value) : null);

const courts = {
  async findById(courtId) {
    if (!numericId(courtId)) return null;
    const { rows } = await query(
      'SELECT id, capacity, price_per_slot, currency, active FROM courts WHERE id = $1',
      [courtId]
    );
    if (!rows[0]) return null;
    return {
      id: String(rows[0].id),
      capacity: rows[0].capacity,
      pricePerSlot: Number(rows[0].price_per_slot),
      currency: rows[0].currency,
      active: rows[0].active
    };
  }
};

const users = {
  async findById(userId) {
    if (!numericId(userId)) return null;
    const { rows } = await query('SELECT id, email FROM users WHERE id = $1', [userId]);
    return rows[0] ? { id: String(rows[0].id), email: rows[0].email } : null;
  },

  async findByEmails(emails) {
    // = ANY($1) with an array parameter, rather than building an IN list by
    // string concatenation. One placeholder, no injection surface, and the
    // plan is cached regardless of how many emails are supplied.
    const { rows } = await query('SELECT id, email FROM users WHERE email = ANY($1)', [emails]);
    return rows.map((r) => ({ id: String(r.id), email: r.email }));
  }
};

const bookings = {
  async create(data) {
    return withTransaction(async (client) => {
      let bookingRow;
      try {
        const { rows } = await client.query(
          `INSERT INTO bookings
             (court_id, organiser_id, slot_start, slot_end, total_amount, currency,
              status, funding_deadline)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_PAYMENT', $7)
           RETURNING ${BOOKING_COLUMNS}`,
          [
            data.courtId,
            data.organiserId,
            data.slotStart,
            data.slotEnd,
            data.totalAmount,
            data.currency,
            data.fundingDeadline
          ]
        );
        bookingRow = rows[0];
      } catch (err) {
        // 23505 from bookings_live_slot_uniq - the partial unique index
        // rejected a second live booking for this court and slot.
        if (err.code === UNIQUE_VIOLATION) throw new SlotTakenError();
        throw err;
      }

      for (const share of data.shares) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO booking_shares (booking_id, user_id, email, amount)
           VALUES ($1, $2, $3, $4)`,
          [bookingRow.id, share.userId, share.email, share.amount]
        );
      }

      return toBooking(bookingRow, await loadShares(client, bookingRow.id));
    });
  },

  async findById(bookingId) {
    if (!numericId(bookingId)) return null;
    return loadBooking({ query }, bookingId);
  },

  async attachPaymentRefs(bookingId, refs) {
    return withTransaction(async (client) => {
      for (const { shareId, paymentRef } of refs) {
        // eslint-disable-next-line no-await-in-loop
        await client.query('UPDATE booking_shares SET payment_ref = $2 WHERE id = $1', [
          shareId,
          paymentRef
        ]);
      }
      return loadBooking(client, bookingId);
    });
  },

  /**
   * Settle one share, conditional on the booking still being open.
   *
   * The `FOR UPDATE` is the whole point of this method.
   *
   * Under READ COMMITTED each statement sees a snapshot taken when that
   * statement began. Guarding with a plain `EXISTS (SELECT ... WHERE
   * b.status = 'PENDING_PAYMENT')` inside the UPDATE would therefore evaluate
   * against a snapshot that a concurrent expiry may already have invalidated -
   * the share would be marked paid on a booking that had just expired, and the
   * refund sweep would never see it. Money stranded.
   *
   * Locking the parent row first serialises this against the expiry sweep,
   * which also writes that row. Whichever transaction takes the lock first
   * wins, and the loser observes the committed new status. MongoDB gave this
   * for free because the parent and child were one document; here it has to be
   * asked for explicitly.
   */
  async markSharePaidIfPending({ bookingId, shareId, at }) {
    if (!numericId(bookingId) || !numericId(shareId)) return null;
    return withTransaction(async (client) => {
      const { rows: locked } = await client.query(
        `SELECT id FROM bookings
          WHERE id = $1 AND status = 'PENDING_PAYMENT'
          FOR UPDATE`,
        [bookingId]
      );
      if (!locked[0]) return null;

      const { rowCount } = await client.query(
        `UPDATE booking_shares
            SET status = 'paid', paid_at = $3
          WHERE id = $2 AND booking_id = $1 AND status = 'pending'`,
        [bookingId, shareId, at]
      );
      if (rowCount === 0) return null;

      return loadBooking(client, bookingId);
    });
  },

  async confirmIfPending(bookingId, at) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE bookings SET status = 'CONFIRMED', confirmed_at = $2
          WHERE id = $1 AND status = 'PENDING_PAYMENT'
        RETURNING ${BOOKING_COLUMNS}`,
        [bookingId, at]
      );
      if (!rows[0]) return null;
      return toBooking(rows[0], await loadShares(client, bookingId));
    });
  },

  async findExpiryCandidateIds(now) {
    const { rows } = await query(
      `SELECT id FROM bookings
        WHERE status = 'PENDING_PAYMENT' AND funding_deadline <= $1`,
      [now]
    );
    return rows.map((r) => String(r.id));
  },

  async claimExpiredIfPending(bookingId, at) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE bookings SET status = 'EXPIRED', expired_at = $2
          WHERE id = $1 AND status = 'PENDING_PAYMENT'
        RETURNING ${BOOKING_COLUMNS}`,
        [bookingId, at]
      );
      if (!rows[0]) return null;
      return toBooking(rows[0], await loadShares(client, bookingId));
    });
  },

  async claimTransition({ bookingId, from, to, at }) {
    const column = to === 'CANCELLED' ? 'cancelled_at' : 'expired_at';
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE bookings SET status = $3, ${column} = $4
          WHERE id = $1 AND status = $2
        RETURNING ${BOOKING_COLUMNS}`,
        [bookingId, from, to, at]
      );
      if (!rows[0]) return null;
      return toBooking(rows[0], await loadShares(client, bookingId));
    });
  },

  async applyRefunds(bookingId, refunds) {
    return withTransaction(async (client) => {
      for (const { shareId, amount, at } of refunds) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `UPDATE booking_shares
              SET status = 'refunded', refunded_at = $2, refund_amount = $3
            WHERE id = $1`,
          [shareId, at, amount]
        );
      }
      return loadBooking(client, bookingId);
    });
  },

  async countLiveForSlot({ courtId, slotStart }) {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM bookings
        WHERE court_id = $1 AND slot_start = $2
          AND status IN ('PENDING_PAYMENT', 'CONFIRMED')`,
      [courtId, slotStart]
    );
    return rows[0].n;
  }
};

const webhookEvents = {
  /**
   * Replay-safe insert.
   *
   * ON CONFLICT DO NOTHING turns "have I already handled this event?" into one
   * statement with no read-then-write window. A zero rowCount means the id was
   * already present, so this delivery is a replay.
   */
  async recordIfNew({ eventId, type }) {
    const { rowCount } = await query(
      `INSERT INTO webhook_events (event_id, type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type]
    );
    return rowCount === 1;
  },

  async countByEventId(eventId) {
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1',
      [eventId]
    );
    return rows[0].n;
  }
};

module.exports = { engine: 'postgres', courts, users, bookings, webhookEvents };
