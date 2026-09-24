// tests/regression/run.js
//
// Wired to `npm run regression`: discovers and runs every `*.test.js` in this
// directory (see tests/regression/README.md for the contract each one
// implements), plus the dormant-asset-budget unit tests at
// tools/verify/budget.test.js (chosen home: see that file's own header and
// the order notes for why it lives there instead of duplicated here), plus
// (fix round R2) tools/ci-checks/scan-run-blocks.js run against every file
// in .github/workflows/ — a repository-integrity check, and this suite is
// its natural home (previously it was wired to NOTHING: not the workflow,
// not this runner, not a package script, so it could bit-rot indefinitely
// without ever actually protecting anything).
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

/**
 * Fix round (R2): run tools/ci-checks/scan-run-blocks.js against every file
 * in .github/workflows/ as a subprocess and fold its exit code in — this is
 * the repository-integrity check that guards against the X1 bug class
 * (illustrative `${{ ... }}`-shaped text breaking workflow parsing). Before
 * this fix round the scanner existed but was invoked by nothing at all.
 */
function runWorkflowScan() {
  return new Promise(async (resolvePromise) => {
    const start = Date.now();
    const workflowsDir = join(repoRoot, '.github', 'workflows');
    let workflowFiles = [];
    try {
      const entries = await readdir(workflowsDir, { withFileTypes: true });
      workflowFiles = entries
        .filter((e) => e.isFile() && (e.name.endsWith('.yml') || e.name.endsWith('.yaml')))
        .map((e) => join(workflowsDir, e.name))
        .sort();
    } catch {
      // No .github/workflows directory at all — nothing to scan, not a failure.
    }
    if (workflowFiles.length === 0) {
      resolvePromise({
        name: 'tools/ci-checks/scan-run-blocks.js (workflow ${{ }} scan)',
        ok: true,
        durationMs: Date.now() - start,
        details: ['no .github/workflows/*.yml files found — nothing to scan']
      });
      return;
    }
    const target = join(repoRoot, 'tools', 'ci-checks', 'scan-run-blocks.js');
    const child = spawn(process.execPath, [target, ...workflowFiles], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolvePromise({
        name: 'tools/ci-checks/scan-run-blocks.js (workflow ${{ }} scan)',
        ok: code === 0,
        durationMs: Date.now() - start,
        message: code === 0 ? undefined : `exit ${code}`,
        details: code === 0 ? stdout.split('\n').filter(Boolean) : undefined,
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

  const workflowScanResult = await runWorkflowScan();
  console.log(`[${workflowScanResult.ok ? 'PASS' : 'FAIL'}] ${workflowScanResult.name} (${workflowScanResult.durationMs}ms)`);
  if (workflowScanResult.ok) {
    if (workflowScanResult.details) for (const line of workflowScanResult.details) console.log(`       ${line}`);
  } else {
    console.log(workflowScanResult.output.split('\n').map((l) => '       ' + l).join('\n'));
  }
  results.push(workflowScanResult);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(failed.length === 0
    ? `all ${results.length} regression check(s) passed`
    : `${failed.length}/${results.length} regression check(s) failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
