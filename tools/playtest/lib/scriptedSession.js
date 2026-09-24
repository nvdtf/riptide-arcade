// tools/playtest/lib/scriptedSession.js
//
// Replays a game's `playtest.probe.js` — the reference interpreter documented
// in that file's header comment — against a freshly-loaded page. TICKED
// (deterministic): __test.tick()/autoClock stays OFF for the whole segment,
// so this run is a pure function of (probe.seed, probe.steps). Screenshots
// are taken at every state transition, at every `label` step, and — fix
// round A5 — every `5 * FIXED_HZ` ticks of CUMULATIVE simulated ticking (the
// spec's "every 5 seconds of play" applies to simulated time here, since
// there is no wall-clock time in this segment at all; see
// exploratorySession.js for the real-time cadence).
//
// FIXED_HZ is hardcoded here to match templates/base-game.html's own
// CONFIG.FIXED_HZ (60) — the template's fixed simulation rate is a repo-wide
// constant, not something a game may override, so there is nothing to read
// back from the page.
//
// Fix round (N7): `screenshotDir` may be `null`/falsy to disable screenshot
// capture for this whole replay (captureScreenshot() then no-ops and returns
// `null` every time, and no `screenshot` events are emitted) — used by
// tools/verify/determinism.js's probe replay, which only needs the final
// snapshot and used to pay real wall-clock cost taking screenshots into a
// scratch directory that was discarded, unread, right after.

import { captureScreenshot } from './capture.js';

const FIXED_HZ = 60;
const SCREENSHOT_TICK_INTERVAL = 5 * FIXED_HZ; // "every 5 seconds of play", in simulated ticks

/**
 * @param {{ page, hook, probe, screenshotDir }} args
 * @returns {Promise<{ events: object[], finalSnapshot: object, finalErrors: object[] }>}
 */
export async function runScriptedSession({ page, hook, probe, screenshotDir }) {
  const events = [];
  await hook.seed(probe.seed); // reseed while still in MENU, per the __test.seed() contract
  events.push({ type: 'seed', seed: probe.seed });

  let lastState = await hook.state();
  const startShot = await captureScreenshot(page, screenshotDir, `scripted-start-${lastState}`);
  if (startShot) events.push({ type: 'screenshot', file: startShot, reason: 'segment-start', state: lastState });

  let ticksSoFar = 0;
  let nextScreenshotAtTick = SCREENSHOT_TICK_INTERVAL;

  /** Emit a periodic screenshot for every SCREENSHOT_TICK_INTERVAL boundary crossed since the last call. */
  async function capturePeriodicIfDue(currentState) {
    while (ticksSoFar >= nextScreenshotAtTick) {
      const file = await captureScreenshot(page, screenshotDir, `scripted-periodic-tick${nextScreenshotAtTick}-${currentState}`);
      if (file) events.push({ type: 'screenshot', file, reason: 'periodic-5s-simulated', state: currentState, simulatedTick: nextScreenshotAtTick });
      nextScreenshotAtTick += SCREENSHOT_TICK_INTERVAL;
    }
  }

  for (let i = 0; i < probe.steps.length; i++) {
    const step = probe.steps[i];
    switch (step.kind) {
      case 'input':
        await hook.input(step.action, step.pressed);
        break;
      case 'tick':
        await hook.tick(step.n);
        ticksSoFar += step.n;
        await capturePeriodicIfDue(await hook.state());
        break;
      case 'auto':
        for (let k = 0; k < step.n; k++) {
          const snap = await hook.snapshot();
          const ops = probe.controller(snap) || [];
          for (const op of ops) await hook.input(op.action, op.pressed);
          await hook.tick(1);
          ticksSoFar += 1;
          await capturePeriodicIfDue(await hook.state());
        }
        break;
      case 'expectState': {
        const actual = await hook.state();
        const ok = actual === step.state;
        events.push({ type: 'expectState', index: i, expected: step.state, actual, ok });
        // Advisory per the probe grammar: log, never fail the harness on a mismatch —
        // a probe may legitimately branch (its own description says so for fixture-pong).
        break;
      }
      case 'label':
        events.push({ type: 'label', index: i, text: step.text });
        break;
      default:
        events.push({ type: 'warning', index: i, message: `unknown step kind "${step.kind}"` });
    }

    const newState = await hook.state();
    if (newState !== lastState) {
      const file = await captureScreenshot(page, screenshotDir, `scripted-transition-${lastState}-to-${newState}`);
      if (file) events.push({ type: 'screenshot', file, reason: 'transition', from: lastState, to: newState, index: i });
      lastState = newState;
    }
  }

  const endShot = await captureScreenshot(page, screenshotDir, `scripted-end-${lastState}`);
  if (endShot) events.push({ type: 'screenshot', file: endShot, reason: 'segment-end', state: lastState });

  const finalSnapshot = await hook.snapshot();
  const finalErrors = await hook.errors();
  return { events, finalSnapshot, finalErrors };
}
