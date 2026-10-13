// test/helpers/gpu.mjs — the render suites' GPU base: platform-picked launch args + a loud pre-flight self-check.
//
// Why this file exists (the bug it replaces): board3d / fieldview / recovery hardcoded `--use-angle=metal`, the
// macOS ANGLE backend. On Windows that name is not a backend, so ANGLE falls back to the **Microsoft Basic Render
// Driver** (WARP, pure software). The app's own `webgl2Available()` asks for a context with
// `{ failIfMajorPerformanceCaveat: true }`, which such a device refuses — so `enable3d()` was never called and the
// 3D board reported `on: false` with an EMPTY `error`. 38 board3d tests failed on that, naming no cause at all.
//
// The fix is a harness fix, not a relaxation: the launch args now follow the platform (`gpuArgs()` in
// tools/perfbench.mjs, the same helper `battle-perf.browser.test.js` already used and `test/perfbench.test.js`
// already pins), and **every assertion is untouched**. The self-check below turns "no usable GPU" from a later
// mystery into an immediate failure that names the backend.

import { gpuArgs } from '../../tools/perfbench.mjs';

export { gpuArgs };

/**
 * Software rasterisers: a real-time board measured on one of these says nothing about the product, and the app
 * deliberately refuses such a device (`failIfMajorPerformanceCaveat`). Matching these names keeps the failure
 * message honest instead of leaving the reader with `board3d.on === false`.
 */
const SOFTWARE_RE = /swiftshader|basic render driver|llvmpipe|softpipe|software rasterizer|software adapter|mesa offscreen|microsoft basic/i;

/**
 * Whether an `UNMASKED_RENDERER_WEBGL` string names a pure-software device.
 * @param {string} renderer the unmasked renderer string ('' / undefined when the extension is missing)
 * @returns {boolean}
 */
export function isSoftwareRenderer(renderer) {
  return SOFTWARE_RE.test(String(renderer ?? ''));
}

/**
 * What the page's WebGL2 really is. Two canvases on purpose: `getContext` returns the *same* context for the same
 * canvas, so asking one canvas twice with different attributes would answer about the first call only.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<{webgl2: boolean, realtime: boolean, renderer: string|null}>} `realtime` = a context the app
 *   itself would accept (`failIfMajorPerformanceCaveat`), `webgl2` = any WebGL2 context at all.
 */
export async function probeGpu(page) {
  return page.evaluate(() => {
    const mk = (attrs) => {
      const c = document.createElement('canvas');
      try { return c.getContext('webgl2', attrs); } catch { return null; }
    };
    const realtime = mk({ failIfMajorPerformanceCaveat: true });
    const any = mk({});
    const ctx = realtime || any;
    let renderer = null;
    if (ctx) {
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      renderer = String(ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
    }
    return { webgl2: !!any, realtime: !!realtime, renderer };
  });
}

/**
 * Fail loudly unless the launched browser has a GPU the render suites can actually use.
 *
 * Called from the `before()` of the render suites, right after `puppeteer.launch()`. Throwing here aborts the
 * suite with a message that names the backend and the fix, instead of 38 failures that all read `3D board on ()`.
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} label the suite name, for the message
 * @returns {Promise<{webgl2: boolean, realtime: boolean, renderer: string|null}>} the probe, for logging
 * @throws {Error} no WebGL2 at all, no real-time-capable context, or a software backend
 */
export async function assertRealtimeGpu(browser, label) {
  const page = await browser.newPage();
  let probe;
  try {
    probe = await probeGpu(page);
  } finally {
    await page.close();
  }
  const backend = probe.renderer ?? '(unknown)';
  const hint = process.platform === 'win32'
    ? 'the args from tools/perfbench.mjs gpuArgs() (--use-angle=d3d11) are required on Windows'
    : process.platform === 'darwin'
      ? 'the args from tools/perfbench.mjs gpuArgs() (--use-angle=metal) are required on macOS'
      : 'tools/perfbench.mjs gpuArgs() passes no --use-angle on Linux (ANGLE picks its own default)';
  if (!probe.webgl2) {
    throw new Error(`${label}: the browser has no WebGL2 context at all — the render suites cannot run. ${hint}`);
  }
  if (!probe.realtime) {
    throw new Error(`${label}: WebGL2 exists but the GPU backend is "${backend}", which the app refuses `
      + `(webgl2Available() asks for failIfMajorPerformanceCaveat: true) — the 3D board would silently stay off. ${hint}`);
  }
  if (isSoftwareRenderer(probe.realtime ? backend : '')) {
    throw new Error(`${label}: the GPU backend is pure software ("${backend}") — a real-time board measured on it `
      + `says nothing about the product. Fix the harness launch args; do NOT relax the assertions. ${hint}`);
  }
  return probe;
}
