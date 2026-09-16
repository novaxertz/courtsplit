// End-to-end demo of the CourtSplit business flow against a running API.
//   node demo/demo-flow.mjs            (API on http://localhost:4000)
const API = process.env.API || 'http://localhost:4000';

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.b('▶ ' + s)}`);
const check = (ok, msg) => { console.log(`  ${ok ? c.g('✔') : c.r('✘')} ${msg}`); if (!ok) process.exitCode = 1; };

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const login = async (email) => (await call('POST', '/auth/login', { body: { email, password: 'password123' } })).body.token;
const aed = (fils) => `AED ${(fils / 100).toFixed(2)}`;
const shares = (b) => b.shares.map((s) => `${s.email.split('@')[0]}:${s.status}${s.refundAmount ? `(-${aed(s.refundAmount)})` : ''}`).join('  ');

// A distinct future slot per run so the demo is re-runnable.
const base = new Date(Date.now() + 3 * 86400_000);
base.setUTCMinutes(0, 0, 0);
const slot = (h) => new Date(base.getTime() + h * 3600_000 + (Date.now() % 1000) * 3600_000).toISOString();

const payWebhook = (booking, share, eventId = `evt_${share.id}`) =>
  call('POST', '/webhooks/payments', {
    raw: JSON.stringify({ id: eventId, type: 'payment_intent.succeeded', data: { object: { metadata: { bookingId: booking.id, shareId: share.id } } } })
  });

const organiser = await login('ibrahim@example.com');
const courts = (await call('GET', '/courts')).body.courts;
const court = courts.find((x) => x.name === 'Court 1');
const courtId = court._id || court.id;

// 1. Business flow ----------------------------------------------------------
step('1. Organiser books Court 1 for 3 players (AED 240 total)');
let { status, body } = await call('POST', '/bookings', {
  token: organiser,
  body: { courtId, slotStart: slot(0), participantEmails: ['sam@example.com', 'alex@example.com'] }
});
let booking = body.booking;
check(status === 201 && booking.status === 'PENDING_PAYMENT', `201, status ${booking.status}, deadline ${booking.fundingDeadline}`);
console.log(c.d(`  shares: ${booking.shares.map((s) => aed(s.amount)).join(' + ')} = ${aed(booking.totalAmount)}`));

step('   Each player pays their own share (payment webhooks)');
for (const s of booking.shares) {
  const r = await payWebhook(booking, s);
  const now = (await call('GET', `/bookings/${booking.id}`, { token: organiser })).body.booking;
  console.log(c.d(`  ${s.email} paid -> booking ${now.status}   ${shares(now)}`));
}
booking = (await call('GET', `/bookings/${booking.id}`, { token: organiser })).body.booking;
check(booking.status === 'CONFIRMED', 'fully funded -> CONFIRMED');

// 2. Double-booking guard ------------------------------------------------------
step('2. Partial unique index: a second group tries the same slot');
({ status, body } = await call('POST', '/bookings', { token: await login('priya@example.com'), body: { courtId, slotStart: booking.slotStart } }));
check(status === 409, `${status} ${body.error || JSON.stringify(body)}`);

step('   20 simultaneous booking requests for one fresh slot');
const raceSlot = slot(1);
const tokens = await Promise.all(['sam', 'alex', 'priya', 'ibrahim'].map((u) => login(`${u}@example.com`)));
const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/bookings', { token: tokens[i % 4], body: { courtId, slotStart: raceSlot } })));
const tally = results.reduce((t, r) => ({ ...t, [r.status]: (t[r.status] || 0) + 1 }), {});
check(tally[201] === 1 && tally[409] === 19, `results: ${JSON.stringify(tally)} (exactly one winner)`);

// 3. Webhook idempotency ------------------------------------------------------
step('3. Stripe-style retry: the same event delivered 5 more times');
const replays = await Promise.all(Array.from({ length: 5 }, () => payWebhook(booking, booking.shares[0])));
check(replays.every((r) => r.status === 200 && r.body.duplicate === true), `all 5 answered 200 {duplicate:true}`);
const after = (await call('GET', `/bookings/${booking.id}`, { token: organiser })).body.booking;
check(after.status === 'CONFIRMED' && after.shares.every((s) => s.status === 'paid'), 'booking unchanged');

step('   Fresh booking: one share\'s event arrives 10 times concurrently');
const b2 = (await call('POST', '/bookings', { token: organiser, body: { courtId, slotStart: slot(2), participantEmails: ['sam@example.com'] } })).body.booking;
await Promise.all(Array.from({ length: 10 }, () => payWebhook(b2, b2.shares[0], `evt_storm_${b2.id}`)));
const b2now = (await call('GET', `/bookings/${b2.id}`, { token: organiser })).body.booking;
check(b2now.status === 'PENDING_PAYMENT' && b2now.shares.filter((s) => s.status === 'paid').length === 1, `counted once: ${shares(b2now)}, still ${b2now.status}`);

// 4. Cancellation refund --------------------------------------------------------
step('4. Organiser cancels the confirmed booking (>24h notice -> 100% refund)');
({ status, body } = await call('POST', `/bookings/${booking.id}/cancel`, { token: organiser }));
check(status === 200 && body.refundPercent === 100 && body.booking.shares.every((s) => s.status === 'refunded'), `${body.booking?.status}, refund ${body.refundPercent}%   ${shares(body.booking)}`);
({ status } = await call('POST', '/bookings', { token: organiser, body: { courtId, slotStart: booking.slotStart } }));
check(status === 201, `slot is bookable again after cancel (${status})`);

console.log(`\nEXPIRY_BOOKING_ID=${b2.id}`);
