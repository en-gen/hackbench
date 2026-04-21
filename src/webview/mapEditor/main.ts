/**
 * SMW Map Editor — webview entry point.
 *
 * Opens a single map (1 of 512 from the SMW ROM). Several related maps linked
 * by entrances/exits together form a "level" in the player-facing sense.
 */


// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()

import { effect } from '@vue/reactivity'
import { storeToRefs } from 'pinia'
import { buildGraph } from '../../rom/model/rehydrate'
import { L2ObjectStream, L2Preset } from '../../rom/model/L2Layer'
import type { MapPayload as ModelMapPayload } from '../../rom/model/MapPayload'
import type { SmwMap } from '../../rom/model/SmwMap'
import { cellBoxOf, type RenderContext } from '../../rom/model/RenderTarget'
import { CanvasRenderTarget } from './CanvasRenderTarget'
import { useEditorStore } from './store'

// FLUX: the store owns state; views dispatch actions; observers read refs.
// `store.foo`      — read a value (auto-unwrapped by Pinia's proxy).
// `storeRefs.foo`  — Ref<T> for passing into the render context so that
//                    @vue/reactivity tracks `.value` reads inside behaviors.
// `store.doThing()` — action (mutation). Never mutate refs from outside.
const store     = useEditorStore()
const storeRefs = storeToRefs(store)

// Self-rendering model graph. Populated from the `modelPayload` message
// alongside the legacy `load`; exposed on window for dev inspection.
// __smwModelChars is the flat VRAM char lookup used by the GFX viewer
// and any other panel that needs a specific char by its flat index.
declare global {
  interface Window {
    __smwModelMap?: SmwMap
    __smwModelChars?: Map<number, import('../../rom/model/chars/Char').Char>
    __smwModelTiles?: Map<number, import('../../rom/model/tiles/Tile').Tile>
    __smwModelBgTiles?: Map<number, import('../../rom/model/tiles/Tile').Tile>
  }
}

/**
 * Set up the reactive render effect for the current map. Vue's effect()
 * tracks every ref read inside renderModelOverlay (transitively, including
 * reads inside behaviors during map.render). Subsequent ref mutations
 * trigger an automatic re-run — exactly the cells that changed get
 * recomposed, and untouched cells are skipped via the per-row scratch
 * + computed-cache discipline lower in the model.
 */
let modelRenderRunner: { stop(): void } | null = null
function ensureReactiveRender(map: SmwMap): void {
  modelRenderRunner?.stop()
  const runner = effect(() => renderModelOverlay(map)) as unknown as { effect?: { stop(): void } }
  // @vue/reactivity exposes effect.stop on the returned runner.
  modelRenderRunner = { stop: () => runner.effect?.stop() }
}

/**
 * Mirror legacy state into model refs. The reactive render effect()
 * re-runs whenever any of these change.
 */
// NOTE: the model refs (imported from ./state) are the single source of
// truth for every reactive input. Event handlers write to them directly;
// there is no legacy→model sync shim. Any legacy variable that still
// exists (e.g. `animFrame`, `zoom`) is kept in lockstep at the write
// site, not via a separate bridging function.

/**
 * Render the self-rendering model graph to the model canvas — now the
 * default view. Called when `modelPayload` arrives and re-runs
 * automatically (via effect()) whenever a tracked ref changes. Sized at
 * 1× natural pixels; legacy zoom/pan is independent for now.
 */
function renderModelOverlay(map: SmwMap): void {
  const overlay = document.getElementById('model-canvas') as HTMLCanvasElement | null
  if (!overlay) return
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  const w = cols * 16
  const h = rows * 16
  if (w === 0 || h === 0) return
  if (overlay.width !== w) overlay.width = w
  if (overlay.height !== h) overlay.height = h
  // Zoom applies via CSS scaling — framebuffer stays at natural resolution
  // so the output is pixel-perfect (image-rendering: pixelated).
  const z = store.zoom
  overlay.style.width = `${w * z}px`
  overlay.style.height = `${h * z}px`

  const target = new CanvasRenderTarget(overlay)
  // Level-wide state on ctx — tile behaviors (PipeVariants) derive
  // per-cell concerns from their own cell position + these fields,
  // so the camera viewport / detail preview / Map16 panel can all
  // reuse the same ctx without pre-computing per-cell variants.
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette: map.palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
    levelOrientation: map.header.orientation,
    screenPipeVariantIdx: map.screenPipeVariantIdx,
  }
  target.clear(map.palette.backAreaColor.rgba(ctx))
  map.render(ctx, target)
  // Camera viewport parallax BG + L1 re-render must land in the
  // framebuffer BEFORE the flush so pixel ops (blend + overwrite) reach
  // the canvas. Read `store.cameraOn` here so flipping the checkbox
  // invalidates the effect and re-renders.
  const cameraOn = store.cameraOn
  if (cameraOn) compositeCameraViewport(target, ctx, map)
  target.flush()

  // Overlays on top of the rendered framebuffer. Canvas 2D draw calls
  // are used here rather than the pixel-level RenderTarget so the lines
  // can be sub-pixel aligned at the natural render resolution. Any read
  // of `store.layerToggles.*` keeps the reactive effect invalidated
  // when a checkbox flips.
  const toggles = store.layerToggles
  if (toggles.block) {
    const octx = overlay.getContext('2d')!
    drawBlockView(octx, map, toggles.l1, toggles.l2)
  }
  if (toggles.screens || toggles.mapGrid) {
    const octx = overlay.getContext('2d')!
    drawScreenAndGridOverlays(octx, map, toggles.screens, toggles.mapGrid)
  }
  if (cameraOn) {
    const octx = overlay.getContext('2d')!
    drawCameraRectOverlay(octx, map)
  }

  // Side-panel canvases share the reactive pass — each re-reads its
  // model inputs via `ctx.*.value`, so a ref change invalidates the
  // effect and rebuilds every panel that reads the changed ref.
  drawPaletteCanvas()
  renderVramPage()
  renderMap16Page()
  // Detail preview goes through the model too so animation / pswitch /
  // switch-palace are reflected. Cheap no-op when nothing is selected.
  redrawDetail()
  // Minimap is a scaled drawImage of this model canvas. The reactive
  // re-run keeps it in step with everything rendered above.
  if (minimapOn) drawMinimap()
}

/**
 * Composite the parallax preview strip into the framebuffer before
 * flush. Horizontal levels get a full-height, camera-width vertical
 * strip at the camera's X position; vertical levels get a full-width,
 * camera-height horizontal strip at the camera's Y position. The
 * parallax shift is sampled at the camera's FG origin, then tiled
 * across the strip. L1 is re-rendered on top of the parallax BG so
 * foreground geometry stays dominant.
 */
function compositeCameraViewport(
  target: CanvasRenderTarget,
  ctx: RenderContext,
  map: SmwMap,
): void {
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  if (rows === 0 || cols === 0) return
  const isVert = map.header.orientation === 'vertical'
  // Read from the store (reactive) so pointer-drag updates invalidate
  // the effect and re-paint at the new camera position. `store.camera`
  // can hold a fractional tile position (free drag). The outer rect
  // overlay uses the float value for smooth gliding, but the strip's
  // tile content floors to stay tile-aligned — otherwise fillRect and
  // tile.render would leave seams when the camera sits between tiles.
  const cam = store.camera
  const camX = Math.floor(Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES), cam.tileX)))
  const camY = Math.floor(Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES), cam.tileY)))

  // Strip dimensions in natural pixels. Horizontal levels scroll L→R so
  // the preview strip runs top-to-bottom at the camera's X; vertical
  // levels do the opposite.
  const sx = isVert ? 0 : camX * 16
  const sy = isVert ? camY * 16 : 0
  const sw = isVert ? cols * 16 : CAMERA_W_TILES * 16
  const sh = isVert ? CAMERA_H_TILES * 16 : rows * 16

  // Repaint the strip from scratch — wipe the existing render inside
  // so parallax BG can be re-sampled without double-painting.
  target.fillRect({ x: sx, y: sy }, { w: sw, h: sh }, map.palette.backAreaColor.rgba(ctx))

  const toggles = store.layerToggles

  // Parallax L2. The strip extends across the "fixed" axis of the map
  // (full height for horizontal levels, full width for vertical), so
  // along that axis the BG should render in its natural layout —
  // otherwise the camera position would double-shift the content and
  // the preview drifts away from the real level geometry. Along the
  // "scrolling" axis, shift by `camera >> shift` as usual (null shift
  // = BG locked to origin 0).
  if (toggles.l2 && map.l2) {
    const vShift = verticalScrollPixelShift(map.header.vertLayer2Setting ?? 0)
    const hShift = horizontalScrollPixelShift(map.header.horizLayer2Setting ?? 0)
    const bgGrid = map.l2.layout()
    const bgRows = bgGrid.length
    const bgCols = bgRows > 0 ? bgGrid[0].length : 0
    if (bgRows > 0 && bgCols > 0) {
      // Horizontal level: camera scrolls X → shift BG cols; keep rows natural.
      // Vertical   level: camera scrolls Y → shift BG rows; keep cols natural.
      const bgOriginRow = isVert
        ? (vShift === null ? 0 : Math.floor(((camY * 16) >> vShift) / 16))
        : 0
      const bgOriginCol = isVert
        ? 0
        : (hShift === null ? 0 : Math.floor(((camX * 16) >> hShift) / 16))
      const stripCols = sw / 16
      const stripRows = sh / 16
      for (let r = 0; r < stripRows; r++) {
        for (let c = 0; c < stripCols; c++) {
          const bgR = ((bgOriginRow + r) % bgRows + bgRows) % bgRows
          const bgC = ((bgOriginCol + c) % bgCols + bgCols) % bgCols
          const tile = bgGrid[bgR]?.[bgC]
          if (!tile) continue
          const px = sx + c * 16
          const py = sy + r * 16
          const cell = {
            tl: { x: px,     y: py },
            tr: { x: px + 8, y: py },
            bl: { x: px,     y: py + 8 },
            br: { x: px + 8, y: py + 8 },
          }
          tile.render(ctx, target, cell, 'nonPriority')
          tile.render(ctx, target, cell, 'priority')
        }
      }
    }
  }

  // L1 on top — reuses world-space tiles so every tile behavior
  // (pipe variants, P-switch reveals, switch-palace alt) self-selects
  // from the world-space cell position. No caller-side injection.
  if (toggles.l1) {
    const worldStartX = Math.floor(sx / 16)
    const worldStartY = Math.floor(sy / 16)
    const stripCols = sw / 16
    const stripRows = sh / 16
    for (let r = 0; r < stripRows; r++) {
      for (let c = 0; c < stripCols; c++) {
        const wx = worldStartX + c
        const wy = worldStartY + r
        const id = map.l1[wy]?.[wx]
        if (id === null || id === undefined) continue
        const tile = map.l1Tiles.get(id)
        if (!tile) continue
        const cell = cellBoxOf(wx, wy)
        tile.render(ctx, target, cell, 'nonPriority')
        tile.render(ctx, target, cell, 'priority')
      }
    }
  }
}

/**
 * Draw the camera-viewport border after the framebuffer flush. The
 * viewport rect is always CAMERA_W_TILES × CAMERA_H_TILES regardless of
 * level orientation — it shows the actual playfield size the player
 * sees, independent of the parallax preview strip.
 */
function drawCameraRectOverlay(
  octx: CanvasRenderingContext2D,
  map: SmwMap,
): void {
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  if (rows === 0 || cols === 0) return
  const isVert = map.header.orientation === 'vertical'
  const cam = store.camera
  // Fractional position — lets the rect glide between tiles as the user
  // drags. Strip content is floored elsewhere; only the visual rect is
  // sub-tile.
  const camXf = Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES), cam.tileX))
  const camYf = Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES), cam.tileY))

  // Inner rect: the actual camera viewport (CAMERA_W × CAMERA_H).
  const rx = camXf * 16
  const ry = camYf * 16
  const rw = CAMERA_W_TILES * 16
  const rh = CAMERA_H_TILES * 16

  // Outer rect: the full preview strip — camera-wide × full-height for
  // horizontal levels, full-width × camera-tall for vertical.
  const sx = isVert ? 0 : rx
  const sy = isVert ? ry : 0
  const sw = isVert ? cols * 16 : rw
  const sh = isVert ? rh : rows * 16

  const w = cols * 16
  const h = rows * 16
  octx.save()
  // Focused dim: spotlight the camera's playfield rect; everything
  // outside (including the parallax strip area) gets a 40% darken.
  if (cam.focused) {
    octx.fillStyle = 'rgba(0,0,0,0.4)'
    octx.fillRect(0, 0, w, ry)                     // above
    octx.fillRect(0, ry + rh, w, h - (ry + rh))    // below
    octx.fillRect(0, ry, rx, rh)                   // left of
    octx.fillRect(rx + rw, ry, w - (rx + rw), rh)  // right of
  }

  // Outer rect — yellow border around the full preview strip.
  octx.strokeStyle = 'rgba(255,255,80,0.95)'
  octx.lineWidth = 2
  octx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2)
  octx.strokeStyle = 'rgba(0,0,0,0.6)'
  octx.lineWidth = 1
  octx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1)

  // Inner rect — indicates the actual camera viewport size inside the
  // strip. Drawn thinner so it doesn't compete with the strip border.
  octx.strokeStyle = 'rgba(255,255,80,0.95)'
  octx.lineWidth = 1
  octx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
  octx.restore()
}

/**
 * Block-view overlay: paint each non-empty L1 (and optionally L2) tile
 * as a colored 16×16 square keyed on the Map16 tile id, deterministic
 * via `tileBlockColor`. L2 renders at 55% alpha so L1 reads over it.
 * Useful for level troubleshooting since it surfaces the underlying
 * tile layout with zero GFX rendering.
 *
 * No text labels on the blocks for now — the hex-id labels need a
 * different approach to scale legibly at every zoom from 1× to 16×.
 * Revisit with a proper bitmap-font / DOM-overlay strategy later.
 */
function drawBlockView(
  octx: CanvasRenderingContext2D,
  map: SmwMap,
  l1On: boolean,
  l2On: boolean,
): void {
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  if (rows === 0 || cols === 0) return

  const paintFills = (
    grid: readonly (readonly (number | null)[])[],
    alpha: number,
  ) => {
    octx.save()
    octx.globalAlpha = alpha
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r]
      if (!row) continue
      for (let c = 0; c < row.length; c++) {
        const id = row[c]
        if (id === null) continue
        octx.fillStyle = tileBlockColor(id)
        octx.fillRect(c * 16, r * 16, 16, 16)
      }
    }
    octx.restore()
  }

  // L2 grids are ids (L2Preset → bgTiles, L2ObjectStream → l1Tiles);
  // we only need the ids for the colored-block visualization, no
  // lookup required.
  if (l2On && map.l2) {
    const l2Grid = map.l2 instanceof L2Preset || map.l2 instanceof L2ObjectStream
      ? map.l2.grid
      : null
    if (l2Grid) paintFills(l2Grid, 0.55)
  }
  if (l1On) paintFills(map.l1, 1.0)
}

/**
 * Draw screen dividers + 2-hex screen-number chips (if `screens`) and/or
 * a 16×16 tile grid (if `mapGrid`) over the model canvas. Both overlays
 * use natural-resolution coordinates — the model canvas is always sized
 * at `cols*16 × rows*16` regardless of zoom (CSS scales it at display).
 */
function drawScreenAndGridOverlays(
  octx: CanvasRenderingContext2D,
  map: SmwMap,
  screens: boolean,
  mapGrid: boolean,
): void {
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  const w = cols * 16
  const h = rows * 16
  const isVert = map.header.orientation === 'vertical'
  const screenCount = map.screenCount
  // Screen size in tile coordinates — horizontal 16×27, vertical 32×16.
  const SCREEN_W_TILES = isVert ? 32 : 16
  const SCREEN_H_TILES = isVert ? 16 : 27

  if (screens && screenCount > 1) {
    octx.strokeStyle = 'rgba(100,120,255,0.4)'
    octx.lineWidth = 1
    if (isVert) {
      for (let s = 1; s < screenCount; s++) {
        const y = Math.round(s * SCREEN_H_TILES * 16) + 0.5
        octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke()
      }
    } else {
      for (let s = 1; s < screenCount; s++) {
        const x = Math.round(s * SCREEN_W_TILES * 16) + 0.5
        octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, h); octx.stroke()
      }
    }
  }

  if (screens) {
    octx.save()
    const fontSize = 14
    octx.font = `bold ${fontSize}px monospace`
    octx.textAlign = 'left'
    octx.textBaseline = 'top'
    const padX = 6
    const padY = 3
    for (let s = 0; s < screenCount; s++) {
      const chipX = (isVert ? 0 : s * SCREEN_W_TILES * 16) + 3
      const chipY = (isVert ? s * SCREEN_H_TILES * 16 : 0) + 3
      const label = s.toString(16).toUpperCase().padStart(2, '0')
      const textW = octx.measureText(label).width
      octx.fillStyle = 'rgba(0,0,0,0.72)'
      octx.fillRect(chipX, chipY, textW + padX * 2, fontSize + padY * 2)
      octx.fillStyle = '#e8d050'
      octx.fillText(label, chipX + padX, chipY + padY)
    }
    octx.restore()
  }

  if (mapGrid) {
    octx.strokeStyle = 'rgba(255,255,255,0.07)'
    octx.lineWidth = 1
    for (let c = 0; c <= cols; c++) {
      const x = Math.round(c * 16) + 0.5
      octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, h); octx.stroke()
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(r * 16) + 0.5
      octx.beginPath(); octx.moveTo(0, y); octx.lineTo(w, y); octx.stroke()
    }
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TILE_PX    = 16
const SCREEN_W   = 16
const SCREEN_H   = 27
// 0.25 increments around 1× so one zoom-in jump is a small visual change
// (1.00 → 1.25 instead of 1× → 2×). Coarser steps above 2× since detail
// differences there are less perceptible.
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]
const ZOOM_DEFAULT_IDX = 3  // 1×
const PAL_CELL   = 8        // pixels per palette swatch cell in the properties panel

// ── Style helpers ─────────────────────────────────────────────────────────────

function selStyle(): string {
  return 'width:100%;background:var(--vscode-dropdown-background,#3c3c3c);' +
         'color:var(--vscode-dropdown-foreground,#ccc);' +
         'border:1px solid #555;border-radius:3px;height:22px;font-size:11px;cursor:pointer;'
}
function btnStyle(): string {
  return 'background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;' +
         'width:22px;height:22px;font-size:14px;line-height:1;cursor:pointer;padding:0;'
}
function chkStyle(): string {
  return 'display:flex;align-items:center;gap:4px;cursor:pointer;' +
         'font-size:12px;color:#888;user-select:none;'
}
function propLabelStyle(): string {
  return 'font-size:9px;font-weight:700;letter-spacing:.08em;' +
         'color:var(--vscode-descriptionForeground,#888);margin-bottom:3px;'
}

// ── Build DOM ─────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!
app.style.cssText = 'display:flex;flex-direction:column;height:100vh;overflow:hidden;'

app.innerHTML = `
<div id="toolbar" style="
  display:flex;align-items:center;gap:10px;flex-shrink:0;
  padding:0 12px;height:36px;
  background:var(--vscode-editor-background,#1e1e1e);
  border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);
  font-size:12px;font-family:var(--vscode-font-family,system-ui);
  color:var(--vscode-foreground,#e0e0e0);">
  <span id="map-id" style="font-family:monospace;color:#5b9cf6;font-weight:600;min-width:90px"></span>
  <span id="map-meta" style="color:#888;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
    <button id="zoom-out" title="Zoom out (Ctrl+scroll)" style="${btnStyle()}">&#8722;</button>
    <span id="zoom-label" style="font-family:monospace;font-size:11px;min-width:32px;text-align:center">1&#215;</span>
    <button id="zoom-in"  title="Zoom in (Ctrl+scroll)"  style="${btnStyle()}">&#43;</button>
  </div>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-screens"> Screens</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-sprites" checked> Sprites</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-block"> Block</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-l1" checked> L1</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-l2" checked> L2</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-camera"> Camera</label>
</div>

<div id="workspace" style="display:flex;flex:1;overflow:hidden;">

  <div id="tiles-panel" style="
    width:220px;flex-shrink:0;overflow-y:auto;
    display:flex;flex-direction:column;
    background:var(--vscode-sideBar-background,#252526);
    border-right:1px solid var(--vscode-panel-border,#3a3a3a);
    font-family:var(--vscode-font-family,system-ui);font-size:12px;">

    <div class="section-hdr">8×8 TILES (VRAM)</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
      <button id="vram-prev" style="${btnStyle()}border:none;" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
      <span id="vram-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 6</span>
      <button id="vram-next" style="${btnStyle()}border:none;" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
    </div>
    <div style="padding:4px 8px 8px;">
      <canvas id="vram-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;display:block;cursor:default;
        border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
        <div id="vram-inspect" style="font-size:10px;font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
        <div style="display:flex;gap:2px;">
          <button id="btn-anim" style="${btnStyle()}border:none;" title="Play animation"><span class="codicon codicon-play"></span></button>
          <button id="btn-vram-grid" style="${btnStyle()}border:none;" title="Toggle grid"><span class="codicon codicon-table"></span></button>
        </div>
      </div>
    </div>

    <div class="section-hdr">16×16 TILES (MAP16)</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
      <button id="map16-prev" style="${btnStyle()}border:none;" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
      <span id="map16-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 2</span>
      <button id="map16-next" style="${btnStyle()}border:none;" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
    </div>
    <div style="padding:4px 8px 8px;">
      <canvas id="map16-canvas" width="256" height="256" style="
        width:100%;image-rendering:pixelated;display:block;cursor:default;
        border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
        <div id="map16-inspect" style="font-size:10px;font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
        <div style="display:flex;gap:2px;">
          <button id="btn-anim2" style="${btnStyle()}border:none;" title="Play animation"><span class="codicon codicon-play"></span></button>
          <button id="btn-map16-grid" style="${btnStyle()}border:none;" title="Toggle grid"><span class="codicon codicon-table"></span></button>
        </div>
      </div>
    </div>

    <div class="section-hdr">SELECTED TILE</div>
    <div id="tile-detail" style="padding:8px;">
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <canvas id="detail-canvas" width="16" height="16" style="
          width:64px;height:64px;image-rendering:pixelated;flex-shrink:0;
          border:1px solid #555;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
        <div id="detail-info" style="font-size:10px;font-family:monospace;color:#aaa;line-height:1.6;">click a tile to inspect</div>
      </div>
    </div>

  </div>

  <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
    <div id="main-view" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
      <div id="canvas-wrap" style="flex:1;overflow:auto;background:#111111;cursor:crosshair;display:flex;justify-content:safe center;align-items:safe center;">
        <canvas id="model-canvas" style="display:block;image-rendering:pixelated;margin:8px;"></canvas>
      </div>
      <div id="minimap-wrap" style="flex-shrink:0;background:#0a0a0a;border-top:1px solid #3a3a3a;padding:4px 8px;display:flex;justify-content:center;align-items:center;">
        <canvas id="minimap-canvas" style="display:block;image-rendering:pixelated;cursor:pointer;background:#000;"></canvas>
      </div>
    </div>
    <div id="map-bottom-bar" style="display:flex;align-items:center;gap:12px;padding:4px 8px;background:#1a1a1a;border-top:1px solid #3a3a3a;font-family:monospace;font-size:11px;color:#ccc;">
      <span id="st-pos" style="min-width:90px;">—</span>
      <span id="st-tile" style="min-width:70px;">—</span>
      <span id="st-info" style="flex:1;color:#888;"></span>
      <button id="btn-map-minimap" style="${btnStyle()}border:none;" title="Toggle minimap"><span class="codicon codicon-map"></span></button>
      <button id="btn-anim3" style="${btnStyle()}border:none;" title="Play animation"><span class="codicon codicon-play"></span></button>
      <button id="btn-map-grid" style="${btnStyle()}border:none;" title="Toggle tile grid"><span class="codicon codicon-table"></span></button>
    </div>
  </div>

  <div id="props-panel" style="
    width:220px;flex-shrink:0;overflow-y:auto;
    display:flex;flex-direction:column;
    background:var(--vscode-sideBar-background,#252526);
    border-left:1px solid var(--vscode-panel-border,#3a3a3a);
    font-family:var(--vscode-font-family,system-ui);font-size:12px;">

    <div class="section-hdr">PALETTE</div>
    <div style="padding:8px 8px 4px;">
      <canvas id="palette-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;cursor:crosshair;display:block;
        background:repeating-conic-gradient(#555 0% 25%,#444 0% 50%) 0 0/8px 8px;
        border:1px solid #3a3a3a;box-sizing:border-box;"></canvas>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
        <div id="palette-inspect" style="font-size:10px;
          font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
        <div style="display:flex;align-items:center;gap:2px;">
          <div id="pal-anim-controls" style="display:none;align-items:center;gap:2px;">
            <button id="btn-pal-play" style="${btnStyle()}border:none;" title="Play palette animation"><span class="codicon codicon-play"></span></button>
          </div>
          <button id="btn-pal-grid" style="${btnStyle()}border:none;" title="Toggle palette grid"><span class="codicon codicon-table"></span></button>
        </div>
      </div>
    </div>

    <div class="section-hdr">LEVEL HEADER SETTINGS</div>
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px;">

      <div>
        <div style="${propLabelStyle()}">BACK AREA COLOR</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div id="back-area-swatch" style="
            width:16px;height:16px;flex-shrink:0;
            border:1px solid #555;border-radius:2px;"></div>
          <select id="sel-bg-color" style="${selStyle()}"></select>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div>
          <div style="${propLabelStyle()}">FG PALETTE</div>
          <select id="sel-fg-palette" style="${selStyle()}"></select>
        </div>
        <div>
          <div style="${propLabelStyle()}">BG PALETTE</div>
          <select id="sel-bg-palette" style="${selStyle()}"></select>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div>
          <div style="${propLabelStyle()}">SPRITE PALETTE</div>
          <select id="sel-sprite-palette" style="${selStyle()}"></select>
        </div>
        <div>
          <div style="${propLabelStyle()}">MARIO PALETTE</div>
          <select id="sel-mario-palette" style="${selStyle()}"></select>
        </div>
      </div>

      <div>
        <div style="${propLabelStyle()}">TILESET (GFX)</div>
        <select id="sel-tileset" style="${selStyle()}"></select>
      </div>

      <div>
        <div style="${propLabelStyle()}">SPRITE SET</div>
        <select id="sel-sprite-set" style="${selStyle()}"></select>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div>
          <div style="${propLabelStyle()}">BG V-SCROLL</div>
          <div id="info-bg-vscroll" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
        </div>
        <div>
          <div style="${propLabelStyle()}">BG H-SCROLL</div>
          <div id="info-bg-hscroll" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
        </div>
      </div>

    </div>

    <div class="section-hdr">ROOM INFO</div>
    <div style="padding:8px;display:flex;flex-direction:column;gap:6px;">
      <div>
        <div style="${propLabelStyle()}">SCREENS</div>
        <div id="info-screens" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
      </div>
      <div>
        <div style="${propLabelStyle()}">SPRITES</div>
        <div id="info-sprites" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
      </div>
    </div>

    <div class="section-hdr" style="margin-top:auto;">SWITCH STATE</div>
    <div style="padding:8px;display:flex;flex-direction:column;gap:6px;">
      <div id="switch-toggles" style="display:flex;gap:6px;justify-content:space-between;">
        <button class="pswitch-toggle" data-pcolor="blue" title="Blue P-switch — reveals hidden doors, ? blocks, and P-switch coins at 50% opacity">
          <canvas width="16" height="16"></canvas>
        </button>
        <button class="switch-toggle" data-color="0" title="Green switch — click to toggle cleared state">
          <canvas width="16" height="16"></canvas>
        </button>
        <button class="switch-toggle" data-color="1" title="Yellow switch — click to toggle cleared state">
          <canvas width="16" height="16"></canvas>
        </button>
        <button class="switch-toggle" data-color="2" title="Blue switch — click to toggle cleared state">
          <canvas width="16" height="16"></canvas>
        </button>
        <button class="switch-toggle" data-color="3" title="Red switch — click to toggle cleared state">
          <canvas width="16" height="16"></canvas>
        </button>
      </div>
    </div>

  </div>
</div>

<style>
  .section-hdr {
    padding:4px 8px 3px;font-size:10px;font-weight:700;letter-spacing:.08em;
    color:var(--vscode-sideBarSectionHeader-foreground,#bbb);
    background:var(--vscode-sideBarSectionHeader-background,#2d2d2d);
    user-select:none;
  }
  .tile-tab { transition: color 0.15s, border-bottom 0.15s; border-bottom: 2px solid transparent; }
  .tile-tab-active { color: #ccc !important; border-bottom: 2px solid #007acc !important; }
  .switch-toggle, .pswitch-toggle {
    width:36px;height:36px;padding:2px;border-radius:4px;cursor:pointer;
    background:var(--vscode-input-background,#1e1e1e);border:2px solid #555;
    display:flex;align-items:center;justify-content:center;
    transition:border-color 0.15s, box-shadow 0.15s;
  }
  .switch-toggle:hover, .pswitch-toggle:hover { border-color:#888; }
  .switch-toggle.switch-on, .pswitch-toggle.switch-on {
    border-color:#007acc; box-shadow:0 0 4px rgba(0,122,204,0.4);
  }
  .switch-toggle canvas, .pswitch-toggle canvas {
    width:28px;height:28px;image-rendering:pixelated;display:block;
    background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/4px 4px;
  }
</style>
`

// ── Element refs ─────────────────────────────────────────────────────────────

const modelCanvas    = document.getElementById('model-canvas') as HTMLCanvasElement
const canvasWrap     = document.getElementById('canvas-wrap')!
const minimapCanvas  = document.getElementById('minimap-canvas') as HTMLCanvasElement
const minimapCtx     = minimapCanvas.getContext('2d')!
const mapId          = document.getElementById('map-id')!
const mapMeta        = document.getElementById('map-meta')!
const zoomLabel      = document.getElementById('zoom-label')!
const stPos          = document.getElementById('st-pos')!
const stTile         = document.getElementById('st-tile')!
const stInfo         = document.getElementById('st-info')!
const chkScreens     = document.getElementById('chk-screens')     as HTMLInputElement
const chkSprites     = document.getElementById('chk-sprites')     as HTMLInputElement
const chkBlock       = document.getElementById('chk-block')       as HTMLInputElement
const chkL1          = document.getElementById('chk-l1')          as HTMLInputElement
const chkL2          = document.getElementById('chk-l2')          as HTMLInputElement
const chkCamera      = document.getElementById('chk-camera')      as HTMLInputElement

// ── Camera viewport overlay ──────────────────────────────────────────────────
// A draggable 16×14 tile rectangle representing the SNES FG screen window
// (256×224 px). When the "Camera" toggle is on, the rectangle is drawn over
// the map; inside it the parallax strip re-composites L2 at its parallax-adjusted
// position so the user sees what the player actually sees in-game at that scroll
// point. Scroll ratios come from mapData.header.vertLayer2Setting (0..3):
//   0 = locked (BG static),  1 = 1:1 (BG pinned to camera),
//   2 = 1/2 rate,             3 = 1/32 rate
// Per CODE_00F7AA (bank_00.asm:13735-13749). Position lives in `store.camera`.
const CAMERA_W_TILES = 16
const CAMERA_H_TILES = 14
let cameraDragging = false
let cameraDragOffX = 0  // pointer offset from rect top-left at mousedown (tile coords)
let cameraDragOffY = 0

/** Pixel shift applied to FG pixel Y to get BG pixel Y, per VertLayer2Setting. */
function verticalScrollPixelShift(setting: number): number | null {
  // Returns null for setting 0 (BG locked, BG Y doesn't update).
  // Otherwise: shift is applied to Layer1YPos in pixels (bank_00.asm:13737-13746).
  switch (setting) {
    case 1: return 0
    case 2: return 1
    case 3: return 5
    default: return null
  }
}

function horizontalScrollPixelShift(setting: number): number | null {
  // bank_00.asm:13727-13733. Setting 0 locks BG X; 1 is 1:1, 2 is 1/2.
  // (No setting 3 for horizontal; the table tops out at 2.)
  switch (setting) {
    case 1: return 0
    case 2: return 1
    default: return null
  }
}

// ── Tile detail preview state ─────────────────────────────────────────────────
let selectedDetail: { type: 'vram'; page: number; col: number; row: number } |
                    { type: 'map16'; page: number; col: number; row: number } | null = null

function redrawDetail(): void {
  if (!selectedDetail) return
  // Self-rendering model drives the preview — animation / pswitch /
  // switch-palace state all reflect automatically via the reactive chain.
  redrawDetailFromModel()
}

/**
 * Render the selected-tile preview through the model. Every read here
 * goes through `storeRefs.*.value` (via char.getPixels / tile.render /
 * palette.row), so when this function runs inside the reactive effect
 * it auto-retracks animation / pswitch / palette-cycle changes and
 * re-renders on each tick.
 */
function redrawDetailFromModel(): void {
  if (!selectedDetail) return
  const map      = window.__smwModelMap
  const chars    = window.__smwModelChars
  const l1Tiles  = window.__smwModelTiles
  const bgTiles  = window.__smwModelBgTiles
  if (!map) return

  const dc   = document.getElementById('detail-canvas') as HTMLCanvasElement
  const info = document.getElementById('detail-info')!
  const ctx: RenderContext = {
    animFrame:         storeRefs.animFrame,
    palAnimFrame:      storeRefs.palAnimFrame,
    pSwitchActive:     storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette:           map.palette,
    camera:            storeRefs.camera,
    zoom:              storeRefs.zoom,
    layerToggles:      storeRefs.layerToggles,
  }

  if (selectedDetail.type === 'vram' && chars) {
    dc.width = 8
    dc.height = 8
    const charNum = selectedDetail.page * VRAM_TILES_PER_PAGE
                  + selectedDetail.row * 16 + selectedDetail.col
    const char = chars.get(charNum)
    const slot = charNum < 0x80 ? 'FG1'
               : charNum < 0x100 ? 'FG2'
               : charNum < 0x180 ? 'FG3'
               : charNum < 0x200 ? 'AN1'
               : charNum < 0x400 ? '—'
               : 'SP'
    info.innerHTML = `<b>8×8 char $${charNum.toString(16).padStart(3,'0')}</b><br>slot: ${slot}`
    const dctx = dc.getContext('2d')!
    if (!char) { dctx.clearRect(0, 0, 8, 8); return }
    const pixels = char.getPixels(ctx)
    // Palette-row convention matches VRAM viewer: $000-$17F → row 2
    // (FG terrain), $180-$2FF → row 6 (AN / sprite-slot), $300+ → row 8.
    const palRowIdx = charNum < 0x180 ? 2 : charNum < 0x300 ? 6 : 8
    const paletteRow = map.palette.row(palRowIdx, ctx)
    const buf = new Uint8ClampedArray(8 * 8 * 4)
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const idx = pixels[py * 8 + px] ?? 0
        if (idx === 0) continue
        const col = paletteRow[idx]
        if (!col) continue
        const di = (py * 8 + px) * 4
        buf[di]     = col[0]
        buf[di + 1] = col[1]
        buf[di + 2] = col[2]
        buf[di + 3] = 255
      }
    }
    dctx.putImageData(new ImageData(buf, 8, 8), 0, 0)
    return
  }

  if (selectedDetail.type === 'map16' && l1Tiles && map16Pages[selectedDetail.page]) {
    const entry = map16Pages[selectedDetail.page]
    const isL1 = entry.label.startsWith('L1')
    const tileSource = isL1 ? l1Tiles : (bgTiles ?? new Map())
    const localTile = selectedDetail.row * 16 + selectedDetail.col
    const tileId = entry.pageInAtlas * 256 + localTile
    info.innerHTML = `<b>Map16 tile $${tileId.toString(16).padStart(3,'0')}</b>`
    dc.width = 16
    dc.height = 16
    const target = new CanvasRenderTarget(dc)
    target.clear()
    const tile = tileSource.get(tileId)
    if (tile) {
      const cellBox = cellBoxOf(0, 0)
      tile.render(ctx, target, cellBox, 'nonPriority')
      tile.render(ctx, target, cellBox, 'priority')
    }
    target.flush()
  }
}

// ── Tile viewer hover highlight ───────────────────────────────────────────────
let vramHoverTile: { col: number; row: number } | null = null
let map16HoverTile: { col: number; row: number } | null = null

// ── Tile viewer grid toggles ─────────────────────────────────────────────────
let vramGridOn = false
let map16GridOn = false
let palGridOn = false
let mapGridOn = false
let minimapOn = true
document.getElementById('btn-vram-grid')!.addEventListener('click', () => {
  vramGridOn = !vramGridOn
  document.getElementById('btn-vram-grid')!.style.color = vramGridOn ? '#5b9cf6' : '#ccc'
  renderVramPage()
})
document.getElementById('btn-map16-grid')!.addEventListener('click', () => {
  map16GridOn = !map16GridOn
  document.getElementById('btn-map16-grid')!.style.color = map16GridOn ? '#5b9cf6' : '#ccc'
  renderMap16Page()
})
document.getElementById('btn-pal-grid')!.addEventListener('click', () => {
  palGridOn = !palGridOn
  document.getElementById('btn-pal-grid')!.style.color = palGridOn ? '#5b9cf6' : '#ccc'
  drawPaletteCanvas()
})
document.getElementById('btn-map-grid')!.addEventListener('click', () => {
  mapGridOn = !mapGridOn
  store.setLayerToggle('mapGrid', mapGridOn)
  document.getElementById('btn-map-grid')!.style.color = mapGridOn ? '#5b9cf6' : '#ccc'
})
document.getElementById('btn-map-minimap')!.addEventListener('click', () => {
  minimapOn = !minimapOn
  document.getElementById('btn-map-minimap')!.style.color = minimapOn ? '#5b9cf6' : '#ccc'
  const wrap = document.getElementById('minimap-wrap')!
  wrap.style.display = minimapOn ? 'flex' : 'none'
  if (minimapOn) drawMinimap()
})
// Sync each button's initial tint with its default state.
{
  const grid = document.getElementById('btn-map-grid')
  if (grid) grid.style.color = mapGridOn ? '#5b9cf6' : '#ccc'
  const mini = document.getElementById('btn-map-minimap')
  if (mini) mini.style.color = minimapOn ? '#5b9cf6' : '#ccc'
}

// ── Animation ────────────────────────────────────────────────────────────────
// Animation drives `store.animFrame` (tile-animation timer) and
// `store.palAnimFrame` (palette-cycle timer). Every model behavior that
// cares reads these through the RenderContext refs, so the reactive
// render effect re-runs only the cells whose input actually changed.
//
// Driven by requestAnimationFrame rather than setInterval so that hidden or
// backgrounded webviews stop ticking automatically (Chromium throttles rAF to
// 0 Hz in hidden iframes, but leaves setInterval running at ≥1 Hz — which
// produced the main-thread contention the user saw when rapid preview-tab
// cycling left zombie webviews alive).
let animRunning = false
let animRafId: number | null = null
let animLastTickMs = 0
let animIntervalMs = 133
let animFrameCount = 1

let palAnimRafId: number | null = null
let palAnimLastTickMs = 0
let palAnimIntervalMs = 133
let palAnimRunning = false

function applyAnimFrame(f: number): void {
  // Dispatch to the store. AnimatedPixels chars read ctx.animFrame.value
  // and their per-char caches invalidate only when their frame actually
  // moves, so swapping the frame ref re-renders only the animated chars.
  store.setAnimFrame(f)
}

function applyPalAnimFrame(f: number): void {
  // Dispatch to the store. CyclingColor cells read ctx.palAnimFrame.value
  // — each cell's computed invalidates only when its frame actually moves,
  // so the whole palette doesn't rebuild on every tick.
  store.setPalAnimFrame(f)
}

function syncPalAnimButton(): void {
  const btn = document.getElementById('btn-pal-play')
  if (btn) btn.innerHTML = palAnimRunning ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'
}

function palAnimTick(now: number): void {
  if (!palAnimRunning) return
  if (now - palAnimLastTickMs >= palAnimIntervalMs) {
    const frameCount = mapData?.paletteAnimation?.frameCount ?? 8
    applyPalAnimFrame((store.palAnimFrame + 1) % frameCount)
    palAnimLastTickMs = now
  }
  palAnimRafId = requestAnimationFrame(palAnimTick)
}

function startPalAnimTimer(): void {
  if (palAnimRafId !== null) { cancelAnimationFrame(palAnimRafId); palAnimRafId = null }
  if (!mapData?.paletteAnimation) return
  palAnimRunning = true
  palAnimIntervalMs = mapData.paletteAnimation.intervalMs
  palAnimLastTickMs = performance.now()
  syncPalAnimButton()
  palAnimRafId = requestAnimationFrame(palAnimTick)
}

function stopPalAnimTimer(): void {
  if (palAnimRafId !== null) { cancelAnimationFrame(palAnimRafId); palAnimRafId = null }
  palAnimRunning = false
  syncPalAnimButton()
}

function togglePalAnim(): void {
  if (palAnimRunning) stopPalAnimTimer()
  else startPalAnimTimer()
}

document.getElementById('btn-pal-play')!.addEventListener('click', togglePalAnim)

const animPlayBtns = [
  document.getElementById('btn-anim')!,
  document.getElementById('btn-anim2')!,
  document.getElementById('btn-anim3')!,
]

function syncAnimButtons(): void {
  for (const btn of animPlayBtns) {
    btn.innerHTML = animRunning ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'
    btn.title = animRunning ? 'Pause animation' : 'Play animation'
    btn.style.color = animRunning ? '#5b9cf6' : '#ccc'
  }
}

function toggleAnim(): void {
  if (animFrameCount <= 1) return
  animRunning = !animRunning
  syncAnimButtons()
  if (animRunning) startAnimTimer()
  else stopAnimTimer()
}

for (const btn of animPlayBtns) btn.addEventListener('click', toggleAnim)

function animTick(now: number): void {
  if (!animRunning) return
  if (now - animLastTickMs >= animIntervalMs) {
    // Compute from store (single source of truth); applyAnimFrame handles
    // both the dispatch and the legacy-mirror update.
    applyAnimFrame((store.animFrame + 1) % animFrameCount)
    animLastTickMs = now
  }
  animRafId = requestAnimationFrame(animTick)
}

function startAnimTimer(): void {
  if (animRafId !== null) { cancelAnimationFrame(animRafId); animRafId = null }
  applyAnimFrame(0)
  animLastTickMs = performance.now()
  animRafId = requestAnimationFrame(animTick)
}

function stopAnimTimer(): void {
  if (animRafId !== null) { cancelAnimationFrame(animRafId); animRafId = null }
  applyAnimFrame(0)
}

// ── Tile panel page navigation ───────────────────────────────────────────────
// VRAM pages: 256 tiles per page (16×16 grid = 128×128px), matching Mesen/LM.
// Page count derived from data height, not hardcoded.
const VRAM_TILES_PER_PAGE = 256
let vramPage = 0
let vramTotalPages = 0

function renderVramPage(): void {
  renderVramPageFromModel()
}

document.getElementById('vram-prev')!.addEventListener('click', () => {
  if (vramTotalPages > 0) { vramPage = (vramPage - 1 + vramTotalPages) % vramTotalPages; renderVramPage() }
})
document.getElementById('vram-next')!.addEventListener('click', () => {
  if (vramTotalPages > 0) { vramPage = (vramPage + 1) % vramTotalPages; renderVramPage() }
})

/**
 * Render the current VRAM page from the self-rendering model. Each
 * char on the page gets its pixels via `Char.getPixels(ctx)` — so
 * AnimatedPixels / PSwitchAlternate / etc. all reflect current
 * state automatically. Palette row selection mirrors the legacy
 * convention: $000-$17F → row 2 (FG), $180-$2FF → row 6 (AN/BG),
 * $300+ → row 8 (sprite).
 */
function renderVramPageFromModel(): void {
  const map = window.__smwModelMap
  const chars = window.__smwModelChars
  const vc = document.getElementById('vram-canvas') as HTMLCanvasElement
  const vctx = vc.getContext('2d')!
  const tilesPerRow = 16
  const rowsPerPage = VRAM_TILES_PER_PAGE / tilesPerRow // 16
  vc.width = tilesPerRow * 8
  vc.height = rowsPerPage * 8

  if (!map || !chars) {
    vctx.clearRect(0, 0, vc.width, vc.height)
    return
  }

  const palette = map.palette
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }

  const sw = vc.width
  const sh = vc.height
  const buf = new Uint8ClampedArray(sw * sh * 4)
  const firstCharNum = vramPage * VRAM_TILES_PER_PAGE

  for (let ti = 0; ti < VRAM_TILES_PER_PAGE; ti++) {
    const charNum = firstCharNum + ti
    const char = chars.get(charNum)
    // Char/palette-row convention from legacy rebuildVramSheet:
    //   $000-$17F → palette row 2 (FG terrain)
    //   $180-$2FF → palette row 6 (AN / sprite-slot; FlashingColors writes here)
    //   $300+     → palette row 8 (sprite)
    const palRowIdx = charNum < 0x180 ? 2 : charNum < 0x300 ? 6 : 8
    const paletteRow = palette.row(palRowIdx, ctx)

    const tileCol = ti % tilesPerRow
    const tileRow = Math.floor(ti / tilesPerRow)
    const dx0 = tileCol * 8
    const dy0 = tileRow * 8

    if (!char) continue // unmapped slot → leave transparent
    const pixels = char.getPixels(ctx)
    if (!pixels) continue
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const palIdx = pixels[py * 8 + px] ?? 0
        if (palIdx === 0) continue
        const col = paletteRow[palIdx]
        if (!col) continue
        const di = ((dy0 + py) * sw + (dx0 + px)) * 4
        buf[di] = col[0]
        buf[di + 1] = col[1]
        buf[di + 2] = col[2]
        buf[di + 3] = 255
      }
    }
  }

  vctx.putImageData(new ImageData(buf, sw, sh), 0, 0)

  if (vramGridOn) {
    vctx.strokeStyle = 'rgba(0,0,0,0.5)'
    vctx.lineWidth = 0.5
    for (let x = 0; x <= vc.width; x += 8) { vctx.beginPath(); vctx.moveTo(x, 0); vctx.lineTo(x, vc.height); vctx.stroke() }
    for (let y = 0; y <= vc.height; y += 8) { vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(vc.width, y); vctx.stroke() }
  }

  // Hover: dim everything, un-dim just the hovered tile. Same visual
  // convention the legacy render uses so the two paths feel identical.
  if (vramHoverTile) {
    vctx.fillStyle = 'rgba(0,0,0,0.55)'
    vctx.fillRect(0, 0, vc.width, vc.height)
    const hx = vramHoverTile.col * 8
    const hy = vramHoverTile.row * 8
    vctx.clearRect(hx, hy, 8, 8)
    const tileSlice = new Uint8ClampedArray(8 * 8 * 4)
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const si = ((hy + py) * sw + (hx + px)) * 4
        const di = (py * 8 + px) * 4
        tileSlice[di]     = buf[si]
        tileSlice[di + 1] = buf[si + 1]
        tileSlice[di + 2] = buf[si + 2]
        tileSlice[di + 3] = buf[si + 3]
      }
    }
    vctx.putImageData(new ImageData(tileSlice, 8, 8), hx, hy)
  }

  // Selected tile: yellow outline when the selection is on this page.
  if (selectedDetail?.type === 'vram' && selectedDetail.page === vramPage) {
    vctx.strokeStyle = '#ffcf5b'
    vctx.lineWidth = 1
    vctx.strokeRect(selectedDetail.col * 8 + 0.5, selectedDetail.row * 8 + 0.5, 7, 7)
  }

  const lbl = document.getElementById('vram-page-label')!
  lbl.textContent = `Page ${vramPage + 1} / ${vramTotalPages}`
}

// ── Map16 model render ───────────────────────────────────────────────────────

/**
 * Render the current Map16 page using the self-rendering model.
 * Each tile's `render()` drives SubTile → Char → pixel lookup through
 * the model graph, so animated / switch-palace / pipe-variant behaviors
 * all reflect the current reactive state automatically.
 */
function renderMap16PageFromModel(): void {
  const mc = document.getElementById('map16-canvas') as HTMLCanvasElement | null
  if (!mc) return
  const map = window.__smwModelMap
  const l1Tiles = window.__smwModelTiles
  const bgTiles = window.__smwModelBgTiles
  if (!map || !l1Tiles) {
    mc.getContext('2d')?.clearRect(0, 0, mc.width, mc.height)
    return
  }

  mc.width = 256
  mc.height = 256
  const target = new CanvasRenderTarget(mc)
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette: map.palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }

  target.clear()

  if (map16Pages.length > 0) {
    const entry = map16Pages[map16PageIdx]
    const isL1 = entry.label.startsWith('L1')
    const tileSource = isL1 ? l1Tiles : (bgTiles ?? new Map())
    const startId = entry.pageInAtlas * 256
    for (let i = 0; i < 256; i++) {
      const tile = tileSource.get(startId + i)
      if (!tile) continue
      const col = i % 16
      const row = Math.floor(i / 16)
      const cellBox = cellBoxOf(col, row)
      tile.render(ctx, target, cellBox, 'nonPriority')
      tile.render(ctx, target, cellBox, 'priority')
    }
  }

  target.flush()

  const mctx = mc.getContext('2d')!
  if (map16GridOn) {
    mctx.strokeStyle = 'rgba(0,0,0,0.5)'
    mctx.lineWidth = 0.5
    for (let x = 0; x <= 256; x += 16) { mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, 256); mctx.stroke() }
    for (let y = 0; y <= 256; y += 16) { mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(256, y); mctx.stroke() }
  }
  // Hover: dim everything, un-dim just the hovered tile. Snapshot the
  // rendered canvas first so we can restore the hovered 16×16 slice
  // without re-running the whole render pass.
  if (map16HoverTile) {
    const fullSnap = mctx.getImageData(0, 0, 256, 256)
    mctx.fillStyle = 'rgba(0,0,0,0.55)'
    mctx.fillRect(0, 0, 256, 256)
    const hx = map16HoverTile.col * 16
    const hy = map16HoverTile.row * 16
    mctx.clearRect(hx, hy, 16, 16)
    const tileSlice = new Uint8ClampedArray(16 * 16 * 4)
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const si = ((hy + py) * 256 + (hx + px)) * 4
        const di = (py * 16 + px) * 4
        tileSlice[di]     = fullSnap.data[si]
        tileSlice[di + 1] = fullSnap.data[si + 1]
        tileSlice[di + 2] = fullSnap.data[si + 2]
        tileSlice[di + 3] = fullSnap.data[si + 3]
      }
    }
    mctx.putImageData(new ImageData(tileSlice, 16, 16), hx, hy)
  }

  // Selected tile: yellow outline when the selection is on this page.
  if (selectedDetail?.type === 'map16' && selectedDetail.page === map16PageIdx) {
    mctx.strokeStyle = '#ffcf5b'
    mctx.lineWidth = 1
    mctx.strokeRect(selectedDetail.col * 16 + 0.5, selectedDetail.row * 16 + 0.5, 15, 15)
  }

  const lbl2 = document.getElementById('map16-page-label')
  if (lbl2) lbl2.textContent = `Page ${map16PageIdx + 1} / ${map16Pages.length}`
}

// MAP16 page viewer — pages derived from L1 / L2 Map16 table sizes.
// Each entry labels a page and carries its index within its table; the
// renderer asks the model for tiles at those indices.
interface Map16PageEntry { pageInAtlas: number; label: string }
let map16Pages: Map16PageEntry[] = []
let map16PageIdx = 0

function renderMap16Page(): void {
  renderMap16PageFromModel()
}

document.getElementById('map16-prev')!.addEventListener('click', () => {
  if (map16Pages.length > 0) { map16PageIdx = (map16PageIdx - 1 + map16Pages.length) % map16Pages.length; renderMap16Page() }
})
document.getElementById('map16-next')!.addEventListener('click', () => {
  if (map16Pages.length > 0) { map16PageIdx = (map16PageIdx + 1) % map16Pages.length; renderMap16Page() }
})

// Props panel
const palCanvas      = document.getElementById('palette-canvas')  as HTMLCanvasElement
const palCtx         = palCanvas.getContext('2d')!
const palInspect     = document.getElementById('palette-inspect')!
const backAreaSwatch = document.getElementById('back-area-swatch')!
const selBgColor     = document.getElementById('sel-bg-color')     as HTMLSelectElement
const selFgPalette   = document.getElementById('sel-fg-palette')   as HTMLSelectElement
const selBgPalette   = document.getElementById('sel-bg-palette')   as HTMLSelectElement
const selSpritePal   = document.getElementById('sel-sprite-palette') as HTMLSelectElement
const selMarioPal    = document.getElementById('sel-mario-palette') as HTMLSelectElement
const selTileset     = document.getElementById('sel-tileset')      as HTMLSelectElement
const selSpriteSet   = document.getElementById('sel-sprite-set')   as HTMLSelectElement
const infoScreens    = document.getElementById('info-screens')!
const infoSprites    = document.getElementById('info-sprites')!
const infoBgVScroll  = document.getElementById('info-bg-vscroll')!
const infoBgHScroll  = document.getElementById('info-bg-hscroll')!

// ── State ────────────────────────────────────────────────────────────────────

let zoomIdx      = ZOOM_DEFAULT_IDX
let mapData: MapPayload | null = null
const activeTileId = -1
let activeTool: 'place' | 'erase' = 'place'
let isPainting   = false
// Which CGRAM cells to highlight in the palette panel (null = all at full brightness)
// Each entry: { row, colStart, colEnd } — highlights cols colStart..colEnd (inclusive)
interface PaletteHighlight { row: number; colStart: number; colEnd: number }
let paletteHighlightCells: PaletteHighlight[] | null = null

interface MapPayload {
  mapIndex:      number
  screens:         number
  /** True if Layer 1 is vertical (ScreenMode bit 0 via VerticalTable). */
  isVertical?:     boolean
  tileGrid:        number[][]
  sprites:         Array<{ x: number; y: number; spriteId: number }>
  backAreaColor:   [number, number, number, number]
  backAreaColors:  number[][]   // 8 variants × [r,g,b,a]
  /** Count of L1 Map16 tiles — used to page the Map16 panel. */
  map16DefCount?:  number
  /** Count of L2 Map16 tiles — used to add L2 pages when > 0. */
  map16BgDefCount?: number
  animation?: {
    frameCount: number
    intervalMs: number
  }
  /** Palette animation timing only — the model drives actual cycling. */
  paletteAnimation?: {
    frameCount: number
    intervalMs: number
  } | null
  header: {
    music:          number
    spriteSet:      number
    bgPalette:      number
    fgPalette:      number
    bgColor:        number
    spritePalette:  number
    marioVariant:   number
    gfxTilesetId:   number
    // VertLayer2Setting / HorizLayer2Setting (0..3) looked up from the
    // per-level scroll byte. Drives the BG parallax ratio: 0=locked, 1=1:1,
    // 2=1/2, 3=1/32. See MapEditorProvider comment at the lookup site.
    vertLayer2Setting:  number
    horizLayer2Setting: number
  }
}

// ── Level-dimension helpers ──────────────────────────────────────────────────
// In vertical levels the grid shape flips: 32 cols × (screens*16) rows instead
// of (screens*16) cols × 27 rows. `SCREEN_H` (27) is the horizontal-only tall,
// `SCREEN_H_VERT` (16) is a vertical-level screen's row count.
const SCREEN_H_VERT = 16
const SCREEN_W_VERT = 32

function isVert(): boolean {
  return mapData?.isVertical === true
}
function levelCols(): number {
  if (!mapData) return 0
  return isVert() ? SCREEN_W_VERT : mapData.screens * SCREEN_W
}
function levelRows(): number {
  if (!mapData) return 0
  return isVert() ? mapData.screens * SCREEN_H_VERT : SCREEN_H
}
// ── Zoom ─────────────────────────────────────────────────────────────────────

/** Browser canvas dimension cap. Chrome and Firefox limit canvases to 16384
 *  pixels per side; beyond that, the canvas silently fails or allocations
 *  thrash the webview. Stay well under that. */
const MAX_CANVAS_PX = 16000

/** Highest zoom index whose resulting canvas still fits under MAX_CANVAS_PX.
 *  Depends on level width (screens × 16 tiles). Recomputed per level load. */
function maxZoomIdx(): number {
  if (!mapData) return ZOOM_STEPS.length - 1
  const cols = levelCols()
  const rows = levelRows()
  let limit = ZOOM_STEPS.length - 1
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const px = TILE_PX * ZOOM_STEPS[i]
    if (cols * px <= MAX_CANVAS_PX && rows * px <= MAX_CANVAS_PX) {
      limit = i
      break
    }
    limit = i - 1
  }
  return Math.max(0, limit)
}

function applyZoom(): void {
  // Clamp to whatever the current level can actually fit on-screen.
  const cap = maxZoomIdx()
  if (zoomIdx > cap) zoomIdx = cap
  const z = ZOOM_STEPS[zoomIdx]
  store.setZoom(z)  // reactive — triggers renderModelOverlay with the new zoom
  zoomLabel.textContent = `${z}×`
}

document.getElementById('zoom-in')!.addEventListener('click', () => {
  if (zoomIdx < maxZoomIdx()) { zoomIdx++; applyZoom() }
})
document.getElementById('zoom-out')!.addEventListener('click', () => {
  if (zoomIdx > 0) { zoomIdx--; applyZoom() }
})
canvasWrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  const next = zoomIdx + (e.deltaY < 0 ? 1 : -1)
  if (next >= 0 && next <= maxZoomIdx()) { zoomIdx = next; applyZoom() }
}, { passive: false })

// ── Palette canvas ────────────────────────────────────────────────────────────

function drawPaletteCanvas(): void {
  drawPaletteFromModel()
}

/**
 * Render the palette panel from the self-rendering model's Palette.
 * Reads each cell via its ColorBehavior (static or CyclingColor) so
 * palette animation is naturally driven by `ctx.palAnimFrame` — no
 * separate tick logic needed. Falls back to the legacy path if the
 * model hasn't arrived yet.
 */
function drawPaletteFromModel(): void {
  const map = window.__smwModelMap
  if (!map) {
    // Model not yet rehydrated — clear to transparent so the panel
    // doesn't keep showing stale legacy content.
    palCtx.clearRect(0, 0, 128, 128)
    return
  }
  const palette = map.palette
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }

  palCtx.clearRect(0, 0, 128, 128)

  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      const cell = palette.cells[row]?.[col]
      if (!cell) continue
      const c = cell.rgba(ctx)
      const x = col * PAL_CELL
      const y = row * PAL_CELL
      if (c[3] < 255) {
        palCtx.fillStyle = (col + row) % 2 === 0 ? '#666' : '#444'
        palCtx.fillRect(x, y, PAL_CELL, PAL_CELL)
      }
      if (c[3] > 0) {
        palCtx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`
        palCtx.fillRect(x, y, PAL_CELL, PAL_CELL)
      }
    }
  }

  if (paletteHighlightCells !== null) {
    palCtx.fillStyle = 'rgba(0,0,0,0.65)'
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const isHighlighted = paletteHighlightCells.some(
          h => h.row === row && col >= h.colStart && col <= h.colEnd,
        )
        if (!isHighlighted) {
          palCtx.fillRect(col * PAL_CELL, row * PAL_CELL, PAL_CELL, PAL_CELL)
        }
      }
    }
  }

  if (palGridOn) {
    palCtx.strokeStyle = 'rgba(0,0,0,0.5)'
    palCtx.lineWidth = 0.5
    for (let x = 0; x <= 128; x += PAL_CELL) {
      palCtx.beginPath(); palCtx.moveTo(x, 0); palCtx.lineTo(x, 128); palCtx.stroke()
    }
    for (let y = 0; y <= 128; y += PAL_CELL) {
      palCtx.beginPath(); palCtx.moveTo(0, y); palCtx.lineTo(128, y); palCtx.stroke()
    }
  }
}

palCanvas.addEventListener('mousemove', (e) => {
  const map = window.__smwModelMap
  if (!map) return
  const rect = palCanvas.getBoundingClientRect()
  const scaleX = 128 / rect.width
  const col = Math.floor((e.clientX - rect.left) * scaleX / PAL_CELL)
  const row = Math.floor((e.clientY - rect.top)  * scaleX / PAL_CELL)
  if (col < 0 || col > 15 || row < 0 || row > 15) return
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette: map.palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }
  const cell = map.palette.cells[row]?.[col]
  const c = cell ? cell.rgba(ctx) : [0, 0, 0, 0]
  const hex = `#${c[0].toString(16).padStart(2,'0')}${c[1].toString(16).padStart(2,'0')}${c[2].toString(16).padStart(2,'0')}`
  palInspect.textContent = `row ${row}  col ${col}  ${hex}`
})
palCanvas.addEventListener('mouseleave', () => {
  palInspect.textContent = 'hover to inspect'
})

// ── Rendering ─────────────────────────────────────────────────────────────────

function tileBlockColor(tileId: number): string {
  const r = (tileId & 0x1F) << 3
  const g = ((tileId >> 5) & 0xF) << 4
  const b = Math.round((tileId / 0x1FF) * 180) + 40
  return `rgb(${r},${g},${b})`
}

/** True if the given canvas pixel (x,y) lies inside the camera rect. */
function hitCameraRect(canvasX: number, canvasY: number): boolean {
  if (!chkCamera.checked || !mapData) return false
  const px = TILE_PX * store.zoom
  const cam = store.camera
  const rx = cam.tileX * px
  const ry = cam.tileY * px
  const rw = CAMERA_W_TILES * px
  const rh = CAMERA_H_TILES * px
  return canvasX >= rx && canvasX < rx + rw && canvasY >= ry && canvasY < ry + rh
}

/** Scroll the map container so the camera rect stays fully visible. */
function scrollContainerToCamera(): void {
  const px = TILE_PX * store.zoom
  const cam = store.camera
  const rx = cam.tileX * px
  const ry = cam.tileY * px
  const rw = CAMERA_W_TILES * px
  const rh = CAMERA_H_TILES * px
  const wrap = canvasWrap
  const marginX = Math.max(0, (wrap.clientWidth  - rw) / 2)
  const marginY = Math.max(0, (wrap.clientHeight - rh) / 2)
  wrap.scrollLeft = Math.max(0, rx - marginX)
  wrap.scrollTop  = Math.max(0, ry - marginY)
}

// ── Minimap ──────────────────────────────────────────────────────────────────
// Small overview rendering of the full map. Horizontal levels pin it to the
// bottom as a short strip; vertical levels pin it to the right as a narrow
// column so the aspect ratio matches the level shape.

/**
 * Toggle the main-view flex direction and minimap-wrap border/padding based on
 * level orientation. Called once per load so the layout matches the level shape:
 *   horizontal → main-view column + minimap below
 *   vertical   → main-view row + minimap to the right
 */
function applyMinimapOrientation(): void {
  const mainView = document.getElementById('main-view')
  const minimapWrap = document.getElementById('minimap-wrap')
  if (!mainView || !minimapWrap) return
  if (isVert()) {
    mainView.style.flexDirection = 'row'
    minimapWrap.style.borderTop = 'none'
    minimapWrap.style.borderLeft = '1px solid #3a3a3a'
    minimapWrap.style.padding = '8px 4px'
  } else {
    mainView.style.flexDirection = 'column'
    minimapWrap.style.borderLeft = 'none'
    minimapWrap.style.borderTop = '1px solid #3a3a3a'
    minimapWrap.style.padding = '4px 8px'
  }
}

/** Short-axis cap for the minimap (height when bottom, width when right). */
const MINIMAP_SHORT_AXIS_MAX = 54
/** Long-axis cap: fraction of the available parent extent we're willing to use. */
const MINIMAP_LONG_AXIS_SLACK_PX = 16

function minimapTilePx(): number {
  if (!mapData) return 1
  const cols = levelCols()
  const rows = levelRows()
  const vert = isVert()
  // Pick the largest tile size (1–4 px) that keeps the minimap within the
  // available space along both axes. In vertical mode, the long axis is the
  // parent's height and the short axis is the width, and vice versa.
  const parent = minimapCanvas.parentElement!
  const availLong = Math.max(100, (vert ? parent.clientHeight : parent.clientWidth) - MINIMAP_LONG_AXIS_SLACK_PX)
  const longTiles = vert ? rows : cols
  const shortTiles = vert ? cols : rows
  const byLong = Math.floor(availLong / longTiles)
  const byShort = Math.floor(MINIMAP_SHORT_AXIS_MAX / shortTiles)
  return Math.max(1, Math.min(4, byLong, byShort))
}

function drawMinimap(): void {
  if (!minimapOn) return
  // Use the already-rendered model canvas as the source. Everything
  // model-correct — pipe-variant palettes, P-switch reveals, animated
  // tiles, switch-palace alt — carries through for free because the
  // source was produced by the same `tile.render` chain that draws the
  // main viewport. No per-tile re-render needed here.
  const src = document.getElementById('model-canvas') as HTMLCanvasElement | null
  if (!src || src.width === 0 || src.height === 0) return
  const cols = levelCols()
  const rows = levelRows()
  const tp = minimapTilePx()
  const w = cols * tp
  const h = rows * tp

  if (minimapCanvas.width !== w || minimapCanvas.height !== h) {
    minimapCanvas.width = w
    minimapCanvas.height = h
  }

  // Smooth downsample — at 1–4 px per tile each source 16×16 tile gets
  // averaged to a single color-ish blob, which reads better as a
  // thumbnail than hard nearest-neighbor picks.
  minimapCtx.imageSmoothingEnabled = true
  minimapCtx.clearRect(0, 0, w, h)
  minimapCtx.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h)

  drawMinimapViewport()
}

/** Repaint just the viewport rectangle (fast path for scroll events). */
function drawMinimapViewport(): void {
  if (!mapData) return
  const cols = levelCols()
  const rows = levelRows()
  const mainPx = TILE_PX * store.zoom
  const mainW = cols * mainPx
  const mainH = rows * mainPx
  if (mainW === 0 || mainH === 0) return

  const mmW = minimapCanvas.width
  const mmH = minimapCanvas.height
  const vx = Math.round((canvasWrap.scrollLeft / mainW) * mmW)
  const vy = Math.round((canvasWrap.scrollTop  / mainH) * mmH)
  // clientWidth/clientHeight minus canvas margins (8px on each side)
  const vw = Math.max(1, Math.round((canvasWrap.clientWidth  / mainW) * mmW))
  const vh = Math.max(1, Math.round((canvasWrap.clientHeight / mainH) * mmH))

  minimapCtx.strokeStyle = 'rgba(255,220,80,0.9)'
  minimapCtx.lineWidth = 1
  minimapCtx.strokeRect(vx + 0.5, vy + 0.5, Math.min(vw, mmW - vx) - 1, Math.min(vh, mmH - vy) - 1)
  minimapCtx.fillStyle = 'rgba(255,220,80,0.12)'
  minimapCtx.fillRect(vx, vy, Math.min(vw, mmW - vx), Math.min(vh, mmH - vy))
}

// Click-to-center and drag-to-pan. Pointer capture keeps the drag live even
// when the cursor strays outside the minimap rectangle.
let minimapDragging = false
function minimapPanTo(e: PointerEvent): void {
  if (!mapData) return
  const rect = minimapCanvas.getBoundingClientRect()
  const cols = levelCols()
  const rows = levelRows()
  const mainPx = TILE_PX * store.zoom
  const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const fy = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height))
  canvasWrap.scrollLeft = fx * cols * mainPx - canvasWrap.clientWidth  / 2
  canvasWrap.scrollTop  = fy * rows * mainPx - canvasWrap.clientHeight / 2
  // If the camera viewport is on, pull it along to the new center so
  // the preview stays on-screen after the pan. Center of visible area
  // in tile-coords minus half the camera window gives the new top-left.
  if (store.cameraOn) {
    const centerX = fx * cols
    const centerY = fy * rows
    const nextX = Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES),
      centerX - CAMERA_W_TILES / 2))
    const nextY = Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES),
      centerY - CAMERA_H_TILES / 2))
    store.setCamera({ tileX: nextX, tileY: nextY, focused: store.camera.focused })
  }
}
minimapCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  minimapDragging = true
  minimapCanvas.setPointerCapture(e.pointerId)
  minimapPanTo(e)
})
minimapCanvas.addEventListener('pointermove', (e) => {
  if (!minimapDragging) return
  minimapPanTo(e)
})
const endDrag = (e: PointerEvent) => {
  if (!minimapDragging) return
  minimapDragging = false
  minimapCanvas.releasePointerCapture(e.pointerId)
}
minimapCanvas.addEventListener('pointerup',     endDrag)
minimapCanvas.addEventListener('pointercancel', endDrag)

// Viewport rectangle follows main-view scrolling.
canvasWrap.addEventListener('scroll', () => {
  drawMinimap()  // cheapest reliable option; tile blits are tiny
})

// Keep the minimap sized to the available width as the window/panel resizes.
new ResizeObserver(() => drawMinimap()).observe(minimapCanvas.parentElement!)

function syncLayerTogglesFromDom(): void {
  store.setLayerToggles({
    l1:      chkL1.checked,
    l2:      chkL2.checked,
    sprites: chkSprites.checked,
    screens: chkScreens.checked,
    block:   chkBlock.checked,
    mapGrid: mapGridOn,
  })
}
chkScreens.addEventListener('change', syncLayerTogglesFromDom)
chkSprites.addEventListener('change', syncLayerTogglesFromDom)
chkBlock.addEventListener('change',   syncLayerTogglesFromDom)
chkL1.addEventListener('change',      syncLayerTogglesFromDom)
chkL2.addEventListener('change',      syncLayerTogglesFromDom)
chkCamera.addEventListener('change',  () => {
  const on = chkCamera.checked
  store.setCameraOn(on)  // reactive — triggers renderModelOverlay
  if (on) {
    scrollContainerToCamera()
  } else {
    const cam = store.camera
    if (cam.focused) store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: false })
  }
})

// ── Camera rectangle drag + focus ────────────────────────────────────────────
// Click inside the rect: focus camera, start drag. Click outside: blur camera.
// Cursor switches to grab/grabbing when hovering/dragging the rect.
//
// Coords come from the visible modelCanvas. Its bounding rect covers the
// CSS-scaled display, so a `pxPerTile = rect.width / levelCols()` ratio
// works at any zoom without reading the zoom ref directly.
modelCanvas.addEventListener('pointerdown', (e) => {
  if (!chkCamera.checked || e.button !== 0) return
  const rect = modelCanvas.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  const cam = store.camera
  if (hitCameraRect(cx, cy)) {
    const pxPerTile = rect.width / Math.max(1, levelCols())
    cameraDragging = true
    cameraDragOffX = cx / pxPerTile - cam.tileX
    cameraDragOffY = cy / pxPerTile - cam.tileY
    store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: true })
    modelCanvas.setPointerCapture(e.pointerId)
    modelCanvas.style.cursor = 'grabbing'
    e.preventDefault()
  } else if (cam.focused) {
    store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: false })
  }
})

modelCanvas.addEventListener('pointermove', (e) => {
  const rect = modelCanvas.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top

  if (cameraDragging) {
    const pxPerTile = rect.width / Math.max(1, levelCols())
    const cols = levelCols()
    const rows = levelRows()
    // No rounding — keep the drag in fractional-tile space so the rect
    // glides pixel-smooth with the cursor. The strip floors this value
    // internally so its parallax content stays tile-aligned.
    const nextX = Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES),
      cx / pxPerTile - cameraDragOffX))
    const nextY = Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES),
      cy / pxPerTile - cameraDragOffY))
    // Dispatch to the store so the reactive effect re-runs; the overlay
    // (`compositeCameraViewport`, `drawCameraRectOverlay`) reads
    // `store.camera` and re-renders to the new position.
    store.setCamera({ tileX: nextX, tileY: nextY, focused: true })
    // Keep the viewport near the center of the visible scroll area as
    // the user drags. Without this, the rect can leave the fold and
    // the drag snaps when cursor runs out of canvas.
    scrollContainerToCamera()
    return
  }

  if (chkCamera.checked && hitCameraRect(cx, cy)) {
    modelCanvas.style.cursor = 'grab'
  } else {
    modelCanvas.style.cursor = ''
  }
})

modelCanvas.addEventListener('pointerup', (e) => {
  if (!cameraDragging) return
  cameraDragging = false
  modelCanvas.releasePointerCapture(e.pointerId)
  const rect = modelCanvas.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  modelCanvas.style.cursor = (chkCamera.checked && hitCameraRect(cx, cy)) ? 'grab' : ''
})

// Arrow-key nudge when camera is focused. Shift = 4-tile jumps for faster scan.
window.addEventListener('keydown', (e) => {
  if (!chkCamera.checked || !store.camera.focused) return
  // Don't swallow keys when typing into a form field.
  const tgt = e.target as HTMLElement | null
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return
  const step = e.shiftKey ? 4 : 1
  const cam = store.camera
  let tileX = cam.tileX
  let tileY = cam.tileY
  let focused = cam.focused
  let handled = true
  switch (e.key) {
    case 'ArrowUp':    tileY -= step; break
    case 'ArrowDown':  tileY += step; break
    case 'ArrowLeft':  tileX -= step; break
    case 'ArrowRight': tileX += step; break
    case 'Escape':     focused = false; break
    default: handled = false
  }
  if (handled) {
    e.preventDefault()
    const cols = levelCols()
    const rows = levelRows()
    tileX = Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES), tileX))
    tileY = Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES), tileY))
    store.setCamera({ tileX, tileY, focused })
    scrollContainerToCamera()
  }
})

// ── Switch-palace toggles ─────────────────────────────────────────────────────
// Each button shows the Map16 tile in its current state; clicking flips between
// the uncleared (page 0) and cleared (page 1) variants for that color. Thumb
// renders through the model (Tile → SubTile → Char → pixel) so animation /
// palette cycle / switch-palace-alt behaviors are reflected automatically.

function drawSwitchToggleThumb(colorIdx: number): void {
  const btn = document.querySelector(
    `.switch-toggle[data-color="${colorIdx}"]`) as HTMLButtonElement | null
  if (!btn) return
  const tc = btn.querySelector('canvas') as HTMLCanvasElement | null
  if (!tc) return
  const c = tc.getContext('2d')
  if (!c) return
  c.imageSmoothingEnabled = false
  c.clearRect(0, 0, tc.width, tc.height)
  const map = window.__smwModelMap
  const l1Tiles = window.__smwModelTiles
  if (!map || !l1Tiles) return
  const tileId = (store.switchPalaceState[colorIdx] ? 0x100 : 0x000) | (0x6A + colorIdx)
  const tile = l1Tiles.get(tileId)
  if (!tile) return
  // Render at 16×16 natural, CSS-scale via the canvas's width/height to the
  // button's displayed size.
  tc.width = 16
  tc.height = 16
  const target = new CanvasRenderTarget(tc)
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette: map.palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }
  target.clear()
  const cellBox = cellBoxOf(0, 0)
  tile.render(ctx, target, cellBox, 'nonPriority')
  tile.render(ctx, target, cellBox, 'priority')
  target.flush()
}

function refreshSwitchToggleThumbs(): void {
  for (let i = 0; i < 4; i++) drawSwitchToggleThumb(i)
}

for (let i = 0; i < 4; i++) {
  const btn = document.querySelector(
    `.switch-toggle[data-color="${i}"]`) as HTMLButtonElement | null
  if (!btn) continue
  btn.addEventListener('click', () => {
    store.toggleSwitchPalace(i as 0 | 1 | 2 | 3)
    btn.classList.toggle('switch-on', store.switchPalaceState[i])
    drawSwitchToggleThumb(i)
  })
}

// ── Blue P-switch toggle ─────────────────────────────────────────────────────
// Thumbnail renders the P-switch sprite directly from VRAM (not from Map16),
// since P-switches are sprites and don't appear in the Map16 tile pages.
//   Standing (off): 2×2 of 8×8 chars at $442/$443/$452/$453 in sp1
//   Pressed  (on):  one 8×8 char at $4FE drawn twice, right copy h-flipped
//   Palette: OBJ palette 3 = CGRAM row $0B, from PSwitchPal table (bank_01.asm:681).

/** Draw one 8×8 char from the model into an RGBA buffer at the given offset. */
function blitCharIntoBuf(
  buf: Uint8ClampedArray, dstW: number,
  charNum: number, palRow: ReadonlyArray<readonly [number, number, number, number]>,
  ctx: RenderContext, dstX: number, dstY: number, hFlip: boolean, vFlip = false,
): void {
  const chars = window.__smwModelChars
  if (!chars) return
  const char = chars.get(charNum)
  if (!char) return
  const pixels = char.getPixels(ctx)
  for (let py = 0; py < 8; py++) {
    const sy = vFlip ? 7 - py : py
    for (let px = 0; px < 8; px++) {
      const sx = hFlip ? 7 - px : px
      const palIdx = pixels[sy * 8 + sx] ?? 0
      if (palIdx === 0) continue
      const col = palRow[palIdx]
      if (!col) continue
      const di = ((dstY + py) * dstW + (dstX + px)) * 4
      buf[di]     = col[0]
      buf[di + 1] = col[1]
      buf[di + 2] = col[2]
      buf[di + 3] = 255
    }
  }
}

function drawPSwitchToggleThumb(): void {
  const btn = document.querySelector('.pswitch-toggle[data-pcolor="blue"]') as HTMLButtonElement | null
  if (!btn) return
  const tc = btn.querySelector('canvas') as HTMLCanvasElement | null
  if (!tc) return
  const c = tc.getContext('2d')
  if (!c) return
  c.imageSmoothingEnabled = false
  tc.width = 16
  tc.height = 16
  c.clearRect(0, 0, 16, 16)
  const map = window.__smwModelMap
  if (!map) return
  const ctx: RenderContext = {
    animFrame: storeRefs.animFrame,
    palAnimFrame: storeRefs.palAnimFrame,
    pSwitchActive: storeRefs.pSwitchActive,
    switchPalaceState: storeRefs.switchPalaceState,
    palette: map.palette,
    camera: storeRefs.camera,
    zoom: storeRefs.zoom,
    layerToggles: storeRefs.layerToggles,
  }
  const palRow = map.palette.row(0x0B, ctx) as ReadonlyArray<readonly [number, number, number, number]>
  if (!palRow) return
  const buf = new Uint8ClampedArray(16 * 16 * 4)
  if (store.pSwitchActive) {
    // Pressed: the sprite is 16×8 (chars $4FE + $4FE h-flipped), with
    // the top half empty. Bottom-align so the button sits flush with
    // the "ground" — matches how the pressed P-switch sits in-game.
    blitCharIntoBuf(buf, 16, 0x4FE, palRow, ctx, 0, 8, false)
    blitCharIntoBuf(buf, 16, 0x4FE, palRow, ctx, 8, 8, true)
  } else {
    blitCharIntoBuf(buf, 16, 0x442, palRow, ctx, 0, 0, false)
    blitCharIntoBuf(buf, 16, 0x443, palRow, ctx, 8, 0, false)
    blitCharIntoBuf(buf, 16, 0x452, palRow, ctx, 0, 8, false)
    blitCharIntoBuf(buf, 16, 0x453, palRow, ctx, 8, 8, false)
  }
  c.putImageData(new ImageData(buf, 16, 16), 0, 0)
}

{
  const btn = document.querySelector('.pswitch-toggle[data-pcolor="blue"]') as HTMLButtonElement | null
  if (btn) {
    btn.addEventListener('click', () => {
      store.togglePSwitch()
      btn.classList.toggle('switch-on', store.pSwitchActive)
      drawPSwitchToggleThumb()
    })
  }
}

// ── Mouse / edit interactions ─────────────────────────────────────────────────

function canvasTileAt(e: MouseEvent): { col: number; row: number } | null {
  if (!mapData) return null
  const rect = modelCanvas.getBoundingClientRect()
  const cols = levelCols()
  const rows = levelRows()
  if (rect.width <= 0 || rect.height <= 0 || cols === 0 || rows === 0) return null
  // Compute from the bounding rect directly — works at any zoom since
  // the model canvas is CSS-scaled by the zoom ref.
  const col = Math.floor((e.clientX - rect.left) / (rect.width  / cols))
  const row = Math.floor((e.clientY - rect.top)  / (rect.height / rows))
  if (col < 0 || row < 0 || row >= rows || col >= cols) return null
  return { col, row }
}

function paintAt(e: MouseEvent): void {
  const pos = canvasTileAt(e)
  if (!pos || !mapData) return
  const tileId = activeTool === 'erase' ? 0 : activeTileId
  if (tileId < 0) return
  if (mapData.tileGrid[pos.row][pos.col] === tileId) return
  mapData.tileGrid[pos.row][pos.col] = tileId
  vscode.postMessage({ type: 'edit', kind: activeTool, tileId, col: pos.col, row: pos.row })
}

modelCanvas.addEventListener('mousedown', (e) => { if (e.button !== 0) return; isPainting = true; paintAt(e) })
modelCanvas.addEventListener('mousemove', (e) => {
  const pos = canvasTileAt(e)
  if (pos) {
    const tileId = mapData?.tileGrid[pos.row]?.[pos.col] ?? 0
    stPos.textContent  = `col ${pos.col}  row ${pos.row}`
    stTile.textContent = `tile $${tileId.toString(16).toUpperCase().padStart(3,'0')}`
  }
  if (isPainting) paintAt(e)
})
modelCanvas.addEventListener('mouseup',    () => { isPainting = false })
modelCanvas.addEventListener('mouseleave', () => { isPainting = false })
modelCanvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const prev = activeTool; activeTool = 'erase'; paintAt(e); activeTool = prev
})

modelCanvas.addEventListener('dragover', (e) => { e.preventDefault() })
modelCanvas.addEventListener('drop', (e) => {
  e.preventDefault()
  const tileId = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10)
  if (isNaN(tileId) || !mapData) return
  const pos = canvasTileAt(e)
  if (!pos) return
  mapData.tileGrid[pos.row][pos.col] = tileId
  vscode.postMessage({ type: 'edit', kind: 'place', tileId, col: pos.col, row: pos.row })
})

// ── Properties panel — selectors ──────────────────────────────────────────────

function buildSelect(el: HTMLSelectElement, count: number, value: number, labelFn?: (i: number) => string): void {
  el.innerHTML = ''
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = labelFn ? labelFn(i) : String(i)
    if (i === value) opt.selected = true
    el.appendChild(opt)
  }
}

function postRerender(): void {
  vscode.postMessage({
    type:           'rerender',
    bgVariant:      parseInt(selBgPalette.value),
    fgVariant:      parseInt(selFgPalette.value),
    spriteSet:      parseInt(selSpriteSet.value),
    spritePalette:  parseInt(selSpritePal.value),
    tilesetId:      parseInt(selTileset.value),
    bgColorVariant: parseInt(selBgColor.value),
    marioVariant:   parseInt(selMarioPal.value),
  })
}

function setPaletteHighlight(cells: PaletteHighlight[] | null): void {
  paletteHighlightCells = cells
  drawPaletteCanvas()
}

/** Helper: highlight specific cols of specific rows. */
function highlightRowCols(rows: number[], colStart: number, colEnd: number): PaletteHighlight[] {
  return rows.map(row => ({ row, colStart, colEnd }))
}

selBgColor.addEventListener('change', () => {
  // Update the back area swatch immediately from the pre-loaded colors array
  const colors = mapData?.backAreaColors
  const idx    = parseInt(selBgColor.value)
  if (colors && colors[idx]) {
    const [r, g, b] = colors[idx]
    backAreaSwatch.style.background = `rgb(${r},${g},${b})`
  }
  postRerender()
})
selFgPalette.addEventListener('change',  postRerender)
selBgPalette.addEventListener('change',  postRerender)
selSpritePal.addEventListener('change',  postRerender)
selSpriteSet.addEventListener('change',  postRerender)
selTileset.addEventListener('change',    postRerender)

// Palette highlighting on focus — only highlight the cols controlled by each dropdown
selBgPalette.addEventListener('focus',  () => setPaletteHighlight(highlightRowCols([0, 1], 2, 7)))
selBgPalette.addEventListener('blur',   () => setPaletteHighlight(null))
selBgColor.addEventListener('focus',    () => setPaletteHighlight(highlightRowCols([0, 1, 2, 3, 4, 5, 6, 7], 1, 1)))
selBgColor.addEventListener('blur',     () => setPaletteHighlight(null))
selFgPalette.addEventListener('focus',  () => setPaletteHighlight(highlightRowCols([2, 3], 2, 7)))
selFgPalette.addEventListener('blur',   () => setPaletteHighlight(null))
selSpritePal.addEventListener('focus',  () => setPaletteHighlight(highlightRowCols([14, 15], 2, 7)))
selSpritePal.addEventListener('blur',   () => setPaletteHighlight(null))
selSpriteSet.addEventListener('focus',  () => setPaletteHighlight(highlightRowCols([14, 15], 2, 7)))
selSpriteSet.addEventListener('blur',   () => setPaletteHighlight(null))
selMarioPal.addEventListener('change',  postRerender)
selMarioPal.addEventListener('focus',   () => setPaletteHighlight(highlightRowCols([8], 6, 15)))
selMarioPal.addEventListener('blur',    () => setPaletteHighlight(null))

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
  const msg = event.data as Record<string, unknown>
  if (msg['type'] === 'modelPayload') {
    try {
      const payload = msg['payload'] as ModelMapPayload
      const { map, chars, tiles, bgTiles } = buildGraph(payload)
      window.__smwModelMap = map
      window.__smwModelChars = chars
      window.__smwModelTiles = tiles
      window.__smwModelBgTiles = bgTiles
      console.log(
        '[mapEditor] model ready —',
        'chars:', chars.size,
        'tiles:', tiles.size,
        'bgTiles:', bgTiles.size,
        'sprites:', payload.sprites.length,
        'l2:', payload.l2?.kind ?? 'none',
      )
      ensureReactiveRender(map)
      renderMap16Page()
      // Switch-state button thumbnails render from Map16 tiles ($06A..$06D
      // off / $16A..$16D on) + the blue P-switch from OBJ chars; both need
      // the model graph populated before they can draw. Triggering here
      // means the very first paint is correct without needing a user click.
      refreshSwitchToggleThumbs()
      drawPSwitchToggleThumb()
    } catch (err) {
      console.error('[mapEditor] modelPayload rehydrate failed:', err)
    }
    return
  }
  if (msg['type'] === 'load') {
    mapData  = msg as unknown as MapPayload

    applyMinimapOrientation()

    const hex     = mapData.mapIndex.toString(16).toUpperCase().padStart(3, '0')
    const screens = mapData.screens
    mapId.textContent   = `Map $${hex}`
    mapMeta.textContent = `${screens} screen${screens !== 1 ? 's' : ''}${mapData.isVertical ? ' · vertical' : ''}`
    stInfo.textContent    =
      `Music $${mapData.header.music.toString(16).toUpperCase()} · ` +
      `Tileset ${mapData.header.gfxTilesetId}`

    // Populate props panel selectors (only on initial load)
    if (msg['_initial'] !== false) {
      buildSelect(selBgColor,   8,  mapData.header.bgColor,       i => `Color ${i}`)
      buildSelect(selFgPalette, 8,  mapData.header.fgPalette,     i => `FG ${i}`)
      buildSelect(selBgPalette, 8,  mapData.header.bgPalette,     i => `BG ${i}`)
      buildSelect(selSpritePal, 4,  mapData.header.spritePalette, i => `Set ${i}`)
      buildSelect(selMarioPal,  4,  mapData.header.marioVariant,
        i => ['Mario', 'Luigi', 'Fire Mario', 'Fire Luigi'][i] ?? String(i))
      buildSelect(selTileset,   16, mapData.header.gfxTilesetId)
      buildSelect(selSpriteSet, 16, mapData.header.spriteSet)
    }

    // Back area color swatch — use the selected variant from backAreaColors
    const bac = mapData.backAreaColors
    const bacIdx = mapData.header.bgColor
    const bacColor = (bac && bac[bacIdx]) ? bac[bacIdx] : mapData.backAreaColor
    backAreaSwatch.style.background = `rgb(${bacColor[0]},${bacColor[1]},${bacColor[2]})`

    // Room info
    infoScreens.textContent = String(screens)
    infoSprites.textContent = String(mapData.sprites.length)

    // BG scroll settings (read-only, derived from per-level ROM byte via
    // DATA_05F000 → top-nibble → DATA_05D710/20). Label each setting with a
    // human-readable rate so the UI is useful without peeking at ASM comments.
    const vSet = mapData.header.vertLayer2Setting ?? 0
    const hSet = mapData.header.horizLayer2Setting ?? 0
    const vLabel = ['locked', '1:1', '1/2', '1/32'][vSet] ?? '?'
    const hLabel = ['locked', '1:1', '1/2', '?'   ][hSet] ?? '?'
    infoBgVScroll.textContent = `${vSet} (${vLabel})`
    infoBgHScroll.textContent = `${hSet} (${hLabel})`

    // Reset camera to level start and scroll into view if Camera is on.
    store.setCamera({ tileX: 0, tileY: 0, focused: false })
    if (chkCamera.checked) scrollContainerToCamera()

    // Palette canvas — the model render effect will also render this
    // reactively once the model arrives, but this first paint keeps the
    // panel from showing stale content before `modelPayload` lands.
    drawPaletteCanvas()

    // Reset animation state. Tile-anim / palette-anim frames come from
    // the store and are re-read by every model behavior on every effect
    // tick, so there is no cache to invalidate here.
    stopAnimTimer()
    stopPalAnimTimer()
    animRunning = false
    syncAnimButtons()
    animFrameCount = 1
    if (mapData.animation && mapData.animation.frameCount > 1) {
      animFrameCount = mapData.animation.frameCount
      animIntervalMs = mapData.animation.intervalMs
      for (const b of animPlayBtns) b.style.display = ''
    } else {
      for (const b of animPlayBtns) b.style.display = 'none'
    }

    // Clamp zoom to what the freshly-loaded level can fit, then draw.
    applyZoom()

    // ── VRAM 8×8 tile sheet paged by slot ─────────────────────────────
    // 1536 chars @ 16 per row = 96 rows × 8 px = 768 px tall. Pages cover
    // 256 chars (128 px) each, so 6 pages total. Content comes from the
    // self-rendering model via `renderVramPageFromModel`.
    {
      const vh = Math.ceil(1536 / 16) * 8
      const pxPerPage = (VRAM_TILES_PER_PAGE / 16) * 8
      vramTotalPages = Math.ceil(vh / pxPerPage)
      vramPage = 0

      const vramCanvas = document.getElementById('vram-canvas') as HTMLCanvasElement
      const vramInspect = document.getElementById('vram-inspect') as HTMLElement
      vramCanvas.onmousemove = (e) => {
        const rect = vramCanvas.getBoundingClientRect()
        const sx = vramCanvas.width / rect.width, sy = vramCanvas.height / rect.height
        const px = Math.floor((e.clientX - rect.left) * sx)
        const py = Math.floor((e.clientY - rect.top) * sy)
        const col = Math.floor(px / 8), row = Math.floor(py / 8)
        const localChar = row * 16 + col
        const globalChar = vramPage * VRAM_TILES_PER_PAGE + localChar
        const slot = globalChar < 0x80 ? 'FG1' : globalChar < 0x100 ? 'FG2' : globalChar < 0x180 ? 'FG3' : globalChar < 0x200 ? 'AN1' : globalChar < 0x400 ? '—' : 'SP'
        vramInspect.textContent = `char $${globalChar.toString(16).padStart(3,'0')} (${slot})`
        vramHoverTile = { col, row }
        renderVramPage()
      }
      vramCanvas.onmouseleave = () => {
        vramInspect.textContent = 'hover to inspect'
        vramHoverTile = null
        renderVramPage()
      }

      vramCanvas.onclick = (e) => {
        const rect = vramCanvas.getBoundingClientRect()
        const sx = vramCanvas.width / rect.width, sy = vramCanvas.height / rect.height
        const col = Math.floor((e.clientX - rect.left) * sx / 8)
        const row = Math.floor((e.clientY - rect.top) * sy / 8)
        selectedDetail = { type: 'vram', page: vramPage, col, row }
        redrawDetail()
        renderVramPage()  // repaint so the yellow selection outline shows
      }
    }

    // ── Map16 tile pages — page structure only; render driven by model ──
    {
      map16Pages = []
      const l1DefCount = mapData.map16DefCount ?? 0
      const l1PageCount = l1DefCount > 0 ? Math.ceil(l1DefCount / 256) : 1
      for (let p = 0; p < l1PageCount; p++) {
        map16Pages.push({ pageInAtlas: p, label: `L1 0x${p.toString(16).padStart(2,'0')}` })
      }
      const l2DefCount = mapData.map16BgDefCount ?? 0
      if (l2DefCount > 0) {
        const bgPageCount = Math.ceil(l2DefCount / 256)
        for (let p = 0; p < bgPageCount; p++) {
          map16Pages.push({ pageInAtlas: p, label: `L2 0x${(0x80 + p).toString(16)}` })
        }
      }
      map16PageIdx = 0
      renderMap16Page()

      const m16Canvas = document.getElementById('map16-canvas') as HTMLCanvasElement
      const m16Inspect = document.getElementById('map16-inspect') as HTMLElement
      m16Canvas.onmousemove = (e) => {
        if (map16Pages.length === 0) return
        const rect = m16Canvas.getBoundingClientRect()
        const sx = m16Canvas.width / rect.width, sy = m16Canvas.height / rect.height
        const col = Math.floor((e.clientX - rect.left) * sx / 16)
        const row = Math.floor((e.clientY - rect.top) * sy / 16)
        const entry = map16Pages[map16PageIdx]
        m16Inspect.textContent = `tile ${row * 16 + col}  (${entry.label})`
        map16HoverTile = { col, row }
        renderMap16Page()
      }
      m16Canvas.onmouseleave = () => {
        m16Inspect.textContent = 'hover to inspect'
        map16HoverTile = null
        renderMap16Page()
      }

      m16Canvas.onclick = (e) => {
        const rect = m16Canvas.getBoundingClientRect()
        const sx = m16Canvas.width / rect.width, sy = m16Canvas.height / rect.height
        const col = Math.floor((e.clientX - rect.left) * sx / 16)
        const row = Math.floor((e.clientY - rect.top) * sy / 16)
        selectedDetail = { type: 'map16', page: map16PageIdx, col, row }
        redrawDetail()
        renderMap16Page()  // repaint so the yellow selection outline shows
      }
    }

    // Refresh tile detail preview (persists across palette/tileset changes)
    redrawDetail()

    // Reset palette animation timer. CyclingColor cells read
    // `ctx.palAnimFrame.value` directly, so every ref update invalidates
    // only the cells that actually moved.
    stopPalAnimTimer()
    applyPalAnimFrame(0)
    const palAnimEl = document.getElementById('pal-anim-controls') as HTMLElement
    palAnimEl.style.display = mapData.paletteAnimation ? 'flex' : 'none'

  } else if (msg['type'] === 'error') {
    mapId.textContent   = 'Error'
    mapMeta.textContent = msg['message'] as string
  }
})

// Tear down animation + palette timers when the webview is disposed
// (preview-tab replacement, close, reload) so nothing keeps firing in a
// zombie context.
window.addEventListener('pagehide', () => {
  stopAnimTimer()
  stopPalAnimTimer()
  animRunning = false
  palAnimRunning = false
})

// Pause animation loops whenever the webview becomes hidden. VS Code keeps
// replaced preview-tab webviews alive briefly (and sometimes for much
// longer) while they transition out — before pagehide fires. Without this,
// a stack of hidden-but-alive webviews each with an animation loop fights
// the visible tab's main thread and drops its FPS.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (animRafId !== null) { cancelAnimationFrame(animRafId); animRafId = null }
    if (palAnimRafId !== null) { cancelAnimationFrame(palAnimRafId); palAnimRafId = null }
  } else if (document.visibilityState === 'visible') {
    // Resume what was running before we went hidden. State (animRunning /
    // palAnimRunning) was preserved on purpose so the user's play/pause
    // intent survives tab-switching.
    if (animRunning && animRafId === null) {
      animLastTickMs = performance.now()
      animRafId = requestAnimationFrame(animTick)
    }
    if (palAnimRunning && palAnimRafId === null) {
      palAnimLastTickMs = performance.now()
      palAnimRafId = requestAnimationFrame(palAnimTick)
    }
  }
})

vscode.postMessage({ type: 'ready' })

export {}
