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

const child = spawn(
  process.execPath,
  ['--test', 'tests/**/*.test.js'],
  { stdio: 'inherit', env: { ...process.env, DB_ENGINE: engine } }
);

child.on('exit', (code) => process.exit(code ?? 1));
