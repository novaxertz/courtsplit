/**
 * Runs the test suite against one persistence engine.
 *
 * A tiny spawner rather than `DB_ENGINE=x node --test`, because that inline
 * syntax is POSIX-only and fails on Windows shells. Keeping it in Node adds no
 * dependency and behaves identically everywhere.
 *
 *   node scripts/test-engine.mjs mongo
 *   node scripts/test-engine.mjs postgres
 */
import { spawn } from 'node:child_process';

const engine = process.argv[2];

if (!['mongo', 'postgres'].includes(engine)) {
  console.error('Usage: node scripts/test-engine.mjs <mongo|postgres>');
  process.exit(2);
}

console.log(`\n=== test suite on ${engine} ===\n`);

/**
 * node --test runs test files in parallel processes. On MongoDB each file
 * starts its own in-memory server, but on PostgreSQL every file shares one
 * database and truncates it between tests, so parallel files wipe each other's
 * fixtures mid-test ("Court not found"). Files run one at a time there.
 */
const concurrency = engine === 'postgres' ? ['--test-concurrency=1'] : [];

const child = spawn(
  process.execPath,
  ['--test', ...concurrency, 'tests/**/*.test.js'],
  { stdio: 'inherit', env: { ...process.env, DB_ENGINE: engine } }
);

child.on('exit', (code) => process.exit(code ?? 1));
