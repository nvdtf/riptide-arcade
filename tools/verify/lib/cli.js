// tools/verify/lib/cli.js
//
// Shared "make this file individually runnable" wrapper so every verifier
// under tools/verify/ behaves identically from the command line:
//   node tools/verify/<name>.js <game-dir>
// and via the single entry point `node tools/verify/index.js <game-dir>`,
// which imports `run()` from each module directly instead of shelling out.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNamed, printResult } from './report.js';

/** True when this module was invoked directly (`node thisfile.js ...`). */
export function isMain(moduleUrl) {
  return process.argv[1] && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/**
 * Standalone CLI entry for one verifier module.
 * @param {string} name verifier name, e.g. 'smoke'
 * @param {(gameDir: string) => Promise<string[]|void>} runFn
 */
export async function runAsCli(name, runFn) {
  const gameDirArg = process.argv[2];
  if (!gameDirArg) {
    console.error(`usage: node tools/verify/${name}.js <game-dir>`);
    process.exit(2);
  }
  const gameDir = resolve(gameDirArg);
  const result = await runNamed(name, () => runFn(gameDir));
  printResult(result);
  process.exit(result.ok ? 0 : 1);
}
