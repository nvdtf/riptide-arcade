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

  const session = await serveAndLaunch(gameDir, { headless: !headed });
  let hardFailure = null;
  let scripted = null;
  let exploratory = null;

  try {
    // --- Session 1: scripted probe (ticked, deterministic) ---
    const { page: scriptedPage, close: closeScriptedPage } = await session.newPage();
    try {
      const hook = await gotoGameAndWaitForMenu(scriptedPage, session.baseURL, probe.entry || 'index.html', { timeoutMs: BOOT_TIMEOUT_MS });
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
      const hook = await gotoGameAndWaitForMenu(exploratoryPage, session.baseURL, probe.entry || 'index.html', { timeoutMs: BOOT_TIMEOUT_MS });
      const startState = await hook.state();
      const result = await runExploratorySession({ page: exploratoryPage, hook, seed, maxWallMs: EXPLORATORY_DURATION_MS, screenshotDir: reportDir });
      exploratory = { ...result, startState, requestedDurationMs: EXPLORATORY_DURATION_MS };
      console.log(`exploratory session: ${exploratory.finalErrors.length === 0 ? 'clean' : `${exploratory.finalErrors.length} error(s)`} (${exploratory.fps.avgFps ?? 'n/a'} avg fps)`);
    } finally {
      await closeExploratoryPage();
    }
  } catch (err) {
    hardFailure = err;
  } finally {
    await session.close();
  }

  if (hardFailure) {
    console.error(`FAIL: playtest could not complete: ${hardFailure.message}`);
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
