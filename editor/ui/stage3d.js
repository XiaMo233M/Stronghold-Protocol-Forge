// editor/ui/stage3d.js — the map editor's 3D preview, built on the GAME's own renderer.
//
// It deliberately reuses `public/js/render/board3d/*` and `public/js/render/projection.js` rather than re-drawing the
// board: the preview is then the game's own code over the map's own data, so it cannot drift from what players see.
// The editor server serves those modules read-only under /client/ (see editor/server.mjs).
//
// Availability is a chain of four checks, and ANY failure falls back to the 2D canvas instead of erroring — exactly the
// stance of the game client (board3d/load.js):
//   1. the local-art manifest lists the board atlas   (`/data/local-assets.json`, read through a minimal asset store)
//   2. the browser has WebGL2 (software GPUs count as unavailable, like the client)
//   3. the vendored three.js build loads
//   4. the board pack actually loads (atlas + tiles.json + the optional meshes/materials)
//
// The asset store is ~20 lines instead of importing public/js/assets.js: `loadBoardPack` only ever calls
// `local()`, `localUrl(group, name)` and `image(url)`, so this supplies exactly those three and nothing else pulls the
// whole client dependency graph into the editor.

const MANIFEST_URL = '/data/local-assets.json';
const THREE_URL = '/vendor/three.module.js';

/** The three functions `boardArtListed` / `loadBoardPack` need, over the editor's own manifest route. */
function miniAssets() {
  let manifest = null;
  let promise = null;
  const local = () => {
    if (!promise) {
      promise = fetch(MANIFEST_URL, { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((m) => { manifest = m && typeof m === 'object' && m.groups ? m : null; return manifest; });
    }
    return promise;
  };
  return {
    local,
    localUrl(group, name) {
      const g = manifest && manifest.groups ? manifest.groups[group] : null;
      const e = g ? g[name] : null;
      return e && typeof e.path === 'string' && e.path ? e.path : null;
    },
    image(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`image failed: ${url}`));
        img.src = url;
      });
    },
  };
}

/**
 * Try to build the 3D view. Never throws: resolves { ok: false, reason } when the preview is unavailable, so the caller
 * simply keeps its 2D canvas and can say WHY (missing art / no WebGL2 / three failed / pack failed).
 * @param {{ canvas: HTMLCanvasElement, getStage: () => object|null, onError?: (e: any) => void }} opts
 * @returns {Promise<{ ok: true, update: () => void, resize: () => void, dispose: () => void, stats: () => object }
 *   | { ok: false, reason: string }>}
 */
export async function createStageView3d({ canvas, getStage, onError } = {}) {
  const assets = miniAssets();
  try {
    const { boardArtListed, loadBoardPack, loadThree, webgl2Available } = await import('/client/js/render/board3d/load.js');
    if (!(await boardArtListed(assets))) {
      return { ok: false, reason: '本机没有官方棋盘素材（data/local-assets.json 未列出棋盘图集），已退回 2D' };
    }
    if (!webgl2Available()) return { ok: false, reason: '这台设备没有可用的 WebGL2，已退回 2D' };
    const THREE = await loadThree(THREE_URL);
    if (!THREE) return { ok: false, reason: 'three.js 没加载成功，已退回 2D' };
    const pack = await loadBoardPack(assets);
    if (!pack) return { ok: false, reason: '棋盘素材包不完整，已退回 2D' };

    const { BoardScene } = await import('/client/js/render/board3d/scene.js');
    const { Camera } = await import('/client/js/render/projection.js');
    const { AREAS } = await import('/client/js/render/board3d/layout.js');

    // preserveDrawingBuffer: a preview is something you want to capture (and that a test can read pixels from). The game
    // client leaves it off for throughput; an editor frame is not in a performance race, and losing the buffer on
    // composite is exactly what makes a rendered preview come back black from a screenshot.
    const scene = new BoardScene(THREE, pack, { canvas, antialias: true, preserveDrawingBuffer: true });
    // Frame the whole 19x21 board. The board's tile space is x = column, y = row (layout.placeMesh), so the target is
    // the middle of the grid. Two numbers matter, and both are dictated by the scene rather than taste:
    //   * `scale` — `threeCameraParams` derives the fov from `scale * dist`, so the visible world height is H/scale.
    //     Choosing it per canvas height keeps the whole board in frame at any window size.
    //   * `dist` — the scene fogs from 17 units to 36 into a near-black colour (scene.js LIGHTING.fog). A camera much
    //     further out than the project's own DEFAULT_OPTICS.dist (16) renders a perfectly built board 89% swallowed by
    //     fog, which reads as "black canvas" and sends you hunting for a lighting bug that is not there.
    // An OVERVIEW has to build the WHOLE board: BoardScene only builds the tiles inside its current `area`, and the
    // default (AREAS.normal — the left battle half plus the lower-right island) is a PARTIAL map. Framing that partial
    // build is what made an earlier version of this file look like a featureless plane. AREAS.all is the project's own
    // whole-19x21 rect, so the preview uses it instead of restating the numbers.
    scene.setArea(AREAS.all);
    // Light the WHOLE board. BoardScene dims everything outside its focus rect (materials.js uFocusDim 0.72), and the
    // uniform's default is a small rect — so a preview that never calls this renders a correctly built but nearly black
    // board. `setFocus(null)` is the scene's own "everything lit" (scene.js:503).
    scene.setFocus(null);
    // The scene's fog (near 17, far 36, near-black) is a BATTLE depth cue, tuned for the game's ~16-unit camera. A
    // whole-map overview sits further back, where the same fog swallows the board into the void. Push it past the
    // preview distance rather than pulling the camera into the battle's tight framing: geometry, textures and lights
    // stay the game's.
    if (scene.scene?.fog) { scene.scene.fog.near = 400; scene.scene.fog.far = 1000; }

    // The board's world bounds are the ground truth for framing (layout.js places tile c,r at world x=c, y=r, but the
    // build's extent depends on the area, the stage's heights and the rim — so it is READ, never assumed).
    const COLS = 21, ROWS = 19;
    const home = { tx: COLS / 2, ty: ROWS / 2, tz: 0, tilt: 52, dist: 30, scale: 24 };
    const cam = new Camera(home);
    let cssW = 672, cssH = 608;
    let framedKey = null;
    /**
     * Aim at whatever the board actually built, and fit it to the frame.
     *
     * Two things here are easy to get wrong and both produced a board in the corner of an otherwise empty canvas:
     *   * `cx`/`cy` are the camera's screen-centre in PIXELS, and `threeCameraParams` turns them into a view offset
     *     (`offsetX = W/2 - cx`). The Camera default is 0, which shifts the whole view half a screen to the right —
     *     the game sets them with its viewport, so a standalone preview must too.
     *   * `scale` is pixels per world unit at the target plane, so the visible world height is `cssH / scale`.
     */
    function frameBoard() {
      const b = scene.board?.bounds;
      if (!b) return;
      const key = `${b.x0},${b.x1},${b.y0},${b.y1},${cssW}x${cssH}`;
      if (key === framedKey) return;
      framedKey = key;
      cam.cx = cssW / 2;
      cam.cy = cssH / 2;
      cam.tx = (b.x0 + b.x1) / 2;
      cam.ty = (b.y0 + b.y1) / 2;
      cam.scale = cssH / (Math.max(b.x1 - b.x0, b.y1 - b.y0) + 3);
      cam.update();
      Object.assign(home, { tx: cam.tx, ty: cam.ty, scale: cam.scale });
    }

    let disposed = false;
    let frames = 0;

    const view = {
      update() {
        if (disposed) return;
        const stage = getStage();
        if (!stage) return;
        // setStage() no-ops when the grid is unchanged, so this is cheap to call on every edit
        scene.setStage({ id: stage.id, rows: stage.rows, devices: stage.devices });
        view.resize();
        scene.render(cam, performance.now() / 1000);
        frames++;
      },
      resize() {
        // Prefer the canvas's own CSS box; fall back to its parent, then to a floor. Never let the backing store collapse
        // to a few pixels (a hidden or not-yet-laid-out element measures 0, and a 2-px render is silently useless).
        const box = canvas.getBoundingClientRect();
        const parent = canvas.parentElement?.getBoundingClientRect();
        const w = Math.max(320, Math.round(box.width || parent?.width || 672));
        const h = Math.max(200, Math.round(box.height || parent?.height || 608));
        cssW = w;
        cssH = h;
        scene.resize(w, h, Math.min(2, globalThis.devicePixelRatio || 1));
        frameBoard();
      },
      /** Drag to pan, wheel to zoom, shift-drag (or right-drag) to tilt. The game's camera is a fixed-orientation
       *  projection camera, so there is no yaw to expose — pan/zoom/tilt is the whole control set it has. */
      attach() {
        let dragging = null;
        const onDown = (ev) => {
          dragging = { x: ev.clientX, y: ev.clientY, tilt: ev.shiftKey || ev.button === 2 };
          canvas.setPointerCapture?.(ev.pointerId);
        };
        const onMove = (ev) => {
          if (!dragging) return;
          const dx = ev.clientX - dragging.x;
          const dy = ev.clientY - dragging.y;
          dragging.x = ev.clientX;
          dragging.y = ev.clientY;
          if (dragging.tilt) {
            cam.tilt = Math.max(0, Math.min(80, cam.tilt - dy * 0.4));
          } else {
            // pixels → board units: the camera's scale is px per unit at the target depth
            cam.tx -= (dx / cam.scale) * (cam.dist / 20);
            cam.ty += (dy / cam.scale) * (cam.dist / 20) * Math.cos((cam.tilt * Math.PI) / 180);
          }
          cam.update();
          view.update();
        };
        const onUp = (ev) => { dragging = null; canvas.releasePointerCapture?.(ev.pointerId); };
        const onWheel = (ev) => {
          ev.preventDefault();
          cam.dist = Math.max(8, Math.min(90, cam.dist * (ev.deltaY > 0 ? 1.1 : 0.9)));
          cam.update();
          view.update();
        };
        const onContext = (ev) => ev.preventDefault();
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('contextmenu', onContext);
        return () => {
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('contextmenu', onContext);
        };
      },
      reset() { Object.assign(cam, home); view.resize(); view.update(); },
      stats: () => ({ frames, dist: Math.round(cam.dist), tilt: Math.round(cam.tilt), board3d: scene.stats?.() ?? null }),
      /** The live scene, for the devtools console (`__spEditor3d.stats()`) and for automated checks. */
      scene: () => scene,
      /** The current frame as a PNG data URL (needs preserveDrawingBuffer, which this view sets). */
      snapshot: () => { try { return canvas.toDataURL('image/png'); } catch { return null; } },
      dispose() {
        disposed = true;
        try { scene.destroy(); } catch (e) { onError?.(e); }
      },
    };
    const detach = view.attach();
    const origDispose = view.dispose;
    view.dispose = () => { detach(); origDispose(); };
    view.update();
    return { ok: true, ...view };
  } catch (e) {
    onError?.(e);
    return { ok: false, reason: `3D 预览不可用：${e && e.message ? e.message : e}` };
  }
}
