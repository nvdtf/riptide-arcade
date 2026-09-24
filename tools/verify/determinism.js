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
//   N6 — the probe-replay path (added for C4) misattributed blame: a
//   mismatch always named only "the game's own scored mechanic" (never
//   playtest.probe.js itself, which can just as easily be the nondeterministic
//   party — e.g. a controller() reading Math.random()); a probe that threw
//   mid-replay surfaced its raw message with no mention of playtest.probe.js
//   at all; and a probe file that exists but is malformed (import failure, or
//   no `.steps` array) was silently treated as "no probe found", quietly
//   weakening the check instead of failing loudly. Fixed: every error path
//   through the probe replay now names playtest.probe.js as a suspect, and a
//   malformed probe is a FAIL, never a silent downgrade.
//   N7 — the probe replay (twice, per run) was writing screenshots into a
//   temp directory that was discarded, unread, immediately after — the sole
//   consumer of a probe replay here is the final snapshot. Screenshot capture
//   is now skippable (`screenshotDir: null`), measured at ~0.9s of this
//   verifier's ~11s total — cutting it out removed real, if modest, cost.
//   R4 — N6's "name playtest.probe.js first" fix went one step too far: a
//   probe replay that THROWS because the GAME recorded unexpected
//   `__test.errors` (as opposed to playtest.probe.js's own steps/controller()
//   throwing, or the scripted-session interpreter throwing) named
//   playtest.probe.js as the primary suspect regardless — sending the author
//   to the wrong file when the bug was in their own game. runProbeOnce() now
//   marks that specific case (`isGameSideError`) and the catch in run() names
//   the GAME first for it, while every other throw here (a genuine
//   playtest.probe.js/interpreter throw) still names playtest.probe.js first,
//   unchanged.
//
// Individually runnable: `node tools/verify/determinism.js <game-dir>`

import { stat } from 'node:fs/promises';
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
    const hook = await gotoGameAndWaitForMenu(page, baseURL, entry, { gameDir });
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

/**
 * Load `<gameDir>/playtest.probe.js`.
 * Returns `null` ONLY when the file is genuinely ABSENT (no such path) — that
 * is a legitimate, quiet fallback to the generic-script-only check.
 * Fix round (N6): a probe file that EXISTS but is malformed (fails to
 * import — a syntax error, a throwing top-level statement — or imports fine
 * but exports no valid `.steps` array) used to be treated identically to "no
 * probe found", silently weakening the check with no hint that
 * `playtest.probe.js` itself was the problem (an import failure could even
 * surface later as a confusing `probe is not defined`-style ReferenceError
 * from unrelated code, with nothing pointing back at this file). Both cases
 * now THROW a clear error naming `playtest.probe.js` as the suspect — a
 * malformed probe is a FAIL, not a silent downgrade.
 */
async function loadProbeIfPresent(gameDir) {
  const probePath = join(gameDir, 'playtest.probe.js');
  try {
    await stat(probePath);
  } catch {
    return null; // genuinely absent — the quiet, legitimate fallback case
  }
  let mod;
  try {
    mod = await import(pathToFileURL(probePath).href);
  } catch (e) {
    throw new Error(`playtest.probe.js exists (${probePath}) but failed to import: ${e.message} — this is a MALFORMED probe, not an absent one; fix or remove the file rather than letting the determinism check silently fall back to the weaker generic-script-only guarantee`);
  }
  const probe = mod.default || mod.probe;
  if (!probe || !Array.isArray(probe.steps)) {
    throw new Error(`playtest.probe.js exists (${probePath}) but does not export a valid probe with a "steps" array (expected 'export default probe', got ${JSON.stringify(probe)}) — this is a MALFORMED probe, not an absent one; fix or remove the file rather than letting the determinism check silently fall back to the weaker generic-script-only guarantee`);
  }
  return probe;
}

/**
 * Replay `probe` once against a fresh page/session; return the final snapshot.
 * Reuses the playtest interpreter. `screenshotDir: null` (fix round N7) skips
 * screenshot capture entirely — this replay only needs the final snapshot,
 * and the screenshots were being written to a scratch directory that was
 * discarded unread immediately after, at real wall-clock cost.
 *
 * Fix round (R4): the thrown Error for unexpected `__test.errors` is marked
 * `isGameSideError` so the caller can tell it apart from a throw in the
 * replay machinery itself (playtest.probe.js, the scripted-session
 * interpreter) and attribute blame correctly — see the catch in run() below.
 */
async function runProbeOnce(gameDir, probe, screenshotDir = null) {
  const entry = probe.entry || 'index.html';
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, entry, { gameDir });
    const result = await runScriptedSession({ page, hook, probe, screenshotDir });
    if (result.finalErrors.length > 0) {
      const err = new Error(`unexpected __test.errors during playtest.probe.js replay (seed ${probe.seed}): ${JSON.stringify(result.finalErrors[0])}`);
      err.isGameSideError = true;
      throw err;
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
  // N7: no scratch dir / screenshots here any more — see runProbeOnce().
  const probe = await loadProbeIfPresent(gameDir);
  if (probe) {
    let probeSnap1, probeSnap2;
    try {
      probeSnap1 = await runProbeOnce(gameDir, probe);
      probeSnap2 = await runProbeOnce(gameDir, probe);
    } catch (e) {
      // Fix round (R4): a throw here can mean two very different things —
      // (a) the GAME recorded unexpected __test.errors during the replay
      // (runProbeOnce marks this `isGameSideError`), which points at the
      // game's own code, not at playtest.probe.js; or (b) playtest.probe.js
      // itself threw (a bad steps array, a throwing controller()), an import
      // failure, or a malformed probe (both handled earlier, in
      // loadProbeIfPresent) — those genuinely do point at playtest.probe.js
      // first. N6 originally named playtest.probe.js as the primary suspect
      // for EVERY throw here, including case (a), which sent the author
      // looking in the wrong file for a bug that was in their own game.
      if (e.isGameSideError) {
        throw new Error(`the GAME recorded unexpected __test.errors during a playtest.probe.js ("${probe.name || 'unnamed'}", seed ${probe.seed}) replay: ${e.message} — treat the GAME's own code as the primary suspect (the error came from the game's own __test.errors, not from playtest.probe.js or the scripted-session interpreter throwing); playtest.probe.js driving an input the game doesn't handle cleanly is still worth a second look, but the game is where this points first`);
      }
      throw new Error(`playtest.probe.js ("${probe.name || 'unnamed'}", seed ${probe.seed}) threw during determinism replay: ${e.message} — treat playtest.probe.js itself (its steps array, or its controller() function if it has one) as the primary suspect, alongside the scripted-session interpreter it runs through`);
    }
    if (!snapshotsEqual(probeSnap1, probeSnap2)) {
      // N6: this used to blame only "the game's own scored mechanic" — but a
      // mismatch here can equally be caused by playtest.probe.js itself (e.g.
      // a controller() that reads Math.random() or wall-clock time instead of
      // the game's own seeded RNG). Name both suspects, playtest.probe.js first.
      const err = new Error(`playtest.probe.js ("${probe.name || 'unnamed'}") replayed twice at seed ${probe.seed} produced DIFFERENT final snapshots — a hidden Math.random()/time/order dependency is likely, either in playtest.probe.js itself (its steps, or its controller() function) or in the game's own scored mechanic the probe exercises (the generic script above already ruled out everything the generic script itself reaches, so playtest.probe.js is the first place to look)`);
      err.details = [
        `run 1 digest: ${snapshotDigest(probeSnap1)}`,
        `run 2 digest: ${snapshotDigest(probeSnap2)}`,
        `run 1: ${canonicalJSON(probeSnap1).slice(0, 500)}`,
        `run 2: ${canonicalJSON(probeSnap2).slice(0, 500)}`
      ];
      throw err;
    }
    details.push(`playtest.probe.js ("${probe.name}") replayed twice at seed ${probe.seed}: identical final snapshots (digest ${snapshotDigest(probeSnap1)}) — the game's own scored mechanic is deterministic too`);
  } else {
    details.push('no playtest.probe.js found in this game dir — probe-based replay SKIPPED, falling back to the generic script only; this is a WEAKER determinism guarantee for any mechanic the generic script does not exercise (e.g. a paddle-hit path a stationary/centred paddle never reaches)');
  }

  return details;
}

if (isMain(import.meta.url)) runAsCli('determinism', run);
