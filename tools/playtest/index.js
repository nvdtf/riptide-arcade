// tools/playtest/index.js
//
// `npm run playtest -- <game-dir> [--headed] [--seed=<n>]`
//
// Plays the game TWICE (see tools/playtest/lib/{scripted,exploratory}Session.js
// for the mechanics of each) and emits `<game-dir>/playtest-report/` with
// screenshots, `report.json`, and `report.md`.
//
// EXIT-CODE POLICY (also restated in report.md so a reviewer sees it without
// reading source):
//   non-zero when:
//     1. the game never boots to MENU within the boot timeout, or
//     2. __test.errors is non-empty at the end of EITHER session, or
//     3. the harness itself throws (a tooling bug, not a game bug).
//   zero otherwise — including when a probe's `expectState` checks branch
//   away from what was expected (advisory, logged in the report) and
//   regardless of the (human-authored) confusion/clarity findings. Playtest
//   REPORTS on quality; it does not gate merges on taste.

import { resolve, join, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rm, mkdir, stat } from 'node:fs/promises';
import { serveAndLaunch } from '../lib/browser.js';
import { gotoGameAndWaitForMenu } from '../lib/hook.js';
import { installFrameRecorder } from './lib/capture.js';
import { runScriptedSession } from './lib/scriptedSession.js';
import { runExploratorySession } from './lib/exploratorySession.js';
import { writeReports } from './lib/reportWriter.js';
import { randomSeed } from './lib/prng.js';

const EXIT_POLICY_TEXT = `\`npm run playtest -- <game-dir>\` exits **non-zero** only when:
1. the game never boots to MENU within the boot timeout (the same failure class \`tools/verify/smoke.js\` checks), or
2. \`__test.errors\` is non-empty at the end of EITHER session (scripted or exploratory) — a captured uncaught error, unhandled rejection, \`console.error\`, runtime fault, or bad snapshot, or
3. the harness itself throws (a bug in the tooling, not the game).

It exits **zero** whenever both sessions completed cleanly and a report was written — including when a scripted probe's \`expectState\` checks did not match (a probe may legitimately branch) and regardless of what the confusion/clarity findings say once a reviewer fills them in. Playtest REPORTS on quality; it does not GATE merges on taste.`;

const EXPLORATORY_DURATION_MS = 10000;
const BOOT_TIMEOUT_MS = 10000;

// Fix round (N4): `npm run playtest` had NO overall deadline at all — a game
// that hangs (e.g. an infinite loop reachable from a tick()/evaluate() call
// in either session, or a page that never settles) left the harness running
// indefinitely; observed still hung at 150s with no end in sight. 120s is
// generous versus a normal run's observed ~5-15s (scripted session + bounded
// 10s-real-time exploratory session + report writing) while still being a
// real, hard ceiling. This is a SEPARATE deadline from the verifiers' own
// existing 60s-per-verifier deadline (tools/verify/lib/report.js, untouched
// by this fix) — this one covers the playtest harness as a whole (both
// sessions plus report writing), not any single verifier.
const PLAYTEST_DEADLINE_MS = 120000;

/**
 * Race `promise` against a `ms` timeout; rejects with a clear message on
 * timeout, never leaves a dangling timer (always cleared in `finally`).
 *
 * Deliberately does NOT `.unref()` the deadline timer (unlike the verifiers'
 * per-verifier deadline in tools/verify/lib/report.js, which this fix round
 * leaves untouched): the entire point of an overall deadline is to guarantee
 * the process exits even when NOTHING else is keeping the event loop alive
 * (an unref'd timer can be starved of its own callback when it is the only
 * remaining handle, which defeats a "guaranteed" deadline). A live Playwright
 * session always has open handles of its own regardless, so this makes no
 * difference in the common case — it only matters in the adversarial one,
 * which is exactly the case N4 exists for.
 */
function withDeadline(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseArgs(argv) {
  let headed = false, seed = null, gameDirArg = null;
  for (const a of argv) {
    if (a === '--headed') headed = true;
    else if (a.startsWith('--seed=')) seed = Number(a.slice('--seed='.length));
    else if (!gameDirArg) gameDirArg = a;
  }
  return { headed, seed, gameDirArg };
}

async function loadProbe(gameDir) {
  const probePath = join(gameDir, 'playtest.probe.js');
  try {
    await stat(probePath);
  } catch {
    throw new Error(`no playtest.probe.js found in ${gameDir} — every game must declare one (see games/fixture-pong/playtest.probe.js for the reference shape)`);
  }
  const mod = await import(pathToFileURL(probePath).href);
  const probe = mod.default || mod.probe;
  if (!probe || !Array.isArray(probe.steps)) {
    throw new Error(`${probePath} did not export a valid probe (expected 'export default probe' with a .steps array)`);
  }
  return probe;
}

async function main() {
  const { headed, seed: seedArg, gameDirArg } = parseArgs(process.argv.slice(2));
  if (!gameDirArg) {
    console.error('usage: npm run playtest -- <game-dir> [--headed] [--seed=<n>]');
    process.exit(2);
  }
  const gameDir = resolve(gameDirArg);
  const gameName = basename(gameDir);
  const reportDir = join(gameDir, 'playtest-report');
  const seed = Number.isFinite(seedArg) ? seedArg >>> 0 : randomSeed();

  console.log(`playtest: ${gameDir}`);
  console.log(`exploratory seed: ${seed} (pass --seed=${seed} to reproduce the action sequence)`);
  console.log(`mode: ${headed ? 'headed' : 'headless'}`);

  let probe;
  try {
    probe = await loadProbe(gameDir);
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  }

  await rm(reportDir, { recursive: true, force: true });
  await mkdir(reportDir, { recursive: true });

  let scripted = null;
  let exploratory = null;

  /** Both sessions, start to finish — this whole body is what N4's overall deadline bounds. */
  async function runBothSessions() {
    const session = await serveAndLaunch(gameDir, { headless: !headed });
    try {
      // --- Session 1: scripted probe (ticked, deterministic) ---
      const { page: scriptedPage, close: closeScriptedPage } = await session.newPage();
      try {
        const hook = await gotoGameAndWaitForMenu(scriptedPage, session.baseURL, probe.entry || 'index.html', { timeoutMs: BOOT_TIMEOUT_MS, gameDir });
        const startState = await hook.state();
        const result = await runScriptedSession({ page: scriptedPage, hook, probe, screenshotDir: reportDir });
        scripted = { ...result, startState, probeName: probe.name, probeDescription: probe.description, seed: probe.seed };
        console.log(`scripted session: ${scripted.finalErrors.length === 0 ? 'clean' : `${scripted.finalErrors.length} error(s)`}`);
      } finally {
        await closeScriptedPage();
      }

      // --- Session 2: bounded, seeded exploratory session (real-time) ---
      const { page: exploratoryPage, close: closeExploratoryPage } = await session.newPage();
      try {
        await installFrameRecorder(exploratoryPage); // must be installed before goto
        const hook = await gotoGameAndWaitForMenu(exploratoryPage, session.baseURL, probe.entry || 'index.html', { timeoutMs: BOOT_TIMEOUT_MS, gameDir });
        const startState = await hook.state();
        const result = await runExploratorySession({ page: exploratoryPage, hook, seed, maxWallMs: EXPLORATORY_DURATION_MS, screenshotDir: reportDir });
        exploratory = { ...result, startState, requestedDurationMs: EXPLORATORY_DURATION_MS };
        console.log(`exploratory session: ${exploratory.finalErrors.length === 0 ? 'clean' : `${exploratory.finalErrors.length} error(s)`} (${exploratory.fps.avgFps ?? 'n/a'} avg fps)`);
      } finally {
        await closeExploratoryPage();
      }
    } finally {
      await session.close();
    }
  }

  try {
    await withDeadline(
      runBothSessions(),
      PLAYTEST_DEADLINE_MS,
      `playtest exceeded its overall ${PLAYTEST_DEADLINE_MS}ms deadline — the harness appears to be hung (e.g. an infinite loop reachable from a tick()/evaluate() call in the scripted or exploratory session, or a page that never settles); failing instead of running forever. (This is the playtest harness's own deadline, covering both sessions; it is separate from the verifiers' existing 60s-per-verifier deadline, which is unchanged.)`
    );
  } catch (err) {
    console.error(`FAIL: playtest could not complete: ${err.message}`);
    process.exit(1);
  }

  const { report } = await writeReports({
    reportDir,
    game: gameName,
    gameDir: relative(process.cwd(), gameDir) || '.',
    scripted,
    exploratory,
    exitPolicyText: EXIT_POLICY_TEXT
  });

  console.log(`report written: ${relative(process.cwd(), reportDir)}/ (report.json, report.md, ${report.screenshots.length} screenshot(s))`);

  const errorsFound = scripted.finalErrors.length > 0 || exploratory.finalErrors.length > 0;
  if (errorsFound) {
    console.error('FAIL: __test.errors was non-empty in at least one session — see report.json for detail');
    process.exit(1);
  }
  process.exit(0);
}

main();
