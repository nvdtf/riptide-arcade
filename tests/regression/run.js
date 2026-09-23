// tests/regression/run.js
//
// Wired to `npm run regression`: discovers and runs every `*.test.js` in this
// directory (see tests/regression/README.md for the contract each one
// implements), plus the dormant-asset-budget unit tests at
// tools/verify/budget.test.js (chosen home: see that file's own header and
// the order notes for why it lives there instead of duplicated here).
// Prints a per-test PASS/FAIL summary and exits non-zero on any failure.
//
// No test framework dependency: this is Node's own `node:test` runner
// (invoked as a subprocess for the budget unit tests, which are themselves
// written with `node:test`) plus a tiny hand-rolled loop for the
// `*.test.js` regression files, which use the simpler `export async
// function run()` contract (matching tools/verify/*.js) since they don't
// need node:test's sub-test/skip machinery.

import { readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const regressionDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(regressionDir, '..', '..');

async function discoverRegressionTests() {
  const entries = await readdir(regressionDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => e.name)
    .sort();
}

async function runRegressionTest(filename) {
  const full = join(regressionDir, filename);
  const start = Date.now();
  try {
    const mod = await import(pathToFileURL(full).href);
    if (typeof mod.run !== 'function') {
      throw new Error(`${filename} does not export an async run() function — see tests/regression/README.md`);
    }
    const details = await mod.run();
    return { name: filename, ok: true, durationMs: Date.now() - start, details: details || [] };
  } catch (err) {
    return { name: filename, ok: false, durationMs: Date.now() - start, message: err.message };
  }
}

/** Run `node --test tools/verify/budget.test.js` as a subprocess and fold its exit code in. */
function runBudgetUnitTests() {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const target = join(repoRoot, 'tools', 'verify', 'budget.test.js');
    const child = spawn(process.execPath, ['--test', target], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolvePromise({
        name: 'tools/verify/budget.test.js (dormant asset-budget unit tests, via node:test)',
        ok: code === 0,
        durationMs: Date.now() - start,
        message: code === 0 ? undefined : `exit ${code}`,
        output: stdout + stderr
      });
    });
  });
}

async function main() {
  const testFiles = await discoverRegressionTests();
  console.log(`regression: discovered ${testFiles.length} test file(s) in tests/regression/`);

  const results = [];
  for (const filename of testFiles) {
    const result = await runRegressionTest(filename);
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name} (${result.durationMs}ms)${result.ok ? '' : ' — ' + result.message}`);
    if (result.ok) for (const line of result.details) console.log(`       ${line}`);
    results.push(result);
  }

  const budgetResult = await runBudgetUnitTests();
  console.log(`[${budgetResult.ok ? 'PASS' : 'FAIL'}] ${budgetResult.name} (${budgetResult.durationMs}ms)`);
  if (!budgetResult.ok) {
    console.log(budgetResult.output.split('\n').map((l) => '       ' + l).join('\n'));
  }
  results.push(budgetResult);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0
    ? `all ${results.length} regression check(s) passed`
    : `${failed.length}/${results.length} regression check(s) failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
