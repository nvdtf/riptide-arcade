// tools/verify/lib/report.js
//
// Shared PASS/FAIL printing so index.js and each standalone verifier print
// results in the same shape (CI logs and human eyeballs both bisect on this).

export function printResult(result) {
  const badge = result.ok ? 'PASS' : 'FAIL';
  console.log(`[${badge}] ${result.name} (${result.durationMs}ms)${result.ok ? '' : ' — ' + result.message}`);
  if (!result.ok && result.details) {
    for (const line of result.details) console.log(`       ${line}`);
  }
}

export function printSummary(results) {
  console.log('');
  console.log('verify summary:');
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0
    ? `all ${results.length} verifier(s) passed`
    : `${failed.length}/${results.length} verifier(s) failed`);
  return failed.length === 0;
}

/** Wrap a verifier's body so timing + error handling is identical everywhere. */
export async function runNamed(name, fn) {
  const start = Date.now();
  try {
    const details = await fn();
    return { name, ok: true, durationMs: Date.now() - start, details: details || [] };
  } catch (err) {
    return { name, ok: false, durationMs: Date.now() - start, message: err.message, details: err.details };
  }
}
