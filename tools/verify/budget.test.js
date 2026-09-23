// tools/verify/budget.test.js
//
// Unit tests for the DORMANT asset checks in tools/verify/lib/budgets.js
// (triangle cap, file-size cap, required clean-rig sidecar) — proven against
// the tiny checked-in GLB fixture at tools/verify/fixtures/triangle.glb
// (1 triangle, 672 bytes) since no shipped game has an assets/ dir yet.
//
// Run standalone: `node --test tools/verify/budget.test.js`
// Also invoked by `npm run regression` (see tests/regression/run.js), which
// is how CI exercises these — per the order this is the chosen wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudgets } from './lib/budgets.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_GLB = join(here, 'fixtures', 'triangle.glb');
const FIXTURE_META = join(here, 'fixtures', 'triangle.glb.meta.json');

/** A fresh scratch game dir with an index.html and assets/triangle.glb (+ meta unless told not to). */
async function makeScratchGameDir({ includeMeta = true, metaOverrides = {}, budgetsOverrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
  await mkdir(join(dir, 'assets'));
  await cp(FIXTURE_GLB, join(dir, 'assets', 'triangle.glb'));
  if (includeMeta) {
    const meta = JSON.parse(await (await import('node:fs/promises')).readFile(FIXTURE_META, 'utf8'));
    Object.assign(meta, metaOverrides);
    await writeFile(join(dir, 'assets', 'triangle.glb.meta.json'), JSON.stringify(meta, null, 2));
  }
  const budgets = {
    budgetsVersion: 1,
    entry: 'index.html',
    maxFileBytes: 204800,
    maxDirBytes: 512000,
    excludeGlobs: ['playtest-report/**', '*.map'],
    assets: { maxGlbFileBytes: 2097152, maxGlbTriangles: 50000, requireRigCheck: true, ...budgetsOverrides.assets },
    ...budgetsOverrides
  };
  await writeFile(join(dir, 'budgets.json'), JSON.stringify(budgets, null, 2));
  return dir;
}

test('budget.js: passing case — 1-triangle GLB with a clean sidecar under generous budgets', async () => {
  const dir = await makeScratchGameDir();
  try {
    const { ok, violations, info } = await checkBudgets(dir);
    assert.equal(ok, true, `expected pass, got violations: ${JSON.stringify(violations)}`);
    assert.equal(info.assetResults.length, 1);
    assert.equal(info.assetResults[0].triangles, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: triangle-cap failure — maxGlbTriangles below the fixture\'s 1 triangle', async () => {
  const dir = await makeScratchGameDir({ budgetsOverrides: { assets: { maxGlbTriangles: 0 } } });
  try {
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /triangles/.test(v)), `expected a triangles violation, got: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: file-size failure — maxGlbFileBytes below the fixture\'s actual size', async () => {
  const fixtureSize = (await stat(FIXTURE_GLB)).size;
  const dir = await makeScratchGameDir({ budgetsOverrides: { assets: { maxGlbFileBytes: fixtureSize - 1 } } });
  try {
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /file size/.test(v)), `expected a file-size violation, got: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: missing-sidecar failure — .glb with no <asset>.meta.json', async () => {
  const dir = await makeScratchGameDir({ includeMeta: false });
  try {
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /missing or unreadable sidecar/.test(v)), `expected a missing-sidecar violation, got: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: rig-status-not-clean failure — sidecar declares rigStatus "dirty"', async () => {
  const dir = await makeScratchGameDir({ metaOverrides: { rigStatus: 'dirty' } });
  try {
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /rigStatus/.test(v)), `expected a rigStatus violation, got: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: declaredTriangles mismatch beyond tolerance fails', async () => {
  const dir = await makeScratchGameDir({ metaOverrides: { declaredTriangles: 999 } });
  try {
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /declaredTriangles/.test(v)), `expected a declaredTriangles violation, got: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: excludeGlobs keeps playtest-report/** out of both the per-file and dir-total checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await mkdir(join(dir, 'playtest-report'));
    // A report file that would blow a tiny per-file budget if it were counted.
    await writeFile(join(dir, 'playtest-report', 'huge.json'), 'x'.repeat(2000));
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html',
      maxFileBytes: 1000, maxDirBytes: 1500,
      excludeGlobs: ['playtest-report/**', '*.map']
    }));
    const { ok, violations, info } = await checkBudgets(dir);
    assert.equal(ok, true, `expected excludeGlobs to keep this passing, got: ${JSON.stringify(violations)}`);
    assert.equal(info.excludedCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js: a file over maxFileBytes fails when NOT excluded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), 'x'.repeat(2000));
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: []
    }));
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, false);
    assert.ok(violations.some((v) => /maxFileBytes/.test(v)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
