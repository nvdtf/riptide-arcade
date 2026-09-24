/**
 * games/fixture-pong/playtest.probe.js
 *
 * The scripted input script for fixture-pong. Order 2's playtest harness
 * (`tools/playtest/`) imports this file as a plain Node ES module and replays it
 * against the page through `window.__test`. It is dependency-free and contains
 * only data and pure functions — it never touches the DOM, the network or fs.
 *
 * EXPORT SHAPE
 *   export default probe            // the object below
 *   export { probe }                // same object, named
 *   export const steps              // probe.steps, named, for harnesses that only want the script
 *
 *   probe = {
 *     name:        string           // human label for the report
 *     description: string           // what this run is supposed to demonstrate
 *     entry:       'index.html'     // the file the harness should load (relative to this dir)
 *     seed:        number           // pass to __test.seed(seed) BEFORE the first step
 *     estimatedTicks: number        // total simulation ticks the script consumes
 *     steps:       Step[]           // replay in order
 *     controller:  (snapshot) => InputOp[]   // pure; used only by { kind: 'auto' } steps
 *   }
 *
 *   Step =
 *     | { kind: 'input',       action: string, pressed: boolean }  // -> __test.input(action, pressed)
 *     | { kind: 'tick',        n: number }                         // -> __test.tick(n)
 *     | { kind: 'auto',        n: number }                         // n times: apply controller(__test.snapshot()), then __test.tick(1)
 *     | { kind: 'expectState', state: string }                     // assert __test.state() === state (advisory: log/fail, do not tick)
 *     | { kind: 'label',       text: string }                      // marker for screenshots / report sections
 *
 *   InputOp = { action: string, pressed: boolean }                 // -> __test.input(action, pressed)
 *
 * REFERENCE INTERPRETER (all a harness needs):
 *
 *   await page.evaluate((s) => window.__test.seed(s), probe.seed);
 *   for (const step of probe.steps) {
 *     switch (step.kind) {
 *       case 'input': await page.evaluate(([a, p]) => window.__test.input(a, p), [step.action, step.pressed]); break;
 *       case 'tick':  await page.evaluate((n) => window.__test.tick(n), step.n); break;
 *       case 'auto':  for (let i = 0; i < step.n; i++) {
 *                       const snap = await page.evaluate(() => window.__test.snapshot());
 *                       for (const op of probe.controller(snap)) {
 *                         await page.evaluate(([a, p]) => window.__test.input(a, p), [op.action, op.pressed]);
 *                       }
 *                       await page.evaluate(() => window.__test.tick(1));
 *                     } break;
 *       case 'expectState': /* compare with page.evaluate(() => window.__test.state()) *\/ break;
 *       case 'label': /* screenshot / report heading *\/ break;
 *     }
 *   }
 *
 * A harness that does not want to implement 'auto' can skip those steps: the
 * 'input'/'tick' steps alone still walk MENU -> PLAYING -> PAUSED -> PLAYING and
 * end in a valid state. It just will not score any points, because blind play
 * cannot follow the ball.
 */

const DEADZONE = 5;          // world units of slop before the paddle chases the ball

/** Pure: snapshot -> the input actions that should be held for the next tick. */
function controller(snapshot) {
  if (!snapshot || !snapshot.ball || !snapshot.paddle) return [];
  const dx = snapshot.ball.x - snapshot.paddle.x;
  const wantLeft = dx < -DEADZONE;
  const wantRight = dx > DEADZONE;
  // While the ball is parked before a serve, tap `primary` (alternating so the
  // input layer sees a rising edge) to serve immediately instead of waiting.
  const serveNow = snapshot.serveTimer > 0 && snapshot.serveTimer % 2 === 0;
  return [
    { action: 'left', pressed: wantLeft },
    { action: 'right', pressed: wantRight },
    { action: 'primary', pressed: serveNow }
  ];
}

export const probe = {
  name: 'fixture-pong — rally the ball, pause, rally again',
  description:
    'Starts the game, tracks the ball with the paddle to score real returns (the core mechanic), ' +
    'pauses and resumes mid-rally, then rallies again. Ends in PLAYING or GAME_OVER depending on ' +
    'how the rally went; both are valid outcomes for a playtest.',
  entry: 'index.html',
  seed: 1,
  estimatedTicks: 762,
  steps: [
    { kind: 'expectState', state: 'MENU' },
    { kind: 'label', text: 'start the game' },
    { kind: 'input', action: 'primary', pressed: true },
    { kind: 'tick', n: 1 },
    { kind: 'input', action: 'primary', pressed: false },
    { kind: 'expectState', state: 'PLAYING' },

    { kind: 'label', text: 'rally: chase the ball for 400 ticks' },
    { kind: 'auto', n: 400 },

    { kind: 'label', text: 'pause mid-rally' },
    { kind: 'input', action: 'left', pressed: false },
    { kind: 'input', action: 'right', pressed: false },
    { kind: 'input', action: 'primary', pressed: false },
    { kind: 'input', action: 'pause', pressed: true },
    { kind: 'tick', n: 1 },
    { kind: 'input', action: 'pause', pressed: false },
    { kind: 'expectState', state: 'PAUSED' },
    { kind: 'tick', n: 30 },

    { kind: 'label', text: 'resume' },
    { kind: 'input', action: 'pause', pressed: true },
    { kind: 'tick', n: 1 },
    { kind: 'input', action: 'pause', pressed: false },
    { kind: 'expectState', state: 'PLAYING' },

    { kind: 'label', text: 'rally again for 300 ticks' },
    { kind: 'auto', n: 300 },

    { kind: 'label', text: 'let go and coast' },
    { kind: 'input', action: 'left', pressed: false },
    { kind: 'input', action: 'right', pressed: false },
    { kind: 'tick', n: 30 }
  ],
  controller
};

export const steps = probe.steps;
export default probe;
