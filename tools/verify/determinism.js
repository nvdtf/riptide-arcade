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
// FIX ROUND:
//   C4 — the generic script above never chases the ball (it just holds
//   left/right/primary blindly), and fixture-pong is built so a centred idle
//   paddle always misses — so the generic script never exercises the
//   paddle-hit path, which carries the fixture's only per-hit RNG draw. A
//   determinism bug hiding there is invisible to the generic script alone.
//   FIX: additionally replay the game's own `playtest.probe.js` TWICE at
//   `probe.seed`, reusing tools/playtest/lib/scriptedSession.js's interpreter
//   (the probe actually chases the ball and scores hits — see its own
//   header). If a game dir has no probe, fall back to the generic-script-only
//   result and SAY so explicitly, rather than silently weakening the check.
//   A1 — the anti-stub "different seed -> different snapshot" check compared
//   FULL snapshots, which always include `rng.seed` — a field that differs by
//   construction whenever a different seed value is passed to __test.seed(),
//   whether or not that seed actually influenced gameplay. That made the
//   check pass trivially even for a game that ignores the seed entirely. Fix:
//   compare snapshots with `rng` excluded, so only the GAME's own fields can
//   satisfy the check.
//
// Individually runnable: `node tools/verify/determinism.js <game-dir>`

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openGame } from '../lib/browser.js';
import { gotoGameAndWaitForMenu } from '../lib/hook.js';
import { snapshotsEqual, canonicalJSON, snapshotDigest } from '../lib/snapshot.js';
import { loadBudgets } from './lib/budgets.js';
import { runScriptedSession } from '../playtest/lib/scriptedSession.js';
import { runAsCli, isMain } from './lib/cli.js';

const TOTAL_TICKS_BUDGET = 500; // stays comfortably under fixture-pong's ~1020-1075-tick idle horizon

// Fields to exclude before comparing snapshots for the "different seed must
// differ" anti-stub check ONLY (A1) — `rng.seed`/`rng.calls` reflect what was
// PASSED to __test.seed()/how many draws happened, not whether the seed
// actually shaped gameplay, so leaving them in makes the check unfalsifiable.
const ANTI_STUB_EXCLUDED_KEYS = ['rng'];

function omitKeys(snapshot, keys) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const copy = { ...snapshot };
  for (const k of keys) delete copy[k];
  return copy;
}

/** Run a fixed, generic scripted sequence against a freshly-seeded game; return the final snapshot. */
async function runScript(gameDir, seed, entry) {
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, entry);
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

/** Load `<gameDir>/playtest.probe.js` if present; return null (not throw) if absent. */
async function loadProbeIfPresent(gameDir) {
  const probePath = join(gameDir, 'playtest.probe.js');
  try {
    await stat(probePath);
  } catch {
    return null;
  }
  const mod = await import(pathToFileURL(probePath).href);
  const probe = mod.default || mod.probe;
  if (!probe || !Array.isArray(probe.steps)) return null;
  return probe;
}

/** Replay `probe` once against a fresh page/session; return the final snapshot. Reuses the playtest interpreter. */
async function runProbeOnce(gameDir, probe, scratchDir) {
  const entry = probe.entry || 'index.html';
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, entry);
    const result = await runScriptedSession({ page, hook, probe, screenshotDir: scratchDir });
    if (result.finalErrors.length > 0) {
      throw new Error(`unexpected __test.errors during playtest.probe.js replay (seed ${probe.seed}): ${JSON.stringify(result.finalErrors[0])}`);
    }
    return result.finalSnapshot;
  } finally {
    await close();
  }
}

export async function run(gameDir) {
  const details = [];
  const budgets = await loadBudgets(gameDir);
  const entry = budgets.entry;

  const snapA1 = await runScript(gameDir, 1, entry);
  const snapA2 = await runScript(gameDir, 1, entry);
  if (!snapshotsEqual(snapA1, snapA2)) {
    const err = new Error('same seed (1) + same scripted inputs produced DIFFERENT final snapshots — a hidden Math.random()/time/order dependency is likely');
    err.details = [
      `run 1: ${canonicalJSON(snapA1).slice(0, 500)}`,
      `run 2: ${canonicalJSON(snapA2).slice(0, 500)}`
    ];
    throw err;
  }
  details.push('generic script, seed 1 run twice: identical final snapshots');

  const snapB = await runScript(gameDir, 12345, entry);
  if (snapshotsEqual(omitKeys(snapA1, ANTI_STUB_EXCLUDED_KEYS), omitKeys(snapB, ANTI_STUB_EXCLUDED_KEYS))) {
    throw new Error(`a DIFFERENT seed (12345) produced the SAME final snapshot as seed 1, EXCLUDING ${JSON.stringify(ANTI_STUB_EXCLUDED_KEYS)} (which differ trivially regardless of whether the seed shapes play) — the game appears to ignore the seed entirely (constant/stubbed output), which would let it pass trivially`);
  }
  details.push(`generic script, seed 1 vs seed 12345: snapshots differ (excluding ${JSON.stringify(ANTI_STUB_EXCLUDED_KEYS)}), so the seed genuinely affects play (not a constant-output stub)`);

  // C4: additionally replay the game's OWN scripted probe, which (unlike the
  // generic script) actually chases the ball and exercises the paddle-hit
  // path — the fixture's only per-hit RNG draw is otherwise never reached.
  const probe = await loadProbeIfPresent(gameDir);
  if (probe) {
    const scratchDir = await mkdtemp(join(tmpdir(), 'riptide-determinism-probe-'));
    try {
      const probeSnap1 = await runProbeOnce(gameDir, probe, scratchDir);
      const probeSnap2 = await runProbeOnce(gameDir, probe, scratchDir);
      if (!snapshotsEqual(probeSnap1, probeSnap2)) {
        const err = new Error(`playtest.probe.js replayed twice at seed ${probe.seed} produced DIFFERENT final snapshots — a hidden Math.random()/time/order dependency is likely in the game's own scored mechanic (the generic script above can miss this if it never exercises that mechanic)`);
        err.details = [
          `run 1 digest: ${snapshotDigest(probeSnap1)}`,
          `run 2 digest: ${snapshotDigest(probeSnap2)}`,
          `run 1: ${canonicalJSON(probeSnap1).slice(0, 500)}`,
          `run 2: ${canonicalJSON(probeSnap2).slice(0, 500)}`
        ];
        throw err;
      }
      details.push(`playtest.probe.js ("${probe.name}") replayed twice at seed ${probe.seed}: identical final snapshots (digest ${snapshotDigest(probeSnap1)}) — the game's own scored mechanic is deterministic too`);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  } else {
    details.push('no playtest.probe.js found in this game dir — probe-based replay SKIPPED, falling back to the generic script only; this is a WEAKER determinism guarantee for any mechanic the generic script does not exercise (e.g. a paddle-hit path a stationary/centred paddle never reaches)');
  }

  return details;
}

if (isMain(import.meta.url)) runAsCli('determinism', run);
