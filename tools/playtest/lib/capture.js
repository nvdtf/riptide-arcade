// tools/playtest/lib/capture.js
//
// Screenshot naming/writing and rAF-based FPS sampling shared by both
// playtest sessions.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

let counter = 0;

/** Take a screenshot into `dir`, numbered so filenames sort in capture order. */
export async function captureScreenshot(page, dir, label) {
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

/** Turn a list of rAF timestamps (ms) into FPS summary stats. */
export function computeFpsStats(timestamps) {
  if (!timestamps || timestamps.length < 2) {
    return { sampleCount: timestamps ? timestamps.length : 0, avgFps: null, minFps: null, maxFps: null };
  }
  const fpsSamples = [];
  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (delta > 0) fpsSamples.push(1000 / delta);
  }
  if (fpsSamples.length === 0) return { sampleCount: timestamps.length, avgFps: null, minFps: null, maxFps: null };
  const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  return {
    sampleCount: timestamps.length,
    avgFps: Math.round(avg * 10) / 10,
    minFps: Math.round(Math.min(...fpsSamples) * 10) / 10,
    maxFps: Math.round(Math.max(...fpsSamples) * 10) / 10
  };
}
