// tools/lib/snapshot.js
//
// Canonical comparison/hashing of `__test.snapshot()` payloads. Snapshots are
// deep-JSON-safe by contract (templates/base-game.html's `jsonSafe()`), but
// key insertion order is not something we want equality to depend on, so
// everything here goes through a canonical (sorted-key) stringify first.

import { createHash } from 'node:crypto';

/** Recursively sort object keys so structurally-equal objects stringify identically. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

export function snapshotsEqual(a, b) {
  return canonicalJSON(a) === canonicalJSON(b);
}

/** Short, stable digest of a snapshot — used in playtest reports, not for equality checks. */
export function snapshotDigest(value) {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex').slice(0, 16);
}

/**
 * Diff two flat-ish snapshots and return the list of top-level keys whose
 * canonical JSON differs. Used to PROVE gameplay advanced (journey.js) rather
 * than merely asserting `state` changed.
 */
export function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const diffs = [];
  for (const key of keys) {
    const av = a ? a[key] : undefined;
    const bv = b ? b[key] : undefined;
    if (canonicalJSON(av) !== canonicalJSON(bv)) diffs.push(key);
  }
  return diffs;
}
