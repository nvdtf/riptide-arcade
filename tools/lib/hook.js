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
 * @param {{ timeoutMs?: number, extraQuery?: string }} [opts]
 */
export async function gotoGameAndWaitForMenu(page, baseURL, entry, opts = {}) {
  const { timeoutMs = 10000, extraQuery = '' } = opts;
  const url = `${baseURL}${entry}?test=1${extraQuery ? '&' + extraQuery : ''}`;
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  const hook = hookFor(page);
  try {
    await hook.waitForReady(timeoutMs);
  } catch {
    throw new Error(`${entry}: window.__test never attached (__test.ready() stayed false) within ${timeoutMs}ms`);
  }
  try {
    await hook.waitForState('MENU', timeoutMs);
  } catch {
    const state = await hook.state().catch(() => '<unreadable>');
    throw new Error(`${entry}: never reached MENU within ${timeoutMs}ms (stuck at "${state}")`);
  }
  return hook;
}
