# fixture-pong

The fixture game for Riptide Arcade. One screen, one mechanic: keep the ball up
with the paddle. Three lives, then GAME_OVER, then restart. It is built FROM
[`templates/base-game.html`](../../templates/base-game.html) with the substrate
copied verbatim — only the `GAME CODE — EDIT BELOW` region differs — and it
exists to prove the tooling, **not** to be fun.

```
games/fixture-pong/
  index.html          the whole game: one self-contained file, zero dependencies
  playtest.probe.js   the scripted input script the playtest harness replays
  budgets.json        the size budgets `tools/verify/budget.js` enforces
  README.md           this file
```

Serve the repo with any static file server and open
`games/fixture-pong/index.html` to play, or `…/index.html?test=1` to expose the
`window.__test` hook. Nothing is fetched at play time.

## Controls

| input | action |
|---|---|
| `←` / `A`, `→` / `D` | `left` / `right` — slide the paddle |
| `Space` / `Enter` / `J` | `primary` — start, serve immediately, resume, restart |
| `Esc` / `P` | `pause` — toggle PAUSED |
| touch / mouse drag | press the left or right half of the canvas; a press is also `primary` |

## Rules

* The ball is parked at the top centre for a **60-tick serve delay**, then serves
  itself. `primary` during the delay serves immediately.
* A return scores **+1** and speeds the ball up by **6%** (capped at 3.2 units/tick).
  The bounce angle depends on where the ball hits the paddle, plus a small
  **seeded** jitter.
* Missing the ball costs one of **3 lives**. At zero lives: `GAME_OVER`.
* `primary` on the game-over screen restarts with a **full reset** — score,
  lives, hits, misses, tick counters, ball and paddle all return to their
  starting values (`tests/regression/` targets exactly this bug class).

## Numbers the tooling needs (all measured in headless Chromium, not estimated)

| fact | value |
|---|---|
| entry file | `index.html` |
| idle run: PLAYING → GAME_OVER, no input at all | **1050–1060 ticks** (seeds 1, 2, 7, 12345, 99999 measured: 1060 / 1055 / 1050 / 1055 / 1050) |
| fastest route to GAME_OVER | tap `primary` whenever `snapshot().serveTimer > 0` → **883 ticks** (seed 1); three missed descents is the floor |
| state at tick 600 of an idle run | `PLAYING`, `lives: 2`, `errors: []` — deliberately far from GAME_OVER so `smoke.js`'s 600-tick assertion is never ambiguous |
| ticks per life | ~60 (serve delay) + ~280–300 (descent) |
| world | 640 × 480 logical units, letterboxed into the canvas |

Idle termination is **seed-independent by construction**: the serve angle is
drawn so the ball's horizontal travel over the descent is 97–152 world units,
always more than the 56 units (paddle half-width + ball radius) a centred idle
paddle covers, and always less than the 312 units that would bounce it off a
side wall first. Every seed loses all three lives.

## Snapshot shape

`__test.snapshot()` returns the template's base fields merged with this game's
fields and everything registered through `__test.expose()`:

```json
{
  "state": "PLAYING", "tick": 601, "stateTick": 601, "transitions": 2,
  "lastTransition": { "from": "MENU", "to": "PLAYING" },
  "rng": { "seed": 1, "calls": 4 }, "reducedMotion": false,
  "score": 0, "lives": 2, "hits": 0, "misses": 1,
  "serveTimer": 0, "ticksInPlay": 601,
  "ball": { "x": 418.44, "y": 376.13, "vx": 0.518, "vy": 1.137, "r": 8 },
  "paddle": { "x": 320, "y": 444, "w": 96, "h": 12 },
  "entityCount": 2, "entities": { "balls": 1, "paddles": 1 },
  "game": "fixture-pong", "ballInPlay": true, "ballSpeed": 1.25,
  "livesRemaining": 2, "world": { "w": 640, "h": 480 }
}
```

`game`, `ballInPlay`, `ballSpeed`, `livesRemaining` and `world` arrive through
`__test.expose()`; everything else is `Game.snapshot()` plus the template's base
fields. The whole object is deep-JSON-safe (`JSON.parse(JSON.stringify(s))`
round-trips) and contains no non-finite numbers.

## `budgets.json` keys

`tools/verify/budget.js` (Order 2) is implemented against exactly these key
names. Sizes are **bytes**, so no unit is ever ambiguous.

| key | type | value here | meaning |
|---|---|---|---|
| `budgetsVersion` | number | `1` | schema version of this file; bump if keys change |
| `entry` | string | `"index.html"` | the file the tooling loads from this dir |
| `maxFileBytes` | number | `204800` (200 KB) | no single file in the game dir may exceed this |
| `maxDirBytes` | number | `512000` (500 KB) | total size of the game dir may not exceed this |
| `excludeGlobs` | string[] | `["playtest-report/**", "*.map"]` | paths excluded from both checks — the playtest harness writes its report *into* the game dir and must not blow the budget |
| `assets.maxGlbFileBytes` | number | `2097152` (2 MB) | per-`.glb` file cap (dormant: this game ships no `assets/`) |
| `assets.maxGlbTriangles` | number | `50000` | per-model triangle cap read from the GLB JSON chunk (dormant) |
| `assets.requireRigCheck` | boolean | `true` | each `<asset>.meta.json` must declare a passing rig check (dormant) |

Current usage: `index.html` 45,987 B of 204,800 B (22%), directory 57,519 B of
512,000 B (11%) — both comfortably inside budget.

## `playtest.probe.js`

ES module, dependency-free, pure data + pure functions. `export default probe`,
plus named `probe` and `steps`. The full step grammar and a reference
interpreter are in the header comment of that file.
