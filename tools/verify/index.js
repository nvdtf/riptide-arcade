// tools/verify/index.js
//
// Single entry point: `npm run verify -- <game-dir>` runs ALL FOUR verifiers
// against the given game directory, prints a clear per-verifier PASS/FAIL
// summary, and exits non-zero if any failed.
//
// Each verifier is ALSO individually runnable (`node tools/verify/smoke.js
// <game-dir>`, etc.) — this file imports the same `run()` functions those
// CLIs use, so there is exactly one implementation of each check.

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { run as smoke } from './smoke.js';
import { run as journey } from './journey.js';
import { run as determinism } from './determinism.js';
import { run as budget } from './budget.js';
import { runNamed, printResult, printSummary } from './lib/report.js';

const VERIFIERS = [
  { name: 'smoke', fn: smoke },
  { name: 'journey', fn: journey },
  { name: 'determinism', fn: determinism },
  { name: 'budget', fn: budget }
];

async function main() {
  const gameDirArg = process.argv[2];
  if (!gameDirArg) {
    console.error('usage: npm run verify -- <game-dir>');
    console.error('   or: node tools/verify/index.js <game-dir>');
    process.exit(2);
  }
  const gameDir = resolve(gameDirArg);
  try {
    const st = await stat(gameDir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(`game dir not found: ${gameDir}`);
    process.exit(2);
  }

  console.log(`verify: ${gameDir}`);
  const results = [];
  for (const { name, fn } of VERIFIERS) {
    const result = await runNamed(name, () => fn(gameDir));
    printResult(result);
    results.push(result);
  }
  const allPassed = printSummary(results);
  process.exit(allPassed ? 0 : 1);
}

main();
