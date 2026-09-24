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

// --- Fix round C2: budgets.json is now type-checked. A type slip used to
// silently disable the budget it appeared in (never a FAIL); it must now be
// a FAIL naming the offending key. Each case below is the exact mutant class
// the reviewer proved against games/fixture-pong ("globstr", "strbudget", a
// misspelled key) reproduced against a scratch dir.

test('budget.js (C2/"globstr"): excludeGlobs as a STRING (not array) fails validation, naming the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    // A big file that a working excludeGlobs=["playtest-report/**"] would NOT
    // exclude — proving this isn't accidentally passing for an unrelated reason.
    await writeFile(join(dir, 'index.html'), 'x'.repeat(50000));
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 1500,
      excludeGlobs: 'playtest-report/**' // BUG: a string, not an array — iterated char-by-char pre-fix
    }));
    await assert.rejects(() => checkBudgets(dir), /"excludeGlobs" must be an array of strings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (C2/"strbudget"): maxFileBytes as a STRING ("20KB") fails validation, naming the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), 'x'.repeat(47000)); // ~46KB: `size > "20KB"` is NaN, never trips, pre-fix
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: '20KB', maxDirBytes: 512000, excludeGlobs: []
    }));
    await assert.rejects(() => checkBudgets(dir), /"maxFileBytes" must be a finite non-negative number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (C2/typo key): a misspelled top-level key (maxFileKB) fails validation instead of being silently ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileKB: 5, maxDirBytes: 512000, excludeGlobs: []
      // BUG: no valid maxFileBytes at all — pre-fix this silently took the
      // 200KB default instead of failing, so a game author's "tighten the
      // budget" change would have no effect and nobody would notice.
    }));
    await assert.rejects(() => checkBudgets(dir), /unknown top-level key "maxFileKB"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (C2): an unknown assets.* key fails validation, naming the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      assets: { maxGlbTriangls: 100 } // typo'd key
    }));
    await assert.rejects(() => checkBudgets(dir), /unknown key "assets\.maxGlbTriangls"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (C2): progressKeys must be an array of strings when present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      progressKeys: 'ball' // BUG: a string, not an array
    }));
    await assert.rejects(() => checkBudgets(dir), /"progressKeys" must be an array of strings/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (C2): a valid budgets.json with progressKeys declared still passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      progressKeys: ['ball', 'paddle', 'score']
    }));
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, true, `expected pass, got violations: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Fix round N3: a documented `notes` free-form string escape hatch, and a
// `budgetsVersion` the tool does not understand is now a clear FAIL rather
// than a silent accept.

test('budget.js (N3): a documented `notes` string key is accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      notes: 'maxDirBytes raised because this game ships one .glb asset'
    }));
    const { ok, violations } = await checkBudgets(dir);
    assert.equal(ok, true, `expected pass, got violations: ${JSON.stringify(violations)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (N3): a non-string `notes` fails validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      notes: 12345 // BUG: not a string
    }));
    await assert.rejects(() => checkBudgets(dir), /"notes" must be a string/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (N3): `_comment` is NOT the escape hatch — still a hard FAIL (only `notes` is sanctioned)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 1, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: [],
      _comment: 'humans love writing these'
    }));
    await assert.rejects(() => checkBudgets(dir), /unknown top-level key "_comment"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('budget.js (N3): an unrecognised budgetsVersion (99) fails validation with a clear message, not a silent accept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riptide-budget-test-'));
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>scratch</title>');
    await writeFile(join(dir, 'budgets.json'), JSON.stringify({
      budgetsVersion: 99, entry: 'index.html', maxFileBytes: 1000, maxDirBytes: 5000, excludeGlobs: []
    }));
    await assert.rejects(() => checkBudgets(dir), /"budgetsVersion" 99 is not a version this tool understands/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

