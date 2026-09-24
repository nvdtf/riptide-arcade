// tools/verify/lib/budgets.js
//
// Enforces `<game-dir>/budgets.json` (or the baked-in defaults below when the
// file is absent). Two independent things are checked:
//   1. Size budgets: max single file, max total directory size, honouring
//      `excludeGlobs` (so the playtest harness's own `playtest-report/` output
//      never counts against a game's budget).
//   2. Asset budgets (dormant until a game ships `assets/*.glb`): per-file
//      size cap, triangle-count cap (via tools/verify/lib/glb.js), and a
//      required clean-rig sidecar `<asset>.meta.json`.
//
// SIDECAR SCHEMA (`<asset-path>.meta.json`, e.g. `assets/ship.glb.meta.json`):
//   {
//     "provenance": { "tool": "...", "prompt": "...", "model": "..." },
//     "declaredTriangles": 12,
//     "rigStatus": "clean" | "unchecked" | "dirty"
//   }
// RIG/TRI RULE (stated here, restated in the order notes):
//   - `rigStatus` MUST be the literal string "clean".
//   - `declaredTriangles` MUST match the triangle count parsed from the GLB's
//     own JSON chunk within a tolerance of `max(1, ceil(parsed * 0.01))`
//     (i.e. exact, or within 1%, whichever is looser) — this absorbs the ±1
//     rounding a TRIANGLE_STRIP/FAN primitive can introduce without letting a
//     grossly wrong declared count slide through.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep, extname } from 'node:path';
import { readGlbJsonChunk, countTriangles } from './glb.js';

export const DEFAULT_BUDGETS = Object.freeze({
  budgetsVersion: 1,
  entry: 'index.html',
  maxFileBytes: 200 * 1024,
  maxDirBytes: 500 * 1024,
  excludeGlobs: ['playtest-report/**', '*.map'],
  assets: Object.freeze({
    maxGlbFileBytes: 2 * 1024 * 1024,
    maxGlbTriangles: 50000,
    requireRigCheck: true
  })
});

// SCHEMA / TYPE-CHECKING (fix round, finding C2): a type slip in budgets.json
// used to be silently ignored — a string where an array was expected, a
// numeric-looking string where a number was expected, or a misspelled key —
// and the game would then pass every budget check for the wrong reason (the
// budget was effectively disabled, not honoured). Every declared key is now
// validated; any violation is a thrown Error naming the offending key and
// what was wrong with it. There is no silent default for a key that IS
// present but malformed — only an ABSENT key falls back to DEFAULT_BUDGETS.
// `progressKeys` (fix round C3): the snapshot keys a game declares as proof
// that gameplay itself advanced, consumed by tools/verify/journey.js — see
// that file's header comment. Not used by budget.js itself, but it lives in
// the same budgets.json, so it is validated here alongside everything else.
// `notes` (fix round N3): the one free-form, documented escape hatch for
// human notes on a game's budgets.json (e.g. "why maxDirBytes is raised") —
// see README.md/docs/spec-template.md §7 for the one-line description. Any
// OTHER unrecognised key (a typo, `_comment`, anything not in this list) is
// still a hard FAIL — `notes` is the only sanctioned place for prose.
const ALLOWED_TOP_KEYS = new Set(['budgetsVersion', 'entry', 'maxFileBytes', 'maxDirBytes', 'excludeGlobs', 'progressKeys', 'assets', 'notes']);
const ALLOWED_ASSET_KEYS = new Set(['maxGlbFileBytes', 'maxGlbTriangles', 'requireRigCheck']);

// fix round N3: budgetsVersion used to be validated as "any finite
// non-negative number", so a value like 99 — meaningless to every version of
// this tool that has ever existed — was accepted silently, as if the file
// declared a schema version this tool actually understood. The only version
// this tool has ever spoken is 1.
const KNOWN_BUDGETS_VERSIONS = new Set([1]);

function isFiniteNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** @returns {string[]} human-readable problem descriptions, one per violation, empty when clean */
function validateBudgets(declared) {
  const problems = [];

  for (const key of Object.keys(declared)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      problems.push(`unknown top-level key "${key}" (check for a typo — allowed keys: ${[...ALLOWED_TOP_KEYS].join(', ')})`);
    }
  }

  if (declared.budgetsVersion !== undefined && !isFiniteNonNegativeNumber(declared.budgetsVersion)) {
    problems.push(`"budgetsVersion" must be a finite non-negative number, got ${JSON.stringify(declared.budgetsVersion)}`);
  } else if (declared.budgetsVersion !== undefined && !KNOWN_BUDGETS_VERSIONS.has(declared.budgetsVersion)) {
    problems.push(`"budgetsVersion" ${JSON.stringify(declared.budgetsVersion)} is not a version this tool understands (known: ${[...KNOWN_BUDGETS_VERSIONS].join(', ')}) — this is not silently accepted; either this budgets.json targets a newer/older tool than the one running, or the number is a typo`);
  }
  if (declared.entry !== undefined && (typeof declared.entry !== 'string' || declared.entry.length === 0)) {
    problems.push(`"entry" must be a non-empty string, got ${JSON.stringify(declared.entry)}`);
  }
  if (declared.maxFileBytes !== undefined && !isFiniteNonNegativeNumber(declared.maxFileBytes)) {
    problems.push(`"maxFileBytes" must be a finite non-negative number, got ${JSON.stringify(declared.maxFileBytes)} (a string like "20KB" is NOT accepted — units are not parsed, use bytes)`);
  }
  if (declared.maxDirBytes !== undefined && !isFiniteNonNegativeNumber(declared.maxDirBytes)) {
    problems.push(`"maxDirBytes" must be a finite non-negative number, got ${JSON.stringify(declared.maxDirBytes)}`);
  }
  if (declared.excludeGlobs !== undefined) {
    const isArrayOfStrings = Array.isArray(declared.excludeGlobs) && declared.excludeGlobs.every((g) => typeof g === 'string');
    if (!isArrayOfStrings) {
      problems.push(`"excludeGlobs" must be an array of strings, got ${JSON.stringify(declared.excludeGlobs)} (a bare string is iterated character-by-character, not treated as one glob)`);
    }
  }
  if (declared.progressKeys !== undefined) {
    const isArrayOfStrings = Array.isArray(declared.progressKeys) && declared.progressKeys.every((g) => typeof g === 'string');
    if (!isArrayOfStrings) {
      problems.push(`"progressKeys" must be an array of strings, got ${JSON.stringify(declared.progressKeys)}`);
    }
  }
  if (declared.notes !== undefined && typeof declared.notes !== 'string') {
    problems.push(`"notes" must be a string, got ${JSON.stringify(declared.notes)}`);
  }
  if (declared.assets !== undefined) {
    if (declared.assets === null || typeof declared.assets !== 'object' || Array.isArray(declared.assets)) {
      problems.push(`"assets" must be an object, got ${JSON.stringify(declared.assets)}`);
    } else {
      const a = declared.assets;
      for (const key of Object.keys(a)) {
        if (!ALLOWED_ASSET_KEYS.has(key)) {
          problems.push(`unknown key "assets.${key}" (check for a typo — allowed keys: ${[...ALLOWED_ASSET_KEYS].join(', ')})`);
        }
      }
      if (a.maxGlbFileBytes !== undefined && !isFiniteNonNegativeNumber(a.maxGlbFileBytes)) {
        problems.push(`"assets.maxGlbFileBytes" must be a finite non-negative number, got ${JSON.stringify(a.maxGlbFileBytes)}`);
      }
      if (a.maxGlbTriangles !== undefined && !isFiniteNonNegativeNumber(a.maxGlbTriangles)) {
        problems.push(`"assets.maxGlbTriangles" must be a finite non-negative number, got ${JSON.stringify(a.maxGlbTriangles)}`);
      }
      if (a.requireRigCheck !== undefined && typeof a.requireRigCheck !== 'boolean') {
        problems.push(`"assets.requireRigCheck" must be a boolean, got ${JSON.stringify(a.requireRigCheck)}`);
      }
    }
  }

  return problems;
}

/** Load `<gameDir>/budgets.json`, falling back to DEFAULT_BUDGETS key-by-key. */
export async function loadBudgets(gameDir) {
  let declared = {};
  try {
    const raw = await readFile(join(gameDir, 'budgets.json'), 'utf8');
    declared = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`budgets.json is present but invalid JSON: ${err.message}`);
  }
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new Error(`budgets.json must contain a JSON object, got ${JSON.stringify(declared)}`);
  }
  const problems = validateBudgets(declared);
  if (problems.length > 0) {
    throw new Error(`budgets.json failed validation (${problems.length} problem(s)):\n  - ${problems.join('\n  - ')}`);
  }
  return {
    ...DEFAULT_BUDGETS,
    ...declared,
    assets: { ...DEFAULT_BUDGETS.assets, ...(declared.assets || {}) }
  };
}

/** Convert a `.gitignore`-ish glob into a RegExp. Supports `*`, `**`, `?`. */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Does `relPath` (POSIX-separated, relative to the game dir) match any of
 * `globs`? A glob with no `/` matches by basename at any depth (gitignore
 * semantics); a glob with `/` is anchored to the full relative path.
 */
export function matchesAnyGlob(relPath, globs) {
  const parts = relPath.split('/');
  const basename = parts[parts.length - 1];
  for (const glob of globs) {
    const re = globToRegExp(glob);
    if (glob.includes('/')) { if (re.test(relPath)) return true; }
    else if (re.test(basename)) return true;
  }
  return false;
}

/** Recursively list every file under `dir`, returning POSIX-relative paths. */
async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(await walk(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full).split(sep).join('/'));
    }
  }
  return files;
}

/**
 * Run every budget check against `gameDir`.
 * @returns {Promise<{ ok: boolean, violations: string[], info: object }>}
 */
export async function checkBudgets(gameDir) {
  const budgets = await loadBudgets(gameDir);
  const allFiles = await walk(gameDir);
  const excluded = allFiles.filter((f) => matchesAnyGlob(f, budgets.excludeGlobs));
  const counted = allFiles.filter((f) => !matchesAnyGlob(f, budgets.excludeGlobs));

  const violations = [];
  const sizes = {};
  let totalBytes = 0;
  for (const rel of counted) {
    const st = await stat(join(gameDir, rel));
    sizes[rel] = st.size;
    totalBytes += st.size;
    if (st.size > budgets.maxFileBytes) {
      violations.push(`${rel}: ${st.size}B exceeds maxFileBytes ${budgets.maxFileBytes}B`);
    }
  }
  if (totalBytes > budgets.maxDirBytes) {
    violations.push(`directory total ${totalBytes}B exceeds maxDirBytes ${budgets.maxDirBytes}B (excluding ${excluded.length} globbed path(s))`);
  }

  // Asset checks (dormant until a game ships assets/*.glb — see spec 001 non-goals).
  const glbFiles = counted.filter((f) => f.startsWith('assets/') && extname(f).toLowerCase() === '.glb');
  const assetResults = [];
  for (const rel of glbFiles) {
    const abs = join(gameDir, rel);
    const result = { file: rel, ok: true, problems: [] };
    const fileBytes = sizes[rel];
    if (fileBytes > budgets.assets.maxGlbFileBytes) {
      result.ok = false;
      result.problems.push(`file size ${fileBytes}B exceeds maxGlbFileBytes ${budgets.assets.maxGlbFileBytes}B`);
    }
    let triangles = null;
    try {
      const buf = await readFile(abs);
      const { json } = readGlbJsonChunk(buf);
      triangles = countTriangles(json);
    } catch (e) {
      result.ok = false;
      result.problems.push(`could not parse GLB: ${e.message}`);
    }
    if (triangles !== null) {
      result.triangles = triangles;
      if (triangles > budgets.assets.maxGlbTriangles) {
        result.ok = false;
        result.problems.push(`${triangles} triangles exceeds maxGlbTriangles ${budgets.assets.maxGlbTriangles}`);
      }
    }
    if (budgets.assets.requireRigCheck) {
      const sidecarPath = abs + '.meta.json';
      let meta = null;
      try {
        meta = JSON.parse(await readFile(sidecarPath, 'utf8'));
      } catch (e) {
        result.ok = false;
        result.problems.push(`missing or unreadable sidecar ${rel}.meta.json: ${e.message}`);
      }
      if (meta) {
        if (meta.rigStatus !== 'clean') {
          result.ok = false;
          result.problems.push(`sidecar rigStatus is "${meta.rigStatus}", required "clean"`);
        }
        if (typeof meta.declaredTriangles !== 'number') {
          result.ok = false;
          result.problems.push('sidecar missing numeric declaredTriangles');
        } else if (triangles !== null) {
          const tolerance = Math.max(1, Math.ceil(triangles * 0.01));
          if (Math.abs(meta.declaredTriangles - triangles) > tolerance) {
            result.ok = false;
            result.problems.push(`sidecar declaredTriangles ${meta.declaredTriangles} does not match parsed ${triangles} (tolerance ${tolerance})`);
          }
        }
        if (!meta.provenance || typeof meta.provenance !== 'object') {
          result.ok = false;
          result.problems.push('sidecar missing provenance object');
        }
      }
    }
    if (!result.ok) violations.push(`asset ${rel}: ${result.problems.join('; ')}`);
    assetResults.push(result);
  }

  return {
    ok: violations.length === 0,
    violations,
    info: {
      budgets,
      totalBytes,
      fileCount: counted.length,
      excludedCount: excluded.length,
      assetResults
    }
  };
}
