// tools/verify/journey.js
//
// Walks the FULL state graph via injected inputs:
//   menu -> playing -> paused -> playing -> game over -> restart(->playing)
//
// After every transition into a "live" state (PLAYING) it PROVES gameplay is
// not frozen by ticking further and requiring some non-bookkeeping snapshot
// field to change. After the transition into PAUSED it proves the mirror
// image: ticking further must NOT change any non-bookkeeping field. The
// target bug class either way: a transition that updates `state` but leaves
// the simulation frozen (or, mirrored, a pause that doesn't actually pause).
//
// FIX ROUND (C3): two compounding gaps let a frozen-after-resume bug through:
//   1. PROBE_TICKS (30) was smaller than fixture-pong's own SERVE_DELAY (60),
//      so both 30-tick probe windows (after start, after resume) landed
//      entirely inside the fixture's serve hold, where the only fields that
//      ever move are `serveTimer`/`ticksInPlay` — bookkeeping counters that
//      advance unconditionally in Game.step(), whether or not gameplay itself
//      is frozen. PROBE_TICKS is now well past any reasonable serve hold.
//   2. Even past the serve hold, "some field changed" was satisfied by those
//      same counters. A game may now declare `progressKeys` in its
//      budgets.json (e.g. `["ball","paddle","score"]`); when declared, at
//      least one DECLARED key must change, or the probe fails — a counter
//      that advances unconditionally can no longer stand in for proof that
//      gameplay itself advanced. Games that declare no progressKeys keep the
//      old any-key behaviour (weaker, but not a regression for them).
//
// Individually runnable: `node tools/verify/journey.js <game-dir>`

import { openGame } from '../lib/browser.js';
import { gotoGameAndWaitForMenu } from '../lib/hook.js';
import { diffKeys } from '../lib/snapshot.js';
import { loadBudgets } from './lib/budgets.js';
import { runAsCli, isMain } from './lib/cli.js';

// Fields the template writes on every single tick/transition regardless of
// whether the GAME itself did anything — these must be excluded from the
// "did gameplay move" test, or the test would pass even on a fully frozen
// game (tick/stateTick always advance; state/transitions/lastTransition only
// change on the transition tick itself, which we've already asserted on).
const MACHINE_BOOKKEEPING_FIELDS = ['state', 'tick', 'stateTick', 'transitions', 'lastTransition'];

// Raised from 30 (fix round C3): fixture-pong's SERVE_DELAY is 60 ticks, and
// the old value let both probe windows land entirely inside a serve hold.
// 120 clears any serve/reaction hold with comfortable headroom while staying
// far under fixture-pong's ~1020-1075-tick idle-to-GAME_OVER horizon.
const PROBE_TICKS = 120;
const IDLE_TICKS_TO_GAME_OVER_CHUNK = 100;
const MAX_IDLE_TICKS_TO_GAME_OVER = 4000; // generous headroom over fixture-pong's measured ~1020-1075 (300 seeds)

function nonBookkeepingDiff(before, after) {
  return diffKeys(before, after).filter((k) => !MACHINE_BOOKKEEPING_FIELDS.includes(k));
}

/**
 * `changed` is the full non-bookkeeping diff. When `progressKeys` is declared
 * (non-empty), at least one of THOSE keys must be among `changed` — a game's
 * own bookkeeping counters (ticksInPlay, serveTimer, ...) no longer count as
 * proof by themselves. When no progressKeys are declared, any non-bookkeeping
 * change still counts (today's behaviour, for games that declare none).
 */
function progressProven(changed, progressKeys) {
  if (!progressKeys || progressKeys.length === 0) return changed.length > 0;
  return changed.some((k) => progressKeys.includes(k));
}

async function assertAdvances(hook, label, progressKeys, ticks = PROBE_TICKS) {
  const before = await hook.snapshot();
  await hook.tick(ticks);
  const after = await hook.snapshot();
  const changed = nonBookkeepingDiff(before, after);
  if (!progressProven(changed, progressKeys)) {
    const keyNote = progressKeys && progressKeys.length > 0
      ? ` — none of the declared progressKeys (${JSON.stringify(progressKeys)}) changed (only ${JSON.stringify(changed)} did, which do not count as proof)`
      : ' (only machine bookkeeping fields would have changed) — simulation appears frozen';
    throw new Error(`${label}: snapshot did not change over ${ticks} ticks${keyNote}`);
  }
  return changed;
}

async function assertFrozen(hook, label, ticks = PROBE_TICKS) {
  const before = await hook.snapshot();
  await hook.tick(ticks);
  const after = await hook.snapshot();
  const changed = nonBookkeepingDiff(before, after);
  if (changed.length > 0) {
    throw new Error(`${label}: snapshot changed over ${ticks} ticks while it should have been frozen — field(s) ${JSON.stringify(changed)} moved`);
  }
}

async function assertState(hook, expected, label) {
  const actual = await hook.state();
  if (actual !== expected) {
    throw new Error(`${label}: expected state "${expected}", got "${actual}"`);
  }
}

/** Idle-tick toward GAME_OVER in bounded chunks; throws if never reached. */
async function tickUntilGameOver(hook) {
  let total = 0;
  while (total < MAX_IDLE_TICKS_TO_GAME_OVER) {
    await hook.tick(IDLE_TICKS_TO_GAME_OVER_CHUNK);
    total += IDLE_TICKS_TO_GAME_OVER_CHUNK;
    const s = await hook.state();
    if (s === 'GAME_OVER') return total;
    if (s !== 'PLAYING') {
      throw new Error(`unexpected state "${s}" while idling toward GAME_OVER (after ${total} ticks)`);
    }
  }
  throw new Error(`did not reach GAME_OVER after ${MAX_IDLE_TICKS_TO_GAME_OVER} idle ticks from PLAYING`);
}

export async function run(gameDir) {
  const details = [];
  const budgets = await loadBudgets(gameDir);
  const progressKeys = Array.isArray(budgets.progressKeys) ? budgets.progressKeys : [];
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, budgets.entry);
    await assertState(hook, 'MENU', 'initial load');
    details.push('MENU reached after load');
    details.push(progressKeys.length > 0
      ? `progressKeys declared: ${JSON.stringify(progressKeys)} — at least one MUST change to prove gameplay advanced`
      : 'no progressKeys declared in budgets.json — falling back to any-non-bookkeeping-key-changed (weaker) rule');

    // --- MENU -> PLAYING ---
    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);
    await assertState(hook, 'PLAYING', 'MENU -> PLAYING');
    const advance1 = await assertAdvances(hook, 'PLAYING after start', progressKeys);
    details.push(`MENU -> PLAYING: state changed and gameplay advanced (fields: ${advance1.join(', ')})`);

    // --- PLAYING -> PAUSED ---
    await hook.input('pause', true);
    await hook.tick(1);
    await hook.input('pause', false);
    await assertState(hook, 'PAUSED', 'PLAYING -> PAUSED');
    await assertFrozen(hook, 'PAUSED');
    details.push('PLAYING -> PAUSED: state changed and gameplay correctly did NOT advance while paused');

    // --- PAUSED -> PLAYING (resume) ---
    await hook.input('pause', true);
    await hook.tick(1);
    await hook.input('pause', false);
    await assertState(hook, 'PLAYING', 'PAUSED -> PLAYING (resume)');
    const advance2 = await assertAdvances(hook, 'PLAYING after resume', progressKeys);
    details.push(`PAUSED -> PLAYING: state changed and gameplay resumed advancing (fields: ${advance2.join(', ')})`);

    // --- PLAYING -> GAME_OVER (idle to the natural loss condition) ---
    const idleTicks = await tickUntilGameOver(hook);
    await assertState(hook, 'GAME_OVER', 'PLAYING -> GAME_OVER');
    details.push(`PLAYING -> GAME_OVER: reached after ${idleTicks} idle ticks`);

    // --- GAME_OVER -> PLAYING (restart) ---
    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);
    await assertState(hook, 'PLAYING', 'GAME_OVER -> PLAYING (restart)');
    const advance3 = await assertAdvances(hook, 'PLAYING after restart', progressKeys);
    details.push(`GAME_OVER -> PLAYING (restart): state changed and gameplay advanced again (fields: ${advance3.join(', ')})`);

    return details;
  } finally {
    await close();
  }
}

if (isMain(import.meta.url)) runAsCli('journey', run);
