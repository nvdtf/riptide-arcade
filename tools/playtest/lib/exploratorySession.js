// tools/playtest/lib/exploratorySession.js
//
// Bounded, SEEDED exploratory session: real-time play (autoClock(true)) so
// the FPS sampler has meaningful rAF timestamps, driven by a Node-side seeded
// PRNG picking from the game's own `__test.actions()` list. Bounded by wall
// clock (never by "until something interesting happens") so this can never
// hang: `maxWallMs` is a hard ceiling enforced with real Date.now() checks.

import { mulberry32 } from './prng.js';
import { captureScreenshot, readFrameTimestamps, computeFpsStats } from './capture.js';

const DECISION_INTERVAL_MS = 250;   // how often the mashing PRNG re-decides
const SCREENSHOT_INTERVAL_MS = 5000; // "every 5 seconds of play", per spec
const POLL_INTERVAL_MS = 50;         // state/transition polling cadence

/**
 * @param {{ page, hook, seed: number, maxWallMs?: number, screenshotDir: string }} args
 */
export async function runExploratorySession({ page, hook, seed, maxWallMs = 10000, screenshotDir }) {
  const events = [];
  const rand = mulberry32(seed);
  const actions = await hook.actions();
  events.push({ type: 'seed', seed });
  events.push({ type: 'note', text: 'exploratory segment runs REAL-TIME (__test.autoClock(true)) specifically so FPS can be sampled from rAF timestamps; action choices come from a seeded PRNG, not the page RNG.' });

  await hook.autoClock(true);

  // A real player's first move is almost always "press something to start" —
  // MENU -> PLAYING is universally `primary` in this repo's template.
  // Fix round (A4): capture the state BEFORE the start press (the true
  // "segment start") so the caller can record it as `startState`, then
  // capture the state AFTER the press and — if it already differs, which is
  // likely since this segment runs real-time — emit an explicit transition
  // screenshot/event for it. Previously the caller's `startState` was taken
  // before the press but the loop's own `lastState` was seeded AFTER the
  // press with no transition event recorded for the gap in between, so
  // report.json's state sequence could read "MENU -> PAUSED" (skipping the
  // MENU -> PLAYING edge that actually happened).
  const preStartState = await hook.state();
  await hook.input('primary', true);
  await page.waitForTimeout(80);
  await hook.input('primary', false);

  let lastState = await hook.state();
  if (lastState !== preStartState) {
    const file = await captureScreenshot(page, screenshotDir, `exploratory-transition-${preStartState}-to-${lastState}`);
    events.push({ type: 'screenshot', file, reason: 'transition', from: preStartState, to: lastState });
  }
  const startShot = await captureScreenshot(page, screenshotDir, `exploratory-start-${lastState}`);
  events.push({ type: 'screenshot', file: startShot, reason: 'segment-start', state: lastState });

  const startTime = Date.now();
  let lastScreenshotAt = startTime;
  let nextDecisionAt = startTime;
  let heldAction = null;

  while (Date.now() - startTime < maxWallMs) {
    const now = Date.now();
    if (now >= nextDecisionAt) {
      if (heldAction) { await hook.input(heldAction, false); heldAction = null; }
      if (actions.length > 0 && rand() < 0.85) { // ~15% of decisions are "let go entirely"
        heldAction = actions[Math.floor(rand() * actions.length)];
        await hook.input(heldAction, true);
      }
      nextDecisionAt = now + DECISION_INTERVAL_MS;
    }

    const state = await hook.state();
    if (state !== lastState) {
      const file = await captureScreenshot(page, screenshotDir, `exploratory-transition-${lastState}-to-${state}`);
      events.push({ type: 'screenshot', file, reason: 'transition', from: lastState, to: state });
      lastState = state;
    }
    if (Date.now() - lastScreenshotAt >= SCREENSHOT_INTERVAL_MS) {
      const file = await captureScreenshot(page, screenshotDir, `exploratory-periodic-${state}`);
      events.push({ type: 'screenshot', file, reason: 'periodic-5s', state });
      lastScreenshotAt = Date.now();
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  if (heldAction) await hook.input(heldAction, false);

  const endShot = await captureScreenshot(page, screenshotDir, `exploratory-end-${lastState}`);
  events.push({ type: 'screenshot', file: endShot, reason: 'segment-end', state: lastState });

  const frames = await readFrameTimestamps(page);
  const fps = computeFpsStats(frames);
  const actualDurationMs = Date.now() - startTime;

  await hook.autoClock(false); // restore determinism before anything else touches this page

  const finalSnapshot = await hook.snapshot();
  const finalErrors = await hook.errors();
  return { events, finalSnapshot, finalErrors, fps, actualDurationMs, actionsAvailable: actions, seed };
}
