// tools/verify/determinism.js
//
// The same seed plus the same scripted inputs, run twice, must produce
// identical final snapshots. It must ALSO be able to tell a genuinely
// non-deterministic game from a deterministic one: a different seed is run
// too, and its snapshot must DIFFER from the first — a game that ignores the
// seed entirely (e.g. constant output, or a stub that never reads RNG) would
// otherwise pass the same-seed check trivially.
//
// The scripted input script is generic and game-agnostic: start the game,
// then hold `left` for a while, release, hold `right` for a while, release,
// tap `primary` a few times (covers games whose only progress mechanism is a
// button tap), then idle-tick. This does not require knowing a game's mechanic
// (unlike playtest.probe.js, which is declared per-game) — determinism must
// hold for ANY input sequence, so a fixed generic one is a valid witness.
//
// Individually runnable: `node tools/verify/determinism.js <game-dir>`

import { openGame } from '../lib/browser.js';
import { gotoGameAndWaitForMenu } from '../lib/hook.js';
import { snapshotsEqual, canonicalJSON } from '../lib/snapshot.js';
import { runAsCli, isMain } from './lib/cli.js';

const TOTAL_TICKS_BUDGET = 500; // stays comfortably under fixture-pong's ~1050-tick idle horizon

/** Run a fixed, generic scripted sequence against a freshly-seeded game; return the final snapshot. */
async function runScript(gameDir, seed) {
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, 'index.html');
    await hook.seed(seed); // reseed while still in MENU, per the __test.seed() contract

    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);

    await hook.input('left', true);
    await hook.tick(40);
    await hook.input('left', false);

    await hook.input('right', true);
    await hook.tick(40);
    await hook.input('right', false);

    for (let i = 0; i < 3; i++) {
      await hook.input('primary', true);
      await hook.tick(5);
      await hook.input('primary', false);
      await hook.tick(20);
    }

    const ticksSoFar = 1 + 40 + 40 + 3 * 25;
    await hook.tick(TOTAL_TICKS_BUDGET - ticksSoFar);

    const errors = await hook.errors();
    if (errors.length > 0) {
      throw new Error(`unexpected __test.errors during determinism script (seed ${seed}): ${JSON.stringify(errors[0])}`);
    }
    return await hook.snapshot();
  } finally {
    await close();
  }
}

export async function run(gameDir) {
  const details = [];

  const snapA1 = await runScript(gameDir, 1);
  const snapA2 = await runScript(gameDir, 1);
  if (!snapshotsEqual(snapA1, snapA2)) {
    const err = new Error('same seed (1) + same scripted inputs produced DIFFERENT final snapshots — a hidden Math.random()/time/order dependency is likely');
    err.details = [
      `run 1: ${canonicalJSON(snapA1).slice(0, 500)}`,
      `run 2: ${canonicalJSON(snapA2).slice(0, 500)}`
    ];
    throw err;
  }
  details.push('seed 1 run twice: identical final snapshots');

  const snapB = await runScript(gameDir, 12345);
  if (snapshotsEqual(snapA1, snapB)) {
    throw new Error('a DIFFERENT seed (12345) produced the SAME final snapshot as seed 1 — the game appears to ignore the seed entirely (constant/stubbed output), which would let it pass trivially');
  }
  details.push('seed 1 vs seed 12345: snapshots differ, so the seed genuinely affects play (not a constant-output stub)');

  return details;
}

if (isMain(import.meta.url)) runAsCli('determinism', run);
