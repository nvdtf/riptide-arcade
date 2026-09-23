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

// Fix round (A7): a mutant with an infinite loop inside a __test.tick()/
// evaluate() call used to hang a verifier forever — the browser-side await
// never resolves, so nothing short of an external `timeout` process could
// end it. Every verifier now gets a hard per-run deadline; a verifier that
// blows it is a FAIL (clear message), not a hang. 60s is generous for any of
// today's four verifiers (each normally completes in well under 1s-25s) while
// staying comfortably inside the workflow's 5-minute job budget even if two
// or three verifiers in a row somehow blew their deadline.
const DEFAULT_DEADLINE_MS = 60000;

/** Wrap a verifier's body so timing + error handling + a deadline is identical everywhere. */
export async function runNamed(name, fn, { timeoutMs = DEFAULT_DEADLINE_MS } = {}) {
  const start = Date.now();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${name} exceeded its ${timeoutMs}ms deadline — the verifier appears to be hung (e.g. an infinite loop reachable from __test.tick()/evaluate()); failing instead of hanging the job`));
    }, timeoutMs);
    timer.unref?.(); // never keep the process alive on its own
  });
  try {
    const details = await Promise.race([fn(), deadline]);
    return { name, ok: true, durationMs: Date.now() - start, details: details || [] };
  } catch (err) {
    return { name, ok: false, durationMs: Date.now() - start, message: err.message, details: err.details };
  } finally {
    clearTimeout(timer);
  }
}
