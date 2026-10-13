// test/render/gpu-harness.test.js — the render suites' GPU base (test/helpers/gpu.mjs), unit-tested without a GPU.
//
// The bug this guards: the launch args were hardcoded to the macOS backend, so on Windows the browser ran on the
// software WARP device, the app's `webgl2Available()` refused it (`failIfMajorPerformanceCaveat`), and 38 board3d
// tests failed reporting `3D board on ()` — an empty error naming no cause. These tests pin both halves of the fix:
// the args follow the platform, and an unusable GPU fails loudly WITH the backend named.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assertRealtimeGpu, gpuArgs, isSoftwareRenderer } from '../helpers/gpu.mjs';

/** A stand-in `Browser` whose only page answers `probeGpu()` with a canned probe result. */
const fakeBrowser = (probe) => ({
  newPage: async () => ({ evaluate: async () => probe, close: async () => {} }),
});

describe('render suite GPU base', () => {
  test('launch args follow the platform: d3d11 on Windows, metal on macOS, no --use-angle on Linux', () => {
    assert.ok(gpuArgs('win32').includes('--use-angle=d3d11'), 'Windows must ask for the D3D11 backend');
    assert.ok(!gpuArgs('win32').includes('--use-angle=metal'), 'the macOS backend must not be requested on Windows');
    assert.ok(gpuArgs('darwin').includes('--use-angle=metal'));
    assert.ok(!gpuArgs('linux').some((a) => a.startsWith('--use-angle')), 'Linux leaves ANGLE its own default');
    for (const p of ['win32', 'darwin', 'linux']) assert.ok(gpuArgs(p).includes('--ignore-gpu-blocklist'), p);
  });

  test('isSoftwareRenderer: software rasterisers yes, real GPUs no', () => {
    for (const s of ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.6, 256 bits)', 'Mesa OffScreen']) {
      assert.equal(isSoftwareRenderer(s), true, `should read as software: ${JSON.stringify(s)}`);
    }
    // an empty / unknown string is NOT "software": `assertRealtimeGpu` judges that case by the context request
    // itself (`realtime`), so classifying it here would blame a backend nobody identified.
    for (const s of ['', undefined, null, '(unknown)']) {
      assert.equal(isSoftwareRenderer(s), false, `unknown is not software: ${JSON.stringify(s)}`);
    }
    for (const s of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      'AMD Radeon RX 7900 XT (0x0000744C) Direct3D11']) {
      assert.equal(isSoftwareRenderer(s), false, `should read as real GPU: ${JSON.stringify(s)}`);
    }
  });

  test('a usable GPU passes and reports the backend', async () => {
    const probe = { webgl2: true, realtime: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti, D3D11)' };
    assert.deepEqual(await assertRealtimeGpu(fakeBrowser(probe), 'suite'), probe);
  });

  test('no WebGL2 at all fails loudly and names the suite', async () => {
    await assert.rejects(
      () => assertRealtimeGpu(fakeBrowser({ webgl2: false, realtime: false, renderer: null }), 'my suite'),
      (e) => /my suite/.test(e.message) && /no WebGL2 context/.test(e.message));
  });

  test('a software backend fails loudly and names the backend (never a silent `on: false`)', async () => {
    const warp = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    // the WARP device refuses the app's own context request — the exact shape of the board3d outage
    await assert.rejects(
      () => assertRealtimeGpu(fakeBrowser({ webgl2: true, realtime: false, renderer: warp }), 'my suite'),
      (e) => /my suite/.test(e.message) && e.message.includes(warp) && /failIfMajorPerformanceCaveat/.test(e.message));
    // and a software device that does hand out a context is still refused, by name
    await assert.rejects(
      () => assertRealtimeGpu(fakeBrowser({ webgl2: true, realtime: true, renderer: 'SwiftShader driver' }), 'my suite'),
      (e) => /pure software/.test(e.message) && /SwiftShader/.test(e.message));
  });
});
