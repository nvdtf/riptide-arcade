// tools/verify/budget.js
//
// Enforces `<game-dir>/budgets.json` (or the defaults in tools/verify/lib/budgets.js
// when absent): max single-file size, max total directory size (honouring
// excludeGlobs — the playtest harness's `playtest-report/` must not count),
// and — dormant until a game ships `assets/*.glb` — per-asset triangle/file
// size caps plus a required clean-rig sidecar. See tools/verify/lib/budgets.js
// and tools/verify/lib/glb.js for the exact rules; this file is the CLI shell.
//
// Individually runnable: `node tools/verify/budget.js <game-dir>`

import { checkBudgets } from './lib/budgets.js';
import { runAsCli, isMain } from './lib/cli.js';

export async function run(gameDir) {
  const { ok, violations, info } = await checkBudgets(gameDir);
  const details = [
    `directory total: ${info.totalBytes}B across ${info.fileCount} file(s) (${info.excludedCount} excluded by excludeGlobs)`,
    `budgets: maxFileBytes=${info.budgets.maxFileBytes}B maxDirBytes=${info.budgets.maxDirBytes}B`
  ];
  if (info.assetResults.length > 0) {
    details.push(`asset checks: ${info.assetResults.length} .glb file(s) under assets/`);
    for (const a of info.assetResults) {
      details.push(`  ${a.file}: ${a.ok ? 'ok' : 'FAIL'}${a.triangles !== undefined ? ` (${a.triangles} triangles)` : ''}`);
    }
  } else {
    details.push('asset checks: no assets/ directory present — dormant');
  }
  if (!ok) {
    const err = new Error(`${violations.length} budget violation(s)`);
    err.details = violations;
    throw err;
  }
  return details;
}

if (isMain(import.meta.url)) runAsCli('budget', run);
