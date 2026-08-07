# Two engines, one set of invariants

CourtSplit's correctness story is about concurrency: a slot must not be double-booked, a
replayed payment webhook must not double-credit, and a booking must not end up both confirmed
and expired. Those properties were originally enforced by MongoDB constructs and described in
code comments.

This document records what happened when the same properties were re-implemented on
PostgreSQL, and what the two engines do differently to get there.

The point of the exercise was not "port the database". It was to find out which parts of the
design were **domain reasoning** and which were **MongoDB doing work I hadn't noticed**.

## What changed

| | Before | After |
|---|---|---|
| Persistence | Mongoose models called directly from `bookingService` | Repository in `src/db`, selected by `DB_ENGINE` |
| Engines | MongoDB | MongoDB **or** PostgreSQL |
| Concurrency tests | none | 6 invariant tests, run against both engines unchanged |

`bookingService.js` no longer imports a model, a driver, or an error code. It receives plain
objects and calls methods like `markSharePaidIfPending`. Each adapter translates its own driver
failure — Mongo's `11000`, Postgres's SQLSTATE `23505` — into a shared `SlotTakenError`, so the
service has no per-engine branch.

## The three mechanisms, side by side

### 1. Slot exclusivity

A plain unique constraint would be wrong: it would hold a slot forever once cancelled. Both
engines need the constraint to apply only to *live* bookings.

```js
// MongoDB
bookingSchema.index(
  { court: 1, slotStart: 1 },
  { unique: true,
    partialFilterExpression: { status: { $in: ['PENDING_PAYMENT', 'CONFIRMED'] } } }
);
```

```sql
-- PostgreSQL
CREATE UNIQUE INDEX bookings_live_slot_uniq
  ON bookings (court_id, slot_start)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');
```

Near-identical, and both are *partial* indexes. This is one of the places PostgreSQL is ahead of
MySQL, which has no partial index and would need either a nullable generated column or an
application-level check — and an application-level check is a time-of-check/time-of-use race by
construction.

### 2. Webhook replay

```js
await WebhookEvent.create({ eventId, type });   // throws 11000 on replay
```

```sql
INSERT INTO webhook_events (event_id, type)
VALUES ($1, $2)
ON CONFLICT (event_id) DO NOTHING;              -- rowCount 0 on replay
```

Same idea, but the Postgres form reads better: a replay is an ordinary zero-row result rather
than an exception used for control flow.

### 3. Conditional state transition

```js
findOneAndUpdate({ _id, status: 'PENDING_PAYMENT' }, { $set: { status: 'EXPIRED' } })
```

```sql
UPDATE bookings SET status = 'EXPIRED', expired_at = $2
 WHERE id = $1 AND status = 'PENDING_PAYMENT'
RETURNING *;
```

A direct translation. `RETURNING` is the piece with no MySQL equivalent — it makes "change the
row and tell me whether you did" a single statement.

## The part that did not translate

Everything above is close to a transliteration. This is not.

In MongoDB, `shares` is an **embedded subdocument array**. A booking and its shares are one
document, so a single write can guard on the parent's status and mutate a child atomically:

```js
findOneAndUpdate(
  { _id: bookingId,
    status: 'PENDING_PAYMENT',                                   // parent guard
    shares: { $elemMatch: { _id: shareId, status: 'pending' } }  // child guard
  },
  { $set: { 'shares.$.status': 'paid' } }
);
```

Relationally, `booking_shares` is its own table. The equivalent operation spans two tables, and
the obvious translation is quietly wrong:

```sql
-- WRONG under READ COMMITTED
UPDATE booking_shares SET status = 'paid'
 WHERE id = $2 AND status = 'pending'
   AND EXISTS (SELECT 1 FROM bookings b
                WHERE b.id = $1 AND b.status = 'PENDING_PAYMENT');
```

Under READ COMMITTED — Postgres's default — each statement sees a snapshot taken when that
statement began. The `EXISTS` can therefore be satisfied by a booking that a concurrent expiry
transaction has *already* moved to `EXPIRED`. The share gets marked paid on an expired booking,
and the refund sweep, which read its shares before that write landed, never refunds it. The
money is stranded.

The fix is to lock the parent row before touching the child:

```sql
BEGIN;
  SELECT id FROM bookings
   WHERE id = $1 AND status = 'PENDING_PAYMENT'
     FOR UPDATE;                       -- serialises against the expiry sweep

  UPDATE booking_shares SET status = 'paid', paid_at = $3
   WHERE id = $2 AND booking_id = $1 AND status = 'pending';
COMMIT;
```

The expiry sweep writes the same booking row, so the two transactions now contend on one lock.
Whichever takes it first wins; the loser sees the committed new status and becomes a no-op.

**That is the finding worth keeping.** The document model was providing an atomicity guarantee
for free, purely because of how the data was laid out. Nothing in the original code said "lock
the parent" — it didn't have to. Moving to a relational schema made an implicit guarantee
explicit, and the only way to keep the behaviour identical was to ask for it by name.

### Why READ COMMITTED is enough

Given the above, SERIALIZABLE isn't needed. Every transition is guarded by either a unique
constraint or an explicit row lock, so the database is doing the mutual exclusion. SERIALIZABLE
would add serialization-failure retries to every caller in exchange for a guarantee the
constraints already provide.

## What the tests showed

Six invariant tests, one file, both engines (`npm run test:both`). They assert invariants —
"exactly one live booking exists for this slot" — never mechanisms, which is why the same
assertions hold on both.

Two honest limitations, both measured:

**The race tests sample interleavings; they do not enumerate them.** Deliberately removing the
booking-status guard from share settlement — which should permit the stranded-payment bug above
— did **not** fail the suite at 600 iterations on MongoDB (434 confirmed / 166 expired, zero
violations). The required interleaving never arose under natural scheduling. A green race test
means the invariant held for the orderings that happened, not that it always holds.

**On PostgreSQL the same test is weaker still.** The printed outcome counts are part of the
result:

| Engine | confirm wins | expiry wins |
|---|---|---|
| MongoDB | 13 | 12 |
| PostgreSQL | **0** | **25** |

Settlement on Postgres opens a transaction and takes a row lock before writing, so it is
reliably slower than the sweep's single UPDATE and loses every time. The confirm-wins branch is
never exercised there — the suite passes while covering half of what it covers on Mongo.

Catching that class of bug needs a **forced** interleaving rather than a hoped-for one. That is
more tractable on PostgreSQL, where two connections can hold open transactions while the test
controls commit ordering. Standalone MongoDB has no transaction to hold open. Not yet done.

## Known gaps

- `bookingController.listMine` and `getOne` still query Mongoose directly and use `populate`.
  They are read-only and outside the concurrency surface, but they mean the **read endpoints do
  not work under `DB_ENGINE=postgres`**. Porting them needs JOINs plus a decision about
  preserving the current nested response shape, which the mobile client depends on.
- No migration tooling. `schema.sql` is applied wholesale; there is no versioned migration
  history.
- No data migration path between engines. This demonstrates that the domain runs on both, not
  that a live deployment can move between them.

## Running it

```bash
cd backend
npm install
docker compose up -d          # PostgreSQL on host port 5433
npm run test:both             # suite on MongoDB, then on PostgreSQL
```

MongoDB tests use an in-memory server and need no container.
