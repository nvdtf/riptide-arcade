# tests/regression/

**The rule: every bug that ships in any game becomes a minimal regression test
here, named `<game>-<short-slug>.test.js`, and the suite never shrinks.**

If a bug reaches `games/<name>/` and gets fixed, the fix is not "done" until a
test lives in this directory that would have caught it. Tests are never
deleted, only added to — that is what makes this suite a permanent record of
every bug class this factory has already shipped and fixed once.

## Running

```sh
npm run regression
```

This runs [`run.js`](./run.js), which:

1. discovers every `*.test.js` file in this directory (sorted, deterministic
   order),
2. imports each one and calls its exported `run()`,
3. also runs the dormant asset-budget unit tests at
   `tools/verify/budget.test.js` (via Node's own `node:test`, since a real
   `.glb` fixture and its checks belong next to the verifier that reads them,
   not duplicated here — see that file's header comment),
4. prints a PASS/FAIL line per test (with details on success, the failing
   assertion message on failure), and
5. **exits non-zero if anything failed.**

## Writing a new regression test

Name it `<game>-<short-slug>.test.js`, e.g.
`fixture-pong-restart-resets-state.test.js`. It drives the real game through
`window.__test` **exactly like the verifiers do** — no mocking the game, no
reimplementing its rules in the test. The contract:

```js
// tests/regression/<game>-<slug>.test.js
export async function run() {
  // 1. open the game (see tools/lib/browser.js's openGame(), the same
  //    helper tools/verify/*.js uses — serves the game dir, launches
  //    headless Chromium)
  // 2. drive it via the hook (see tools/lib/hook.js: hookFor(page) /
  //    gotoGameAndWaitForMenu()) — inject inputs, tick(), snapshot()
  // 3. assert (node:assert/strict is fine) the specific behaviour that
  //    regressed
  // 4. return an array of short human-readable strings describing what
  //    happened (printed on success), OR throw an Error with a clear
  //    message (the test fails; run.js prints err.message and exits non-zero)
}
```

`run.js` discovers the file automatically — nothing else to wire up. Keep the
test **minimal**: reproduce the bug's exact preconditions and assert the one
behaviour that regressed, not a whole playthrough. See
[`fixture-pong-restart-resets-state.test.js`](./fixture-pong-restart-resets-state.test.js)
for a worked example (restart-after-game-over must fully reset score, lives,
hits/misses, ball position and paddle position — not just flip the state).

### A test must actually fail without the fix

Before committing a regression test, verify it fails against the buggy
behaviour (e.g. temporarily comment out the fix in a **scratch copy** of the
game, run the test, confirm it fails with a clear message, then discard the
scratch copy — never commit the break). A regression test that would pass
either way is not testing anything.

### "Never shrinks" is enforced, not just stated

CI (`.github/workflows/verify.yml`) fails the build if any `*.test.js` file
present in this directory on the PR's base branch is missing from the head,
so deleting a regression test is a CI failure, not a silent pass; if the game
a test exercises is ever removed from `games/`, its regression test file
stays and is updated to note the game's removal rather than being deleted,
so the record of every bug this factory has shipped and fixed stays intact.
