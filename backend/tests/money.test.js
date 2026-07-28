const test = require('node:test');
const assert = require('node:assert');

const { splitAmount, percentageOf, format } = require('../src/utils/money');

/**
 * Splitting money is where rounding bugs hide. The invariant that matters is
 * that the parts always sum back to the original total - a venue must never
 * be short-changed, and players must never be collectively overcharged.
 */

test('splits evenly when the total divides exactly', () => {
  assert.deepStrictEqual(splitAmount(10000, 4), [2500, 2500, 2500, 2500]);
});

test('distributes the remainder instead of losing it', () => {
  const parts = splitAmount(10000, 3);
  assert.deepStrictEqual(parts, [3334, 3333, 3333]);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), 10000);
});

test('parts always sum back to the total across many combinations', () => {
  for (let total = 0; total <= 1000; total += 7) {
    for (let n = 1; n <= 8; n += 1) {
      const parts = splitAmount(total, n);
      assert.strictEqual(parts.length, n);
      assert.strictEqual(
        parts.reduce((a, b) => a + b, 0),
        total,
        `${total} split ${n} ways should sum back to ${total}`
      );
    }
  }
});

test('no share is ever negative', () => {
  for (const [total, n] of [[1, 4], [0, 3], [7, 2]]) {
    assert.ok(splitAmount(total, n).every((p) => p >= 0));
  }
});

test('shares differ by at most one minor unit', () => {
  const parts = splitAmount(1001, 6);
  assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
});

test('rejects invalid inputs rather than returning nonsense', () => {
  assert.throws(() => splitAmount(-100, 2), TypeError);
  assert.throws(() => splitAmount(10.5, 2), TypeError);
  assert.throws(() => splitAmount(100, 0), TypeError);
});

test('percentageOf rounds to the nearest whole unit', () => {
  assert.strictEqual(percentageOf(2500, 50), 1250);
  assert.strictEqual(percentageOf(3333, 50), 1667);
  assert.strictEqual(percentageOf(2500, 100), 2500);
  assert.strictEqual(percentageOf(2500, 0), 0);
});

test('percentageOf rejects out-of-range percentages', () => {
  assert.throws(() => percentageOf(100, 150), RangeError);
  assert.throws(() => percentageOf(100, -1), RangeError);
});

test('format renders minor units as a readable amount', () => {
  assert.strictEqual(format(2500), '25.00 AED');
  assert.strictEqual(format(3333), '33.33 AED');
});
