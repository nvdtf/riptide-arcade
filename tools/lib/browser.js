// tools/lib/browser.js
//
// Playwright boot helper shared by tools/verify and tools/playtest. Chromium
// only (that is what CI installs — `npx playwright install --with-deps
// chromium`); nothing here reaches for other engines.

import { chromium } from 'playwright';
import { serveDir } from './server.js';

/**
 * Serve `gameDir` and open a fresh Chromium page against it. Callers own the
 * returned handles and must call `close()` when done (even on failure paths —
 * use try/finally) so a run never leaks a server or a browser process.
 *
 * @param {string} gameDir absolute path to a game directory
 * @param {{ headless?: boolean }} [opts]
 * @returns {Promise<{
 *   browser: import('playwright').Browser,
 *   context: import('playwright').BrowserContext,
 *   page: import('playwright').Page,
 *   baseURL: string,
 *   close: () => Promise<void>
 * }>}
 */
export async function openGame(gameDir, opts = {}) {
  const { headless = true } = opts;
  const { url: baseURL, close: closeServer } = await serveDir(gameDir);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    browser, context, page, baseURL,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
      await closeServer();
    }
  };
}

/**
 * Serve `gameDir` and launch ONE Chromium browser that can host several
 * independent contexts/pages (used by the playtest harness, which runs two
 * sessions — scripted and exploratory — and does not want to pay browser
 * launch cost twice, nor share a page between them since the exploratory
 * session needs an rAF-recording init script installed before its own load).
 *
 * @param {string} gameDir
 * @param {{ headless?: boolean }} [opts]
 */
export async function serveAndLaunch(gameDir, opts = {}) {
  const { headless = true } = opts;
  const { url: baseURL, close: closeServer } = await serveDir(gameDir);
  const browser = await chromium.launch({ headless });
  return {
    browser, baseURL,
    /** A fresh, independent context+page (own cookie jar, own init scripts). */
    async newPage() {
      const context = await browser.newContext();
      const page = await context.newPage();
      return { context, page, close: () => context.close().catch(() => {}) };
    },
    close: async () => {
      await browser.close().catch(() => {});
      await closeServer();
    }
  };
}
