// tools/playtest/lib/scriptedSession.js
//
// Replays a game's `playtest.probe.js` — the reference interpreter documented
// in that file's header comment — against a freshly-loaded page. TICKED
// (deterministic): __test.tick()/autoClock stays OFF for the whole segment,
// so this run is a pure function of (probe.seed, probe.steps). Screenshots
// are taken at every state transition and at every `label` step; there is no
// wall-clock time in this segment, so the "every 5 seconds" cadence from the
// spec does not apply here (see exploratorySession.js for that).

import { captureScreenshot } from './capture.js';

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
  events.push({ type: 'screenshot', file: startShot, reason: 'segment-start', state: lastState });

  for (let i = 0; i < probe.steps.length; i++) {
    const step = probe.steps[i];
    switch (step.kind) {
      case 'input':
        await hook.input(step.action, step.pressed);
        break;
      case 'tick':
        await hook.tick(step.n);
        break;
      case 'auto':
        for (let k = 0; k < step.n; k++) {
          const snap = await hook.snapshot();
          const ops = probe.controller(snap) || [];
          for (const op of ops) await hook.input(op.action, op.pressed);
          await hook.tick(1);
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
      events.push({ type: 'screenshot', file, reason: 'transition', from: lastState, to: newState, index: i });
      lastState = newState;
    }
  }

  const endShot = await captureScreenshot(page, screenshotDir, `scripted-end-${lastState}`);
  events.push({ type: 'screenshot', file: endShot, reason: 'segment-end', state: lastState });

  const finalSnapshot = await hook.snapshot();
  const finalErrors = await hook.errors();
  return { events, finalSnapshot, finalErrors };
}
