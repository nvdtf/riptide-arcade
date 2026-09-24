# Riptide Arcade

A factory for small static browser games, built as tasks on a Riptide network:
each game is **one posted task** referencing a spec in [`specs/`](specs/);
agent workers deliver **rival pull requests**; the poster reviews by running
the verifiers, reading the playtest report, and **playing the preview** — and
pays by merging. This repository is the substrate every game task is built on
and judged by: a shared game template, four automated verifiers, a playtest
harness, and a permanent regression suite.

Everything here runs **statically**. Games are single self-contained HTML
files built from `templates/base-game.html` — no build step, no server, no
network at play time. Tooling (verifiers, playtest harness, regression suite)
is Node + Playwright and runs at development/review time only.

## Layout

| path | what lives here |
|---|---|
| `templates/base-game.html` | the opinionated game shell every game starts from — fixed-timestep loop, single `setState()` chokepoint, audio lifecycle discipline, input-action mapping, DPR/visibility/reduced-motion canvas discipline, a seedable PRNG, and the `window.__test` hook (exposed only under `?test=1`) |
| `games/<name>/` | one directory per shipped game: `index.html` (the whole game), `playtest.probe.js` (scripted input script), `budgets.json` (size/asset budgets), `README.md`. See `games/fixture-pong/` below. |
| `tools/verify/` | the four verifiers (`smoke.js`, `journey.js`, `determinism.js`, `budget.js`) plus `index.js` (runs all four), shared `lib/`, `budget.test.js` (unit tests for the dormant GLB/rig checks), and `fixtures/` (a tiny checked-in `.glb` + sidecar used only by those unit tests) |
| `tools/playtest/` | the playtest harness: `index.js` plus `lib/` (scripted session, exploratory session, screenshot capture, report writer) |
| `tools/lib/` | helpers shared by both `tools/verify/` and `tools/playtest/` (serving a game dir + launching Chromium, the `__test` hook wrapper, snapshot digesting) |
| `tests/regression/` | the permanent regression suite — see [`tests/regression/README.md`](tests/regression/README.md) for the rule and the contract each test implements |
| `docs/spec-template.md` | the document a poster copies to write a new game-task spec |
| `specs/` | one spec per game task (`specs/001-init-scaffold.md` is this substrate's own spec) |
| `.github/workflows/verify.yml` | the CI workflow — see [CI](#ci) below |

## Quickstart (fresh clone)

```sh
npm ci
npx playwright install --with-deps chromium   # only Chromium, not all 3 browsers
npm run verify -- games/fixture-pong
npm run regression
npm run playtest -- games/fixture-pong
```

`npx playwright install --with-deps chromium` is required once per
environment (fresh clone, fresh CI runner, fresh container) — Playwright
needs the actual browser binary and its OS-level runtime libraries, which
`npm ci` does not fetch on its own.

## The three npm scripts

| command | does | flags | exit codes |
|---|---|---|---|
| `npm run verify -- <game-dir>` | runs all four verifiers (smoke, journey, determinism, budget) in-process against `<game-dir>` and prints a PASS/FAIL summary. Each is also runnable standalone: `node tools/verify/{smoke,journey,determinism,budget}.js <game-dir>`. | none | `2` usage error (missing/bad game dir) · `1` one or more verifiers failed · `0` all four passed |
| `npm run playtest -- <game-dir> [--headed] [--seed=<n>]` | plays the game twice — once via the game dir's own `playtest.probe.js`, once via a bounded exploratory session — and writes `<game-dir>/playtest-report/` (screenshots, `report.json`, `report.md`) | `--headed` runs visible Chromium (default headless); `--seed=<n>` sets the exploratory session's action-mashing PRNG (default random; the seed actually used is always printed so a run can be reproduced) | `2` usage error (no `<game-dir>` argument at all) · `1` missing/invalid `playtest.probe.js`, the game never booted to `MENU`, `__test.errors` was non-empty at the end of either session, the harness itself threw, or the overall run exceeded its 120s deadline (both sessions combined; separate from the verifiers' own 60s-per-verifier deadline in `tools/verify/lib/report.js` — see `tools/playtest/index.js`) · `0` otherwise — including when a probe's `expectState` checks mismatch (advisory) or a human hasn't yet filled in the confusion-findings table. Playtest **reports** on quality; it never gates on taste. |
| `npm run regression` | discovers and runs every `tests/regression/*.test.js` (contract: `export async function run()` returning an array of strings, or throwing), plus `tools/verify/budget.test.js` via `node --test` | none | `1` any failure · `0` otherwise |

Sample output shapes (captured from a real fresh-clone run; exact timings vary
by machine — the very first `verify` invocation after installing Chromium is
markedly slower, e.g. `smoke` took ~20s on its cold-start run here vs. under
1s on every run after). Note `determinism` is now ~10s, not under 1s — see
[the fix-round note in `tools/verify/determinism.js`](tools/verify/determinism.js)
(C4/N7): most of that is the probe-replay path added to catch a determinism
bug the generic script alone cannot reach, and it will keep changing as that
path evolves — do not treat this number as stable:

```
$ npm run verify -- games/fixture-pong
verify: /…/games/fixture-pong
[PASS] smoke (258ms)
[PASS] journey (266ms)
[PASS] determinism (10124ms)
[PASS] budget (2ms)

verify summary:
  [PASS] smoke
  [PASS] journey
  [PASS] determinism
  [PASS] budget
all 4 verifier(s) passed
```

```
$ npm run regression
regression: discovered 1 test file(s) in tests/regression/
[PASS] fixture-pong-restart-resets-state.test.js (3330ms)
       scored 1 hit(s) / score 1 before losing all lives (400 controlled + 1400 idle ticks)
       GAME_OVER snapshot: score=1 lives=0 hits=1 misses=3
       restart snapshot: score=0 lives=3 hits=0 misses=0 ball=(320,160) paddle.x=320
[PASS] tools/verify/budget.test.js (dormant asset-budget unit tests, via node:test) (192ms)

all 2 regression check(s) passed
```

```
$ npm run playtest -- games/fixture-pong
playtest: /…/games/fixture-pong
exploratory seed: 1146444645 (pass --seed=1146444645 to reproduce the action sequence)
mode: headless
scripted session: clean
exploratory session: clean (59.9 avg fps)
report written: games/fixture-pong/playtest-report/ (report.json, report.md, 15 screenshot(s))
```

The playtest report lands in `<game-dir>/playtest-report/` — **git-ignored**,
cleared and rewritten every run: numbered screenshots, `report.json`
(machine-readable) and `report.md` (evidence pre-filled; reviewer-judgement
cells — confusion/clarity findings, "controls discoverable without
instructions" — left as explicit placeholders for the human reviewing the PR).

## Building a game

1. Copy `templates/base-game.html` into a new `games/<name>/index.html` and
   edit only inside the `GAME CODE — EDIT BELOW` region — the substrate above
   it (state machine, audio lifecycle, input mapping, canvas/resize
   discipline, PRNG) ships verbatim.
2. Use `RNG.next()` / the template's seedable PRNG for anything that must be
   reproducible under `?test=1` — never `Math.random()`.
3. Register anything a reviewer needs to see in a snapshot via
   `__test.expose(fn)`.
4. Write `games/<name>/playtest.probe.js` (see
   `games/fixture-pong/playtest.probe.js` for the step grammar and a
   reference interpreter) and `games/<name>/budgets.json` (see
   `games/fixture-pong/budgets.json` for the key names `tools/verify/budget.js`
   reads; omitted keys fall back to the tool's defaults; every declared key
   is type-checked — a misspelled or mistyped key is a FAIL naming it, from
   ALL FOUR verifiers, since every one of them loads and validates
   `budgets.json` before doing anything else, never a silent default).
   - **`progressKeys`** — declare the top-level `__test.snapshot()` keys that
     prove real gameplay moved (as opposed to bookkeeping counters that
     advance unconditionally). `tools/verify/journey.js` reads this list as
     EXPECTED PRACTICE for every game: with it declared, at least one of
     those keys must change across a pause/resume/restart, or journey FAILS;
     with none declared (or `[]`), journey falls back to a weaker
     "some non-bookkeeping field changed" rule and prints a one-line WARNING
     saying so. A declared key must exist in the MENU snapshot, the first
     PLAYING snapshot, or both (a key that only appears once play begins —
     e.g. a spawned entity — is fine); a declared key that exists in
     NEITHER, is a nested path (only top-level keys are diffed — `"ball"`,
     never `"ball.x"`), or names a machine-bookkeeping field (`tick`,
     `state`, ...) is itself a FAIL that says the declaration is wrong, not
     the game.
   - **`notes`** — the one free-form string key for human prose on a
     `budgets.json` (e.g. why a budget was raised); any other unrecognised
     key is still a hard FAIL.
   - **`budgetsVersion`** — must be a version this tool understands (`1`
     today); an unrecognised version is a FAIL, not a silent accept.
5. Write the game's spec from [`docs/spec-template.md`](docs/spec-template.md)
   before or alongside the implementation.

## How a delivered game PR is reviewed

The poster reviews a rival PR by:

1. running `npm run verify -- games/<name>` (all four verifiers must pass),
2. running `npm run regression` (must pass, and must still pass for every
   other game already in `games/`),
3. reading the `playtest-report/` attached to the PR (or generating it fresh
   with `npm run playtest -- games/<name>`),
4. **playing the live preview** — the report and the verifiers establish that
   the game runs correctly; whether it's fun is judged by the human playing
   it, never by a score in the report.

Pays by merging.

## The regression rule

**Every bug that ships in any game becomes a minimal permanent test in
`tests/regression/`, named `<game>-<short-slug>.test.js`, and the suite never
shrinks.** Tests are added, never deleted — see
[`tests/regression/README.md`](tests/regression/README.md) for the exact
contract and `tests/regression/fixture-pong-restart-resets-state.test.js` for
a worked example.

## CI

[`.github/workflows/verify.yml`](.github/workflows/verify.yml) — one job,
`verify`, triggered on every `pull_request` (any base), on `push` to `main`,
and on demand via `workflow_dispatch`. `permissions: contents: read` — fork
PRs run with no secrets. Steps, in order: checkout → setup Node →
**regression suite shrink check** (fails if any `tests/regression/*.test.js`
present on the base commit is missing from HEAD — see
[the regression rule](#the-regression-rule)) → `npm ci` → cache Playwright's
Chromium download → install Chromium → discover game directories (all vs.
changed, diffed against the PR base or the previous push; a change under
`templates/`, `tools/`, or `tests/`, or to `package.json`/`package-lock.json`
themselves, counts as "every game dir changed", since any of those can affect
every game) → verify every game directory → run the regression suite →
playtest every changed game directory (`if: always()`, so a verify failure
does not suppress the report a reviewer most wants) → upload one
`playtest-reports` artifact bundling every changed game's report as a
subfolder. Budgeted to finish under 5 minutes.

## `games/fixture-pong/`

The fixture game the substrate is proven against: one screen, one mechanic
(keep the ball up with the paddle), built from `templates/base-game.html`
with the shared substrate copied verbatim. **It exists to prove the tooling,
not to be fun** — acceptance for this repository runs against it, but no
future game should be modeled on it for gameplay.
