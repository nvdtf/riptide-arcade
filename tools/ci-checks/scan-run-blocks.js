#!/usr/bin/env node
// Scans a GitHub Actions workflow YAML file for `${{ ... }}` occurrences
// that appear inside `run:` block bodies, and asserts each one is a
// *syntactically valid* GitHub Actions expression (not illustrative text,
// not `...`, not anything that would make GitHub's parser choke). This is
// the regression guard for X1: a `${{ ... }}`-shaped snippet was left
// inside a shell COMMENT inside a `run:` block, and GitHub evaluates the
// double-curly syntax anywhere in a `run:` block, comments included, which
// broke workflow parsing entirely.
//
// Usage: node scan_run_blocks.js <path-to-workflow.yml>
// Exit code: 0 if every run: block's ${{ }} occurrences are valid-looking
// expressions; 1 otherwise (prints every offending line).

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scan-run-blocks.js <workflow.yml>');
  process.exit(2);
}
const text = fs.readFileSync(path, 'utf8');
const lines = text.split('\n');

// A conservative "is this a plausible real GitHub Actions expression"
// check: it must not be empty/whitespace, must not be literally `...`,
// and must not contain characters that are meaningless inside an
// expression (backticks, unmatched quotes spanning the whole thing, etc).
// The goal isn't to fully re-implement GitHub's expression grammar (that's
// what actionlint is for) — it's a cheap, dependency-free tripwire so this
// specific bug class (illustrative/prose text pasted inside `${{ }}`
// inside a run: block) can never silently reappear.
function looksLikeValidExpression(expr) {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '...' || trimmed.includes('...')) return false;
  if (/^['"`]/.test(trimmed) && !/^['"].*['"]$/.test(trimmed)) return false;
  // Must look like a context reference, function call, literal, or operator
  // expression - i.e. contain only characters valid in GHA expressions.
  if (!/^[A-Za-z0-9_.\[\]'"()!=<>&|,\s-]*$/.test(trimmed)) return false;
  return true;
}

let inRunBlock = false;
let runBlockIndent = null;
let offenses = [];
let totalFound = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNum = i + 1;
  const runMatch = line.match(/^(\s*)run:\s*(\|)?\s*$/);
  const runInlineMatch = line.match(/^(\s*)run:\s*(.+)$/);

  if (runMatch) {
    inRunBlock = true;
    runBlockIndent = runMatch[1].length;
    continue;
  }

  if (inRunBlock) {
    // Block scalar ends when we hit a line at or below the `run:` key's
    // own indentation that isn't blank.
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch[1].length;
    if (line.trim().length > 0 && indent <= runBlockIndent) {
      inRunBlock = false;
    }
  }

  if (inRunBlock || (runInlineMatch && !runMatch)) {
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
}

console.log(`scanned ${path}: ${totalFound} occurrence(s) of `+'${{ }}'+` inside run: blocks`);
if (offenses.length > 0) {
  console.log(`\n${offenses.length} OFFENDING occurrence(s) (not valid-looking expressions):`);
  for (const o of offenses) {
    console.log(`  line ${o.lineNum}: ${o.line}`);
    console.log(`    -> expression body: "${o.expr}"`);
  }
  process.exit(1);
}
console.log('OK: every ${{ }} occurrence inside a run: block looks like a valid expression.');
process.exit(0);
