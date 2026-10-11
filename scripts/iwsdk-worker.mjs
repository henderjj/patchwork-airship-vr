/**
 * Worker thread for scripts/xr-smoke-test.mjs.
 *
 * The test calls the IWSDK CLI a few hundred times and waits for each answer.
 * Starting a fresh Node process per call, and for each page evaluation also
 * loading Playwright and connecting it to the browser again, cost about a
 * second a call on CI. This worker keeps the CLI loaded (its `runCli` export)
 * and one Playwright connection to the managed browser open, and answers
 * through a SharedArrayBuffer so the test can wait for it synchronously
 * (Atomics.wait) without changing how its steps are written.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { root, shared } = workerData;
const header = new Int32Array(shared, 0, 2); // [answer ready, answer length]
const body = new Uint8Array(shared, 8);

// Loaded on the first request, so a loading error is answered like any other.
let runCli;
let playwright;
async function load() {
  ({ runCli } = await import(pathToFileURL(`${root}/node_modules/@iwsdk/cli/dist/index.js`).href));
  playwright = createRequire(`${root}/package.json`)('playwright');
}
let loaded = null;

function answer(value) {
  let encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.length > body.length) {
    encoded = new TextEncoder().encode(JSON.stringify({ error: `answer too large (${encoded.length} bytes)` }));
  }
  body.set(encoded);
  Atomics.store(header, 1, encoded.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

/** Runs one CLI command in this thread; returns what it printed. */
async function cli(argv) {
  let out = '';
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      out += chunk;
      done();
    },
  });
  const stderr = new Writable({ write: (_chunk, _encoding, done) => done() });
  await runCli(argv, { stdout, stderr, cwd: root });
  return out;
}

// The application frame in the managed browser, found the way `iwsdk browser
// run` finds it (the page the runtime marks as its own; inside it the
// workspace's runtime frame when the editor view wraps the app). It survives
// page reloads; it is looked up again if the browser is relaunched.
let browser = null;
let target = null;
let fastPathBroken = false;

async function appFrame() {
  if (target && !target.page.isClosed() && browser?.isConnected()) return target.frame ?? target.page.mainFrame();
  target = null;
  if (browser) await browser.close().catch(() => {});
  const status = JSON.parse(await cli(['dev', 'status'])).data;
  const session = status?.state?.session;
  const automation = session?.browserAutomation;
  if (!automation?.enabled || automation.protocol !== 'cdp' || !automation.endpoint || !session.localUrl) {
    throw new Error('managed browser automation is not available');
  }
  browser = await playwright.chromium.connectOverCDP(automation.endpoint, { timeout: 30000 });
  const origin = new URL(session.localUrl).origin;
  const candidates = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      let pageOrigin = null;
      try {
        pageOrigin = new URL(page.url()).origin;
      } catch {}
      if (pageOrigin !== origin) continue;
      if (await page.evaluate(() => globalThis.__IWSDK_MANAGED_BROWSER_TARGET === true).catch(() => false)) {
        candidates.push(page);
      }
    }
  }
  if (candidates.length !== 1) throw new Error(`expected one managed application page, found ${candidates.length}`);
  const page = candidates[0];
  const wrapped =
    new URL(page.url()).pathname.startsWith('/__iwsdk/workspace') ||
    (await page.evaluate(() => document.documentElement.dataset.iwsdkWorkspaceView != null));
  const frame = wrapped ? await (await page.$('#workspace-runtime-frame'))?.contentFrame() : null;
  if (wrapped && !frame) throw new Error('IWSDK workspace application frame is unavailable');
  target = { page, frame };
  return frame ?? page.mainFrame();
}

/** The old route, kept as a fallback: a script file run by `iwsdk browser run`. */
async function evaluateThroughCli(expression) {
  const file = 'artifacts/.eval.mjs';
  writeFileSync(
    `${root}/${file}`,
    `export default async function run({ page, frame }) {\n` +
      `  const target = frame ?? page;\n` +
      `  return await target.evaluate(() => (${expression}));\n}\n`,
  );
  try {
    return await cli(['browser', 'run', file, '--timeout', '20000']);
  } finally {
    rmSync(`${root}/${file}`, { force: true });
  }
}

async function evaluate(expression) {
  if (!fastPathBroken) {
    let frame;
    try {
      frame = await appFrame();
    } catch (error) {
      fastPathBroken = true;
      console.log(`    (evaluating through iwsdk browser run: ${error.message})`);
    }
    if (frame) {
      // The same evaluation `browser run` would do (a returned promise is
      // awaited in the page), with its 20 s limit and its result shape.
      let timer;
      const value = await Promise.race([
        frame.evaluate(`(async () => (${expression}))()`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('evaluation timed out after 20000 ms')), 20000);
        }),
      ]).finally(() => clearTimeout(timer));
      return JSON.stringify({ ok: true, data: { result: value === undefined ? null : value } });
    }
  }
  return evaluateThroughCli(expression);
}

parentPort.on('message', async (request) => {
  try {
    await (loaded ??= load());
    const stdout = request.kind === 'eval' ? await evaluate(request.expression) : await cli(request.argv);
    answer({ stdout });
  } catch (error) {
    answer({ error: error instanceof Error ? error.message : String(error) });
  }
});
