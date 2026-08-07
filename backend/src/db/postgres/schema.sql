-- CourtSplit - PostgreSQL schema
--
-- A relational expression of the same domain the Mongoose models describe.
-- The comments record why each choice was made, particularly where Postgres
-- differs from MySQL or from the document model this ports from.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  -- GENERATED ALWAYS AS IDENTITY is the SQL-standard replacement for SERIAL.
  -- Unlike SERIAL it does not create a separately-owned sequence that can drift
  -- out of sync, and it rejects accidental manual inserts into the id column.
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  -- CITEXT would give case-insensitive comparison natively, but it needs an
  -- extension. Lowercasing on write (as the Mongoose schema already does)
  -- keeps the schema extension-free.
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'venue')),
  -- timestamptz, never timestamp. `timestamp` discards the offset and silently
  -- reinterprets values in the session timezone - the classic production bug.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- courts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS courts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT NOT NULL,
  venue_name     TEXT NOT NULL,
  location       TEXT NOT NULL,
  sport          TEXT NOT NULL DEFAULT 'padel'
                 CHECK (sport IN ('padel', 'tennis', 'football', 'basketball')),
  -- Money as an integer count of the smallest currency unit (fils; 1 AED = 100).
  -- BIGINT rather than NUMERIC deliberately: NUMERIC is exact too, but it is
  -- variable-length, slower to aggregate, and invites decimal amounts back into
  -- a domain that should only ever hold whole minor units. The existing
  -- money.js invariants assume integers, so the column enforces the same thing.
  price_per_slot BIGINT NOT NULL CHECK (price_per_slot >= 0),
  currency       TEXT NOT NULL DEFAULT 'AED',
  capacity       INTEGER NOT NULL DEFAULT 4 CHECK (capacity >= 2),
  owner_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courts_sport_idx ON courts (sport);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
-- CHECK-constrained TEXT rather than a native ENUM type. Postgres enums are
-- real types, but adding a value requires ALTER TYPE and removing one is not
-- supported at all. A CHECK constraint is edited with an ordinary migration.
CREATE TABLE IF NOT EXISTS bookings (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  court_id         BIGINT NOT NULL REFERENCES courts(id) ON DELETE RESTRICT,
  organiser_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slot_start       TIMESTAMPTZ NOT NULL,
  slot_end         TIMESTAMPTZ NOT NULL,
  total_amount     BIGINT NOT NULL CHECK (total_amount >= 0),
  currency         TEXT NOT NULL DEFAULT 'AED',
  status           TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                   CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  funding_deadline TIMESTAMPTZ NOT NULL,
  confirmed_at     TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  expired_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT bookings_slot_order CHECK (slot_end > slot_start)
);

-- The double-booking guard, and the direct translation of the Mongoose
-- partialFilterExpression index in models/Booking.js.
--
-- A plain UNIQUE (court_id, slot_start) would be wrong: it would keep a slot
-- locked forever once expired or cancelled. The WHERE clause makes the
-- constraint apply only to live rows, so terminal bookings release the slot -
-- exactly the semantics the document version has.
--
-- This is a *partial index*, one of the main things Postgres offers that MySQL
-- does not. MySQL would need a nullable generated column or application-level
-- checking, and an application-level check is a time-of-check/time-of-use race
-- by construction.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_live_slot_uniq
  ON bookings (court_id, slot_start)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

-- Supports the expiry sweep's candidate query. Also partial: rows in a terminal
-- state are never candidates, so there is no reason to index them. A smaller
-- index means fewer pages read and less to keep warm in cache.
CREATE INDEX IF NOT EXISTS bookings_expiry_sweep_idx
  ON bookings (funding_deadline)
  WHERE status = 'PENDING_PAYMENT';

-- ---------------------------------------------------------------------------
-- booking_shares
-- ---------------------------------------------------------------------------
-- The structural heart of the port. In MongoDB `shares` is an embedded
-- subdocument array, so a single findOneAndUpdate touches a share and its
-- parent booking atomically - atomicity comes free from the document boundary.
--
-- Relationally the shares are their own rows, so that same operation spans two
-- tables and needs an explicit transaction (or a CTE performing both writes in
-- one statement) to get the same guarantee. Same invariant, atomicity sourced
-- from somewhere completely different.
CREATE TABLE IF NOT EXISTS booking_shares (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  email         TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount >= 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'refunded')),
  payment_ref   TEXT,
  paid_at       TIMESTAMPTZ,
  refunded_at   TIMESTAMPTZ,
  refund_amount BIGINT NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),

  -- One share per participant per booking.
  CONSTRAINT booking_shares_unique_participant UNIQUE (booking_id, user_id)
);

CREATE INDEX IF NOT EXISTS booking_shares_booking_idx ON booking_shares (booking_id);

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
-- The replay ledger. UNIQUE on event_id is what makes deduplication a single
-- INSERT ... ON CONFLICT DO NOTHING rather than a read-then-write race.
--
-- Worth noting against the current Mongo implementation: in Postgres this row
-- and the effect it authorises can be committed in one transaction, closing the
-- crash window where an event is marked processed but its effect never lands.
-- Doing the same in MongoDB requires a replica set (see config/db.js).
CREATE TABLE IF NOT EXISTS webhook_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
