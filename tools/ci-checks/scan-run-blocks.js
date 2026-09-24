#!/usr/bin/env node
// Scans one or more GitHub Actions workflow YAML files for `${{ ... }}`
// occurrences and asserts each one is a *syntactically plausible* GitHub
// Actions expression (not illustrative text, not `...`, not anything that
// would make GitHub's parser choke or misbehave). This is the regression
// guard for X1: a `${{ ... }}`-shaped snippet was left inside a shell
// COMMENT inside a `run:` block, and GitHub evaluates the double-curly
// syntax ANYWHERE in a workflow file's values — comments inside `run:`
// blocks included — which broke workflow parsing entirely.
//
// FIX ROUND (R2): the previous version of this scanner (a) only looked
// inside `run:` blocks it could detect via a `^(\s*)run:` regex, which
// missed the most common step form (`- run: |`) entirely, along with the
// `|-`/`>`/`>-` block-scalar variants, and missed bad `${{ }}` anywhere
// outside a `run:` value (`name:`, `with:`, `env:`, ...); and (b) used a
// character-class check that both missed plain-English prose made only of
// letters and spaces (e.g. `${{ the changed dirs json }}`) and
// false-positived on legitimate expressions containing `{`/`}` (e.g.
// `format('{0}', github.sha)`), since `{`/`}` weren't in its allowed set.
//
// This version scans every line of the file, not just inside detected
// `run:` blocks — the block-form / step-shape distinction that caused the
// blind spots simply does not matter once you stop trying to detect it —
// and validates each `${{ ... }}` body with a conservative structural
// check (see looksLikeValidExpression below) rather than a plain
// character-class allowlist alone.
//
// This is a cheap, dependency-free tripwire, not a full re-implementation
// of GitHub's expression grammar (that's what `actionlint` is for — see
// .github/workflows/verify.yml, which now runs both).
//
// Usage: node scan-run-blocks.js <workflow.yml> [<workflow.yml> ...]
// Exit code: 0 if every ${{ }} occurrence in every given file looks like a
// valid expression; 1 otherwise (prints every offending line, across all
// files given).

import fs from 'node:fs';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node scan-run-blocks.js <workflow.yml> [<workflow.yml> ...]');
  process.exit(2);
}

// GHA's own literal keywords — the only bare, unqualified words a real
// expression ever contains without a dot chain, a bracket index, or a
// trailing call `(`.
const KEYWORDS = new Set(['true', 'false', 'null']);

/** Replace GHA single-quoted string literals ('...', with '' as an escaped quote) with a neutral placeholder. */
function stripStringLiterals(s) {
  return s.replace(/'(?:[^']|'')*'/g, '0');
}

function balanced(s, open, close) {
  let depth = 0;
  for (const ch of s) {
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Conservative "can this possibly be a real GitHub Actions expression"
 * check. The goal is NOT to fully re-implement GitHub's expression grammar
 * (that's what actionlint is for) — it's a cheap, dependency-free tripwire
 * that only flags bodies that CANNOT possibly be valid: empty, a bare
 * ellipsis, containing a character/token no expression can contain, or
 * prose (two or more bare, unqualified English-looking words in a row,
 * which no GHA expression ever contains — a real reference is always
 * dotted/bracketed/called, e.g. `steps.x.outputs.y`, `success()`).
 * @param {string} exprRaw
 */
function looksLikeValidExpression(exprRaw) {
  const trimmed = exprRaw.trim();
  if (trimmed.length === 0) return false; // empty body

  // A bare ellipsis token is never a real expression — exactly the shape of
  // the original X1 bug (illustrative prose pasted where a real expression
  // belonged, e.g. "`echo '${{ ... }}'` used to").
  if (trimmed === '...' || /(^|\s)\.\.\.(\s|$)/.test(trimmed)) return false;

  const stripped = stripStringLiterals(trimmed);

  // Characters that can never appear in a real expression once its own
  // string literals (single-quoted, handled above) are stripped: backticks,
  // semicolons, a leftover quote (GHA strings are single-quoted only — a
  // stray quote here means an unbalanced/foreign literal), colons and
  // question marks (no ternary or mapping syntax in GHA expressions).
  if (/[`;"'?:]/.test(stripped)) return false;

  // Every remaining character must be one an expression can legitimately
  // contain: identifier/keyword characters, dot/bracket/paren access
  // (including the `*` wildcard, e.g. `needs.*.result`), commas,
  // comparison/logical operators, arithmetic, and `{`/`}` (legitimate
  // inside a format() string's placeholders — the string itself is already
  // stripped above, so a literal `{`/`}` left over is otherwise harmless).
  if (!/^[A-Za-z0-9_.[\]() \t!=<>&|,\-+*/%{}]*$/.test(stripped)) return false;

  if (!balanced(stripped, '(', ')')) return false;
  if (!balanced(stripped, '[', ']')) return false;

  // Reject bare, unqualified English-looking words strung together with
  // nothing but whitespace between them. GHA expressions never juxtapose
  // two identifiers this way — this is the "prose in the braces" blind
  // spot (e.g. `${{ the changed dirs json }}`).
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const bareWords = tokens.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !KEYWORDS.has(t));
  if (bareWords.length >= 2) return false;

  return true;
}

function scanFile(path) {
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const offenses = [];
  let totalFound = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const re = /\$\{\{(.*?)\}\}/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      totalFound++;
      const expr = m[1];
      if (!looksLikeValidExpression(expr)) {
        offenses.push({ lineNum, line: line.trim(), expr: expr.trim() });
      }
    }
  }
  return { path, totalFound, offenses };
}

let anyOffenses = false;
for (const path of paths) {
  const { totalFound, offenses } = scanFile(path);
  console.log(`scanned ${path}: ${totalFound} occurrence(s) of ` + '${{ }}');
  if (offenses.length > 0) {
    anyOffenses = true;
    console.log(`  ${offenses.length} OFFENDING occurrence(s) (not valid-looking expressions):`);
    for (const o of offenses) {
      console.log(`    line ${o.lineNum}: ${o.line}`);
      console.log(`      -> expression body: "${o.expr}"`);
    }
  }
}

if (anyOffenses) {
  process.exit(1);
}
console.log('OK: every ${{ }} occurrence in every given file looks like a valid expression.');
process.exit(0);
