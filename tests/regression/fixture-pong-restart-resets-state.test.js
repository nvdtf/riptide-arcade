// tests/regression/fixture-pong-restart-resets-state.test.js
//
// Regression test for the bug class documented at the reset() call site in
// games/fixture-pong/index.html: "restart after game over keeps the old
// score / entities". Drives the real game through __test exactly like the
// verifiers do — no mocking, no reimplementing the game's rules.
//
// Contract (see tests/regression/README.md): `export async function run()`
// returns an array of human-readable detail strings on success, or throws an
// Error (with a clear message) on failure. tests/regression/run.js discovers
// and executes every `*.test.js` file in this directory this way.

import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGame } from '../../tools/lib/browser.js';
import { gotoGameAndWaitForMenu } from '../../tools/lib/hook.js';
import { probe } from '../../games/fixture-pong/playtest.probe.js';

const here = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(here, '..', '..', 'games', 'fixture-pong');

const CONTROL_TICKS = 400;    // enough for the probe's own controller to score at least once (seed 1)
const IDLE_CHUNK = 100;
const MAX_IDLE_TICKS = 3000;  // generous headroom over fixture-pong's measured idle-to-GAME_OVER horizon

export async function run() {
  const { page, baseURL, close } = await openGame(GAME_DIR, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, 'index.html');
    await hook.seed(1); // reseed while still in MENU

    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);

    // Actually score at least one real return — a test that reaches GAME_OVER
    // with score/hits already at zero would not catch "restart keeps the old
    // score", because zero would trivially match a correct reset too. Reuse
    // the game's own declared probe controller (playtest.probe.js) to track
    // the ball, exactly the way a real player / the playtest harness would.
    for (let i = 0; i < CONTROL_TICKS; i++) {
      const snap = await hook.snapshot();
      for (const op of probe.controller(snap)) await hook.input(op.action, op.pressed);
      await hook.tick(1);
    }
    await hook.input('left', false);
    await hook.input('right', false);
    await hook.input('primary', false);

    const preLossSnapshot = await hook.snapshot();
    if (preLossSnapshot.score === 0 || preLossSnapshot.hits === 0) {
      throw new Error(`test setup failed to score any hits in ${CONTROL_TICKS} controlled ticks (score=${preLossSnapshot.score}, hits=${preLossSnapshot.hits}) — cannot prove restart resets a NON-zero score; this test needs adjusting, not the game`);
    }

    // Let go and idle-tick (bounded) until the paddle, no longer tracked, misses enough to lose.
    let idleTicks = 0;
    let state = await hook.state();
    while (state === 'PLAYING' && idleTicks < MAX_IDLE_TICKS) {
      await hook.tick(IDLE_CHUNK);
      idleTicks += IDLE_CHUNK;
      state = await hook.state();
    }
    if (state !== 'GAME_OVER') {
      throw new Error(`did not reach GAME_OVER within ${MAX_IDLE_TICKS} idle ticks after releasing control (stuck at "${state}")`);
    }

    const gameOverSnapshot = await hook.snapshot();
    assert.equal(gameOverSnapshot.lives, 0, 'GAME_OVER snapshot should show 0 lives');
    assert.ok(gameOverSnapshot.score > 0, 'precondition: score should be > 0 going into GAME_OVER (see the check above)');

    // Restart via INJECTED INPUT — never a raw key press.
    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);

    const stateAfterRestart = await hook.state();
    if (stateAfterRestart !== 'PLAYING') {
      throw new Error(`restart did not transition to PLAYING (got "${stateAfterRestart}")`);
    }

    const restartSnapshot = await hook.snapshot();
    const expected = { score: 0, lives: 3, hits: 0, misses: 0 };
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(
        restartSnapshot[key], value,
        `restart must reset "${key}" to ${value}, got ${restartSnapshot[key]} (pre-restart GAME_OVER snapshot had ${key}=${gameOverSnapshot[key]})`
      );
    }
    assert.equal(restartSnapshot.ball.x, 320, 'restart must re-park the ball at x=320');
    assert.equal(restartSnapshot.ball.y, 160, 'restart must re-park the ball at y=160');
    assert.equal(restartSnapshot.paddle.x, 320, 'restart must re-centre the paddle at x=320');

    return [
      `scored ${gameOverSnapshot.hits} hit(s) / score ${gameOverSnapshot.score} before losing all lives (${CONTROL_TICKS} controlled + ${idleTicks} idle ticks)`,
      `GAME_OVER snapshot: score=${gameOverSnapshot.score} lives=${gameOverSnapshot.lives} hits=${gameOverSnapshot.hits} misses=${gameOverSnapshot.misses}`,
      `restart snapshot: score=${restartSnapshot.score} lives=${restartSnapshot.lives} hits=${restartSnapshot.hits} misses=${restartSnapshot.misses} ball=(${restartSnapshot.ball.x},${restartSnapshot.ball.y}) paddle.x=${restartSnapshot.paddle.x}`
    ];
  } finally {
    await close();
  }
}
