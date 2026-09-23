# Game-task spec template

> **How to use this template.** Copy this whole file to `specs/NNN-your-game.md`,
> keep the eight section headers in this order, and replace every *Example*
> block with your own game's content. Every section carries one line of
> *Guidance* (why the section exists / what belongs in it) and a *Example*
> block filled in for one worked game (**Meteor Miner**, invented for this
> document — it is not in this repository) so the whole template reads as one
> coherent spec, not a checklist. Where a section also needs boilerplate you
> paste verbatim, that is marked **Skeleton**. Guidance, Example and Skeleton
> are visually distinct on purpose — never mix them.
>
> Every game is built from [`templates/base-game.html`](../templates/base-game.html)
> and judged headlessly through the `window.__test` hook that template exposes
> under `?test=1` (state machine, seedable PRNG, scripted input, snapshots —
> see that file's header comment for the exact API). Read it before writing a
> spec: everything you require here must be something a game built on that
> template can actually expose to `__test`.

---

## 1. Concept

> *Guidance — one paragraph: the game in a sentence, and the platform
> (desktop / mobile / both). This is the only section a reviewer reads before
> opening a PR's preview link; it should let a stranger picture the game.*

**Example (Meteor Miner).** A one-screen top-down game where the player pilots
a small mining ship between tumbling asteroids, holding a mining laser on each
rock long enough to crack it open for ore before hull integrity or the clock
runs out. Desktop (keyboard) and mobile (touch drag + tap) both required —
the laser-hold mechanic must feel equally immediate on a touchscreen.

---

## 2. Feel contract

> *Guidance — 3 to 5 **atomic** (one claim per statement, nothing bundled
> with "and") and **observable** (a reviewer can check it by watching the
> preview or reading a snapshot field, with no access to source) statements
> about the signature mechanic. Mark them **UNCUTTABLE**: an implementation
> may cut scope anywhere else in the spec, never here. A statement is weak
> when it describes a feeling with no way to check it; it is strong when
> anyone playing (or reading `__test.snapshot()`) can confirm it directly.*
>
> **Weak → strong, worked:**
> - Weak: *"mining feels satisfying."* (Not observable — satisfying to whom, checked how?)
> - Strong: *"a cracked asteroid visibly fragments into 3–5 debris pieces that drift apart and fade over ~1 second; the player's ore counter increments the instant fragmentation starts, not after it finishes."*

**Example (Meteor Miner) — UNCUTTABLE:**

1. **UNCUTTABLE** — The laser beam is only drawn while `primary` is held AND
   the reticle overlaps an asteroid; releasing `primary` or drifting off the
   rock kills the beam within one tick, with no fade-out grace period.
2. **UNCUTTABLE** — Each asteroid has a visible crack overlay that advances
   through at least 3 discrete damage stages before it breaks; the stage
   only ever advances while the beam is actively connected, never on a timer.
3. **UNCUTTABLE** — A cracked asteroid fragments into 3–5 debris pieces that
   drift outward and fade over roughly 1 second (30–90 ticks at the
   template's fixed step); the ore counter increments the instant
   fragmentation starts.
4. **UNCUTTABLE** — Hull integrity visibly decreases (a numeric readout, not
   only a colour shift) the instant the ship's hitbox overlaps an
   un-cracked asteroid or a drifting debris piece.
5. **UNCUTTABLE** — At 0 hull integrity the ship visibly stops responding to
   input for at least one full tick before `setState('GAME_OVER')` fires —
   the death is never instantaneous with the collision that caused it.

---

## 3. Mechanics & states

> *Guidance — the rules, the win/lose conditions, and (only if you need more
> than the template ships with) the extended state graph. Most games do not
> need to extend `LOADING → MENU → PLAYING → PAUSED / GAME_OVER`; say so
> explicitly either way, so a builder doesn't wonder whether a `WIN` state
> was silently assumed.*

**Example (Meteor Miner).**

- **Controls (input actions, mapped per the template's input layer):**
  `left`/`right`/`up`/`down` — thrust the ship (8-directional, normalized);
  `primary` (Space / tap-and-hold) — fire the mining laser at the nearest
  reticle-locked asteroid; `pause` (Esc / two-finger tap) — toggle `PAUSED`.
- **Win condition:** cargo hold reaches 10 ore before hull integrity or the
  90-second clock runs out.
- **Lose conditions:** hull integrity reaches 0, or the clock runs out with
  cargo below 10.
- **State graph — extended beyond the template's default.** This game adds a
  `WIN` state alongside `GAME_OVER`, since "ran out of hull" and "filled the
  cargo hold" are observably different outcomes a playtest reviewer should be
  able to tell apart from the snapshot alone (`__test.snapshot().outcome`):

  ```
  LOADING → MENU → PLAYING → PAUSED → PLAYING
                       │
                       ├──(hull reaches 0)──→ GAME_OVER ──(primary)──→ PLAYING (restart)
                       └──(cargo reaches 10)→ WIN ────────(primary)──→ PLAYING (restart)
  ```

  Both `GAME_OVER` and `WIN` restart identically (full reset — score, hull,
  cargo, ship/asteroid positions, tick counters); `journey.js`'s "state
  changed and gameplay advanced" check applies to the `WIN` transition
  exactly as it does to `GAME_OVER`.

---

## 4. Assets

> *Guidance — only needed when the game ships binary assets; say "None — this
> game is drawn entirely in canvas primitives" when it doesn't, and skip the
> rest of this section. When it does ship a `.glb`, this section is where you
> commit to the exact numbers `tools/verify/budget.js` will enforce: source,
> triangle budget, required animations by name, the rig-check requirement,
> and a filled sidecar. The rig/triangle rule below is copied verbatim from
> `tools/verify/lib/budgets.js` — match it exactly, don't approximate it:*
>
> - `rigStatus` in the sidecar must be the literal string `"clean"`.
> - `declaredTriangles` must match the count the verifier parses from the
>   GLB's own JSON chunk within `max(1, ceil(parsed * 0.01))` — exact, or
>   within 1%, whichever tolerance is looser.
> - Triangles are counted from the JSON chunk only, per primitive: mode `4`
>   (TRIANGLES) → `vertexCount / 3`; modes `5`/`6` (STRIP/FAN) →
>   `vertexCount - 2`; every other mode contributes `0`.
> - `provenance` must be an object (tool / prompt / model — however the asset
>   was produced; hand-modeled counts too, just say so).

**Example (Meteor Miner) — `assets/asteroid.glb`:**

| field | value |
|---|---|
| source | text-to-3D generation (see sidecar `provenance` below), not hand-modeled |
| triangle budget | 1,200 triangles max per asteroid mesh (this game's own cap, tighter than the tool default of 50,000 — see §7) |
| required animations | `idle-spin` (a slow single-axis rotation loop used while an asteroid drifts, before the laser engages) — no other named animation required |
| rig-check requirement | `rigStatus: "clean"` in the sidecar, same as every asset this factory ships |

Sidecar `assets/asteroid.glb.meta.json` (filled example — the numbers below
are illustrative, not measured against a real file):

```json
{
  "provenance": {
    "tool": "Tripo3D text-to-3D",
    "prompt": "low-poly tumbling asteroid, cratered rock surface, flat-shaded, game-ready, no textures",
    "model": "tripo-v2.5"
  },
  "declaredTriangles": 842,
  "rigStatus": "clean"
}
```

(`842` must be within `max(1, ceil(parsed * 0.01))` of whatever
`tools/verify/budget.js` actually parses from `asteroid.glb`'s JSON chunk —
the sidecar declares it, the verifier checks it, they are not the same step.)

---

## 5. Verification

> *Guidance — "verify + regression green, playtest report attached to the PR"
> is **standing** for every game task; do not restate it as a game-specific
> requirement. What this section adds is the game-specific probes worth
> scripting on top of that — the assertions generic enough that `smoke.js`/
> `journey.js`/`determinism.js` can't know to make them, but specific enough
> that a rival PR's `playtest.probe.js` should hit them anyway.*

**Example (Meteor Miner).** Standing requirement: `npm run verify --
games/meteor-miner` (all four verifiers green), `npm run regression` green,
and a `playtest-report/` attached to the PR. In addition, this game's task
expects the delivered `playtest.probe.js` to script at least:

- serving the laser at an asteroid for enough consecutive ticks to reach the
  final crack stage, then confirming fragmentation and the ore-counter
  increment land in the same tick;
- driving hull integrity to exactly 0 and confirming the `WIN`/`GAME_OVER`
  split reports through `snapshot().outcome`, not just through state name.

Expressed against `__test` (the shape a probe step or a verifier assertion
takes — see `games/fixture-pong/playtest.probe.js` for the full step
grammar):

```js
// Hold the laser on a locked asteroid for 45 ticks, then assert it cracked
// and ore incremented in the same tick fragmentation started.
await page.evaluate(() => window.__test.input('primary', true));
const before = await page.evaluate(() => window.__test.snapshot());
await page.evaluate(() => window.__test.tick(45));
const after = await page.evaluate(() => window.__test.snapshot());
if (after.ore !== before.ore + 1) {
  throw new Error(`expected ore to increment by 1 after 45 ticks of sustained laser, got ${before.ore} -> ${after.ore}`);
}
```

---

## 6. Preview

> *Guidance — a live, playable URL is required at delivery; static bundles
> make this trivial (no build step, no server-side state). A good preview
> link points straight at the specific game's `index.html` (not the repo
> root), is reachable over plain HTTPS with no auth wall, and — because
> reviewers open it without `?test=1` — plays exactly as a normal player
> would experience it.*

**Example (Meteor Miner).** `https://<poster>.github.io/riptide-arcade/games/meteor-miner/index.html`
via GitHub Pages serving the repository statically, or any equivalent static
host (a Pages branch deploy, a preview-deploy URL from a static-hosting
provider, or even a plain `python3 -m http.server` tunnel for local review) —
the only requirement is that it resolves to `games/meteor-miner/`'s `entry`
file (per `budgets.json`, below) with nothing else running.

---

## 7. Budgets

> *Guidance — the `budgets.json` values for this game, using the tool's real
> key names exactly (`tools/verify/budget.js` reads these verbatim; inventing
> a key name here that doesn't match what the verifier reads is a spec bug).
> Override only what this game genuinely needs different from the tool's
> defaults, and say why.*

**Example (Meteor Miner)** — `games/meteor-miner/budgets.json`:

```json
{
  "budgetsVersion": 1,
  "entry": "index.html",
  "maxFileBytes": 204800,
  "maxDirBytes": 3145728,
  "excludeGlobs": ["playtest-report/**", "*.map"],
  "assets": {
    "maxGlbFileBytes": 1048576,
    "maxGlbTriangles": 20000,
    "requireRigCheck": true
  }
}
```

`maxDirBytes` is raised from the tool default (500 KB) to ~3 MB because this
game ships one `.glb` asset; `assets.maxGlbTriangles` is tightened from the
tool default (50,000) to 20,000 since a single low-poly asteroid never needs
more, and this game's own per-asteroid cap (§4) is tighter still at 1,200.

---

## 8. Non-goals

> *Guidance — say plainly what reviewers should not expect, so a PR isn't
> penalized for not delivering scope the spec never asked for.*

**Example (Meteor Miner).**

- No more than one asteroid archetype (`asteroid.glb`) — visual variety via
  scale/rotation jitter is enough; a rock-type system is out of scope.
- No persistent high scores, leaderboards, or any storage across page loads.
- No sound design beyond the template's existing blip/audio-lifecycle hooks —
  a full mix is not expected.
- No difficulty curve beyond the fixed 90-second clock — asteroids do not
  need to spawn faster over time.

---

## Skeleton (copy this, delete the guidance/example prose above)

```markdown
# NNN — <game name>

## 1. Concept

<one paragraph: the game in a sentence; platform: desktop / mobile / both>

## 2. Feel contract

1. **UNCUTTABLE** — <atomic, observable statement>
2. **UNCUTTABLE** — <atomic, observable statement>
3. **UNCUTTABLE** — <atomic, observable statement>

## 3. Mechanics & states

- Controls: <input actions and what they do>
- Win condition: <...>
- Lose condition(s): <...>
- State graph: <"unextended — uses LOADING → MENU → PLAYING → PAUSED / GAME_OVER"
  or a diagram of the extension>

## 4. Assets

<"None — drawn entirely in canvas primitives" OR a table: source / triangle
budget / required animations by name / rig-check requirement, plus a filled
`<asset>.glb.meta.json` example>

## 5. Verification

Standing: verify + regression green, playtest report attached to the PR.
Game-specific probes this task expects scripted:
- <probe 1, expressed against __test>
- <probe 2>

## 6. Preview

<what the live URL will point at>

## 7. Budgets

`games/<name>/budgets.json`:
```json
{
  "budgetsVersion": 1,
  "entry": "index.html",
  "maxFileBytes": <bytes>,
  "maxDirBytes": <bytes>,
  "excludeGlobs": ["playtest-report/**", "*.map"],
  "assets": { "maxGlbFileBytes": <bytes>, "maxGlbTriangles": <n>, "requireRigCheck": true }
}
```

## 8. Non-goals

- <...>
```
