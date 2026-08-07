# CourtSplit

Book a sports court, invite your group, and **everyone pays their own share**. The slot is held
while the group pays and only confirms once it is fully funded — if someone doesn't pay before the
deadline, the booking expires and everyone who did pay is automatically refunded.

Booking a padel court with friends usually means one person fronts the whole cost and then chases
everybody for money. CourtSplit removes that step.

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)
![Mongoose](https://img.shields.io/badge/Mongoose-880000?logo=mongoose&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-635BFF?logo=stripe&logoColor=white)
![React Native](https://img.shields.io/badge/React_Native-61DAFB?logo=react&logoColor=black)
![Expo](https://img.shields.io/badge/Expo-000020?logo=expo&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?logo=jsonwebtokens&logoColor=white)

---

## The interesting part

Most booking apps are CRUD. The difficulty here is that **money and time both have to be correct
at once**:

- A slot can only be sold once, even if two groups tap "book" in the same millisecond.
- A booking is funded by *several independent payments*, so it is neither paid nor unpaid but
  somewhere in between.
- Payment webhooks arrive **at least once**, so the same "payment succeeded" event routinely gets
  delivered twice and must only count once.
- If the group never completes, every collected payment has to find its way back.

The engineering notes below explain how each of these is handled.

---

## How a booking works

```
 organiser picks a court and slot
            │
            ▼
   ┌──────────────────┐   slot claimed atomically; one payment
   │ PENDING_PAYMENT  │   intent created per participant
   └────────┬─────────┘
            │
      each participant pays their own share
            │
            ├─── all shares paid ────────► ┌───────────┐
            │                              │ CONFIRMED │
            │                              └─────┬─────┘
            │                                    │ organiser cancels
            ├─── funding deadline passes ──►┌─────▼─────┐
            │      (refund everyone)        │ CANCELLED │
            ▼                               └───────────┘
      ┌───────────┐                     refund depends on notice given:
      │  EXPIRED  │                     100% if ≥24h, 50% inside that
      └───────────┘
```

`EXPIRED` and `CANCELLED` release the slot; `PENDING_PAYMENT` and `CONFIRMED` hold it.

---

## Engineering notes

### Only one group can take a slot

Checking "is this slot free?" and then inserting is a race — two requests can both read *free*
before either writes. The guarantee is pushed into MongoDB with a **partial unique index**:

```js
bookingSchema.index(
  { court: 1, slotStart: 1 },
  { unique: true,
    partialFilterExpression: { status: { $in: ['PENDING_PAYMENT', 'CONFIRMED'] } } }
);
```

The second writer gets a duplicate-key error, which surfaces as a clean `409 Conflict`. Because the
index is *partial*, expired and cancelled bookings no longer occupy the slot and it becomes
bookable again.

### Duplicate webhooks can't double-count

Payment providers retry until they get a `2xx`, so the same event is delivered more than once by
design. Every event id is inserted into a collection with a unique index before it is acted on:

```js
try {
  await WebhookEvent.create({ eventId: event.id, type: event.type });
} catch (err) {
  if (err.code === 11000) return res.json({ received: true, duplicate: true });
  throw err;
}
```

The first delivery inserts and proceeds; every replay collides and returns early.

### State transitions are conditional writes

Marking a share paid matches on the share *still being pending*:

```js
Booking.findOneAndUpdate(
  { _id: bookingId,
    status: 'PENDING_PAYMENT',
    shares: { $elemMatch: { _id: shareId, status: 'pending' } } },
  { $set: { 'shares.$.status': 'paid', 'shares.$.paidAt': new Date() } },
  { new: true }
);
```

If two callbacks arrive together, the second matches nothing and changes nothing. No locks, no
read-modify-write window.

### Webhook signatures are verified

The webhook endpoint is a public URL. Without signature verification anyone could POST *"payment
succeeded"* and confirm a booking they never paid for. The raw body is preserved specifically so
the signature can be checked against the exact bytes the provider sent — which is why that one
route is mounted before `express.json()`.

### Money is integers, and splits always balance

Amounts are stored in the smallest currency unit (fils), never floats. Splitting distributes the
remainder rather than dropping it:

```
24000 fils across 4 players  ->  6000 · 6000 · 6000 · 6000
10000 fils across 3 players  ->  3334 · 3333 · 3333   (sums back to 10000)
```

The test suite asserts this invariant across hundreds of total/participant combinations.

### Expiry is safe to run anywhere

The sweep claims each booking with a conditional transition before refunding, so running it more
often than needed — or on several instances at once — cannot refund anyone twice. It runs as a
Kubernetes CronJob in the deployed setup; see [Kubernetes](#kubernetes).

---

## Running it

### Requirements

Node 18+, and a MongoDB database (a free Atlas M0 cluster is enough).

### Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill in MONGO_URI and JWT_SECRET
npm run seed              # optional: demo users and courts
npm run dev
```

You should see `CourtSplit API listening on :4000`.

**No payment keys are needed.** `PAYMENT_PROVIDER=mock` (the default) runs an in-memory payment
provider implementing the same interface, so the whole booking flow works straight after clone.
Set `PAYMENT_PROVIDER=stripe` with your Stripe **test** keys to use the real API.

### Mobile

```bash
cd mobile
npm install
npm start
```

Scan the QR code with Expo Go, or press `w` for the browser. On a physical device, change
`API_URL` in `mobile/config.js` to your machine's LAN IP — a phone cannot reach `localhost`.

### Tests

```bash
cd backend
npm test              # against MongoDB (in-memory, no Docker needed)
npm run test:both     # the same suite against MongoDB and PostgreSQL in turn
```

---

## Running it in containers

```bash
cd backend
docker compose up -d --build
curl http://localhost:4000/readyz     # {"status":"ready","engine":"mongo"}
```

Brings up the API, MongoDB, and a PostgreSQL instance for the relational adapter.

The image is multi-stage: the build stage compiles `bcrypt` with a C toolchain that never
reaches the runtime layer. It runs as the unprivileged `node` user with `dumb-init` as PID 1,
so `SIGTERM` is forwarded rather than swallowed — without an init process Kubernetes waits out
the full termination grace period on every rollout.

### Two health endpoints, not one

| Endpoint | Checks | Failing it means |
|---|---|---|
| `/livez` | process is alive; **no** external dependencies | restart the container |
| `/readyz` | database answers a real command, bounded to 2s | stop sending traffic, don't restart |

The distinction is load-bearing. Liveness must not touch the database: a failing liveness probe
kills the container, so a brief database blip would restart every replica simultaneously and turn
a recoverable dependency outage into a real one. Readiness must touch it, because a pod that
cannot reach storage should leave the load balancer and rejoin when it recovers.

The readiness ping is bounded deliberately. With MongoDB down, the driver waits out its full
30-second server-selection window, so an unbounded check *hangs* instead of answering — measured
here before the timeout was added. It now returns `503` in ~2s.

Liveness is at `/livez`, not `/healthz`, because ingress-nginx defines its own `/healthz` in the
default server block and answers it directly — through the ingress you get an empty `text/html`
200 from nginx, never the app. Kubelet probes hit the pod IP and were unaffected, which is what
made it easy to miss.

---

## Kubernetes

```bash
cd terraform
docker compose -f bootstrap/docker-compose.yml up -d      # MinIO, the state backend
$env:AWS_ACCESS_KEY_ID = "courtsplit"
$env:AWS_SECRET_ACCESS_KEY = "courtsplit-dev-secret"
terraform init && terraform apply                          # kind cluster + ingress + metrics

cd ../backend && docker build -t courtsplit-api:local .
kind load docker-image courtsplit-api:local --name courtsplit
kubectl --context kind-courtsplit apply -f ../deploy/k8s/

curl http://localhost:8080/readyz
```

`deploy/k8s/` holds a namespace, ConfigMap and Secret, a MongoDB StatefulSet with a PVC, the API
Deployment (2 replicas, HPA to 6), an Ingress, and the expiry CronJob.

**MongoDB is a StatefulSet, not a Deployment.** Deployments assume interchangeable stateless
replicas; a database needs stable identity and a volume that survives rescheduling.

**Rollouts use `maxUnavailable: 0`.** Combined with a readiness probe that checks something real,
a broken image cannot take the service down — the new pod never becomes ready, the old one is
never removed, and the rollout stalls instead of failing open.

**Expect a few API restarts on the very first deploy to a fresh cluster.** The startup connect
retries with backoff over roughly 20 seconds, which covers DNS propagation but not the ~4 minutes
kubelet needs to pull `mongo:7` the first time. The pods crash, restart, and converge once the
database is up; subsequent deploys hit a warm image cache and start clean.

### The expiry sweep is now a CronJob

Previously the sweep ran as a `setInterval` inside the API process — listed in this README's own
limitations as "no dedicated task scheduler". That was survivable at one replica. At two it meant
two schedulers competing over the same bookings: harmless, because every transition is a
conditional write, but duplicated work owned by nobody.

It now runs as a Kubernetes CronJob (`scripts/expiry-sweep.js`), so there is exactly one runner
and the API is genuinely stateless. Correctness still does not depend on that: the transitions
match on the booking still being `PENDING_PAYMENT`, so overlapping runs change nothing twice.
`concurrencyPolicy: Forbid` is belt-and-braces on top, not a substitute.

---

## Terraform

`terraform/` provisions the cluster, ingress-nginx, and metrics-server, with **remote state** on
an S3-compatible backend (MinIO locally, via `terraform/bootstrap/`). State uses `use_lockfile`
for native S3 locking — no DynamoDB table — and the bucket has versioning enabled.

Terraform owns the *platform*; the application manifests stay in `deploy/k8s` and are applied
with kubectl. That split is deliberate: re-expressing Deployments as HCL duplicates them in a
second dialect, and `kubernetes_manifest` needs the cluster to exist at plan time, which is
impossible when the same run creates it.

Pointing the backend at real AWS S3 means deleting the `endpoints`, `use_path_style` and `skip_*`
flags in `backend.tf` and setting a real region. Nothing else changes.

---

## API

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | – | Create an account, returns a JWT |
| `POST` | `/auth/login` | – | Log in, returns a JWT |
| `GET` | `/auth/me` | ✔ | Current user |
| `GET` | `/courts` | – | List courts, filter by sport/location/price |
| `POST` | `/courts` | ✔ | Add a court |
| `GET` | `/courts/:id/availability` | – | Slots already taken in a date range |
| `POST` | `/bookings` | ✔ | Create a booking and a payment intent per player |
| `GET` | `/bookings` | ✔ | Bookings you organise or are part of |
| `GET` | `/bookings/:id` | ✔ | One booking with share breakdown |
| `POST` | `/bookings/:id/cancel` | ✔ | Cancel and refund per policy |
| `POST` | `/webhooks/payments` | signature | Payment provider callback |
| `GET` | `/livez` | – | Liveness — process only, no dependencies |
| `GET` | `/readyz` | – | Readiness — verifies the database answers |
| `GET` | `/health` | – | Legacy alias for `/livez` |

### Example

```bash
curl -X POST http://localhost:4000/bookings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "courtId": "665f...",
        "slotStart": "2026-08-01T18:00:00Z",
        "participantEmails": ["sam@example.com", "alex@example.com"]
      }'
```

```jsonc
{
  "booking": {
    "status": "PENDING_PAYMENT",
    "totalAmount": 24000,
    "fundingDeadline": "2026-07-29T15:30:00.000Z",
    "shares": [
      { "email": "you@example.com",  "amount": 8000, "status": "pending" },
      { "email": "sam@example.com",  "amount": 8000, "status": "pending" },
      { "email": "alex@example.com", "amount": 8000, "status": "pending" }
    ]
  }
}
```

---

## Layout

```
backend/
  server.js                  process entry - connect, start, graceful shutdown
  src/
    app.js                   express wiring and middleware order
    config/                  environment loading, database connection
    domain/status.js         booking/share status vocabulary, engine-neutral
    db/
      index.js               selects the adapter from DB_ENGINE
      mongo/repository.js    Mongoose behind the repository contract
      postgres/              schema.sql, connection pool, SQL adapter
    models/                  User, Court, Booking, WebhookEvent (Mongoose)
    controllers/             request/response handling
    services/
      bookingService.js      the domain logic - splitting, funding, expiry, refunds
      payments/              provider interface + stripe and mock implementations
    middleware/              auth, error handling
    jobs/                    in-process expiry sweep (opt-out under Kubernetes)
    utils/                   money maths, errors, logging
  tests/                     money, payment provider, cross-engine concurrency
  scripts/
    seed.js                  demo data
    expiry-sweep.js          one-shot sweep, run by the Kubernetes CronJob
  Dockerfile                 multi-stage, non-root, dumb-init
  docker-compose.yml         API + MongoDB + PostgreSQL
deploy/
  kind/                      local cluster config and add-on patches
  k8s/                       namespace, config, Mongo StatefulSet, API, Ingress, CronJob
terraform/                   kind cluster + ingress-nginx + metrics-server, remote state
  bootstrap/                 MinIO, the S3-compatible state backend
docs/
  persistence-postgres-vs-mongo.md
mobile/
  App.js                     screens: auth, courts, booking, my bookings
  api.js                     typed API client
  config.js                  API base URL
```

Payments sit behind an interface, so the booking logic never imports Stripe and swapping providers
touches one file.

---

## Scope and limitations

Built as a portfolio project. Deliberately out of scope:

- **No payouts to venues.** Money is collected but not disbursed; that would need Stripe Connect
  onboarding.
- **No real card entry in the mobile app.** Shares are settled through the provider's test flow
  rather than a native payment sheet.
- **No dispute or admin console.**
- **No rate limiting or email delivery.** Participants are matched by existing account, not invited
  by email.
- **No pagination on `GET /bookings`.** `listForUser` returns every booking a user is involved in.
  Two queries regardless of result size, so it does not degrade per-row, but an unbounded result
  set is still the wrong shape for a real account.
- **No migration tooling.** `schema.sql` is applied wholesale; there is no versioned history, and
  no data migration path between engines.
- **Secrets in `deploy/k8s` are plain `stringData` in a committed file.** Kubernetes Secrets are
  base64, not encrypted. Acceptable for a local kind cluster and nothing else — a real deployment
  needs Sealed Secrets, External Secrets, or SOPS.
- **The concurrency tests sample interleavings rather than enumerating them.** Details and the
  measured evidence are in
  [docs/persistence-postgres-vs-mongo.md](docs/persistence-postgres-vs-mongo.md).

---

## Author

**Ibrahim Ansar**
[GitHub](https://github.com/novaxertz) · [LinkedIn](https://linkedin.com/in/ibrahim-ansar-a9571a16b)
