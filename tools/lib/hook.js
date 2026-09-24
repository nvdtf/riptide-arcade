// tools/lib/hook.js
//
// Thin wrapper around `window.__test` (see templates/base-game.html's contract
// comment) so every tool drives games the same way instead of re-typing
// `page.evaluate(() => window.__test.foo())` everywhere. State, never pixels.

/**
 * @param {import('playwright').Page} page
 * @returns {{
 *   state: () => Promise<string>,
 *   snapshot: () => Promise<object>,
 *   tick: (n: number) => Promise<number>,
 *   seed: (s: number) => Promise<number>,
 *   input: (action: string, pressed: boolean) => Promise<boolean>,
 *   errors: () => Promise<Array<object>>,
 *   ready: () => Promise<boolean>,
 *   autoClock: (on: boolean) => Promise<boolean>,
 *   states: () => Promise<string[]>,
 *   actions: () => Promise<string[]>,
 *   waitForReady: (timeoutMs?: number) => Promise<void>,
 *   waitForState: (state: string, timeoutMs?: number) => Promise<void>
 * }}
 */
export function hookFor(page) {
  return {
    state: () => page.evaluate(() => window.__test.state()),
    snapshot: () => page.evaluate(() => window.__test.snapshot()),
    tick: (n) => page.evaluate((n) => window.__test.tick(n), n),
    seed: (s) => page.evaluate((s) => window.__test.seed(s), s),
    input: (action, pressed) => page.evaluate(([a, p]) => window.__test.input(a, p), [action, !!pressed]),
    errors: () => page.evaluate(() => window.__test.errors),
    ready: () => page.evaluate(() => !!(window.__test && window.__test.ready())),
    autoClock: (on) => page.evaluate((on) => window.__test.autoClock(on), !!on),
    states: () => page.evaluate(() => window.__test.states()),
    actions: () => page.evaluate(() => window.__test.actions()),

    /** Poll __test.ready() until true or throw after timeoutMs. */
    async waitForReady(timeoutMs = 5000) {
      await page.waitForFunction(() => !!(window.__test && window.__test.ready()), null, { timeout: timeoutMs });
    },
    /** Poll __test.state() until it equals `state` or throw after timeoutMs. */
    async waitForState(state, timeoutMs = 5000) {
      await page.waitForFunction(
        (s) => !!(window.__test && window.__test.ready() && window.__test.state() === s),
        state,
        { timeout: timeoutMs }
      );
    }
  };
}

/**
 * Load `<baseURL><entry>?test=1[&...extra]` and wait for the game runtime to
 * attach (__test.ready()) and reach MENU. Throws with a clear message if the
 * page never reaches MENU within timeoutMs — callers must not hang forever.
 *
 * @param {import('playwright').Page} page
 * @param {string} baseURL e.g. from serveDir()
 * @param {string} entry e.g. 'index.html'
 * @param {{ timeoutMs?: number, extraQuery?: string, gameDir?: string }} [opts]
 */
export async function gotoGameAndWaitForMenu(page, baseURL, entry, opts = {}) {
  const { timeoutMs = 10000, extraQuery = '', gameDir } = opts;
  const gameLabel = gameDir ? `${gameDir} (${entry})` : entry;
  const url = `${baseURL}${entry}?test=1${extraQuery ? '&' + extraQuery : ''}`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  } catch (e) {
    // Fix round (R8): an inline boot script that loops forever synchronously
    // (before the page's `load` event can ever fire) used to surface as a
    // raw Playwright `page.goto: Timeout ...ms exceeded` — no mention of
    // which game dir, and Playwright's own message includes ANSI colour
    // escapes that are unreadable outside a terminal (e.g. in a CI log
    // viewer or this error re-thrown elsewhere). Wrap it in a message that
    // says plainly what actually happened and names the game dir.
    throw new Error(`${gameLabel}: the page never finished loading within ${timeoutMs}ms — the game's boot script likely never yielded (e.g. a synchronous infinite loop before the 'load' event), so Playwright's own navigation timeout fired first. Original error: ${e.message.replace(/\x1b\[[0-9;]*m/g, '')}`);
  }
  const hook = hookFor(page);
  try {
    await hook.waitForReady(timeoutMs);
  } catch {
    // Fix round (A8): __test (the bridge object) attaches at document parse
    // time, before the game runtime does — so `window.__test.errors` is
    // readable even when `ready()` never went true (e.g. the game threw
    // during boot, before it could call __attach()). Without this, every
    // verifier reported only "never attached", discarding the real error the
    // bridge had already captured.
    const errs = await page.evaluate(() => (window.__test && window.__test.errors) || []).catch(() => []);
    const errNote = errs.length > 0
      ? ` — __test.errors captured ${errs.length} entr${errs.length === 1 ? 'y' : 'ies'} before/during boot; first: ${JSON.stringify(errs[0])}`
      : ' (__test.errors is empty — the game never threw, it simply never called __attach())';
    throw new Error(`${gameLabel}: window.__test never attached (__test.ready() stayed false) within ${timeoutMs}ms${errNote}`);
  }
  try {
    await hook.waitForState('MENU', timeoutMs);
  } catch {
    const state = await hook.state().catch(() => '<unreadable>');
    const errs = await page.evaluate(() => (window.__test && window.__test.errors) || []).catch(() => []);
    const errNote = errs.length > 0
      ? ` — __test.errors captured ${errs.length} entr${errs.length === 1 ? 'y' : 'ies'}; first: ${JSON.stringify(errs[0])}`
      : '';
    throw new Error(`${gameLabel}: never reached MENU within ${timeoutMs}ms (stuck at "${state}")${errNote}`);
  }
  return hook;
}
