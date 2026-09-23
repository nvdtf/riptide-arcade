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

/** Load `<gameDir>/budgets.json`, falling back to DEFAULT_BUDGETS key-by-key. */
export async function loadBudgets(gameDir) {
  let declared = {};
  try {
    const raw = await readFile(join(gameDir, 'budgets.json'), 'utf8');
    declared = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`budgets.json is present but invalid JSON: ${err.message}`);
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
