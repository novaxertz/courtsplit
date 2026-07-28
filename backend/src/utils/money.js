/**
 * Money helpers.
 *
 * Amounts are integers in the smallest currency unit (fils for AED, so
 * 1 AED = 100). Representing money as floats invites rounding drift, and
 * 0.1 + 0.2 !== 0.3 is not a property you want anywhere near a payment.
 *
 * Kept free of database and network dependencies so the arithmetic can be
 * tested on its own.
 */

/**
 * Splits a total into `n` whole parts, distributing any remainder one unit at
 * a time across the earliest shares.
 *
 * The invariant is that the parts always sum back to the total: splitting
 * 10000 across 3 gives 3334/3333/3333, never three lots of 3333 that quietly
 * lose a fil.
 */
function splitAmount(total, n) {
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError('total must be a non-negative integer');
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError('n must be a positive integer');
  }

  const base = Math.floor(total / n);
  const remainder = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Percentage of an amount, rounded to the nearest whole unit. */
function percentageOf(amount, percent) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new TypeError('amount must be a non-negative integer');
  }
  if (percent < 0 || percent > 100) {
    throw new RangeError('percent must be between 0 and 100');
  }
  return Math.round((amount * percent) / 100);
}

/** Formats a minor-unit amount for display, e.g. 2500 -> "25.00". */
function format(amount, currency = 'AED') {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

module.exports = { splitAmount, percentageOf, format };
