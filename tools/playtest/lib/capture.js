// tools/playtest/lib/capture.js
//
// Screenshot naming/writing and rAF-based FPS sampling shared by both
// playtest sessions.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

let counter = 0;

/** Take a screenshot into `dir`, numbered so filenames sort in capture order.
 * Fix round (N7): `dir` may be `null`/falsy to disable screenshot capture
 * entirely (e.g. tools/verify/determinism.js's probe replay, which only ever
 * needs the final snapshot — the screenshots it used to take into a scratch
 * dir were discarded, unread, immediately after, at real wall-clock cost).
 * Returns `null` in that case; callers must treat a `null` return as "no
 * screenshot was taken" rather than assuming one always was. */
export async function captureScreenshot(page, dir, label) {
  if (!dir) return null;
  counter += 1;
  const safeLabel = label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 80);
  const file = `${String(counter).padStart(3, '0')}-${safeLabel}.png`;
  await page.screenshot({ path: join(dir, file) }).catch(() => null);
  return file;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/**
 * Install a requestAnimationFrame recorder BEFORE navigation (call on a page
 * before goto). Only meaningful for the REAL-TIME (autoClock(true)) segment —
 * under ticked/manual-clock play, rAF still fires for rendering, but its
 * cadence says nothing about game performance, so we only ever read this
 * array back for the exploratory real-time session.
 */
export async function installFrameRecorder(page) {
  await page.addInitScript(() => {
    window.__playtestFrames = [];
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return orig((t) => { window.__playtestFrames.push(t); return cb(t); });
    };
  });
}

export async function readFrameTimestamps(page) {
  return page.evaluate(() => (window.__playtestFrames || []).slice());
}

// Fix round (A6): the spec asks for "an FPS sample series (via rAF
// timestamps)" in the report, not just summary numbers — the per-frame
// series was being computed and then thrown away. Cap the series length so a
// long real-time session does not bloat report.json; downsample by picking
// evenly-spaced samples (not just truncating, so the tail of a long session
// is still represented).
const MAX_SERIES_SAMPLES = 300;

function downsample(values, maxLen) {
  if (values.length <= maxLen) return values.slice();
  const out = [];
  const step = values.length / maxLen;
  for (let i = 0; i < maxLen; i++) out.push(values[Math.floor(i * step)]);
  return out;
}

/** Turn a list of rAF timestamps (ms) into FPS summary stats plus a downsampled sample series. */
export function computeFpsStats(timestamps) {
  if (!timestamps || timestamps.length < 2) {
    return { sampleCount: timestamps ? timestamps.length : 0, avgFps: null, minFps: null, maxFps: null, series: [] };
  }
  const fpsSamples = [];
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (delta > 0) fpsSamples.push(Math.round((1000 / delta) * 10) / 10);
  }
  if (fpsSamples.length === 0) return { sampleCount: timestamps.length, avgFps: null, minFps: null, maxFps: null, series: [] };
  const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  return {
    sampleCount: timestamps.length,
    avgFps: Math.round(avg * 10) / 10,
    minFps: Math.round(Math.min(...fpsSamples) * 10) / 10,
    maxFps: Math.round(Math.max(...fpsSamples) * 10) / 10,
    // Downsampled instantaneous-fps series (via rAF timestamp deltas), NOT
    // the raw timestamps — this is what the spec's "FPS sample series" means.
    // `seriesSampleCount` records how many raw per-frame samples this series
    // was downsampled from, so a reader can tell a thinned series from a full one.
    series: downsample(fpsSamples, MAX_SERIES_SAMPLES),
    seriesSampleCount: fpsSamples.length
  };
}
