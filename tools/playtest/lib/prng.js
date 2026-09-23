// tools/playtest/lib/prng.js
//
// Small seeded PRNG (mulberry32 — the same well-known public-domain algorithm
// the game template uses) so the exploratory session's action choices are
// reproducible from a printed/`--seed`-passed integer. This is Node-side only
// (drives which __test.input() calls the harness makes); it is NOT the same
// PRNG instance as the page's own RNG.

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A reasonably random default seed, printed so a run can be reproduced with --seed. */
export function randomSeed() {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
