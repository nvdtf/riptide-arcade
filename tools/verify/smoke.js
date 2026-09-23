// tools/verify/smoke.js
//
// The cheapest, fastest verifier: does the game boot cleanly at all?
//   1. load with ?test=1, wait for MENU
//   2. assert __test.errors is empty at that point
//   3. start the game via INJECTED INPUT (never a raw key press)
//   4. tick 600 steps
//   5. assert the state is sane and errors are still empty
//
// Individually runnable: `node tools/verify/smoke.js <game-dir>`
// Also imported by tools/verify/index.js, which calls run() directly.

import { openGame } from '../lib/browser.js';
import { gotoGameAndWaitForMenu } from '../lib/hook.js';
import { runAsCli, isMain } from './lib/cli.js';

const IDLE_TICKS = 600;

export async function run(gameDir) {
  const details = [];
  const { page, baseURL, close } = await openGame(gameDir, { headless: true });
  try {
    const hook = await gotoGameAndWaitForMenu(page, baseURL, 'index.html');
    details.push('reached MENU after load');

    const errorsAtMenu = await hook.errors();
    if (errorsAtMenu.length > 0) {
      throw new Error(`__test.errors is non-empty at MENU (${errorsAtMenu.length} entr${errorsAtMenu.length === 1 ? 'y' : 'ies'}): ${JSON.stringify(errorsAtMenu[0])}`);
    }
    details.push('__test.errors empty at MENU');

    // Start the game via injected input — never a raw key press.
    await hook.input('primary', true);
    await hook.tick(1);
    await hook.input('primary', false);

    const stateAfterStart = await hook.state();
    if (stateAfterStart === 'MENU') {
      throw new Error('state is still MENU after injecting a primary press + 1 tick; the start transition never fired');
    }
    details.push(`left MENU after injected primary press (state=${stateAfterStart})`);

    await hook.tick(IDLE_TICKS);

    const finalState = await hook.state();
    const legalStates = await hook.states();
    if (!legalStates.includes(finalState)) {
      throw new Error(`state() returned "${finalState}", which is not among states(): ${JSON.stringify(legalStates)}`);
    }
    if (finalState === 'LOADING' || finalState === 'BOOTING') {
      throw new Error(`state is still "${finalState}" after ${IDLE_TICKS} ticks — the game never left its boot state`);
    }
    details.push(`state sane after ${IDLE_TICKS} idle ticks: ${finalState}`);

    const finalErrors = await hook.errors();
    if (finalErrors.length > 0) {
      throw new Error(`__test.errors is non-empty after ${IDLE_TICKS} idle ticks (${finalErrors.length} entr${finalErrors.length === 1 ? 'y' : 'ies'}): ${JSON.stringify(finalErrors[0])}`);
    }
    details.push('__test.errors still empty after idle ticks');

    return details;
  } finally {
    await close();
  }
}

if (isMain(import.meta.url)) runAsCli('smoke', run);
