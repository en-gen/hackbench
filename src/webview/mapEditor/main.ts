/**
 * SMW Map Editor — webview entry point.
 *
 * Opens a single map (1 of 512 from the SMW ROM). Several related maps linked
 * by entrances/exits together form a "level" in the player-facing sense.
 */


// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()

import { effect, shallowRef } from '@vue/reactivity'
import { buildGraph } from '../../rom/model/rehydrate'
import { RomFile } from '../../rom/RomFile'
import {
  buildScrollSimulator,
  computeColumnDyRanges,
  computeLayer2YRange,
  sampleViewportPath,
} from '../../rom/scrollSim'
import { VineSourceBehavior } from '../../rom/model/tiles/behaviors/VineSourceBehavior'
import { StarOneUpVineBlockBehavior } from '../../rom/model/tiles/behaviors/StarOneUpVineBlockBehavior'
import { L2ObjectStream, L2Preset } from '../../rom/model/L2Layer'
import type { MapPayload as ModelMapPayload } from '../../rom/model/MapPayload'
import type { SmwMap } from '../../rom/model/SmwMap'
import type { Sprite } from '../../rom/model/sprites/Sprite'
import type { OverlayContext } from '../../rom/model/OverlayContext'
import { cellBoxOf } from '../../rom/model/RenderTarget'
import type { MapStore } from '../../rom/model/stores/mapStore'
import { CanvasRenderTarget } from './CanvasRenderTarget'
import { drawSurfaces } from './overlays/drawSurfaces'
import { drawWalls } from './overlays/drawWalls'
import { drawL3Range } from './overlays/drawL3Range'
import { drawL2Range } from './overlays/drawL2Range'
import { drawScrollPath } from './overlays/drawScrollPath'
import { drawScrollPlayback } from './overlays/drawScrollPlayback'
import { drawSpriteSelection } from './overlays/drawSpriteSelection'
import { spriteSelectionKey } from './spriteProps'
import { setPropContext as paneSetPropContext, showSpriteProps, type PropContext } from './propsPane'
import { editorStore as store } from './store'
import { frameClock } from '../shared/frameClock'
import { SNES_NTSC_FPS, msToFrames, SPRITE_ANIM_FRAME_STRIDE } from '../../rom/timing'
import { tileBlockColor } from '../shared/blockView'
import { hex2, hex3 } from '../shared/hex'

// FLUX: the store owns state; views dispatch actions; observers read refs.
// `store.foo`         — direct read of the reactive proxy field. Reads inside
//                       an active `effect()` register a dependency, so when
//                       `store.setFoo(...)` mutates, the effect re-runs.
// `store.doThing()`   — action (mutation). Never mutate fields from outside.
//
// Per-map ROM-derived data lives on `map.mapStore` (palette, level orientation,
// pipe variants, mario spawn X). Reach it through the loaded SmwMap.

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
  // Animation event subscriptions. The numeric values are irrelevant —
  // each timer fires by mutating the ref, which retracks the effect so
  // chars / sprites whose internal frame state advanced get redrawn.
  void mapTick.value
  void spriteTick.value
  const overlay = document.getElementById('model-canvas') as HTMLCanvasElement | null
  if (!overlay) return
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  const w = cols * 16
  const h = rows * 16
  if (w === 0 || h === 0) return

  // Read cameraDragging as a tracked dep so the effect re-runs when drag
  // starts/ends, but we skip the expensive base render during drag.
  const dragging = store.cameraDragging

  // Register cursorPx as a toplevel dep so the effect re-runs on every
  // pointer move. The nested read inside ThwompAppearance.render is only
  // tracked while a thwomp is actually rendered — if sprites are toggled
  // off at first paint, the dep never registers and cursor changes fall
  // on the floor. This line keeps the wiring unconditional.
  void store.cursorPx
  // Same reasoning for the sprite-engine scaffolding toggles: `Sprite.render`
  // reads them, but that read never happens on a pass with sprites toggled
  // off, so register them unconditionally here.
  void store.spriteEngine
  void store.spriteEngineMarkers

  // Per-map ROM-derived data lives on `map.mapStore`. Behaviors that need it
  // (PipeVariantsBehavior, KoopaAppearance overlay, etc.) receive it as a
  // render arg so per-cell concerns derive from their own cell position +
  // mapStore fields.
  const mapStore = map.mapStore

  if (!dragging) {
    // ── Base render (expensive): tiles + non-camera overlays ──────────────
    // Skipped during camera drag so pointermove only pays for the cheap
    // camera-strip composite below.
    if (!baseLevelCanvas || baseLevelCanvas.width !== w || baseLevelCanvas.height !== h) {
      baseLevelCanvas = document.createElement('canvas')
      baseLevelCanvas.width  = w
      baseLevelCanvas.height = h
    }
    const baseTarget = new CanvasRenderTarget(baseLevelCanvas)
    baseTarget.clear(map.palette.backAreaColor.rgba())
    map.render(baseTarget)
    baseTarget.flush()

    // Canvas 2D overlays that don't depend on camera position go on the
    // base canvas so drag recomposites inherit them for free.
    const toggles = store.layerToggles
    const bctx = baseLevelCanvas.getContext('2d')!
    if (toggles.block) drawBlockView(bctx, map, toggles.l1, toggles.l2)
    if (toggles.screens || toggles.mapGrid) drawScreenAndGridOverlays(bctx, map, toggles.screens, toggles.mapGrid)
    if (toggles.surfaces) drawSurfaces(bctx, map, store.switchPalaceState)
    if (toggles.walls)    drawWalls(bctx,    map, store.switchPalaceState)
    if (toggles.l3Range)  drawL3Range(bctx,  map)
    if (toggles.l2Range)  drawL2Range(bctx,  map)
    // L1 path + viewport rect are only meaningful when the active
    // scroll cmd actually drives Layer 1. cmd $03 / $08 / $0B / $0E
    // (L2-only) leave Layer 1 stationary — drawing a "playback rect"
    // for those is misleading.
    const l1cmd = mapData?.header?.layer1ScrollCmd
    const l2cmd = mapData?.header?.layer2ScrollCmd
    const showL1Path = toggles.scrollPath && cmdAffectsL1(l1cmd, l2cmd)
    if (showL1Path && mapData?.header?.scrollPath) {
      drawScrollPath(bctx, mapData.header.scrollPath)
    }
    // Scroll-playback rect: tracks `editorStore.frameL1` (the L1
    // viewport's frame in sim-frame units). Gated on the scroll-path
    // toggle AND on the cmd actually affecting L1 — see above.
    //
    // We query the simulator directly for per-frame `(l1x, l1y)`
    // rather than indexing into the strided `scrollPath` (which only
    // has samples every 8 sim frames). Using `stateAtFrame(N)` gives
    // pixel-accurate rect motion at every frame; the path-array
    // conversion would jump in 8-frame chunks and look stuttery.
    const playbackFrame = store.frameL1
    if (showL1Path && playbackFrame >= 0 && mapData?.header?.scrollPath) {
      const sim = mapStore.scrollSimulator
      if (sim !== null) {
        const s = sim.stateAtFrame(playbackFrame)
        // Synthesize a single-element samples array with the live
        // per-frame state so `drawScrollPlayback` can stay agnostic
        // to whether we're using the strided path or the simulator.
        drawScrollPlayback(bctx, [{
          f: playbackFrame,
          l1x: s.layer1XPos, l1y: s.layer1YPos,
          l2x: s.layer2XPos, l2y: s.layer2YPos,
        }], 0)
      } else {
        // No simulator (level had no scroll sprite but somehow has
        // a path? Shouldn't happen, but fall back to the array.)
        drawScrollPlayback(bctx, mapData.header.scrollPath, pathIndexForSimFrame(playbackFrame))
      }
    }
    drawVinePaths(bctx, map)
    map.renderSpriteOverlays(bctx as unknown as OverlayContext, store.activeSpriteOverlays)
  }

  // Guard: base canvas must exist before we can composite.
  if (!baseLevelCanvas) return

  // Ensure fullLevelCanvas dimensions match.
  if (!fullLevelCanvas || fullLevelCanvas.width !== w || fullLevelCanvas.height !== h) {
    fullLevelCanvas = document.createElement('canvas')
    fullLevelCanvas.width  = w
    fullLevelCanvas.height = h
  }

  // Copy base → full (cheap drawImage, no pixel-level JS).
  const foctx = fullLevelCanvas.getContext('2d')!
  foctx.drawImage(baseLevelCanvas, 0, 0)

  // ── Camera composite (fast): only re-renders the viewport strip ─────────
  const cameraOn = store.cameraOn
  if (cameraOn) {
    const camTarget = new CanvasRenderTarget(fullLevelCanvas)
    const strip = compositeCameraViewport(camTarget, mapStore, map)
    // Only overwrite the strip region on fullLevelCanvas — the rest of the
    // base render copied above is left intact.
    if (strip) camTarget.flushRegion(strip.sx, strip.sy, strip.sw, strip.sh)
    drawCameraRectOverlay(foctx, map)
  }

  // Selection mark last so it is never buried by an annotation or the
  // camera rect. Reading the store key here is what registers the
  // reactive dep that makes select/deselect repaint.
  drawSpriteSelection(foctx, store.selectedSpriteKey ? selectedSprite : null)

  // Spacer drives the native scrollbar. Padding centers the level when it
  // fits within the viewport (horizontal levels vertically, vertical horizontally).
  const z = store.zoom
  levelPadX = isVert() ? Math.max(0, Math.floor((canvasWrap.clientWidth  - w * z) / 2)) : 0
  levelPadY = isVert() ? 0 : Math.max(0, Math.floor((canvasWrap.clientHeight - h * z) / 2))
  levelSpacer.style.width  = `${w * z + levelPadX * 2}px`
  levelSpacer.style.height = `${h * z + levelPadY * 2}px`

  // Viewport canvas: size it to the visible area and blit from the offscreen.
  resizeViewportCanvas(overlay)
  blitViewport(overlay)

  // Side-panel canvases share the reactive pass — each re-reads its
  // model inputs via `ctx.*.value`, so a ref change invalidates the
  // effect and rebuilds every panel that reads the changed ref.
  drawPaletteCanvas()
  renderVramPage()
  renderMap16Page()
  // Detail preview goes through the model too so animation / pswitch /
  // switch-palace are reflected. Cheap no-op when nothing is selected.
  redrawDetail()
  // Minimap sources from the full-level offscreen canvas.
  if (minimapOn) drawMinimap()
}

/**
 * Size the viewport canvas to match the current canvas-wrap client area.
 * Called before each blit so the canvas tracks panel/window resize.
 */
function resizeViewportCanvas(overlay: HTMLCanvasElement): void {
  const vpW = canvasWrap.clientWidth
  const vpH = canvasWrap.clientHeight
  if (overlay.width !== vpW)  overlay.width  = vpW
  if (overlay.height !== vpH) overlay.height = vpH
  // No CSS scaling — canvas renders 1:1 with CSS pixels, zoom is handled
  // via the drawImage scale in blitViewport.
  overlay.style.width  = ''
  overlay.style.height = ''
}

/**
 * Copy the visible portion of the full-level offscreen canvas into the
 * viewport canvas. The drawImage scale converts 1× natural pixels to
 * CSS-zoom-level pixels so tiles appear at TILE_PX * z each.
 * Safe to call from the scroll handler without a full model re-render.
 */
function blitViewport(overlay?: HTMLCanvasElement): void {
  const el = overlay ?? (document.getElementById('model-canvas') as HTMLCanvasElement | null)
  if (!el || !fullLevelCanvas) return
  const z   = store.zoom
  const vpW = el.width
  const vpH = el.height
  // Scroll origin in natural pixels, accounting for centering padding.
  const rawSrcX = (canvasWrap.scrollLeft - levelPadX) / z
  const rawSrcY = (canvasWrap.scrollTop  - levelPadY) / z
  // When the level is smaller than the viewport the raw origin is negative
  // (we're panning into the padding). Clamp to 0 and offset the dst.
  const srcX = Math.max(0, rawSrcX)
  const srcY = Math.max(0, rawSrcY)
  const dstX = rawSrcX < 0 ? Math.round(-rawSrcX * z) : 0
  const dstY = rawSrcY < 0 ? Math.round(-rawSrcY * z) : 0
  const oc = el.getContext('2d')!
  oc.imageSmoothingEnabled = false
  oc.clearRect(0, 0, vpW, vpH)
  if (dstX < vpW && dstY < vpH) {
    oc.drawImage(fullLevelCanvas, srcX, srcY, (vpW - dstX) / z, (vpH - dstY) / z, dstX, dstY, vpW - dstX, vpH - dstY)
  }
  // Block-view tile-id labels are drawn on the viewport canvas post-blit
  // so text rasterizes at display pixel density — crisp at every zoom,
  // unlike the base canvas which is nearest-neighbor-upscaled.
  drawBlockViewLabels(oc, srcX, srcY, dstX, dstY, z, vpW, vpH)
}

/**
 * Paint `$XXX` tile-id labels over visible block-view cells on the viewport
 * canvas. Must be called AFTER the fullLevelCanvas blit — drawing here
 * (rather than on the natural-resolution base canvas) keeps text vector-like:
 * the glyphs are re-rasterized at the current zoom's font size every blit,
 * so they stay crisp from 1× to 16× without the pixelation that bitmap-scaled
 * text would have.
 *
 * Label prefers L1 id if present; else falls back to L2 id — matching the
 * paint order in `drawBlockView` (L1 on top of L2 at 0.55 alpha).
 */
function drawBlockViewLabels(
  octx: CanvasRenderingContext2D,
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
  z: number,
  vpW: number,
  vpH: number,
): void {
  const toggles = store.layerToggles
  if (!toggles.block) return
  const map = window.__smwModelMap
  if (!map) return

  const TILE = 16
  const tilePx = TILE * z
  // Below 1× the tile shrinks under 16 px and the label can't fit even a
  // 6-px font; skip rather than render unreadable overlap.
  if (tilePx < 16) return

  const l1 = toggles.l1 ? map.l1 : null
  const l2Grid = toggles.l2 && map.l2 &&
    (map.l2 instanceof L2Preset || map.l2 instanceof L2ObjectStream)
      ? map.l2.grid
      : null
  if (!l1 && !l2Grid) return

  // Visible tile range in natural (pre-zoom) coordinates. The viewport shows
  // srcX..srcX+visW horizontally, srcY..srcY+visH vertically.
  const visW = (vpW - dstX) / z
  const visH = (vpH - dstY) / z
  const maxCols = Math.max(l1?.[0]?.length ?? 0, l2Grid?.[0]?.length ?? 0)
  const maxRows = Math.max(l1?.length ?? 0, l2Grid?.length ?? 0)
  const colStart = Math.max(0, Math.floor(srcX / TILE))
  const colEnd   = Math.min(maxCols - 1, Math.floor((srcX + visW) / TILE))
  const rowStart = Math.max(0, Math.floor(srcY / TILE))
  const rowEnd   = Math.min(maxRows - 1, Math.floor((srcY + visH) / TILE))
  if (colEnd < colStart || rowEnd < rowStart) return

  octx.save()
  // 0.35 * tilePx keeps the 4-char `$XXX` label fitting a monospace tile
  // (char ≈ 0.55 * font-size), with a 6-px floor for low-zoom legibility.
  const fontSize = Math.max(6, Math.round(tilePx * 0.35))
  octx.font = `${fontSize}px monospace`
  octx.textAlign = 'center'
  octx.textBaseline = 'middle'
  octx.lineWidth = Math.max(2, Math.round(fontSize * 0.22))
  octx.strokeStyle = 'rgba(0,0,0,0.85)'
  octx.lineJoin = 'round'
  octx.fillStyle = '#fff'

  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      const l1Id = l1?.[r]?.[c] ?? null
      const l2Id = l2Grid?.[r]?.[c] ?? null
      const id = l1Id !== null ? l1Id : l2Id
      if (id === null || id === undefined) continue
      const cx = (c * TILE + TILE / 2 - srcX) * z + dstX
      const cy = (r * TILE + TILE / 2 - srcY) * z + dstY
      const label = `$${hex3(id)}`
      octx.strokeText(label, cx, cy)
      octx.fillText(label, cx, cy)
    }
  }
  octx.restore()
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
  mapStore: MapStore,
  map: SmwMap,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const rows = map.l1.length
  const cols = rows > 0 ? map.l1[0].length : 0
  if (rows === 0 || cols === 0) return null
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
  target.fillRect({ x: sx, y: sy }, { w: sw, h: sh }, map.palette.backAreaColor.rgba())

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
      // Compute BG parallax position in pixels (matches SNES: Layer2XPos = Layer1XPos >> hShift).
      // Keep the full pixel value before dividing by 16 so we get a sub-tile remainder that
      // lets us shift the first tile's canvas position and achieve smooth pixel-level scroll.
      const bgParallaxPxX = isVert ? 0 : (hShift === null ? 0 : (camX * 16) >> hShift)
      const bgParallaxPxY = isVert ? (vShift === null ? 0 : (camY * 16) >> vShift) : 0
      const bgOriginCol = bgParallaxPxX >> 4          // which BG tile column is at the left edge
      const bgOriginRow = bgParallaxPxY >> 4          // which BG tile row is at the top edge
      const bgSubOffsetX = bgParallaxPxX & 0xF        // pixels into bgOriginCol before viewport edge
      const bgSubOffsetY = bgParallaxPxY & 0xF        // pixels into bgOriginRow before viewport edge
      const stripCols = sw / 16
      const stripRows = sh / 16
      // One extra tile on the scrolling edge fills the gap left by the sub-tile shift.
      // setClip constrains blit8x8/fillRect to the strip so the extra tile doesn't bleed
      // into adjacent world-map tiles outside the camera viewport.
      target.setClip(sx, sy, sw, sh)
      for (let r = 0; r < stripRows + (bgSubOffsetY > 0 ? 1 : 0); r++) {
        for (let c = 0; c < stripCols + (bgSubOffsetX > 0 ? 1 : 0); c++) {
          const bgR = ((bgOriginRow + r) % bgRows + bgRows) % bgRows
          const bgC = ((bgOriginCol + c) % bgCols + bgCols) % bgCols
          const tile = bgGrid[bgR]?.[bgC]
          if (!tile) continue
          const px = sx + c * 16 - bgSubOffsetX
          const py = sy + r * 16 - bgSubOffsetY
          const cell = {
            tl: { x: px,     y: py },
            tr: { x: px + 8, y: py },
            bl: { x: px,     y: py + 8 },
            br: { x: px + 8, y: py + 8 },
          }
          tile.render(target, cell, mapStore, 'nonPriority')
          tile.render(target, cell, mapStore, 'priority')
        }
      }
      target.clearClip()
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
        tile.render(target, cell, mapStore, 'nonPriority')
        tile.render(target, cell, mapStore, 'priority')
      }
    }
  }

  // L3 on top (if toggled) — the camera strip wipe above erased the main
  // render's L3, so re-render it clipped to the strip. Pass clipRangeX so
  // the L3 renderer skips the full-level repeat and only emits tiles for
  // the strip, keeping drag-redraw responsive.
  if (toggles.l3 && map.l3) {
    target.setClip(sx, sy, sw, sh)
    // Both BG3 phases, back to front: this strip repaint sits on top of the
    // wiped region, so it reproduces what the main pass list already drew
    // rather than re-deciding L3's position in the stack.
    map.l3.render(target, mapStore, 'nonPriority', { xMin: sx, xMax: sx + sw })
    map.l3.render(target, mapStore, 'priority', { xMin: sx, xMax: sx + sw })
    target.clearClip()
  }
  return { sx, sy, sw, sh }
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

// ── Vine overlay ─────────────────────────────────────────────────────────────

/** Tile IDs (and null = out-of-bounds) that the vine can grow through. */
const VINE_PASSABLE = new Set<number | null>([null, 0x000, 0x006])

/**
 * Draw upward vine-path overlays for all toggled vine sources.
 * Green tint on passable tiles, red outline on the first solid blocker.
 */
function drawVinePaths(octx: CanvasRenderingContext2D, map: SmwMap): void {
  const active = store.activeVineSources
  if (active.size === 0) return
  const l1 = map.l1
  const T = 16
  octx.save()
  octx.strokeStyle = 'rgba(0,220,80,0.85)'
  octx.lineWidth = 2
  for (const key of active) {
    const [col, row] = key.split(',').map(Number)
    octx.strokeRect(col * T + 1, row * T + 1, T - 2, T - 2)
    for (let r = row - 1; r >= 0; r--) {
      const id = l1[r]?.[col] ?? null
      if (!VINE_PASSABLE.has(id)) {
        octx.strokeStyle = 'rgba(240,60,60,0.85)'
        octx.strokeRect(col * T + 1, r * T + 1, T - 2, T - 2)
        break
      }
      octx.fillStyle = 'rgba(0,220,80,0.22)'
      octx.fillRect(col * T, r * T, T, T)
    }
  }
  octx.restore()
}

/**
 * Return the `"id:x,y"` overlay key of the first sprite under the given
 * level-space CSS-pixel coordinate whose appearance implements
 * `renderOverlay`. Sprites without overlays are skipped. The key format
 * matches `SmwMap.renderSpriteOverlays` so a single `activeSpriteOverlays`
 * set drives both rendering and toggle state.
 */
function spriteOverlayKeyAt(lx: number, ly: number): string | null {
  const map = window.__smwModelMap
  if (!map) return null
  const z = store.zoom
  const natX = lx / z
  const natY = ly / z
  for (const sprite of map.sprites) {
    if (!sprite.appearance.renderOverlay) continue
    if (sprite.pickAt(natX, natY)) return spriteSelectionKey(sprite)
  }
  return null
}

/**
 * Return the "col,row" key of the vine-source block under the given
 * level-space CSS-pixel coordinate, or null if none. Driven by tile
 * behavior (VineSourceBehavior or StarOneUpVineBlockBehavior at a vine column) so the
 * detection is consistent with what the tile renders.
 */
function vineSourceKeyAt(lx: number, ly: number): string | null {
  const map = window.__smwModelMap
  const tiles = window.__smwModelTiles
  if (!map || !tiles) return null
  const z = store.zoom
  const col = Math.floor(lx / z / 16)
  const row = Math.floor(ly / z / 16)
  const id = map.l1[row]?.[col] ?? null
  if (id === null) return null
  const tile = tiles.get(id)
  if (!tile) return null
  if (tile.behavior instanceof VineSourceBehavior) return `${col},${row}`
  if (tile.behavior instanceof StarOneUpVineBlockBehavior && tile.behavior.itemAtCol(col) === 'vine') return `${col},${row}`
  return null
}

/**
 * Block-view overlay: paint each non-empty L1 (and optionally L2) tile
 * as a colored 16×16 square keyed on the Map16 tile id, deterministic
 * via `tileBlockColor`. L2 renders at 55% alpha so L1 reads over it.
 * Useful for level troubleshooting since it surfaces the underlying
 * tile layout with zero GFX rendering.
 *
 * Hex-id labels are drawn separately by `drawBlockViewLabels`, which
 * runs on the viewport canvas post-blit so the text rasterizes at
 * display pixel density (crisp at every zoom) instead of getting
 * nearest-neighbor-scaled with the rest of the base canvas.
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
      const label = hex2(s)
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
app.style.cssText = [
  'display:grid',
  'grid-template-areas:"left toolbar right" "left main right"',
  'grid-template-columns:210px 1fr 230px',
  'grid-template-rows:36px 1fr',
  'height:100vh',
  'overflow:hidden',
  'font-family:var(--vscode-font-family,system-ui)',
  'font-size:12px',
  'color:var(--vscode-foreground,#e0e0e0)',
  'user-select:none',
].join(';')

app.innerHTML = `
<div id="workspace" style="display:contents">

  <!-- ── LEFT PANEL ───────────────────────────────────────────────────────── -->
  <div id="left-panel" style="
    grid-area:left;display:flex;flex-direction:column;overflow:hidden;
    background:var(--vscode-sideBar-background,#252526);
    border-right:1px solid var(--vscode-panel-border,#3a3a3a);">

    <!-- Tab bar -->
    <div style="display:flex;flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);height:30px;overflow:hidden;">
      <button class="tab-btn"        id="tab-vram"    data-tab="vram">8×8</button>
      <button class="tab-btn"        id="tab-map16"   data-tab="map16">Map16</button>
      <button class="tab-btn"        id="tab-objects" data-tab="objects">Objects</button>
      <button class="tab-btn active" id="tab-sprites" data-tab="sprites">Sprites</button>
    </div>

    <!-- Scrollable tab content -->
    <div style="flex:1;overflow-y:auto;min-height:0;">
    <div id="tab-panels">

      <!-- 8×8 VRAM panel -->
      <div id="panel-vram" style="display:none;padding:4px 0;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
          <button id="vram-prev" class="iconBtn" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
          <span id="vram-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 6</span>
          <button id="vram-next" class="iconBtn" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
        </div>
        <div style="padding:0 8px 8px;">
          <canvas id="vram-canvas" width="128" height="128" style="width:100%;image-rendering:pixelated;display:block;cursor:default;border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="vram-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

      <!-- Map16 panel -->
      <div id="panel-map16" style="display:none;padding:4px 0;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
          <button id="map16-prev" class="iconBtn" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
          <span id="map16-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 2</span>
          <button id="map16-next" class="iconBtn" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
        </div>
        <div style="padding:0 8px 8px;">
          <canvas id="map16-canvas" width="256" height="256" style="width:100%;image-rendering:pixelated;display:block;cursor:default;border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="map16-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

      <!-- Objects panel (stub) -->
      <div id="panel-objects" style="display:none;padding:4px 0;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
          <button id="obj-prev" class="iconBtn" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
          <span id="obj-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 4</span>
          <button id="obj-next" class="iconBtn" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
        </div>
        <div style="padding:0 8px 8px;">
          <canvas id="obj-canvas" width="128" height="256" style="width:100%;image-rendering:pixelated;display:block;cursor:default;border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="obj-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

      <!-- Sprites panel (stub) -->
      <div id="panel-sprites" style="padding:4px 0;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
          <button id="spr-prev" class="iconBtn" title="Previous page"><span class="codicon codicon-chevron-left"></span></button>
          <span id="spr-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 4</span>
          <button id="spr-next" class="iconBtn" title="Next page"><span class="codicon codicon-chevron-right"></span></button>
        </div>
        <div style="padding:0 8px 8px;">
          <canvas id="spr-canvas" width="128" height="256" style="width:100%;image-rendering:pixelated;display:block;cursor:default;border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="spr-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

    </div><!-- #tab-panels -->

    <!-- Selected preview (immediately below tile viewer) -->
    <div style="border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:8px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:.08em;color:#888;margin-bottom:4px;">SELECTED</div>
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <canvas id="detail-canvas" width="16" height="16" style="
          width:64px;height:64px;image-rendering:pixelated;flex-shrink:0;
          border:1px solid #555;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
        <div id="detail-info" style="font-size:10px;font-family:monospace;color:#aaa;line-height:1.6;">click a tile to inspect</div>
      </div>
    </div>

    <!-- Palette (CGRAM) -->
    <div style="border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:4px 8px 8px;">
      <canvas id="palette-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;cursor:crosshair;display:block;
        background:repeating-conic-gradient(#555 0% 25%,#444 0% 50%) 0 0/8px 8px;
        border:1px solid #3a3a3a;box-sizing:border-box;"></canvas>
      <div id="palette-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
    </div>

    </div><!-- left scroll wrapper -->

    <!-- Tile hover status pinned at bottom of left panel -->
    <div style="flex-shrink:0;border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:3px 8px;display:flex;flex-direction:column;gap:1px;background:var(--vscode-sideBar-background,#252526);">
      <span id="st-tile" style="font-family:monospace;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
      <span id="st-pos"  style="font-family:monospace;font-size:11px;color:#666;white-space:nowrap;"></span>
    </div>

  </div><!-- #left-panel -->

  <!-- ── TOOLBAR (center top) ───────────────────────────────────────────────── -->
  <div id="toolbar" style="
    grid-area:toolbar;display:flex;align-items:center;gap:4px;padding:0 8px;
    background:var(--vscode-editor-background,#1e1e1e);
    border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);">

    <!-- Layer toggles (SVG 3-bar icons, 40% opacity when off) -->
    <button id="btn-l2" class="iconBtn layerBtn on" title="Layer 2 — background">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="currentColor"/>
      </svg>
    </button>
    <button id="btn-l1" class="iconBtn layerBtn on" title="Layer 1 — foreground">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="currentColor"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="#666"/>
      </svg>
    </button>
    <button id="btn-l3" class="iconBtn layerBtn on" title="Layer 3 — special">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="currentColor"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="#666"/>
      </svg>
    </button>
    <button id="btn-sprites"     class="iconBtn on" title="Sprites overlay"><span class="codicon codicon-symbol-misc"></span></button>

    <div class="tb-sep"></div>

    <!-- Overlay toggles -->
    <button id="btn-surfaces"    class="iconBtn"    title="Show surfaces"><span class="codicon codicon-layout-panel-dock"></span></button>
    <button id="btn-walls"       class="iconBtn"    title="Show walls"><span class="codicon codicon-layout-sidebar-right-dock"></span></button>
    <button id="btn-block"       class="iconBtn"    title="Block view"><span class="codicon codicon-symbol-method"></span></button>

    <div class="tb-sep"></div>

    <button id="btn-play"        class="iconBtn"    title="Play animation"><span class="codicon codicon-play"></span></button>
    <!-- Scaffolding: temporary A/B control for the table-driven sprite draw
         engine. Not a preference, not persisted, deletes with the old render
         path. See docs/sprite-engine-wiring.md. -->
    <button id="btn-sprite-engine"      class="iconBtn" title="Sprite engine (comparison, off)"><span class="codicon codicon-beaker"></span></button>
    <button id="btn-sprite-engine-mark" class="iconBtn on" title="Mark engine-rendered sprites" style="display:none;"><span class="codicon codicon-primitive-square"></span></button>
    <button id="btn-camera"      class="iconBtn"    title="Camera viewport"><span class="codicon codicon-device-camera-video"></span></button>
    <button id="btn-hud"         class="iconBtn"    title="HUD in camera"><span class="codicon codicon-window"></span></button>

    <div class="tb-sep"></div>

    <!-- Zoom -->
    <button id="zoom-out" class="iconBtn" title="Zoom out (Ctrl+scroll)"><span class="codicon codicon-zoom-out"></span></button>
    <span id="zoom-label" style="font-family:monospace;font-size:11px;min-width:28px;text-align:center;flex-shrink:0;">1×</span>
    <button id="zoom-in"  class="iconBtn" title="Zoom in (Ctrl+scroll)"><span class="codicon codicon-zoom-in"></span></button>

    <div class="tb-sep"></div>

    <!-- View toggles -->
    <button id="btn-map-minimap" class="iconBtn on" title="Toggle minimap"><span class="codicon codicon-map"></span></button>
    <button id="btn-map-grid-tb" class="iconBtn"    title="Toggle tile grid"><span class="codicon codicon-table"></span></button>
    <button id="btn-screens"     class="iconBtn"    title="Toggle screen dividers" style="transform:rotate(-90deg)"><span class="codicon codicon-server"></span></button>

    <div class="tb-sep"></div>

    <!-- Edit (stubs) -->
    <button class="iconBtn" title="Undo (not yet implemented)" disabled><span class="codicon codicon-discard"></span></button>
    <button class="iconBtn" title="Redo (not yet implemented)" disabled><span class="codicon codicon-redo"></span></button>

    <div class="tb-sep"></div>

    <!-- Nav (stubs) -->
    <button class="iconBtn" title="Entrances (not yet implemented)" disabled><span class="codicon codicon-sign-in"></span></button>
    <button class="iconBtn" title="Exits (not yet implemented)" disabled><span class="codicon codicon-sign-out"></span></button>

    <!-- Right-aligned: settings gear + level info -->
    <div style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0;">
      <button class="iconBtn" style="color:#e8a72b;" title="Level settings (not yet implemented)" disabled><span class="codicon codicon-settings-gear"></span></button>
      <span id="map-id" style="font-family:monospace;font-size:11px;color:#aaa;white-space:nowrap;"></span>
    </div>

  </div><!-- #toolbar -->

  <!-- ── MAIN CANVAS (center bottom) ──────────────────────────────────────── -->
  <div id="main" style="grid-area:main;display:flex;flex-direction:column;overflow:hidden;position:relative;">
    <div id="canvas-wrap" style="flex:1;overflow:auto;position:relative;background:#111111;cursor:crosshair;min-height:0;">
      <div id="level-spacer" style="position:absolute;top:0;left:0;pointer-events:none;"></div>
      <canvas id="model-canvas" style="position:sticky;top:0;left:0;display:block;image-rendering:pixelated;"></canvas>
    </div>
    <div id="minimap-wrap" style="flex-shrink:0;background:#0a0a0a;border-top:1px solid #3a3a3a;padding:4px 8px;display:flex;align-items:center;justify-content:center;">
      <canvas id="minimap-canvas" style="display:block;image-rendering:pixelated;cursor:pointer;background:#000;"></canvas>
    </div>
    <!-- Hidden meta elements kept for backward compat -->
    <span id="st-info"  style="display:none;"></span>
    <span id="map-meta" style="display:none;"></span>
    <!-- Hidden checkbox inputs: bridge for legacy event handlers -->
    <input type="checkbox" id="chk-l1"      checked style="display:none">
    <input type="checkbox" id="chk-l2"      checked style="display:none">
    <input type="checkbox" id="chk-l3"      checked style="display:none">
    <input type="checkbox" id="chk-sprites" checked style="display:none">
    <input type="checkbox" id="chk-screens"         style="display:none">
    <input type="checkbox" id="chk-block"           style="display:none">
    <input type="checkbox" id="chk-l3hud"           style="display:none">
    <input type="checkbox" id="chk-camera"          style="display:none">
    <input type="checkbox" id="chk-surfaces"        style="display:none">
    <input type="checkbox" id="chk-walls"           style="display:none">
    <input type="checkbox" id="chk-scrollpath"      style="display:none">
  </div><!-- #main -->

  <!-- ── RIGHT PANEL ──────────────────────────────────────────────────────── -->
  <div id="right-panel" style="
    grid-area:right;display:flex;flex-direction:column;overflow:hidden;
    background:var(--vscode-sideBar-background,#252526);
    border-left:1px solid var(--vscode-panel-border,#3a3a3a);">

    <!-- Dynamic inspector header -->
    <div id="props-hdr" style="
      padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);
      font-size:11px;min-height:30px;flex-shrink:0;display:flex;align-items:center;">
      <span id="props-ctx" style="color:#888;font-style:italic;">Click a tile, sprite, or object…</span>
    </div>

    <!-- ── TOP: inspector context panes ───────────────────────────────────
         flex:1 here makes the inspector take all space NOT consumed by the
         middle (tabs) and bottom (switches) regions, which are sized below. -->
    <div id="pp-empty" style="flex:1 1 0;display:flex;align-items:center;justify-content:center;color:#444;font-size:11px;padding:16px;text-align:center;min-height:80px;"></div>
    <div id="pp-tile"   style="display:none;flex:1 1 0;padding:8px;overflow-y:auto;min-height:80px;font-size:11px;color:#ccc;"></div>
    <div id="pp-sprite" style="display:none;flex:1 1 0;padding:8px;overflow-y:auto;min-height:80px;font-size:11px;color:#ccc;"></div>
    <div id="pp-object" style="display:none;flex:1 1 0;padding:8px;overflow-y:auto;min-height:80px;font-size:11px;color:#ccc;"></div>

    <!-- ── MIDDLE: level/map property tabs ────────────────────────────────
         Tab strip is fixed-height; tab content area is bounded by max-height
         and scrolls internally so the strip + content together never push
         the bottom switches off-screen. -->
    <div class="tab-strip" role="tablist">
      <button class="tab-btn active" data-tab="general" role="tab">General</button>
      <button class="tab-btn"        data-tab="layer2"  role="tab">Layer 2</button>
      <button class="tab-btn"        data-tab="layer3"  role="tab">Layer 3</button>
      <button class="tab-btn"        data-tab="scroll"  role="tab" id="tab-btn-scroll">Scroll</button>
    </div>
    <div class="tab-content-wrap">

      <!-- ── Tab: GENERAL ──
           Level-wide settings + L1 / palette / tileset overrides.
           Most fields here are already editable selects (existing behavior). -->
      <div class="tab-pane" data-tab="general" style="padding:8px;display:flex;flex-direction:column;gap:8px;">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">BACK AREA COLOR</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <div id="back-area-swatch" style="width:16px;height:16px;flex-shrink:0;border:1px solid #555;border-radius:2px;"></div>
              <select id="sel-bg-color" style="${selStyle()}"></select>
            </div>
          </div>
          <div>
            <div style="${propLabelStyle()}">TIME LIMIT</div>
            <select id="sel-time-limit" style="${selStyle()}"></select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">FG PALETTE</div>
            <select id="sel-fg-palette" style="${selStyle()}"></select>
          </div>
          <!-- BG PALETTE: header.bgPalette (3-bit field, byte 0 bits 7-5).
               Selects 1 of 8 BackgroundPalettes variants → fills CGRAM rows
               0-1 cols 2-7. Affects ANY tile (L1, L2, L3) whose subtile
               palette index is 0 or 1. NOT an L2-specific knob — many levels
               have L2 tiles encoded with palette indices in the StandardColors
               range (4-7), which no header field controls. -->
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

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">TILESET (GFX)</div>
            <select id="sel-tileset" style="${selStyle()}"></select>
          </div>
          <div>
            <div style="${propLabelStyle()}">SPRITE SET</div>
            <select id="sel-sprite-set" style="${selStyle()}"></select>
          </div>
        </div>

        <div>
          <div style="${propLabelStyle()}">MUSIC</div>
          <div style="display:flex;gap:3px;align-items:center;">
            <button id="btn-music-prev" title="Previous track" style="${btnStyle()}">
              <span class="codicon codicon-debug-reverse-continue"></span>
            </button>
            <div style="position:relative;flex-shrink:0;">
              <button id="btn-music-vol" title="Volume" style="${btnStyle()}">
                <span class="codicon codicon-unmute"></span>
              </button>
              <div id="music-vol-popup" style="display:none;position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);background:var(--vscode-editor-background,#1e1e1e);border:1px solid var(--vscode-widget-border,#454545);border-radius:4px;padding:6px 4px;z-index:100;">
                <input id="slider-music-vol" type="range" min="0" max="1.5" step="0.01" value="1"
                  style="writing-mode:vertical-lr;direction:rtl;width:22px;height:80px;cursor:pointer;accent-color:var(--vscode-focusBorder,#007acc);">
              </div>
            </div>
            <select id="sel-music" style="${selStyle()};flex:1;min-width:0;"></select>
            <button id="btn-music-play" title="Play music" style="${btnStyle()}">
              <span class="codicon codicon-debug-start"></span>
            </button>
            <button id="btn-music-next" title="Next track" style="${btnStyle()}">
              <span class="codicon codicon-debug-continue"></span>
            </button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">LEVEL MODE</div>
            <select id="sel-level-mode" style="${selStyle()}"></select>
          </div>
          <div>
            <div style="${propLabelStyle()}">ITEM MEMORY</div>
            <select id="sel-item-memory" style="${selStyle()}"></select>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">SCREENS</div>
            <div id="info-screens" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
          <div>
            <div style="${propLabelStyle()}">SPRITES</div>
            <div id="info-sprites" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
        </div>

      </div><!-- /tab-pane general -->

      <!-- ── Tab: LAYER 2 ──
           Currently empty placeholder — reserved for future L2-only
           knobs (palette OR mask, atlas override, etc.). All L2
           SCROLL controls live on the Scroll tab. -->
      <div class="tab-pane" data-tab="layer2" style="padding:8px;display:none;flex-direction:column;gap:8px;">
        <div style="${propLabelStyle()};color:#888;">No Layer 2 controls available for this level.</div>
      </div><!-- /tab-pane layer2 -->

      <!-- ── Tab: LAYER 3 ──
           Routine summary from readL3RoutineSummary in L3Loader.ts plus the
           L3 priority bit from header byte 2 bit 7. -->
      <div class="tab-pane" data-tab="layer3" style="padding:8px;display:none;flex-direction:column;gap:8px;">

        <div style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="chk-l3-priority" />
          <label for="chk-l3-priority" style="${propLabelStyle()};margin:0;cursor:pointer;">L3 PRIORITY (BG3 in front of sprites)</label>
        </div>

        <div>
          <div style="${propLabelStyle()}">SETTING</div>
          <select id="sel-l3-setting" style="${selStyle()}"></select>
        </div>

        <!-- Read-only derived values: $009F88 byte, kind, init Y. These come
             from (tileset, layer3Setting) and so cannot be edited directly —
             they're outputs of the routine summary, not inputs. -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">$009F88</div>
            <div id="info-l3-byte" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
          <div>
            <div style="${propLabelStyle()}">INIT Y</div>
            <div id="info-l3-init-y" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
        </div>

        <div>
          <div style="${propLabelStyle()}">KIND</div>
          <div id="info-l3-kind" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
        </div>

      </div><!-- /tab-pane layer3 -->

      <!-- ── Tab: SCROLL ──
           Always visible. Top section (BG parallax rates + L1 V-scroll
           mode) renders for every level. The auto-scroll subsections
           below show only when the level has a scroll sprite (path data
           was shipped); the L2 slider shows for any object-stream L2.

           Render modes for the L2 slider:
             - Auto-scroll level: slider value = scrollPath frame index.
               L2ObjectStream.render shifts the entire L2 plane by
               (Layer1Pos − Layer2Pos) at the chosen frame.
             - Object-stream L2 only (no scroll sprite): slider value =
               raw Layer2YPos override 0..255 (legacy fallback).

           The Link button (when both L1 + L2 sliders are present) ties
           the two slider values together so a single scrub moves both
           viewports in lock-step. Default ON. The Loop button toggles
           wrap-around playback at the path end. -->
      <div class="tab-pane" data-tab="scroll" style="padding:8px;display:flex;flex-direction:column;gap:10px;">

        <!-- Always-visible header values: per-level parallax rates +
             L1 V-scroll mode override. -->
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

        <div>
          <div style="${propLabelStyle()}">L1 V-SCROLL MODE (HDR)</div>
          <select id="sel-vscroll-hdr" style="${selStyle()}"></select>
        </div>

        <!-- Auto-scroll level header: scroll sprite + path-overlay toggle.
             Hidden on levels without a scroll sprite. -->
        <div id="scroll-autoscroll-section" style="display:none;flex-direction:column;gap:8px;">

          <div>
            <div style="${propLabelStyle()}">SCROLL SPRITE</div>
            <div id="info-scroll-sprite" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>

          <div style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="chk-scrollpath-panel" />
            <label for="chk-scrollpath-panel" style="${propLabelStyle()};margin:0;cursor:pointer;">SHOW VIEWPORT PATH</label>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="chk-follow-scroll" checked />
            <label for="chk-follow-scroll" style="${propLabelStyle()};margin:0;cursor:pointer;">follow viewport path</label>
          </div>
          <!-- Cmd-specific gameplay-state inputs. Each is shown only
               when the active scroll cmd reads that state - see
               refreshScrollSliderVisibility. Toggling rebuilds the
               simulator with the new seed so playback / scrubbing
               reflects the new dynamics immediately. -->
          <div id="row-onoff-switch" style="display:none;align-items:center;gap:6px;">
            <input type="checkbox" id="chk-onoff-switch" />
            <label for="chk-onoff-switch" style="${propLabelStyle()};margin:0;cursor:pointer;">ON/OFF SWITCH (cmd $0B)</label>
          </div>
          <div id="row-layer2-touched" style="display:none;align-items:center;gap:6px;">
            <input type="checkbox" id="chk-layer2-touched" />
            <label for="chk-layer2-touched" style="${propLabelStyle()};margin:0;cursor:pointer;">MARIO TOUCHING L2 (cmd $0E)</label>
          </div>

          <!-- Playback row. Play / Stop / Loop / Link share the
               .btn-action class for consistent border + #ccc text
               (same visual as the toolbar music buttons via
               btnStyle()). Toggle state is signaled via the .active
               modifier (color + border-color shift to #5b9cf6) which
               the JS adds/removes on click. -->
          <div style="display:flex;align-items:center;gap:6px;">
            <button id="btn-scroll-play" class="btn-action" title="Play scroll routine">
              <span class="codicon codicon-play"></span>
            </button>
            <button id="btn-scroll-stop" class="btn-action" title="Stop scroll routine">
              <span class="codicon codicon-debug-stop"></span>
            </button>
            <button id="btn-scroll-loop" class="btn-action" title="Loop playback at end of scroll path">
              <span class="codicon codicon-debug-restart"></span>
            </button>
            <select id="sel-scroll-speed" class="sel-action" style="max-width:80px;">
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
              <option value="8">8x</option>
            </select>
          </div>

        </div><!-- /scroll-autoscroll-section -->

        <!-- Single FRAME counter label — shown only for auto-scroll
             levels. Format: "FRAME 12 / 7800". Positioned above the
             slider stack so the user reads the active frame above the
             slider that scrubs it. -->
        <div id="scroll-frame-counter" style="display:none;align-items:center;">
          <span id="lbl-scroll-frame" style="${propLabelStyle()}">FRAME 0 / —</span>
        </div>

        <!-- Slider stack: L1 row (auto-scroll only) + L2 row
             (object-stream L2). Link button to the LEFT of the
             stack, vertically centered between the two rows. The
             whole block is hidden when neither slider would be
             meaningful. -->
        <div id="scroll-sliders-section" style="display:none;flex-direction:row;align-items:center;gap:8px;">
          <button id="btn-scroll-link" class="btn-action" title="Link L1/L2 sliders"
            style="display:none;align-self:center;min-height:48px;">
            <span class="codicon codicon-link"></span>
          </button>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;">
            <div id="row-rng-l1" style="display:none;align-items:center;gap:6px;">
              <span style="${propLabelStyle()};margin:0;width:18px;flex-shrink:0;">L1</span>
              <input id="rng-scroll-frame" type="range" min="0" max="1000" step="1" value="0" style="flex:1;min-width:0;" />
            </div>
            <div id="row-rng-l2" style="display:none;align-items:center;gap:6px;">
              <span style="${propLabelStyle()};margin:0;width:18px;flex-shrink:0;">L2</span>
              <input id="rng-l2y" type="range" min="0" max="255" step="1" value="0" style="flex:1;min-width:0;" />
            </div>
          </div>
        </div>

      </div><!-- /tab-pane scroll -->

    </div><!-- /tab-content-wrap -->

    <!-- ── BOTTOM: switch-state toggles, anchored ─────────────────────────
         flex:0 0 auto so this region keeps its content height regardless of
         how the inspector and tabs grow. Border-top separates it visually
         from the tab-content area above. -->
    <div class="switch-state-anchor">
      <div style="padding:8px;">
        <div style="${propLabelStyle()};margin-bottom:4px;">SWITCH STATE</div>
        <div id="switch-toggles" style="display:flex;gap:6px;justify-content:space-between;">
          <button class="pswitch-toggle" data-pcolor="blue" title="Blue P-switch — swaps coins ↔ used blocks and reveals hidden doors / ? blocks">
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

  </div><!-- #right-panel -->

</div><!-- #workspace -->

<style>
  .iconBtn {
    background: transparent; border: none; color: #ccc;
    width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; padding: 0; flex-shrink: 0; pointer-events: all;
  }
  .iconBtn:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
  .iconBtn.on { color: #5b9cf6; }
  .iconBtn:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Bordered icon-only action buttons (Play / Stop / Loop / Link in
     the Scroll tab playback row). Same visual language as btnStyle()
     but exposed as a CSS class so toggle-active styling can use a
     classList swap instead of inline style.borderColor mutation. */
  .btn-action {
    background: transparent; border: 1px solid #555; color: #ccc;
    border-radius: 3px; cursor: pointer; padding: 3px 10px;
    font-size: 11px; line-height: 1; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; min-height: 22px;
  }
  .btn-action:hover:not(:disabled) { background: rgba(255,255,255,0.08); border-color: #777; }
  .btn-action.active { color: #5b9cf6; border-color: #5b9cf6; }
  .btn-action:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Scroll-tab dropdown for playback speed. Matches selStyle() so
     the speed picker visually pairs with the action buttons. */
  .sel-action {
    background: var(--vscode-dropdown-background,#3c3c3c);
    color: var(--vscode-dropdown-foreground,#ccc);
    border: 1px solid #555; border-radius: 3px;
    height: 22px; font-size: 11px; cursor: pointer;
  }

  .layerBtn { transition: opacity 0.15s; }
  .layerBtn:not(.on) { opacity: 0.4; }

  .canvas-float-btn { background: rgba(0,0,0,0.55); border-radius: 4px; }
  .canvas-float-btn:hover:not(:disabled) { background: rgba(0,0,0,0.75); }

  .tb-sep { width:1px;height:20px;background:var(--vscode-panel-border,#444);margin:0 2px;flex-shrink:0; }

  .tab-btn {
    background: transparent; border: none; border-bottom: 2px solid transparent;
    color: #888; padding: 0 8px; height: 100%; cursor: pointer;
    font-size: 11px; font-family: var(--vscode-font-family, system-ui);
    transition: color 0.15s, border-bottom-color 0.15s; flex-shrink: 0;
  }
  .tab-btn.active { color: #e0e0e0; border-bottom-color: #007acc; }
  .tab-btn:hover:not(.active) { color: #ccc; }

  /* Right-panel tab strip + content wrapper. .tab-btn (defined above) renders
     correctly inside this 30px-tall flex strip. The content wrap caps its
     own height with max-height so it shares space with the inspector above
     and never pushes the bottom switch-state row off-screen. */
  #right-panel .tab-strip {
    display: flex; flex-shrink: 0; height: 30px; overflow: hidden;
    border-top: 1px solid var(--vscode-panel-border, #3a3a3a);
    border-bottom: 1px solid var(--vscode-panel-border, #3a3a3a);
  }
  #right-panel .tab-strip .tab-btn { flex: 1 1 0; }
  #right-panel .tab-content-wrap {
    flex: 0 1 auto; min-height: 0; overflow-y: auto;
    /* Cap so the inspector above keeps usable height in short windows. */
    max-height: 50vh;
  }
  #right-panel .switch-state-anchor {
    flex: 0 0 auto; flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border, #3a3a3a);
  }

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
const levelSpacer    = document.getElementById('level-spacer') as HTMLDivElement
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
const chkL3          = document.getElementById('chk-l3')          as HTMLInputElement
const chkL3Hud       = document.getElementById('chk-l3hud')       as HTMLInputElement
const chkCamera      = document.getElementById('chk-camera')      as HTMLInputElement
const chkSurfaces    = document.getElementById('chk-surfaces')    as HTMLInputElement
const chkWalls       = document.getElementById('chk-walls')       as HTMLInputElement
const chkScrollPath  = document.getElementById('chk-scrollpath')  as HTMLInputElement

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

// ── Blue P-switch toggle ─────────────────────────────────────────────────────
// Two sources of substitution, composed in drawL1TileAt:
//   1. Data-driven swap — each Map16 tile def carries `pSwitchSub`, the
//      ROM-derived substitute tile ID for P-switch activation (CODE_00F545 /
//      CODE_00F577). When the toggle is ON we render that substitute at full
//      alpha instead of the original. Populated in rom/Map16.ts.
//   2. UI-only reveal — webview-specific alpha-preview of tiles that are
//      effectively invisible in the editor (hidden ? block, invisible coin
//      block) or use a non-obvious palette (silver doors). Not in the ROM's
//      P-switch logic; it's a hint so users can see what's there without
//      toggling. Alpha is 50% when OFF, 100% when ON.
let pSwitchBlueOn = false  // eslint-disable-line prefer-const

interface PSwitchRevealBehavior {
  substitute: number
  /** If set, composite the substitute's chars with this palette instead of using the atlas. */
  palOverride?: number
}

function pSwitchReveal(tileId: number): PSwitchRevealBehavior | null {
  if ((tileId & ~0xFF) !== 0) return null
  switch (tileId) {
    case 0x27: return { substitute: 0x1F, palOverride: 4 }  // silver door top
    case 0x28: return { substitute: 0x20, palOverride: 4 }  // silver door bottom
    case 0x29: return { substitute: 0x24 }                  // invisible ? block
    case 0x2A: return { substitute: 0x2B }                  // invisible coin block
    default: return null
  }
}

function blitSubTile(
  indexed: Uint8Array, palRows: number[][][],
  sub: { c: number; p: number; fx: boolean; fy: boolean },
  dest: Uint8ClampedArray, destX: number, destY: number, destW: number,
): void {
  const srcOff = sub.c * 64
  const pal = palRows[sub.p] ?? palRows[0]
  for (let py = 0; py < 8; py++) {
    const sy = sub.fy ? 7 - py : py
    for (let px = 0; px < 8; px++) {
      const sx = sub.fx ? 7 - px : px
      const palIdx = indexed[srcOff + sy * 8 + sx] ?? 0
      const dx2 = destX + px, dy2 = destY + py
      const di = (dy2 * destW + dx2) * 4
      if (palIdx === 0) {
        dest[di] = dest[di + 1] = dest[di + 2] = 0; dest[di + 3] = 0
      } else {
        const c = pal[palIdx] ?? [255, 0, 255, 255]
        dest[di] = c[0]; dest[di + 1] = c[1]; dest[di + 2] = c[2]; dest[di + 3] = 255
      }
    }
  }
}

function applySwitchPalaceState(tileId: number): number {
  const low = tileId & 0xFF
  if (low < 0x6A || low > 0x6D) return tileId
  const colorIdx = low - 0x6A
  return (store.switchPalaceState[colorIdx] ? 0x100 : 0x000) | low
}

/** Cached per-tile 16×16 canvases composed with a palette override. Cleared
 *  whenever VRAM or palette changes, same lifecycle as map16AtlasCanvas. */
const palOverrideCache = new Map<number, HTMLCanvasElement>()

function getPalOverrideCanvas(tileId: number, palOverride: number): HTMLCanvasElement | null {
  const key = (tileId << 8) | palOverride
  const cached = palOverrideCache.get(key)
  if (cached) return cached
  if (!activeVramIndexed || !mapData?.paletteRows || !mapData.map16Defs) return null
  const def = mapData.map16Defs[tileId]
  if (!def) return null
  const buf = new Uint8ClampedArray(16 * 16 * 4)
  const subs = [
    { s: def.tl, dx: 0, dy: 0 },
    { s: def.tr, dx: 8, dy: 0 },
    { s: def.bl, dx: 0, dy: 8 },
    { s: def.br, dx: 8, dy: 8 },
  ]
  for (const { s, dx, dy } of subs) {
    blitSubTile(activeVramIndexed, mapData.paletteRows,
      { c: s.c, p: palOverride, fx: s.fx, fy: s.fy }, buf, dx, dy, 16)
  }
  const canvas = document.createElement('canvas')
  canvas.width = 16; canvas.height = 16
  canvas.getContext('2d')!.putImageData(new ImageData(buf, 16, 16), 0, 0)
  palOverrideCache.set(key, canvas)
  return canvas
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
 * goes through editorStore reads (via Char.getPixels / Tile.render /
 * Palette.row) and the per-map mapStore, so when this function runs
 * inside the reactive effect it auto-retracks animation / pswitch /
 * palette-cycle changes and re-renders on each tick.
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
  const mapStore = map.mapStore

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
    const pixels = char.getPixels()
    // Palette-row convention matches VRAM viewer: $000-$17F → row 2
    // (FG terrain), $180-$2FF → row 6 (AN / sprite-slot), $300+ → row 8.
    const palRowIdx = charNum < 0x180 ? 2 : charNum < 0x300 ? 6 : 8
    const paletteRow = map.palette.row(palRowIdx)
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
      tile.render(target, cellBox, mapStore, 'nonPriority')
      tile.render(target, cellBox, mapStore, 'priority')
    }
    target.flush()
  }
}

// ── Tile viewer hover highlight ───────────────────────────────────────────────
let vramHoverTile: { col: number; row: number } | null = null
let map16HoverTile: { col: number; row: number } | null = null

// ── Tile viewer grid toggles ─────────────────────────────────────────────────
const vramGridOn = false
const map16GridOn = false
const palGridOn = false
let mapGridOn = false
let minimapOn = true
document.getElementById('btn-map-minimap')!.addEventListener('click', () => {
  minimapOn = !minimapOn
  document.getElementById('btn-map-minimap')!.classList.toggle('on', minimapOn)
  const wrap = document.getElementById('minimap-wrap')!
  wrap.style.display = minimapOn ? 'flex' : 'none'
  if (minimapOn) drawMinimap()
})

// ── Toolbar tile-grid button ──────────────────────────────────────────────────
document.getElementById('btn-map-grid-tb')?.addEventListener('click', () => {
  mapGridOn = !mapGridOn
  store.setLayerToggle('mapGrid', mapGridOn)
  const toolbar = document.getElementById('btn-map-grid-tb')
  if (toolbar) toolbar.style.color = mapGridOn ? '#5b9cf6' : '#ccc'
})

// ── Tab switching ─────────────────────────────────────────────────────────────
const TAB_NAMES = ['vram', 'map16', 'objects', 'sprites'] as const
function switchTab(tab: typeof TAB_NAMES[number]): void {
  for (const t of TAB_NAMES) {
    const panel = document.getElementById(`panel-${t}`)
    const btn   = document.getElementById(`tab-${t}`)
    if (panel) panel.style.display = t === tab ? '' : 'none'
    if (btn)   btn.classList.toggle('active', t === tab)
  }
}
for (const t of TAB_NAMES) {
  document.getElementById(`tab-${t}`)?.addEventListener('click', () => switchTab(t))
}

// ── Right-panel tab switching ────────────────────────────────────────────────
// Scoped via the `.tab-strip` parent inside #right-panel so this is independent
// of the left-panel tab JS above (which selects by ID, not by class).
{
  const rightTabStrip = document.querySelector<HTMLElement>('#right-panel .tab-strip')
  const rightTabPanes = Array.from(
    document.querySelectorAll<HTMLElement>('#right-panel .tab-content-wrap .tab-pane'),
  )
  if (rightTabStrip) {
    const rightTabBtns = Array.from(rightTabStrip.querySelectorAll<HTMLButtonElement>('.tab-btn'))
    const switchRightTab = (tabName: string): void => {
      for (const btn of rightTabBtns) {
        btn.classList.toggle('active', btn.dataset['tab'] === tabName)
      }
      for (const pane of rightTabPanes) {
        // Active pane uses flex (grid rows inside); inactive panes hide.
        pane.style.display = pane.dataset['tab'] === tabName ? 'flex' : 'none'
      }
    }
    for (const btn of rightTabBtns) {
      const tabName = btn.dataset['tab']
      if (tabName) btn.addEventListener('click', () => switchRightTab(tabName))
    }
  }
}

// ── Layer icon button → hidden checkbox bridge ────────────────────────────────
// Each icon button flips the backing hidden <input type="checkbox"> and fires
// its 'change' event so the existing syncLayerTogglesFromDom handler picks it up.
function wireLayerBtn(btnId: string, chkId: string): void {
  const btn = document.getElementById(btnId)
  const chk = document.getElementById(chkId) as HTMLInputElement | null
  if (!btn || !chk) return
  btn.classList.toggle('on', chk.checked)
  btn.addEventListener('click', () => {
    chk.checked = !chk.checked
    chk.dispatchEvent(new Event('change'))
    btn.classList.toggle('on', chk.checked)
  })
}
wireLayerBtn('btn-l1',       'chk-l1')
wireLayerBtn('btn-l2',       'chk-l2')
wireLayerBtn('btn-l3',       'chk-l3')
wireLayerBtn('btn-sprites',  'chk-sprites')
wireLayerBtn('btn-surfaces', 'chk-surfaces')
wireLayerBtn('btn-walls',    'chk-walls')
wireLayerBtn('btn-block',    'chk-block')
wireLayerBtn('btn-screens',  'chk-screens')
wireLayerBtn('btn-hud',      'chk-l3hud')

// Camera icon button wires into the existing chkCamera handler.
{
  const btn = document.getElementById('btn-camera')
  const chk = document.getElementById('chk-camera') as HTMLInputElement | null
  if (btn && chk) {
    btn.addEventListener('click', () => {
      chk.checked = !chk.checked
      chk.dispatchEvent(new Event('change'))
      btn.classList.toggle('on', chk.checked)
    })
  }
}

// ── Dynamic properties panel ──────────────────────────────────────────────────
// Pane switching and the sprite pane body live in ./propsPane so they can
// be exercised without a DOM implementation; this wrapper just binds the
// browser document.
function setPropContext(type: PropContext, label = ''): void {
  paneSetPropContext(document, type, label)
}

// ── Sprite properties panel ──────────────────────────────────────────────────
// The store holds only the `id:x,y` key (it drives the reactive repaint);
// the Sprite itself is kept here because the store must stay free of model
// classes. The two are only ever written together, by these two functions.
let selectedSprite: Sprite | null = null

function selectSprite(sprite: Sprite): void {
  selectedSprite = sprite
  store.setSelectedSprite(spriteSelectionKey(sprite))
  showSpriteProps(document, sprite, mapData?.paletteRows ?? [])
}

/** Drop the sprite selection. Any other pick context replaces it. */
function clearSpriteSelection(): void {
  selectedSprite = null
  store.setSelectedSprite(null)
}

// ── Tile properties panel ────────────────────────────────────────────────────
type Map16DefEntry = NonNullable<MapPayload['map16Defs']>[number]

function populateTileProps(tileId: number, def: Map16DefEntry | undefined): void {
  const pp = document.getElementById('pp-tile')!
  if (!def || !mapData) {
    pp.innerHTML = '<span style="color:#555;font-style:italic;">No data</span>'
    return
  }
  const palRow = def.tl.p
  const colors = mapData.paletteRows[palRow] ?? []
  const swatches = colors.map(([r, g, b]: number[]) =>
    `<span style="display:inline-block;width:9px;height:9px;background:rgb(${r},${g},${b});flex-shrink:0;"></span>`
  ).join('')
  const hex = (n: number) => `$${n.toString(16).padStart(3, '0').toUpperCase()}`
  pp.innerHTML = `
    <div style="margin-bottom:8px;">
      <div style="font-size:9px;font-weight:700;letter-spacing:.08em;color:#888;margin-bottom:4px;">PALETTE ROW</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-family:monospace;color:#ccc;">${palRow}</span>
        <div style="display:flex;gap:1px;flex-wrap:wrap;">${swatches}</div>
      </div>
    </div>
    <div>
      <div style="font-size:9px;font-weight:700;letter-spacing:.08em;color:#888;margin-bottom:4px;">SUBTILES</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;font-family:monospace;font-size:11px;">
        <div><span style="color:#666;">TL </span><span style="color:#5b9cf6;">${hex(def.tl.c)}</span></div>
        <div><span style="color:#666;">TR </span><span style="color:#5b9cf6;">${hex(def.tr.c)}</span></div>
        <div><span style="color:#666;">BL </span><span style="color:#5b9cf6;">${hex(def.bl.c)}</span></div>
        <div><span style="color:#666;">BR </span><span style="color:#5b9cf6;">${hex(def.br.c)}</span></div>
      </div>
    </div>`
}

// ── Animation ────────────────────────────────────────────────────────────────
// Three subscriptions on the one shared frame clock, each a pure event
// source. Sharing the clock is what holds tile animation and palette
// cycling in phase, as they are in game (both derive from `EffFrame`).
//   - mapAnimTimer   — ticks animated chars (tile-graphics). Cadence comes
//                       from `mapData.animation.intervalMs` so per-level
//                       tile-animation speed is configurable.
//   - spriteAnimTimer — ticks sprite appearances. Cadence is fixed
//                       (`SPRITE_ANIM_FRAMES`) so sprite cadence is
//                       independent of any level data.
//   - palAnimTimer   — increments `store.palAnimFrame` for CGRAM cycling.
//
// Tile chars and sprite appearances own their own frame state internally
// and advance via `tickAnimation()`. The timers carry no counter — each
// fire is just an event. To force the reactive render effect to re-run
// after a tick, the timer bumps a `shallowRef` event source (`mapTick`
// or `spriteTick`); the render effect reads both values to register a
// dep. The carried number is irrelevant — only the mutation matters.
let mapIntervalMs = 133
let palAnimIntervalMs = 133
let mapAnimEnabled = false  // true when the loaded map declares animated tiles

/** Shared with the draw engine's ROM_FRAMES_PER_TICK, so a tick means the
 *  same number of game frames on both sides. Replaces an uncited 125 ms. */
const SPRITE_ANIM_FRAMES = SPRITE_ANIM_FRAME_STRIDE

const mapTick = shallowRef(0)
const spriteTick = shallowRef(0)

function applyPalAnimFrame(f: number): void {
  store.setPalAnimFrame(f)
}

const mapAnimTimer = frameClock.every(
  () => msToFrames(mapIntervalMs),
  () => {
    const chars = window.__smwModelChars
    if (chars) for (const ch of chars.values()) ch.tickAnimation()
    mapTick.value++
  },
)

const spriteAnimTimer = frameClock.every(
  () => SPRITE_ANIM_FRAMES,
  () => {
    const map = window.__smwModelMap
    if (map) for (const spr of map.sprites) spr.tickAnimation()
    spriteTick.value++
  },
)

const palAnimTimer = frameClock.every(
  () => msToFrames(palAnimIntervalMs),
  () => {
    const frameCount = mapData?.paletteAnimation?.frameCount ?? 8
    applyPalAnimFrame((store.palAnimFrame + 1) % frameCount)
  },
)

function syncPalAnimButton(): void {
  const btn = document.getElementById('btn-pal-play')
  if (btn) btn.innerHTML = palAnimTimer.running ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'
}

function startPalAnimTimer(): void {
  if (!mapData?.paletteAnimation) return
  palAnimIntervalMs = mapData.paletteAnimation.intervalMs
  palAnimTimer.start()
  syncPalAnimButton()
}

function stopPalAnimTimer(): void {
  palAnimTimer.stop()
  syncPalAnimButton()
}

function togglePalAnim(): void {
  if (palAnimTimer.running) stopPalAnimTimer()
  else startPalAnimTimer()
}

const palPlayBtn = document.getElementById('btn-pal-play')
if (palPlayBtn) palPlayBtn.addEventListener('click', togglePalAnim)

const animPlayBtns = [
  document.getElementById('btn-play')!,
]

function syncAnimButtons(): void {
  const running = spriteAnimTimer.running
  for (const btn of animPlayBtns) {
    btn.innerHTML = running ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'
    btn.title = running ? 'Pause animation' : 'Play animation'
    btn.classList.toggle('on', running)
  }
}

function toggleAnim(): void {
  if (spriteAnimTimer.running) {
    stopAnimTimer()
    if (palAnimTimer.running) stopPalAnimTimer()
  } else {
    startAnimTimer()
    if (mapData?.paletteAnimation) startPalAnimTimer()
  }
  syncAnimButtons()
}

for (const btn of animPlayBtns) btn.addEventListener('click', toggleAnim)

// ── Sprite engine A/B toggle (scaffolding) ───────────────────────────────────
// Flipping either button mutates the reactive store; `Sprite.render` reads
// `spriteEngine` inside the render effect, so the map redraws on the spot:
// no ROM reload, no map reopen, no host round trip.
const spriteEngineBtn = document.getElementById('btn-sprite-engine')!
const spriteEngineMarkBtn = document.getElementById('btn-sprite-engine-mark')!

function syncSpriteEngineButtons(): void {
  const on = store.spriteEngine
  spriteEngineBtn.classList.toggle('on', on)
  spriteEngineBtn.title = on ? 'Sprite engine (comparison, ON)' : 'Sprite engine (comparison, off)'
  spriteEngineMarkBtn.style.display = on ? '' : 'none'
  spriteEngineMarkBtn.classList.toggle('on', store.spriteEngineMarkers)
}

spriteEngineBtn.addEventListener('click', () => {
  store.setSpriteEngine(!store.spriteEngine)
  syncSpriteEngineButtons()
})
spriteEngineMarkBtn.addEventListener('click', () => {
  store.setSpriteEngineMarkers(!store.spriteEngineMarkers)
  syncSpriteEngineButtons()
})
syncSpriteEngineButtons()

function startAnimTimer(): void {
  spriteAnimTimer.start()
  if (mapAnimEnabled) mapAnimTimer.start()
}

function stopAnimTimer(): void {
  spriteAnimTimer.stop()
  mapAnimTimer.stop()
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
 * AnimatedPixelsBehavior / PSwitchAlternateBehavior / etc. all reflect current
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
    const paletteRow = palette.row(palRowIdx)

    const tileCol = ti % tilesPerRow
    const tileRow = Math.floor(ti / tilesPerRow)
    const dx0 = tileCol * 8
    const dy0 = tileRow * 8

    if (!char) continue // unmapped slot → leave transparent
    const pixels = char.getPixels()
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
  const mapStore = map.mapStore

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
      tile.render(target, cellBox, mapStore, 'nonPriority')
      tile.render(target, cellBox, mapStore, 'priority')
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
interface Map16PageEntry { pageInAtlas: number; pageNum: number; label: string }
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
// New editable controls (Plan A: render overrides; no ROM write yet).
// Music / level mode / item memory / L1 V-scroll-mode have no current render
// path that honors the override — the controls echo back via the rerender
// pipeline so the selected value sticks across re-renders, but the rendered
// editor doesn't visibly change. Step 3 (ROM write-back) will wire actual
// edits.
const selMusic       = document.getElementById('sel-music')        as HTMLSelectElement
const btnMusicPrev   = document.getElementById('btn-music-prev')   as HTMLButtonElement
const btnMusicVol    = document.getElementById('btn-music-vol')    as HTMLButtonElement
const musicVolPopup  = document.getElementById('music-vol-popup')  as HTMLDivElement
const sliderMusicVol = document.getElementById('slider-music-vol') as HTMLInputElement
const btnMusicPlay   = document.getElementById('btn-music-play')   as HTMLButtonElement
const btnMusicNext   = document.getElementById('btn-music-next')   as HTMLButtonElement
const selTimeLimit   = document.getElementById('sel-time-limit')   as HTMLSelectElement
const selLevelMode   = document.getElementById('sel-level-mode')   as HTMLSelectElement
const selItemMemory  = document.getElementById('sel-item-memory')  as HTMLSelectElement
const selVScrollHdr  = document.getElementById('sel-vscroll-hdr')  as HTMLSelectElement
const rngL2y         = document.getElementById('rng-l2y')         as HTMLInputElement
const infoScrollSprite   = document.getElementById('info-scroll-sprite')   as HTMLDivElement
const chkScrollPathPanel  = document.getElementById('chk-scrollpath-panel')  as HTMLInputElement
const chkFollowScroll     = document.getElementById('chk-follow-scroll')      as HTMLInputElement
const chkOnOffSwitch      = document.getElementById('chk-onoff-switch')       as HTMLInputElement
const rowOnOffSwitch      = document.getElementById('row-onoff-switch')       as HTMLDivElement
const chkLayer2Touched    = document.getElementById('chk-layer2-touched')     as HTMLInputElement
const rowLayer2Touched    = document.getElementById('row-layer2-touched')     as HTMLDivElement
const btnScrollPlay      = document.getElementById('btn-scroll-play')      as HTMLButtonElement
const btnScrollStop      = document.getElementById('btn-scroll-stop')      as HTMLButtonElement
const btnScrollLoop      = document.getElementById('btn-scroll-loop')      as HTMLButtonElement
const btnScrollLink      = document.getElementById('btn-scroll-link')      as HTMLButtonElement
const selScrollSpeed     = document.getElementById('sel-scroll-speed')     as HTMLSelectElement
const rngScrollFrame     = document.getElementById('rng-scroll-frame')     as HTMLInputElement
const lblScrollFrame     = document.getElementById('lbl-scroll-frame')     as HTMLSpanElement
const scrollAutoscrollSection = document.getElementById('scroll-autoscroll-section') as HTMLDivElement
const scrollSlidersSection = document.getElementById('scroll-sliders-section') as HTMLDivElement
const rowRngL1           = document.getElementById('row-rng-l1')           as HTMLDivElement
const rowRngL2           = document.getElementById('row-rng-l2')           as HTMLDivElement
const scrollFrameCounter = document.getElementById('scroll-frame-counter') as HTMLDivElement
const tabBtnScroll       = document.getElementById('tab-btn-scroll')       as HTMLButtonElement
const tabPaneScroll      = document.querySelector<HTMLDivElement>('.tab-pane[data-tab="scroll"]')!
const tabPaneGeneral     = document.querySelector<HTMLDivElement>('.tab-pane[data-tab="general"]')!
const chkL3Priority  = document.getElementById('chk-l3-priority')  as HTMLInputElement
const selL3Setting   = document.getElementById('sel-l3-setting')   as HTMLSelectElement
// Read-only L3 derived fields (driven by the routine summary).
const infoL3Byte     = document.getElementById('info-l3-byte')!
const infoL3Kind     = document.getElementById('info-l3-kind')!
const infoL3InitY    = document.getElementById('info-l3-init-y')!

// ── State ────────────────────────────────────────────────────────────────────

let zoomIdx      = ZOOM_DEFAULT_IDX
let mapData: MapPayload | null = null
let l2TileGrid: number[][] | null = null

// Cached ROM bytes + scroll-sim seed from the most recent modelPayload.
// Used by the gameplay-state checkboxes (`chk-onoff-switch`,
// `chk-layer2-touched`) so toggling them can rebuild the simulator
// with a different `onOffSwitch` / `layer2Touched` seed value
// without round-tripping back to the host.
let cachedRom: import('../../rom/RomFile').RomFile | null = null
let cachedScrollSeed: import('../../rom/scrollSim').ScrollSimSeed | null = null

// ── Music playback ───────────────────────────────────────────────────────────
// SPC bytes keyed by bgmCommand; populated from the load payload.
const musicSpcCache = new Map<number, number[]>()
let musicIsPlaying = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let musicBackend: any = null

// spc.js WASM compilation is async — poll until the Backend object appears.
let _musicInitAttempts = 0
const _musicInitInterval = setInterval(() => {
  _musicInitAttempts++
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = (window as any).SMWCentral?.SPCPlayer?.Backend
  if (b?.status !== undefined) {
    clearInterval(_musicInitInterval)
    musicBackend = b
    if (musicBackend.status === 0) musicBackend.initialize()
  } else if (_musicInitAttempts > 30) {
    clearInterval(_musicInitInterval)
  }
}, 500)

function _setMusicPlayButton(playing: boolean): void {
  btnMusicPlay.innerHTML = playing
    ? '<span class="codicon codicon-debug-stop"></span>'
    : '<span class="codicon codicon-debug-start"></span>'
  btnMusicPlay.title = playing ? 'Stop music' : 'Play music'
  btnMusicPlay.disabled = false
}

// Must be called from a user gesture (click handler) — Chromium requires
// AudioContext.resume() to be within the gesture call stack on first play.
function _unlockAudioContext(): void {
  if (!musicBackend?.context) return
  musicBackend.locked = false
  ;(musicBackend.context as AudioContext).resume().catch(() => { /* ignore */ })
}

function stopMusicPlayback(): void {
  if (!musicIsPlaying) return
  musicBackend?.stopSPC(false)
  musicIsPlaying = false
  _setMusicPlayButton(false)
}

function startMusicPlayback(bgmCommand: number): void {
  if (!musicBackend) return
  const cached = musicSpcCache.get(bgmCommand)
  if (cached) {
    // AudioContext was already unlocked + resumed in the click handler above.
    try {
      musicBackend.loadSPC(new Uint8Array(cached))
      // spc.js UI init can leave the gain at 0; restore user's chosen volume
      if (musicBackend.gainNode) musicBackend.gainNode.gain.value = parseFloat(sliderMusicVol.value)
      musicIsPlaying = true
      _setMusicPlayButton(true)
    } catch (err) {
      console.error('[mapEditor] loadSPC failed:', err)
      _setMusicPlayButton(false)
    }
  } else {
    // Non-current track — fetch SPC on demand. AudioContext was already
    // unlocked in the click handler, so loadSPC will work when data arrives.
    btnMusicPlay.innerHTML = '<span class="codicon codicon-loading codicon-modifier-spin"></span>'
    btnMusicPlay.disabled = true
    vscode.postMessage({ type: 'requestMusicSpc', bgmCommand })
  }
}

// Legacy rendering state — re-introduced from pre-#62 stash. The model renderer
// owns main display; these back the block-mode and camera-viewport overlays.
const canvas = modelCanvas  // map-canvas was renamed model-canvas in #62
const ctx    = canvas.getContext('2d')!
// Off-screen full-level canvas (1× natural pixels). The viewport canvas blits
// from this on scroll; the minimap samples from it for its overview.
// baseLevelCanvas holds the same render WITHOUT the camera-viewport composite,
// so a camera drag can skip the expensive map.render() and just copy the base
// then re-apply the strip overlay.
let fullLevelCanvas: HTMLCanvasElement | null = null
let baseLevelCanvas: HTMLCanvasElement | null = null
let zoom     = ZOOM_STEPS[ZOOM_DEFAULT_IDX]
// CSS-pixel padding added to the spacer on each side so the level is centered
// when it's smaller than the canvas-wrap viewport. Horizontal levels get
// vertical padding (levelPadY); vertical levels get horizontal (levelPadX).
let levelPadX = 0
let levelPadY = 0
const activeVramIndexed: Uint8Array | null = null
const map16AtlasCanvas:    HTMLCanvasElement | null = null
const map16BgAtlasCanvas:  HTMLCanvasElement | null = null
const pipeVariantAtlasCanvases: (HTMLCanvasElement | null)[] = [null, null, null, null]
let cameraTileX  = 0
let cameraTileY  = 0
const cameraFocused = false
const activeTileId = -1
let activeTool: 'place' | 'erase' = 'place'
let isPainting   = false
// Which CGRAM cells to highlight in the palette panel (null = all at full brightness)
// Each entry: { row, colStart, colEnd } — highlights cols colStart..colEnd (inclusive)
interface PaletteHighlight { row: number; colStart: number; colEnd: number }
let paletteHighlightCells: PaletteHighlight[] | null = null

interface MapPayload {
  mapIndex:         number
  allBgmTracks?:    Array<{ bgmCommand: number }>
  currentBgmCommand?: number
  spcData?:         number[] | null
  screens:          number
  /** True if Layer 1 is vertical (ScreenMode bit 0 via VerticalTable). */
  isVertical?:     boolean
  tileGrid:        number[][]
  l2TileGrid?:     number[][] | null
  /** Truthy when the model payload includes a scroll-simulator seed —
   *  the slider scrubs scroll FRAME instead of raw Layer2YPos. Only
   *  passed for legacy payload diffing; the actual seed lives on
   *  `modelMapPayload.scrollSim` and rebuilds the simulator on
   *  rehydrate. The webview reads this boolean to switch slider modes. */
  scrollSim?: unknown
  sprites:         Array<{ x: number; y: number; spriteId: number }>
  backAreaColor:   [number, number, number, number]
  backAreaColors:  number[][]   // 8 variants × [r,g,b,a]
  paletteRows:     number[][][]   // 16 rows × 16 colors × [r,g,b,a]
  // Which atlas the L2 tile grid should sample:
  //   true  → map16BgAtlasCanvas  (preset BG; IDs are into Map16BGTiles)
  //   false → map16AtlasCanvas    (object-stream L2; IDs are regular Map16)
  l2UsesBgAtlas?: boolean
  // Map16 tile definitions for client-side composition.
  // pSwitchSub is L1-only (ROM-derived P-switch swap); L2 BG defs omit it.
  map16Defs?: Array<{
    id: number
    tl: { c: number; p: number; fx: boolean; fy: boolean }
    bl: { c: number; p: number; fx: boolean; fy: boolean }
    tr: { c: number; p: number; fx: boolean; fy: boolean }
    br: { c: number; p: number; fx: boolean; fy: boolean }
    pSwitchSub?: number | null
  }>
  // L2/BG Map16 tile defs (same shape). Enables per-frame L2 atlas rebuild.
  map16BgDefs?: Array<{
    id: number
    tl: { c: number; p: number; fx: boolean; fy: boolean }
    bl: { c: number; p: number; fx: boolean; fy: boolean }
    tr: { c: number; p: number; fx: boolean; fy: boolean }
    br: { c: number; p: number; fx: boolean; fy: boolean }
  }>
  // Pipe palette variants for tiles $133..$13A (see MAP16AppTable in bank_05.asm).
  // 4 variants × 8 tile defs. At render time, tiles in that range are
  // composited using pipeVariantDefs[screenPipeVariants[screen]][tileId-0x133].
  pipeVariantDefs?: Array<Array<{
    id: number
    tl: { c: number; p: number; fx: boolean; fy: boolean }
    bl: { c: number; p: number; fx: boolean; fy: boolean }
    tr: { c: number; p: number; fx: boolean; fy: boolean }
    br: { c: number; p: number; fx: boolean; fy: boolean }
  }>>
  // Per-screen variant index (0..3) for the pipe cycle.
  screenPipeVariants?: number[]
  // Raw indexed VRAM: 1 byte per pixel, 64 bytes per char, 1536 chars
  vramIndexedData?: number[]
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
    /** Initial Layer1YPos (camera Y) in pixels — see LevelHeaderDescriptor. */
    initialCameraYPx?: number
    /**
     * Initial Layer2YPos (BG2VOFS) byte from the L2 object-stream descriptor,
     * mirrored onto the header for convenient slider population. Optional —
     * only populated when L2 is object-stream.
     */
    initialLayer2YPx?: number
    /**
     * L1 scroll-sprite cmd byte (spriteId - $E7), or null when no scroll
     * sprite is present.
     */
    layer1ScrollCmd?: number | null
    /**
     * Post-setup Layer2ScrollCmd (computed via simulateScrollSetup from
     * the L1 sprite cmd + b0). Different from layer1ScrollCmd for cmds
     * that 16-bit-STA-remap during L1 setup. Drives the slider's bounds
     * lookup. null when no scroll sprite or the dispatch produces no L2
     * motion.
     */
    layer2ScrollCmd?: number | null
    /**
     * Layer 2 Y travel bounds, read from the ROM table the post-setup
     * Layer2ScrollCmd's per-frame routine compares against (e.g.
     * DATA_05C71B for cmd $0B). null when the cmd's bounds source isn't
     * decoded yet OR there's no L2 motion — slider locks to initialY.
     */
    layer2ScrollBounds?: { min: number; max: number } | null
    /**
     * Slider clamp range derived from the per-frame scroll simulator
     * (`computeLayer2YRange`). Authoritative for cmds we've ported
     * (currently $00, $01); falls through to `layer2ScrollBounds` for
     * cmd $0B; null when no scroll sprite or unported cmd produced
     * no Y motion.
     */
    layer2YRange?: { min: number; max: number } | null
    /**
     * Per-column experienced `(L1Y − L2Y)` delta ranges (one entry per
     * 16-px column across the level). When present, the slider switches
     * to viewport-progress mode (0..255 = 0..1 lerp factor) instead of
     * raw-Layer2YPos mode. Renderer (`L2ObjectStream.render`) lerps
     * each column independently within its own range.
     */
    columnDyRanges?: readonly { min: number; max: number }[] | null
    /**
     * Sampled camera-viewport trajectory (host-side, one sample per 8
     * simulator frames). Each sample carries `(L1X, L1Y)` and
     * `(L2X, L2Y)` so the editor can draw scroll-path overlays for
     * both layers. `null` when no scroll sprite.
     */
    scrollPath?: readonly { f: number; l1x: number; l1y: number; l2x: number; l2y: number }[] | null
    // Read-only header bits surfaced for the LEVEL HEADER block in the
    // right panel. Editable bits (palettes, tilesets, sprite set) live
    // above as overrides; these are display-only.
    levelLength?:    number
    levelMode?:      number
    timeLimit?:      number
    itemMemory?:     number
    verticalScroll?: number
    layer3Priority?: boolean
    isVertical?:     boolean
  }
  /** L3 routine summary (read-only). See readL3RoutineSummary in L3Loader.ts. */
  l3Routine?: {
    layer3Setting:   number
    settingsByte:    number | null
    kind:            'tide' | 'fixed' | 'camera-tracked' | 'none' | 'disabled'
    initialYPx:      number | null
    isTideUpAndDown: boolean
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

function applyZoom(anchor?: { x: number; y: number }): void {
  const oldZoom = zoom
  const oldPadX = levelPadX
  const oldPadY = levelPadY

  const a = anchor ?? {
    x: canvasWrap.clientWidth  / 2,
    y: canvasWrap.clientHeight / 2,
  }
  const worldX = (canvasWrap.scrollLeft + a.x - oldPadX) / oldZoom
  const worldY = (canvasWrap.scrollTop  + a.y - oldPadY) / oldZoom

  const z = ZOOM_STEPS[zoomIdx]

  // Resize the spacer + pad synchronously before triggering the reactive
  // render. If we let store.setZoom run first, the render path sees the new
  // zoom but the old scroll, and the user gets one frame of wrong content.
  if (fullLevelCanvas) {
    const fw = fullLevelCanvas.width
    const fh = fullLevelCanvas.height
    levelPadX = isVert() ? Math.max(0, Math.floor((canvasWrap.clientWidth  - fw * z) / 2)) : 0
    levelPadY = isVert() ? 0 : Math.max(0, Math.floor((canvasWrap.clientHeight - fh * z) / 2))
    levelSpacer.style.width  = `${fw * z + levelPadX * 2}px`
    levelSpacer.style.height = `${fh * z + levelPadY * 2}px`

    const newScrollX = worldX * z + levelPadX - a.x
    const newScrollY = worldY * z + levelPadY - a.y
    const maxX = Math.max(0, canvasWrap.scrollWidth  - canvasWrap.clientWidth)
    const maxY = Math.max(0, canvasWrap.scrollHeight - canvasWrap.clientHeight)
    canvasWrap.scrollLeft = Math.max(0, Math.min(maxX, newScrollX))
    canvasWrap.scrollTop  = Math.max(0, Math.min(maxY, newScrollY))
  }

  zoom = z
  store.setZoom(z)  // reactive — triggers renderModelOverlay with the new zoom
  zoomLabel.textContent = `${z}×`
}

document.getElementById('zoom-in')!.addEventListener('click', () => {
  if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; applyZoom() }
})
document.getElementById('zoom-out')!.addEventListener('click', () => {
  if (zoomIdx > 0) { zoomIdx--; applyZoom() }
})
canvasWrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  const next = zoomIdx + (e.deltaY < 0 ? 1 : -1)
  if (next >= 0 && next < ZOOM_STEPS.length) {
    zoomIdx = next
    const r = canvasWrap.getBoundingClientRect()
    applyZoom({ x: e.clientX - r.left, y: e.clientY - r.top })
  }
}, { passive: false })

// ── Palette canvas ────────────────────────────────────────────────────────────

function drawPaletteCanvas(): void {
  drawPaletteFromModel()
}

/**
 * Render the palette panel from the self-rendering model's Palette.
 * Reads each cell via its ColorBehavior (static or CyclingColorBehavior) so
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

  palCtx.clearRect(0, 0, 128, 128)

  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      const cell = palette.cells[row]?.[col]
      if (!cell) continue
      const c = cell.rgba()
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
  const cell = map.palette.cells[row]?.[col]
  const c = cell ? cell.rgba() : [0, 0, 0, 0]
  const hex = `#${c[0].toString(16).padStart(2,'0')}${c[1].toString(16).padStart(2,'0')}${c[2].toString(16).padStart(2,'0')}`
  palInspect.textContent = `row ${row}  col ${col}  ${hex}`
})
palCanvas.addEventListener('mouseleave', () => {
  palInspect.textContent = 'hover to inspect'
})

// ── Rendering ─────────────────────────────────────────────────────────────────

function screenX(s: number, px: number): number {
  return isVert() ? 0 : Math.round(s * SCREEN_W * px)
}
function screenY(s: number, px: number): number {
  return isVert() ? Math.round(s * SCREEN_H_VERT * px) : 0
}

function drawBlockGrid(grid: number[][], cols: number, rows: number, px: number, alpha: number): void {
  ctx.save()
  ctx.globalAlpha = alpha
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileId = grid[row]?.[col] ?? 0
      if (tileId === 0) continue
      ctx.fillStyle = tileBlockColor(tileId)
      ctx.fillRect(Math.round(col * px), Math.round(row * px), Math.round(px), Math.round(px))
    }
  }
  if (zoom >= 2) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    ctx.font = `${Math.max(6, Math.round(px * 0.28))}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const tileId = grid[row]?.[col] ?? 0
        if (tileId === 0) continue
        ctx.fillText(`$${hex3(tileId)}`,
          Math.round(col * px) + Math.round(px / 2),
          Math.round(row * px) + Math.round(px / 2))
      }
    }
  }
  ctx.restore()
}

/**
 * Transparency-checkerboard pattern, matching the one used by gfxViewer
 * (4×4 grayscale squares at 40/60 luma). Cached as an offscreen canvas
 * so the main redraw + minimap redraw can reuse a single CanvasPattern.
 */
let checkerPatternCanvas: HTMLCanvasElement | null = null
function getCheckerPattern(c: CanvasRenderingContext2D): CanvasPattern | null {
  if (!checkerPatternCanvas) {
    checkerPatternCanvas = document.createElement('canvas')
    checkerPatternCanvas.width = 8
    checkerPatternCanvas.height = 8
    const p = checkerPatternCanvas.getContext('2d')!
    p.fillStyle = 'rgb(40,40,40)'
    p.fillRect(0, 0, 8, 8)
    p.fillStyle = 'rgb(60,60,60)'
    p.fillRect(0, 0, 4, 4)
    p.fillRect(4, 4, 4, 4)
  }
  return c.createPattern(checkerPatternCanvas, 'repeat')
}

function redraw(): void {
  if (!mapData) return
  if (!chkBlock.checked && !map16AtlasCanvas) return

  const { tileGrid, screens, sprites } = mapData
  const cols = levelCols()
  const rows = levelRows()
  const px   = TILE_PX * zoom

  canvas.width  = Math.round(cols * px)
  canvas.height = Math.round(rows * px)
  ctx.imageSmoothingEnabled = false

  // When L2 is hidden, show a transparency checkerboard in place of the
  // back-area color so the user can clearly tell what's solid L1 vs BG.
  if (!chkL2.checked) {
    const pat = getCheckerPattern(ctx)
    ctx.fillStyle = pat ?? '#202020'
  } else if (mapData.backAreaColor) {
    const [r, g, b] = mapData.backAreaColor
    ctx.fillStyle = `rgb(${r},${g},${b})`
  } else {
    ctx.fillStyle = '#000'
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (chkBlock.checked) {
    if (chkL2.checked && l2TileGrid) drawBlockGrid(l2TileGrid, cols, rows, px, 0.55)
    if (chkL1.checked)               drawBlockGrid(tileGrid,   cols, rows, px, 1.0)
  } else {
    // L2 atlas: 16 cols of 16×16 tiles, tile ID addresses (col,row). Draw
    // underneath L1 so L1 solid tiles cover the BG (matches SNES PPU layer
    // priority). Atlas source depends on L2 type:
    //   preset BG   → map16BgAtlasCanvas (IDs into Map16BGTiles)
    //   object stream → map16AtlasCanvas (IDs into the regular Map16 table)
    if (chkL2.checked && l2TileGrid) {
      const useBg = mapData.l2UsesBgAtlas ?? true
      const atlas = useBg ? map16BgAtlasCanvas : map16AtlasCanvas
      if (atlas) {
        const atlasCols = 16
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const tileId = l2TileGrid[row]?.[col] ?? 0
            // For object-stream L2, tile 0 is "empty" (never drawn). For
            // preset L2 every slot is meaningful (including $25 "empty BG"),
            // so we always draw.
            if (!useBg && tileId === 0) continue
            const sx = (tileId % atlasCols) * TILE_PX
            const sy = Math.floor(tileId / atlasCols) * TILE_PX
            ctx.drawImage(atlas,
              sx, sy, TILE_PX, TILE_PX,
              Math.round(col * px), Math.round(row * px), Math.round(px), Math.round(px))
          }
        }
      }
    }
    // Live L1 Map16 atlas: 16 cols of 16×16 tiles, tile ID directly addresses (col,row).
    if (chkL1.checked && map16AtlasCanvas) {
      ctx.save()
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          drawL1TileAt(row, col, Math.round(col * px), Math.round(row * px), Math.round(px))
        }
      }
      ctx.restore()
    }
  }

  // Screen dividers (shown together with the screen-number chips).
  // Horizontal levels: vertical lines at screen boundaries on X.
  // Vertical levels:   horizontal lines at screen boundaries on Y.
  if (chkScreens.checked) {
    ctx.strokeStyle = 'rgba(100,120,255,0.4)'
    ctx.lineWidth = 1
    if (isVert()) {
      for (let s = 1; s < screens; s++) {
        const y = Math.round(s * SCREEN_H_VERT * px) + 0.5
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
      }
    } else {
      for (let s = 1; s < screens; s++) {
        const x = Math.round(s * SCREEN_W * px) + 0.5
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
      }
    }
  }

  // Screen numbers (LM-style) — 2-digit hex label floating over the top-left
  // of each screen. Font size is independent of the tile size so low-zoom
  // views stay readable. Object stream transitions, screen exits and entrance
  // mappings are all keyed on this index, so visibility is diagnostic.
  if (chkScreens.checked) {
    ctx.save()
    const fontSize = 14   // fixed, readable at any zoom
    ctx.font = `bold ${fontSize}px monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const padX = 6
    const padY = 3
    for (let s = 0; s < screens; s++) {
      const chipX = screenX(s, px) + 3
      const chipY = screenY(s, px) + 3
      const label = hex2(s)
      const textW = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.72)'
      ctx.fillRect(chipX, chipY, textW + padX * 2, fontSize + padY * 2)
      ctx.fillStyle = '#e8d050'
      ctx.fillText(label, chipX + padX, chipY + padY)
    }
    ctx.restore()
  }

  // Tile grid
  if (mapGridOn) {
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.lineWidth = 1
    for (let c = 0; c <= cols; c++) {
      const x = Math.round(c * px) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(r * px) + 0.5
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
    }
  }

  // Sprite markers
  if (chkSprites.checked) {
    for (const spr of sprites) {
      const sx = Math.round(spr.x * px)
      const sy = Math.round(spr.y * px)
      const sp = Math.max(1, Math.round(px) - 2)
      ctx.fillStyle = 'rgba(255,70,70,0.8)'
      ctx.fillRect(sx + 1, sy + 1, sp, sp)
      if (px >= 14) {
        ctx.fillStyle = '#fff'
        ctx.font = `bold ${Math.max(7, Math.round(px * 0.44))}px monospace`
        ctx.fillText(hex2(spr.spriteId), sx + 2, sy + Math.round(px) - 3)
      }
    }
  }

  // Camera viewport — drawn last so it sits above everything else.
  if (chkCamera.checked) drawCameraViewport()

  drawMinimap()
}

/**
 * Dim everything outside the camera rect. Called inside drawCameraViewport()
 * when the camera has focus; mirrors the "spotlight" pattern used by the
 * 8×8/Map16 selected-tile highlights.
 */
function dimOutsideCamera(rx: number, ry: number, rw: number, rh: number): void {
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  // Top band
  ctx.fillRect(0, 0, canvas.width, ry)
  // Bottom band
  ctx.fillRect(0, ry + rh, canvas.width, canvas.height - (ry + rh))
  // Left band (between top and bottom bands)
  ctx.fillRect(0, ry, rx, rh)
  // Right band
  ctx.fillRect(rx + rw, ry, canvas.width - (rx + rw), rh)
  ctx.restore()
}

/**
 * Draw a single L1 tile from the Map16 atlas at the given destination pixel.
 * Honors switch-palace state, P-switch reveal (with alpha + palette override),
 * and the screen-indexed pipe-palette variant for tiles $133..$13A. Called
 * from both the main map loop and the camera re-paint so they stay in sync.
 * `worldRow`/`worldCol` drive the screen lookup — always level-space, never
 * rect-local.
 */
function drawL1TileAt(worldRow: number, worldCol: number, dx: number, dy: number, size: number): void {
  if (!mapData || !map16AtlasCanvas) return
  const rawTileId = mapData.tileGrid[worldRow]?.[worldCol] ?? 0
  const tileId = applySwitchPalaceState(rawTileId)
  if (tileId === 0) return
  // ROM-derived P-switch swap wins over the UI reveal when both apply.
  const romSub = pSwitchBlueOn ? (mapData.map16Defs?.[tileId]?.pSwitchSub ?? null) : null
  const reveal = romSub === null ? pSwitchReveal(rawTileId) : null
  ctx.globalAlpha = reveal ? (pSwitchBlueOn ? 1.0 : 0.5) : 1.0
  if (reveal?.palOverride !== undefined) {
    const override = getPalOverrideCanvas(reveal.substitute, reveal.palOverride)
    if (override) ctx.drawImage(override, 0, 0, TILE_PX, TILE_PX, dx, dy, size, size)
    return
  }
  const drawId = romSub ?? reveal?.substitute ?? tileId
  const screenVariants = mapData.screenPipeVariants
  const vert = mapData.isVertical === true
  if (drawId >= 0x133 && drawId < 0x13B && screenVariants && pipeVariantAtlasCanvases[0]) {
    const screenIdx = vert ? Math.floor(worldRow / 16) : Math.floor(worldCol / 16)
    const variantIdx = screenVariants[screenIdx] ?? 1
    const variantCanvas = pipeVariantAtlasCanvases[variantIdx]
    if (variantCanvas) {
      const sx = (drawId - 0x133) * TILE_PX
      ctx.drawImage(variantCanvas, sx, 0, TILE_PX, TILE_PX, dx, dy, size, size)
      return
    }
  }
  const sx = (drawId % 16) * TILE_PX
  const sy = Math.floor(drawId / 16) * TILE_PX
  ctx.drawImage(map16AtlasCanvas, sx, sy, TILE_PX, TILE_PX, dx, dy, size, size)
}

/**
 * Draw the draggable camera rectangle with parallax-composited BG inside it.
 * Outside the rect we dim the map (so the camera's content stands out); inside,
 * we paint the BG at its parallax-shifted position over the existing FG.
 */
function drawCameraViewport(): void {
  if (!mapData) return
  const cols = levelCols()
  const rows = levelRows()
  const px   = TILE_PX * zoom

  // Clamp camera so rect stays within level bounds.
  const maxX = Math.max(0, cols - CAMERA_W_TILES)
  const maxY = Math.max(0, rows - CAMERA_H_TILES)
  cameraTileX = Math.max(0, Math.min(maxX, cameraTileX))
  cameraTileY = Math.max(0, Math.min(maxY, cameraTileY))

  const rx = Math.round(cameraTileX * px)
  const ry = Math.round(cameraTileY * px)
  const rw = Math.round(CAMERA_W_TILES * px)
  const rh = Math.round(CAMERA_H_TILES * px)

  // Dim the rest of the map when the camera is focused so the composited
  // preview inside the rect visually dominates. Drawn before the rect contents
  // so the parallax repaint lands on top of clean (non-dimmed) tiles.
  if (cameraFocused) dimOutsideCamera(rx, ry, rw, rh)

  // Wipe the rect with the level's back-area color so the map's original L1/L2
  // (drawn by the earlier full-map pass) can't bleed through. Without this,
  // object-stream L2 levels would show two overlapping BGs inside the rect:
  // the raw-position L2 underneath, and the parallax L2 on top, through any
  // "empty" cells the parallax pass skipped.
  ctx.save()
  const bac = mapData.backAreaColor
  ctx.fillStyle = bac ? `rgb(${bac[0]},${bac[1]},${bac[2]})` : '#000'
  ctx.fillRect(rx, ry, rw, rh)
  ctx.restore()

  // Parallax-composited BG inside the rect. Skip if L2 hidden or no preset.
  // The BG origin tracks the camera FG position via shift on pixel Y:
  //   bg_px_y = fg_px_y >> shift    (locked settings mean BG doesn't move)
  // We convert back to tile rows for atlas sampling.
  const vSetting = mapData.header.vertLayer2Setting ?? 0
  const hSetting = mapData.header.horizLayer2Setting ?? 0
  const vShift = verticalScrollPixelShift(vSetting)
  const hShift = horizontalScrollPixelShift(hSetting)
  if (chkL2.checked && l2TileGrid) {
    const useBg = mapData.l2UsesBgAtlas ?? true
    const atlas = useBg ? map16BgAtlasCanvas : map16AtlasCanvas
    if (atlas) {
      const bgRows = l2TileGrid.length
      const bgCols = l2TileGrid[0]?.length ?? 0
      // fg pixel Y of camera top-left. Shift to BG pixels, then wrap mod BG grid size.
      const fgPxY = cameraTileY * TILE_PX
      const fgPxX = cameraTileX * TILE_PX
      const bgPxY = vShift === null ? 0 : (fgPxY >> vShift)
      const bgPxX = hShift === null ? 0 : (fgPxX >> hShift)
      ctx.save()
      ctx.beginPath()
      ctx.rect(rx, ry, rw, rh)
      ctx.clip()
      for (let r = 0; r < CAMERA_H_TILES; r++) {
        for (let c = 0; c < CAMERA_W_TILES; c++) {
          const bgWorldRow = Math.floor((bgPxY + r * TILE_PX) / TILE_PX) % bgRows
          const bgWorldCol = Math.floor((bgPxX + c * TILE_PX) / TILE_PX) % bgCols
          const tileId = l2TileGrid[(bgWorldRow + bgRows) % bgRows]?.[(bgWorldCol + bgCols) % bgCols] ?? 0
          if (!useBg && tileId === 0) continue
          const sx = (tileId % 16) * TILE_PX
          const sy = Math.floor(tileId / 16) * TILE_PX
          const dx = rx + Math.round(c * px)
          const dy = ry + Math.round(r * px)
          ctx.drawImage(atlas, sx, sy, TILE_PX, TILE_PX, dx, dy, Math.round(px), Math.round(px))
        }
      }
      ctx.restore()
      // Re-paint L1 on top of the parallax BG so FG stays dominant inside the
      // rect. Uses drawL1TileAt with world-space row/col so pipe-palette
      // variants and P-switch reveal stay consistent with the main map.
      if (chkL1.checked && map16AtlasCanvas) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(rx, ry, rw, rh)
        ctx.clip()
        for (let r = 0; r < CAMERA_H_TILES; r++) {
          for (let c = 0; c < CAMERA_W_TILES; c++) {
            const worldRow = cameraTileY + r
            const worldCol = cameraTileX + c
            const dx = rx + Math.round(c * px)
            const dy = ry + Math.round(r * px)
            drawL1TileAt(worldRow, worldCol, dx, dy, Math.round(px))
          }
        }
        ctx.restore()
      }
    }
  }

  // Border — bright outline so the rect is easy to spot and grab.
  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,80,0.95)'
  ctx.lineWidth = 2
  ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2)
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 1
  ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
  ctx.restore()
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

/** Scroll the map container so the L1 auto-scroll viewport (pixel
 *  position from the simulator) stays centered. Called during scroll
 *  playback / L1 slider scrub when the path overlay is enabled, so the
 *  rect tracks under the user's eye instead of running off-screen. */
function scrollContainerToL1Viewport(l1x: number, l1y: number): void {
  const z = store.zoom
  const VIEWPORT_W_PX = 256
  const VIEWPORT_H_PX = 224
  const rx = l1x * z
  const ry = l1y * z
  const rw = VIEWPORT_W_PX * z
  const rh = VIEWPORT_H_PX * z
  const marginX = Math.max(0, (canvasWrap.clientWidth  - rw) / 2)
  const marginY = Math.max(0, (canvasWrap.clientHeight - rh) / 2)
  canvasWrap.scrollLeft = Math.max(0, rx + levelPadX - marginX)
  canvasWrap.scrollTop  = Math.max(0, ry + levelPadY - marginY)
}

/** Look up `(l1x, l1y)` for a sim frame from the level's
 *  `mapStore.scrollSimulator`, then center the canvas on it. No-op
 *  when the path overlay is hidden, no simulator, or no scroll path. */
function autoScrollToFrame(simFrame: number): void {
  if (!chkScrollPath.checked) return
  if (!chkFollowScroll.checked) return
  if (simFrame < 0) return
  const sim = window.__smwModelMap?.mapStore.scrollSimulator
  if (!sim) return
  const s = sim.stateAtFrame(simFrame)
  scrollContainerToL1Viewport(s.layer1XPos, s.layer1YPos)
}

/** Scroll the map container so the camera rect stays fully visible. */
function scrollContainerToCamera(center = false): void {
  const px = TILE_PX * store.zoom
  const cam = store.camera
  const rx = cam.tileX * px
  const ry = cam.tileY * px
  const rw = CAMERA_W_TILES * px
  const rh = CAMERA_H_TILES * px
  const wrap = canvasWrap
  if (center) {
    const marginX = Math.max(0, (wrap.clientWidth  - rw) / 2)
    const marginY = Math.max(0, (wrap.clientHeight - rh) / 2)
    wrap.scrollLeft = Math.max(0, rx + levelPadX - marginX)
    wrap.scrollTop  = Math.max(0, ry + levelPadY - marginY)
  } else {
    const pad = px
    const sl = wrap.scrollLeft
    const st = wrap.scrollTop
    const vw = wrap.clientWidth
    const vh = wrap.clientHeight
    if (rx + levelPadX - pad < sl)                      wrap.scrollLeft = Math.max(0, rx + levelPadX - pad)
    else if (rx + levelPadX + rw + pad > sl + vw)       wrap.scrollLeft = rx + levelPadX + rw + pad - vw
    if (ry + levelPadY - pad < st)                      wrap.scrollTop  = Math.max(0, ry + levelPadY - pad)
    else if (ry + levelPadY + rh + pad > st + vh)       wrap.scrollTop  = ry + levelPadY + rh + pad - vh
  }
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
  const mainView = document.getElementById('main')
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
  if (!minimapOn || !mapData) return
  // Scale the full-level offscreen canvas into the minimap. The offscreen
  // canvas is always at natural 1× resolution (cols*16 × rows*16), so
  // all rendering effects (pipe-variant palettes, P-switch reveals,
  // animated tiles, parallax BG, camera overlay) are captured.
  if (!fullLevelCanvas || fullLevelCanvas.width === 0 || fullLevelCanvas.height === 0) return
  const cols = levelCols()
  const rows = levelRows()
  const tp = minimapTilePx()
  const w = cols * tp
  const h = rows * tp

  if (minimapCanvas.width !== w || minimapCanvas.height !== h) {
    minimapCanvas.width = w
    minimapCanvas.height = h
  }

  minimapCtx.imageSmoothingEnabled = false
  minimapCtx.drawImage(fullLevelCanvas, 0, 0, fullLevelCanvas.width, fullLevelCanvas.height, 0, 0, w, h)

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
  const vx = Math.round(((canvasWrap.scrollLeft - levelPadX) / mainW) * mmW)
  const vy = Math.round(((canvasWrap.scrollTop  - levelPadY) / mainH) * mmH)
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
  canvasWrap.scrollLeft = fx * cols * mainPx + levelPadX - canvasWrap.clientWidth  / 2
  canvasWrap.scrollTop  = fy * rows * mainPx + levelPadY - canvasWrap.clientHeight / 2
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

// On scroll: fast blit of the already-rendered offscreen level to the
// viewport canvas, then redraw the minimap (single drawImage + indicator).
canvasWrap.addEventListener('scroll', () => {
  blitViewport()
  drawMinimap()
})

// Resize the viewport canvas and re-blit when the panel or window changes.
new ResizeObserver(() => {
  // Recompute centering pads with the new viewport size — without this the
  // initial render can use a stale levelPadY (computed before a horizontal
  // scrollbar appeared and shrank clientHeight).
  if (fullLevelCanvas) {
    const z = store.zoom
    const fw = fullLevelCanvas.width
    const fh = fullLevelCanvas.height
    levelPadX = isVert() ? Math.max(0, Math.floor((canvasWrap.clientWidth  - fw * z) / 2)) : 0
    levelPadY = isVert() ? 0 : Math.max(0, Math.floor((canvasWrap.clientHeight - fh * z) / 2))
    levelSpacer.style.width  = `${fw * z + levelPadX * 2}px`
    levelSpacer.style.height = `${fh * z + levelPadY * 2}px`
  }
  const overlay = document.getElementById('model-canvas') as HTMLCanvasElement | null
  if (overlay) { resizeViewportCanvas(overlay); blitViewport(overlay) }
  drawMinimap()
}).observe(canvasWrap)

// Keep the minimap sized to the available width as the window/panel resizes.
new ResizeObserver(() => drawMinimap()).observe(minimapCanvas.parentElement!)

function syncLayerTogglesFromDom(): void {
  store.setLayerToggles({
    l1:       chkL1.checked,
    l2:       chkL2.checked,
    l3:       chkL3.checked,
    sprites:  chkSprites.checked,
    screens:  chkScreens.checked,
    block:    chkBlock.checked,
    mapGrid:  mapGridOn,
    l3Hud:    chkL3Hud.checked,
    surfaces: chkSurfaces.checked,
    walls:    chkWalls.checked,
    l3Range:  false,
    l2Range:  false,
    scrollPath: chkScrollPath.checked,
    scrollPlayback: false,  // driven by editorStore.frameL1, not a checkbox
  })
}
chkScreens.addEventListener('change',  syncLayerTogglesFromDom)
chkSprites.addEventListener('change',  syncLayerTogglesFromDom)
chkBlock.addEventListener('change',    syncLayerTogglesFromDom)
chkL1.addEventListener('change',       syncLayerTogglesFromDom)
chkL2.addEventListener('change',       syncLayerTogglesFromDom)
chkL3.addEventListener('change',       syncLayerTogglesFromDom)
chkL3Hud.addEventListener('change',    syncLayerTogglesFromDom)
chkSurfaces.addEventListener('change', syncLayerTogglesFromDom)
chkWalls.addEventListener('change',    syncLayerTogglesFromDom)
chkScrollPath.addEventListener('change', () => {
  syncLayerTogglesFromDom()
  // Path toggle gates L1 slider + Link button visibility, and the
  // frame label's "which layer's frame to show" logic depends on it.
  refreshScrollSliderVisibility()
  updateFrameLabel()
  // When the user turns the overlay ON, recenter on the current
  // frame so the rect is immediately in view.
  if (chkScrollPath.checked) autoScrollToFrame(store.frameL1)
  // Mirror state to the Scroll-tab panel checkbox so both sources of
  // truth stay aligned.
  chkScrollPathPanel.checked = chkScrollPath.checked
})
// "follow viewport path" change handler — when the user toggles it
// on (and SHOW VIEWPORT PATH is also on), immediately re-center the
// canvas on the current L1 frame so the user sees the viewport
// without having to nudge the slider first.
chkFollowScroll.addEventListener('change', () => {
  if (chkFollowScroll.checked) autoScrollToFrame(store.frameL1)
})

/**
 * Compute scrollPath / layer2YRange / columnDyRanges from the cached
 * ROM + scroll-sim seed, attaching the results to mapData.header.
 *
 * The host now ships only the identifying data (sprite + b0 →
 * post-remap seed); the visualization-derived arrays live here so
 * the webview owns the "what does each cmd do visually" half of
 * the pipeline.
 *
 * No-op when no scroll sprite is present or the ROM is missing
 * (e.g. test mocks). Re-runs on every load message and on the
 * gameplay-state checkbox rebuild paths.
 */
function deriveScrollData(): void {
  if (!mapData) return
  const seed = cachedScrollSeed
  const rom = cachedRom
  if (!seed || !rom) {
    if (mapData.header) {
      ;(mapData.header as { scrollPath?: unknown }).scrollPath = null
      ;(mapData.header as { layer2YRange?: unknown }).layer2YRange = null
      ;(mapData.header as { columnDyRanges?: unknown }).columnDyRanges = null
    }
    return
  }
  const screens = mapData.screens ?? 1
  const isVertical = !!mapData.isVertical
  const cols = isVertical ? 1 : screens
  const levelPixelW = cols * 16 * 16   // 16 cols/screen × 16 px/col
  // Use the seed as-is — fresh load defaults checkbox flags to 0.
  // `rebuildScrollSimulator` (the toggle change handler) overlays
  // the live checkbox values when the user flips them mid-session.
  const sim = buildScrollSimulator(rom, seed)
  const r = computeLayer2YRange(sim, levelPixelW)
  const layer2YRange = r.max > r.min ? r : null
  const cdr = computeColumnDyRanges(sim, levelPixelW)
  const columnDyRanges = cdr.some(c => c !== null && c.max > c.min)
    ? cdr.map(c => c ?? { min: 0, max: 0 })
    : null
  const scrollPath = sampleViewportPath(sim, levelPixelW, 8)
  const h = mapData.header as {
    scrollPath?: unknown; layer2YRange?: unknown; columnDyRanges?: unknown
  }
  h.scrollPath = scrollPath
  h.layer2YRange = layer2YRange
  h.columnDyRanges = columnDyRanges
}

/**
 * Rebuild `mapStore.scrollSimulator` from the cached seed + ROM,
 * overlaying the gameplay-state checkbox values into the seed. Used
 * when the user toggles the On/Off Switch or Layer2Touched checkbox
 * — both feed into the cmd $0B / $0E handlers as initial state, so
 * a new simulator is the simplest way to re-tick from frame 0.
 *
 * Resets per-layer frames to 0 so the slider doesn't point past the
 * possibly-changed effective range, and re-runs the L1 path overlay
 * recompute since the L1 path is invariant under L2-only toggles
 * but the L2 plane motion is now different.
 */
function rebuildScrollSimulator(): void {
  const map = window.__smwModelMap
  if (!map || !cachedRom || !cachedScrollSeed) return
  const seed = {
    ...cachedScrollSeed,
    onOffSwitch:   chkOnOffSwitch.checked   ? 1 : 0,
    layer2Touched: chkLayer2Touched.checked ? 1 : 0,
  }
  const newSim = buildScrollSimulator(cachedRom, seed)
  // markRaw was already applied to the original on creation; reactive()
  // wrapping skips the simulator's internal cache mutations. Direct
  // assignment is reactive enough for L2Layer.render to pick up next tick.
  map.mapStore.scrollSimulator = newSim
  // Re-derive scrollPath / layer2YRange / columnDyRanges from the
  // new simulator. Toggling the gameplay-state checkboxes can change
  // L2 motion enough that the L2 slider's clamp range and the per-
  // column dy ranges are now different.
  deriveScrollData()
  refreshScrollSliderVisibility()
  // Reset frames so the slider value doesn't reference a stale cache.
  store.setAllFrames(0)
  rngScrollFrame.value = '0'
  rngL2y.value = '0'
  updateFrameLabel()
  autoScrollToFrame(0)
}

chkOnOffSwitch.addEventListener('change', rebuildScrollSimulator)
chkLayer2Touched.addEventListener('change', rebuildScrollSimulator)

chkCamera.addEventListener('change',  () => {
  const on = chkCamera.checked
  store.setCameraOn(on)  // reactive — triggers renderModelOverlay
  if (on) {
    scrollContainerToCamera(true)
  } else {
    const cam = store.camera
    if (cam.focused) store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: false })
  }
})

// ── Camera rectangle drag + focus ────────────────────────────────────────────
// Click inside the rect: focus camera, start drag. Click outside: blur camera.
// Cursor switches to grab/grabbing when hovering/dragging the rect.
//
// Canvas is now viewport-sized (sticky), so pointer coords are viewport-local.
// Add canvasWrap.scrollLeft/scrollTop to convert to level CSS-pixel space,
// then divide by (TILE_PX × zoom) to get tile coords.
modelCanvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  const rect = modelCanvas.getBoundingClientRect()
  const px = TILE_PX * store.zoom
  const lx = (e.clientX - rect.left) + canvasWrap.scrollLeft - levelPadX
  const ly = (e.clientY - rect.top)  + canvasWrap.scrollTop  - levelPadY

  // Vine block click: toggle vine path for this source (runs regardless of camera mode).
  const vk = vineSourceKeyAt(lx, ly)
  if (vk) {
    clearSpriteSelection()
    store.toggleVineSource(vk)
    e.stopPropagation()
    return
  }

  // Sprite click: the topmost sprite claims the click for the inspector,
  // ahead of the tile behind it. `pickAt` is the same z-ordered hit test
  // the hover status bar uses, so what the panel shows is what the status
  // bar named.
  const pick = pickAt(lx / store.zoom, ly / store.zoom)
  if (pick?.kind === 'sprite') {
    selectSprite(pick.sprite)
  } else {
    clearSpriteSelection()
    setPropContext('empty')
  }

  // Sprite overlay click: any sprite whose appearance owns a renderOverlay
  // toggles its overlay on/off when clicked. The key is "id:x,y".
  const sok = spriteOverlayKeyAt(lx, ly)
  if (sok) {
    store.toggleSpriteOverlay(sok)
    e.stopPropagation()
    return
  }

  if (!chkCamera.checked) return
  const cam = store.camera
  if (hitCameraRect(lx, ly)) {
    cameraDragging = true
    cameraDragOffX = lx / px - cam.tileX
    cameraDragOffY = ly / px - cam.tileY
    store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: true })
    store.setCameraDragging(true)
    modelCanvas.setPointerCapture(e.pointerId)
    modelCanvas.style.cursor = 'grabbing'
    e.preventDefault()
  } else if (cam.focused) {
    store.setCamera({ tileX: cam.tileX, tileY: cam.tileY, focused: false })
  }
})

modelCanvas.addEventListener('pointermove', (e) => {
  const rect = modelCanvas.getBoundingClientRect()
  const px = TILE_PX * store.zoom
  const lx = (e.clientX - rect.left) + canvasWrap.scrollLeft - levelPadX
  const ly = (e.clientY - rect.top)  + canvasWrap.scrollTop  - levelPadY

  if (cameraDragging) {
    const cols = levelCols()
    const rows = levelRows()
    // No rounding — keep the drag in fractional-tile space so the rect
    // glides pixel-smooth with the cursor. The strip floors this value
    // internally so its parallax content stays tile-aligned.
    const nextX = Math.max(0, Math.min(Math.max(0, cols - CAMERA_W_TILES),
      lx / px - cameraDragOffX))
    const nextY = Math.max(0, Math.min(Math.max(0, rows - CAMERA_H_TILES),
      ly / px - cameraDragOffY))
    // Dispatch to the store so the reactive effect re-runs; the overlay
    // (`compositeCameraViewport`, `drawCameraRectOverlay`) reads
    // `store.camera` and re-renders to the new position.
    store.setCamera({ tileX: nextX, tileY: nextY, focused: true })
    // Scroll just enough to keep the camera rect visible. Then compensate
    // the drag offsets for any scroll that occurred: scrolling shifts
    // scrollLeft/scrollTop so level-space coords change on the next
    // pointermove — absorb the delta so the drag origin stays stable.
    const prevSL = canvasWrap.scrollLeft
    const prevST = canvasWrap.scrollTop
    scrollContainerToCamera()
    cameraDragOffX += (canvasWrap.scrollLeft - prevSL) / px
    cameraDragOffY += (canvasWrap.scrollTop  - prevST) / px
    return
  }

  if (chkCamera.checked && hitCameraRect(lx, ly)) {
    modelCanvas.style.cursor = 'grab'
  } else {
    modelCanvas.style.cursor = ''
  }

  // Cursor position in natural (1×) pixels. Cursor-aware sprites (Thwomp)
  // read ctx.cursorPx to pick which tiles to draw; setCursorPx rounds to
  // integer px and suppresses no-op updates so we don't spam re-renders.
  store.setCursorPx({ x: lx / store.zoom, y: ly / store.zoom })

  const hPos = canvasLevelPxAt(e)
  updateHoverStatus(hPos?.levelPx ?? null, hPos?.levelPy ?? null)
})

modelCanvas.addEventListener('pointerleave', () => {
  store.setCursorPx(null)
})

modelCanvas.addEventListener('pointerup', (e) => {
  if (!cameraDragging) return
  cameraDragging = false
  store.setCameraDragging(false)
  modelCanvas.releasePointerCapture(e.pointerId)
  const rect = modelCanvas.getBoundingClientRect()
  const px = TILE_PX * store.zoom
  const lx = (e.clientX - rect.left) + canvasWrap.scrollLeft - levelPadX
  const ly = (e.clientY - rect.top)  + canvasWrap.scrollTop  - levelPadY
  modelCanvas.style.cursor = (chkCamera.checked && hitCameraRect(lx, ly)) ? 'grab' : ''
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
  target.clear()
  const cellBox = cellBoxOf(0, 0)
  tile.render(target, cellBox, map.mapStore, 'nonPriority')
  tile.render(target, cellBox, map.mapStore, 'priority')
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
  dstX: number, dstY: number, hFlip: boolean, vFlip = false,
): void {
  const chars = window.__smwModelChars
  if (!chars) return
  const char = chars.get(charNum)
  if (!char) return
  const pixels = char.getPixels()
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
  const palRow = map.palette.row(0x0B) as ReadonlyArray<readonly [number, number, number, number]>
  if (!palRow) return
  const buf = new Uint8ClampedArray(16 * 16 * 4)
  if (store.pSwitchActive) {
    // Pressed: the sprite is 16×8 (chars $4FE + $4FE h-flipped), with
    // the top half empty. Bottom-align so the button sits flush with
    // the "ground" — matches how the pressed P-switch sits in-game.
    blitCharIntoBuf(buf, 16, 0x4FE, palRow, 0, 8, false)
    blitCharIntoBuf(buf, 16, 0x4FE, palRow, 8, 8, true)
  } else {
    blitCharIntoBuf(buf, 16, 0x442, palRow, 0, 0, false)
    blitCharIntoBuf(buf, 16, 0x443, palRow, 8, 0, false)
    blitCharIntoBuf(buf, 16, 0x452, palRow, 0, 8, false)
    blitCharIntoBuf(buf, 16, 0x453, palRow, 8, 8, false)
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

type PickResult =
  | { kind: 'sprite'; sprite: Sprite }
  | { kind: 'tile';   layer: 'l1' | 'l2'; tileId: number }

/**
 * Z-ordered hit test at a level-pixel coordinate (1× unzoomed space, same
 * as Sprite.x / Sprite.y). Iterates sprites in reverse render order so the
 * topmost visual wins, then falls through to L1 → L2 tiles. Each sprite's
 * hitRect is computed from its rendered part offsets by the appearance class,
 * so multi-tile sprites (Banzai Bill 64×64, Thwomp shifted body) are handled
 * automatically without any per-ID special cases here.
 */
function pickAt(levelPx: number, levelPy: number): PickResult | null {
  const map = window.__smwModelMap
  if (chkSprites.checked && map) {
    const ordered = map.spritesInRenderOrder()
    for (let i = ordered.length - 1; i >= 0; i--) {
      const hit = ordered[i].pickAt(levelPx, levelPy)
      if (hit) {
        return { kind: 'sprite', sprite: hit }
      }
    }
  }
  const col = Math.floor(levelPx / TILE_PX)
  const row = Math.floor(levelPy / TILE_PX)
  if (chkL1.checked && mapData) {
    const id = mapData.tileGrid[row]?.[col] ?? 0
    if (id !== 0) return { kind: 'tile', layer: 'l1', tileId: id }
  }
  if (chkL2.checked && mapData?.l2TileGrid) {
    const id = mapData.l2TileGrid[row]?.[col] ?? 0
    if (id !== 0) return { kind: 'tile', layer: 'l2', tileId: id }
  }
  return null
}

function updateHoverStatus(levelPx: number | null, levelPy: number | null): void {
  if (levelPx === null || levelPy === null) {
    stPos.textContent = ''; stTile.textContent = ''; return
  }
  const col = Math.floor(levelPx / TILE_PX)
  const row = Math.floor(levelPy / TILE_PX)
  const pick = pickAt(levelPx, levelPy)
  if (!pick) {
    stTile.textContent = ''
    stPos.textContent = `col ${col}  row ${row}`
  } else if (pick.kind === 'sprite') {
    const name = pick.sprite.behavior.displayName
    const hex = `$${hex2(pick.sprite.id)}`
    stTile.textContent = name ?? hex
    stPos.textContent = `${name ? hex + '  ' : ''}col ${col}  row ${row}`
  } else {
    stTile.textContent = `${pick.layer.toUpperCase()} $${hex3(pick.tileId)}`
    stPos.textContent = `col ${col}  row ${row}`
  }
}

/**
 * Level-pixel position (1× unzoomed) under the mouse, or null when the cursor
 * is outside the level area (padding / beyond level bounds).
 */
function canvasLevelPxAt(e: MouseEvent): { levelPx: number; levelPy: number } | null {
  if (!mapData) return null
  const rect = modelCanvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const z = store.zoom
  const levelPx = ((e.clientX - rect.left) + canvasWrap.scrollLeft - levelPadX) / z
  const levelPy = ((e.clientY - rect.top)  + canvasWrap.scrollTop  - levelPadY) / z
  if (levelPx < 0 || levelPy < 0
   || levelPx >= levelCols() * TILE_PX
   || levelPy >= levelRows() * TILE_PX) return null
  return { levelPx, levelPy }
}

function canvasTileAt(e: MouseEvent): { col: number; row: number } | null {
  const p = canvasLevelPxAt(e)
  if (!p) return null
  return { col: Math.floor(p.levelPx / TILE_PX), row: Math.floor(p.levelPy / TILE_PX) }
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
  const hPos = canvasLevelPxAt(e)
  updateHoverStatus(hPos?.levelPx ?? null, hPos?.levelPy ?? null)
  if (isPainting) paintAt(e)
})
modelCanvas.addEventListener('mouseup',    () => { isPainting = false })
modelCanvas.addEventListener('mouseleave', () => { isPainting = false; updateHoverStatus(null, null) })
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
    // New header-bit overrides (Plan A — render overrides only). The provider
    // echoes these into the header payload so the controls keep their selected
    // value across re-renders. Render impact varies per field; see the field
    // refs section above for which ones are visibly wired today.
    music:          parseInt(selMusic.value),
    timeLimit:      parseInt(selTimeLimit.value),
    levelMode:      parseInt(selLevelMode.value),
    itemMemory:     parseInt(selItemMemory.value),
    verticalScroll: parseInt(selVScrollHdr.value),
    layer3Priority: chkL3Priority.checked,
    layer3Setting:  parseInt(selL3Setting.value),
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

// New editable header-bit controls. Same rerender path as the existing
// palette/tileset selects.
selMusic.addEventListener('change', () => {
  if (musicIsPlaying) {
    _unlockAudioContext()
    startMusicPlayback(parseInt(selMusic.value))
  }
  // No postRerender — music track does not affect map rendering.
})
function _updateVolIcon(): void {
  const muted = parseFloat(sliderMusicVol.value) === 0
  btnMusicVol.innerHTML = muted
    ? '<span class="codicon codicon-mute"></span>'
    : '<span class="codicon codicon-unmute"></span>'
}

btnMusicVol.addEventListener('click', (e) => {
  e.stopPropagation()
  musicVolPopup.style.display = musicVolPopup.style.display === 'none' ? 'block' : 'none'
})
sliderMusicVol.addEventListener('input', () => {
  if (musicBackend?.gainNode) musicBackend.gainNode.gain.value = parseFloat(sliderMusicVol.value)
  _updateVolIcon()
})
document.addEventListener('click', () => { musicVolPopup.style.display = 'none' })

btnMusicPlay.addEventListener('click', () => {
  if (musicIsPlaying) {
    stopMusicPlayback()
  } else {
    _unlockAudioContext()
    startMusicPlayback(parseInt(selMusic.value))
  }
})
btnMusicPrev.addEventListener('click', () => {
  const idx = selMusic.selectedIndex
  selMusic.selectedIndex = idx > 0 ? idx - 1 : selMusic.options.length - 1
  _unlockAudioContext()
  if (musicIsPlaying) startMusicPlayback(parseInt(selMusic.value))
  // No postRerender — music track does not affect map rendering.
})
btnMusicNext.addEventListener('click', () => {
  const idx = selMusic.selectedIndex
  selMusic.selectedIndex = idx < selMusic.options.length - 1 ? idx + 1 : 0
  _unlockAudioContext()
  if (musicIsPlaying) startMusicPlayback(parseInt(selMusic.value))
  // No postRerender — music track does not affect map rendering.
})
selTimeLimit.addEventListener('change',   postRerender)
selLevelMode.addEventListener('change',   postRerender)
selItemMemory.addEventListener('change',  postRerender)
selVScrollHdr.addEventListener('change',  postRerender)
chkL3Priority.addEventListener('change',  postRerender)
selL3Setting.addEventListener('change',   postRerender)

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

// ── Scroll panel: state ──────────────────────────────────────────────────────
//
// The Scroll tab has three operating modes for the L2 slider:
//
//   - **'frame'**: auto-scroll level (level has a `scrollPath`). L1 and
//     L2 sliders both range 0..pathLen−1 and the slider value is the
//     per-layer frame index. `editorStore.frameL{1,2,3}` is the
//     authoritative state; `L2ObjectStream.render` reads `frameL2` and
//     calls `mapStore.scrollSimulator.stateAtFrame(frameL2)` to compute
//     the L2 plane shift `(layer1{X,Y}Pos − layer2{X,Y}Pos)`. Using
//     ONLY frameL2 means scrubbing L1 alone DOES NOT move L2 — the L2
//     plane reflects the SNES viewport at L2's chosen point in time.
//
//   - **'rawY'**: object-stream L2 with no scroll sprite. L1 slider is
//     hidden; L2 slider is a raw `Layer2YPos` override 0..255 that the
//     legacy `editorStore.l2YOverride` consumes.
//
//   - **'none'**: no scrubbing controls visible (preset L2 / non-L2 levels).
type ScrollMode = 'frame' | 'rawY' | 'none'
let scrollMode: ScrollMode = 'none'

// Loop button: when ON, `tickScrollPlayback` wraps to frame 0 instead of
// stopping at the path end. Default OFF; persists across loads in this
// session so a user who turned it on stays in loop mode. Visible only
// for scroll sprites that don't drive Layer 1 — for L1-affected scrolls
// the path naturally ends at LastScreenHoriz and looping isn't useful.
let scrollLooping = false

/**
 * Cmd → affected-layer dispatch helpers. Mirrors the per-frame routing
 * tables in `bank_05.asm:4518-4566`:
 *
 *   - L1 dispatch BEQs out at cmd $00. cmd $01 = parallax tick on L1.
 *     cmd $0C = auto-scroll level X. cmd $07 = nullroutine. Everything
 *     else has no L1 entry → no L1 effect.
 *   - L2 dispatch BEQs out at cmd $00. cmd $07 = nullroutine. Everything
 *     else (cmd $01..$0E except 5/6/7/A/F) updates L2 state.
 *   - L2 cmd $01 (`CODE_05C198`) mirrors NextLayer2XPos into
 *     NextLayer1XPos at the tail — so an L2 cmd $01 also drives L1.
 *
 * All inputs are post-remap cmd bytes (the `simulateScrollSetup` output
 * shipped on `mapData.header.layer{1,2}ScrollCmd`).
 */
function cmdAffectsL1(l1cmd: number | null | undefined, l2cmd: number | null | undefined): boolean {
  if (l1cmd === 0x01 || l1cmd === 0x0C) return true
  if (l2cmd === 0x01) return true   // cmd $01 L2 mirrors X into nl1x
  return false
}
function cmdAffectsL2(l1cmd: number | null | undefined, l2cmd: number | null | undefined): boolean {
  // L2 dispatch BEQs out only when l2cmd is 0; cmd 7 is also a nullroutine.
  if (l2cmd === null || l2cmd === undefined) return false
  if (l2cmd === 0x00 || l2cmd === 0x07) return false
  return true
}
function cmdAffectsL3(_l1cmd: number | null | undefined, _l2cmd: number | null | undefined): boolean {
  // No vanilla scroll sprite cmd drives Layer 3 — L3 motion comes from
  // hardcoded HDMA tables, not the scroll-cmd dispatch. Kept symmetric
  // with the other two helpers so the visibility rule reads uniformly.
  return false
}
function hasScrollSprite(l1cmd: number | null | undefined, l2cmd: number | null | undefined): boolean {
  return cmdAffectsL1(l1cmd, l2cmd) || cmdAffectsL2(l1cmd, l2cmd) || cmdAffectsL3(l1cmd, l2cmd)
}

/** Apply visual "active" styling to a toggle button via the
 *  `.active` class on `.btn-action` — see the CSS block above. */
function applyToggleClass(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle('active', on)
}
function refreshLinkButton(): void { applyToggleClass(btnScrollLink, store.scrollFramesLinked) }
function refreshLoopButton(): void { applyToggleClass(btnScrollLoop, scrollLooping) }

/**
 * Resolve which slider rows + Link button + Loop button should be
 * visible. Per-layer slider visibility tracks the cmd dispatch (only
 * show what the active scroll sprite cmd actually drives):
 *
 *   - L1 slider visible iff cmd affects L1 AND SHOW VIEWPORT PATH on
 *   - L2 slider visible iff cmd affects L2
 *   - L3 slider — currently no UI; reserved (no vanilla L3 scroll cmd)
 *   - Link button visible iff both L1 + L2 sliders are showing
 *   - Frame counter visible iff cmd affects any layer (= scroll sprite
 *     present), independent of the path toggle
 *   - Loop toggle visible iff scroll sprite exists AND cmd does NOT
 *     affect L1 — for L1 auto-scroll the natural end is the level edge
 *     and looping isn't useful; for L2-only oscillating cmds it is
 *
 * Called from the load handler and the chk-scrollpath change handlers
 * (toolbar + Scroll-tab mirror) so visibility tracks the toggle live.
 */
function refreshScrollTabVisibility(): void {
  const l1cmd = mapData?.header?.layer1ScrollCmd
  const l2cmd = mapData?.header?.layer2ScrollCmd
  const hasSprite = hasScrollSprite(l1cmd, l2cmd)
  tabBtnScroll.style.display = hasSprite ? '' : 'none'
  // If the active tab disappears, switch back to General so the user
  // doesn't see an empty content area.
  if (!hasSprite && tabBtnScroll.classList.contains('active')) {
    tabBtnScroll.classList.remove('active')
    tabPaneScroll.style.display = 'none'
    document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="general"]')?.classList.add('active')
    tabPaneGeneral.style.display = 'flex'
  }
}

function refreshScrollSliderVisibility(): void {
  const l1cmd = mapData?.header?.layer1ScrollCmd
  const l2cmd = mapData?.header?.layer2ScrollCmd
  const affectsL1 = cmdAffectsL1(l1cmd, l2cmd)
  const affectsL2 = cmdAffectsL2(l1cmd, l2cmd)
  const hasSprite = hasScrollSprite(l1cmd, l2cmd)
  const pathOn = chkScrollPath.checked
  const showL1 = affectsL1 && pathOn
  const showL2 = affectsL2
  const showLink = showL1 && showL2 && scrollMode === 'frame'
  rowRngL1.style.display = showL1 ? 'flex' : 'none'
  rowRngL2.style.display = showL2 ? 'flex' : 'none'
  btnScrollLink.style.display = showLink ? 'inline-flex' : 'none'
  scrollFrameCounter.style.display = hasSprite ? 'flex' : 'none'
  scrollSlidersSection.style.display = (showL1 || showL2) ? 'flex' : 'none'
  btnScrollLoop.style.display = (hasSprite && !affectsL1) ? 'inline-flex' : 'none'
  // Cmd-specific gameplay-state toggles. Each row is shown only when
  // the active scroll cmd actually reads that state.
  rowOnOffSwitch.style.display   = (l2cmd === 0x0B) ? 'flex' : 'none'
  rowLayer2Touched.style.display = (l2cmd === 0x0E) ? 'flex' : 'none'
}

function updateFrameLabel(): void {
  const path = mapData?.header?.scrollPath
  if (!path || path.length === 0) {
    lblScrollFrame.textContent = 'FRAME 0 / —'
    return
  }
  // Show the "active" layer's frame. With both sliders or L1-only,
  // that's frameL1 (the playback / path-overlay frame). When the L1
  // slider is hidden (path toggle off, L2-only scrubbing), show
  // frameL2 instead so the counter tracks what the user is actually
  // moving. `updateFrameLabel` is called from every slider input +
  // playback tick so this stays live.
  const lastF = path[path.length - 1].f
  const useL2 = !chkScrollPath.checked
  const raw = useL2 ? store.frameL2 : store.frameL1
  const f = Math.max(0, Math.min(lastF, raw < 0 ? 0 : raw))
  lblScrollFrame.textContent = `FRAME ${f} / ${lastF}`
}

/** Convert a sim frame to the closest scrollPath sample index for
 *  overlays (e.g. `drawScrollPlayback`) that need a path-indexed
 *  bracket. The path is uniformly strided so this is exact for
 *  multiples of the stride and a clamp-to-last-sample otherwise. */
function pathIndexForSimFrame(simFrame: number): number {
  const path = mapData?.header?.scrollPath
  if (!path || path.length === 0) return 0
  // Stride detection: path[1].f − path[0].f = stride (typically 8).
  // Falls back to length scan when only one sample.
  if (path.length < 2) return 0
  const stride = Math.max(1, path[1].f - path[0].f)
  const idx = Math.max(0, Math.min(path.length - 1, Math.round(simFrame / stride)))
  return idx
}

// ── Playback engine ──────────────────────────────────────────────────────────
//
// `scrollPath` is a host-sampled array of viewport snapshots taken every
// 8 simulator frames. Play advances each layer's frame index in
// **real time** (NOT by RAF count) so the playback runs at NES
// game speed (60 sim frames/sec at 1x) regardless of how long
// rendering takes. When the renderer can't keep up (large level,
// L2 plane shift forces a full re-paint), the frame counter jumps
// multiple frames per RAF instead of running visibly slow.
//
// Without this real-time pacing, a slow render (e.g. 100ms per
// frame for a busy level) drags the playback rate down to ~10 Hz
// because tickScrollPlayback effectively runs once per render.
// User-perceived "the playback is SO SLOW" was this exact symptom.
//
// When `scrollFramesLinked` is ON, all three layer frames advance
// together via `setAllFrames`. When OFF, only `frameL1` advances —
// L2's plane stays at whatever frame the L2 slider was last left at.
//
// At the path end the loop either wraps to 0 (Loop ON) or pins to the
// last frame and stops (Loop OFF).
let scrollPlaybackRaf: number | null = null
/** Wall-clock time at the last `tickScrollPlayback` invocation. Used
 *  to compute elapsed real time so the frame advance matches NES
 *  speed independent of render cost. Reset to 0 on stop/start. */
let scrollPlaybackLastTimeMs = 0
/** Fractional accumulator of "frames owed" (in NES frames). Lets us
 *  carry the < 1-frame remainder across ticks when render time
 *  doesn't divide evenly by 1/60s. */
let scrollPlaybackFrameAcc = 0
/** Playback direction: +1 = forward, -1 = reverse. Used by the
 *  boomerang loop mode for L2-only oscillating cmds (cmd $03 / $08 /
 *  $0B / $0E) so playback bounces between 0 and lastF instead of
 *  wrapping to 0. Always +1 for cmds that affect L1 (auto-scroll
 *  levels) — they wrap on Loop. */
let scrollPlaybackDirection: 1 | -1 = 1

function stopScrollPlayback(): void {
  if (scrollPlaybackRaf !== null) {
    cancelAnimationFrame(scrollPlaybackRaf)
    scrollPlaybackRaf = null
  }
  scrollPlaybackLastTimeMs = 0
  scrollPlaybackFrameAcc = 0
  scrollPlaybackDirection = 1
  btnScrollPlay.innerHTML = '<span class="codicon codicon-play"></span>'
  btnScrollPlay.title = 'Play scroll routine'
}

/** Set the per-layer frames from a new L1 frame index, mirroring to L2/L3
 *  if linked. Also reflects the value into the slider DOM. */
function applyL1Frame(idx: number): void {
  if (store.scrollFramesLinked) {
    store.setAllFrames(idx)
    rngScrollFrame.value = String(idx)
    if (scrollMode === 'frame') rngL2y.value = String(idx)
  } else {
    store.setFrameL1(idx)
    rngScrollFrame.value = String(idx)
  }
}

/** Set L2 frame from slider input, mirroring to L1/L3 if linked. */
function applyL2Frame(idx: number): void {
  if (store.scrollFramesLinked) {
    store.setAllFrames(idx)
    rngScrollFrame.value = String(idx)
    rngL2y.value = String(idx)
  } else {
    store.setFrameL2(idx)
    rngL2y.value = String(idx)
  }
}

function tickScrollPlayback(): void {
  const path = mapData?.header?.scrollPath
  if (!path || path.length === 0) { stopScrollPlayback(); return }
  const speed = Math.max(1, parseInt(selScrollSpeed.value, 10) || 1)
  const lastF = path[path.length - 1].f
  const cur = store.frameL1

  // Real-time advancement: use elapsed wall-clock between ticks to
  // compute how many NES frames should have elapsed, then advance.
  // First tick (lastTimeMs===0) seeds the timer without advancing.
  const now = performance.now()
  let advance: number
  if (scrollPlaybackLastTimeMs === 0) {
    advance = 0
  } else {
    const dtMs = now - scrollPlaybackLastTimeMs
    // Elapsed sim frames at the SNES NTSC rate, scaled by speed
    // multiplier. Carry sub-frame remainder across ticks via the
    // accumulator so long-term rate stays exact.
    const framesOwed = ((dtMs * SNES_NTSC_FPS) / 1000) * speed + scrollPlaybackFrameAcc
    advance = Math.floor(framesOwed)
    scrollPlaybackFrameAcc = framesOwed - advance
  }
  scrollPlaybackLastTimeMs = now

  // Direction-aware advance. For cmds that affect L1 (auto-scroll
  // levels) the playback always moves forward — wrap-to-0 on Loop is
  // the natural behavior, since the level itself doesn't run
  // backwards. For L2-only cmds (cmd $03 / $08 / $0B / $0E) the
  // motion is OSCILLATING — wrapping back to 0 produces a visible
  // jump, so Loop instead "boomerangs" by reversing direction at
  // each endpoint.
  const l1cmd = mapData?.header?.layer1ScrollCmd
  const l2cmd = mapData?.header?.layer2ScrollCmd
  const isOscillating = !cmdAffectsL1(l1cmd, l2cmd)
  const start = cur < 0 ? 0 : cur
  let next = start + scrollPlaybackDirection * advance
  if (next >= lastF) {
    if (scrollLooping) {
      if (isOscillating) {
        // Boomerang: reflect off the upper bound and start moving back.
        next = lastF - (next - lastF)
        if (next < 0) next = 0
        scrollPlaybackDirection = -1
      } else {
        // Wrap to 0; keep accumulator (so the wrap doesn't reset pacing).
        next = 0
      }
    } else {
      // Pin to last frame and stop — keeps the moving overlay visible
      // at its final position so the user can inspect end-of-level state.
      next = lastF
      applyL1Frame(next)
      updateFrameLabel()
      stopScrollPlayback()
      return
    }
  } else if (next < 0) {
    // Boomerang at the lower bound (only reachable when scrollLooping
    // is on and we previously reflected). Reverse direction back to
    // forward.
    if (scrollLooping && isOscillating) {
      next = -next
      if (next > lastF) next = lastF
      scrollPlaybackDirection = 1
    } else {
      stopScrollPlayback()
      return
    }
  }
  applyL1Frame(next)
  updateFrameLabel()
  autoScrollToFrame(next)
  scrollPlaybackRaf = requestAnimationFrame(tickScrollPlayback)
}

// ── L1 frame slider input ────────────────────────────────────────────────────
rngScrollFrame.addEventListener('input', () => {
  // Manual scrub aborts running playback so the user sees their value.
  stopScrollPlayback()
  const path = mapData?.header?.scrollPath
  if (!path || path.length === 0) return
  const lastF = path[path.length - 1].f
  // Slider value is a sim frame; clamp and pass straight through.
  const idx = Math.max(0, Math.min(lastF, parseInt(rngScrollFrame.value, 10) | 0))
  applyL1Frame(idx)
  updateFrameLabel()
  autoScrollToFrame(idx)
})

// ── L2 slider input ──────────────────────────────────────────────────────────
//
// In 'frame' mode the slider is the L2 frame index (0..pathLen−1); the
// link button decides whether L1/L3 mirror. In 'rawY' mode it's a raw
// `Layer2YPos` override (0..255).
rngL2y.addEventListener('input', () => {
  stopScrollPlayback()
  const v = parseInt(rngL2y.value, 10) | 0
  if (scrollMode === 'frame') {
    applyL2Frame(v)
    updateFrameLabel()
    // When linked, L2 scrub advances L1's frame too, so re-center
    // the canvas on the new L1 viewport position. Unlinked scrub
    // doesn't move L1 — no-op.
    if (store.scrollFramesLinked) autoScrollToFrame(store.frameL1)
  } else if (scrollMode === 'rawY') {
    store.setL2YOverride(v)
  }
})

// ── Buttons ──────────────────────────────────────────────────────────────────
btnScrollPlay.addEventListener('click', () => {
  const path = mapData?.header?.scrollPath
  if (!path || path.length === 0) return
  if (scrollPlaybackRaf !== null) {
    stopScrollPlayback()
    return
  }
  // Pressing Play forces linked mode: all three layer frames advance
  // in lockstep so the L2 plane shifts visibly alongside the L1 path
  // overlay. The Link button picks up the new state via
  // `refreshLinkButton`.
  if (!store.scrollFramesLinked) {
    store.setScrollFramesLinked(true)
    refreshLinkButton()
    refreshScrollSliderVisibility()
  }
  // Restart from 0 if at end and not looping. (If looping, we'd just
  // wrap on the next tick anyway.) `frameL1` is a sim frame so we
  // compare against the last sampled sim frame, not the array length.
  const lastF = path[path.length - 1].f
  if (!scrollLooping && (store.frameL1 >= lastF || store.frameL1 < 0)) {
    applyL1Frame(0)
    updateFrameLabel()
  }
  btnScrollPlay.innerHTML = '<span class="codicon codicon-debug-pause"></span>'
  btnScrollPlay.title = 'Pause scroll routine'
  scrollPlaybackRaf = requestAnimationFrame(tickScrollPlayback)
})

btnScrollStop.addEventListener('click', () => {
  stopScrollPlayback()
  // Stop resets L1 to 0 always; L2 only if linked (so an unlinked L2
  // slider keeps its last position when the user stops L1 playback).
  if (store.scrollFramesLinked) {
    store.setAllFrames(0)
    rngScrollFrame.value = '0'
    rngL2y.value = '0'
  } else {
    store.setFrameL1(0)
    rngScrollFrame.value = '0'
  }
  updateFrameLabel()
})

btnScrollLink.addEventListener('click', () => {
  const newLinked = !store.scrollFramesLinked
  store.setScrollFramesLinked(newLinked)
  refreshLinkButton()
  if (newLinked && scrollMode === 'frame') {
    // Snap L2/L3 to L1 on enable so all three are coupled going forward.
    store.setAllFrames(store.frameL1)
    rngL2y.value = rngScrollFrame.value
  }
})

btnScrollLoop.addEventListener('click', () => {
  scrollLooping = !scrollLooping
  refreshLoopButton()
})

// Mirror chk-scrollpath-panel into the toolbar toggle. Also refresh
// the L1 slider visibility + frame label since the panel checkbox
// can be the trigger that turns the path on.
chkScrollPathPanel.addEventListener('change', () => {
  chkScrollPath.checked = chkScrollPathPanel.checked
  syncLayerTogglesFromDom()
  refreshScrollSliderVisibility()
  updateFrameLabel()
})

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
  const msg = event.data as Record<string, unknown>
  if (msg['type'] === 'modelPayload') {
    try {
      const payload = msg['payload'] as ModelMapPayload
      // ROM bytes are shipped in the 'load' message and cached in
      // `cachedRom` — modelPayload reuses that reference rather than
      // a second Uint8Array transfer. Falls back to null in test
      // contexts where 'load' didn't arrive first.
      const rom = cachedRom
      // Refresh the cached scroll seed from the model payload so
      // gameplay-state-toggle rebuilds operate on the model's seed
      // (which carries any host-side overrides applied via override
      // re-renders) rather than the original 'load' seed.
      if (payload.scrollSim) cachedScrollSeed = payload.scrollSim
      const { map, chars, tiles, bgTiles } = buildGraph(payload, rom)
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
  if (msg['type'] === 'musicSpc') {
    const bgmCommand = msg['bgmCommand'] as number
    const spcData    = msg['spcData']    as number[] | null
    btnMusicPlay.disabled = false
    if (spcData) {
      musicSpcCache.set(bgmCommand, spcData)
      if (parseInt(selMusic.value) === bgmCommand) startMusicPlayback(bgmCommand)
    } else {
      _setMusicPlayButton(false)
    }
    return
  }
  if (msg['type'] === 'load') {
    stopMusicPlayback()
    musicSpcCache.clear()
    // A selection names a Sprite in the outgoing map's graph; carrying it
    // into the next map would mark a sprite that is no longer there.
    clearSpriteSelection()
    setPropContext('empty')

    mapData  = msg as unknown as MapPayload
    l2TileGrid = mapData.l2TileGrid ?? null

    // ROM bytes arrive once per load message. Cache the RomFile so:
    //  (a) `deriveScrollData` (below) can build a sim + sample paths
    //  (b) `modelPayload`'s rehydrate path can reuse this rom without
    //      a second Uint8Array transfer
    //  (c) the gameplay-state checkboxes (cmd $0B / $0E) can rebuild
    //      the simulator with toggled flags.
    const romBytesLoad = msg['romBytes'] as Uint8Array | undefined
    if (romBytesLoad) cachedRom = RomFile.fromBytes('webview-rom', romBytesLoad)
    cachedScrollSeed = (msg['scrollSim'] as import('../../rom/scrollSim').ScrollSimSeed | null) ?? null
    deriveScrollData()

    // Cache SPC data that arrived with this load payload
    if (mapData.spcData && mapData.currentBgmCommand !== undefined) {
      musicSpcCache.set(mapData.currentBgmCommand, mapData.spcData)
    }

    applyMinimapOrientation()

    const hex     = hex3(mapData.mapIndex)
    const screens = mapData.screens
    mapId.textContent   = `Map $${hex}`
    mapMeta.textContent = `${screens} screen${screens !== 1 ? 's' : ''}${mapData.isVertical ? ' · vertical' : ''}`
    const bgmHex = hex2(mapData.currentBgmCommand ?? mapData.header.music)
    stInfo.textContent  = `BGM $${bgmHex} · Tileset ${mapData.header.gfxTilesetId}`

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

      // Music: populate from ROM-derived full track list, not the 3-bit header index.
      selMusic.innerHTML = ''
      for (const track of mapData.allBgmTracks ?? []) {
        const opt = document.createElement('option')
        opt.value = String(track.bgmCommand)
        opt.textContent = `BGM $${hex2(track.bgmCommand)}`
        opt.selected = track.bgmCommand === mapData.currentBgmCommand
        selMusic.appendChild(opt)
      }

      // New editable controls. Level mode / item memory / V-scroll
      // show raw values only (no verified decoded labels per CLAUDE.md's
      // "every classification must cite an ASM line" rule). Time limit gets
      // a TimerTable-derived label (cited in bank_05.asm:510). L3 setting
      // labels distinguish "Disabled" from the three tileset slots.
      buildSelect(selTimeLimit,  4, mapData.header.timeLimit ?? 0,
        i => `${i} (${['none', '200', '300', '400'][i] ?? '?'})`)
      // 5-bit field; 32 modes covered by the SMW level-mode jump table.
      buildSelect(selLevelMode, 32, mapData.header.levelMode ?? 0,
        i => `$${hex2(i)}`)
      buildSelect(selItemMemory, 4, mapData.header.itemMemory ?? 0)
      buildSelect(selVScrollHdr, 4, mapData.header.verticalScroll ?? 0)
      buildSelect(selL3Setting,  4, mapData.l3Routine?.layer3Setting ?? 0,
        i => i === 0 ? 'Disabled' : `Slot ${i}`)
      chkL3Priority.checked = !!(mapData.header.layer3Priority)
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
    const vLabel = ['locked', '1:1', '1:2', '1:32'][vSet] ?? '?'
    const hLabel = ['locked', '1:1', '1:2', '?'   ][hSet] ?? '?'
    infoBgVScroll.textContent = vLabel
    infoBgHScroll.textContent = hLabel

    // Sync editable controls on every load (initial OR rerender) so any
    // overrides the user picked in this session persist visibly. _initial=true
    // already populated the options via buildSelect; this just reapplies the
    // .value in case the provider echoed a different value back.
    const hdr = mapData.header
    selMusic.value      = String(mapData.currentBgmCommand ?? hdr.music ?? 0)
    selTimeLimit.value  = String(hdr.timeLimit      ?? 0)
    selLevelMode.value  = String(hdr.levelMode      ?? 0)
    selItemMemory.value = String(hdr.itemMemory     ?? 0)
    selVScrollHdr.value = String(hdr.verticalScroll ?? 0)
    chkL3Priority.checked = !!hdr.layer3Priority

    // Scroll-tab section visibility + slider mode selection.
    //
    // Sections (independently shown/hidden based on level features):
    //   - Always: BG V/H-SCROLL + L1 V-SCROLL MODE (top of Scroll tab)
    //   - hasScrollPath  → scroll-autoscroll-section (sprite info + path
    //                       chk + playback row), L1 slider row, frame
    //                       counter
    //   - isObjectStreamL2 → L2 slider row (mode = 'frame' if also
    //                         hasScrollPath, else 'rawY')
    //   - hasScrollPath ∧ isObjectStreamL2 → Link button + linked default
    const isObjectStreamL2 = mapData.l2TileGrid != null && !mapData.l2UsesBgAtlas
    const scrollPath = mapData.header.scrollPath
    const hasScrollPath = !!scrollPath && scrollPath.length > 0
    const initialY = mapData.header.initialLayer2YPx ?? 0

    // Stop any running playback before rewiring slider semantics.
    stopScrollPlayback()
    store.setAllFrames(-1)

    // Top auto-scroll header (sprite info + path chk + playback row).
    if (hasScrollPath) {
      scrollAutoscrollSection.style.display = 'flex'
      const cmd = mapData.header.layer1ScrollCmd
      const cmdHex = cmd !== null && cmd !== undefined
        ? `$${hex2(cmd)}`
        : '—'
      const spriteId = cmd !== null && cmd !== undefined ? 0xE7 + cmd : null
      const spriteHex = spriteId !== null
        ? `$${hex2(spriteId)}`
        : '—'
      infoScrollSprite.textContent = `sprite ${spriteHex} / cmd ${cmdHex}`
      // Sync the panel checkbox with the (toolbar-driven) toggle state.
      chkScrollPathPanel.checked = chkScrollPath.checked
      chkFollowScroll.checked = true
      // Reset cmd-specific gameplay-state toggles on each load —
      // they're per-level state, not session state.
      chkOnOffSwitch.checked = false
      chkLayer2Touched.checked = false
    } else {
      scrollAutoscrollSection.style.display = 'none'
    }

    // Slider rows. Mode + ranges + default values.
    //
    // Slider VALUES are in **simulator frames** (NOT path-array
    // indices). The path is sampled every 8 sim frames (stride from
    // `MapEditorProvider._sendLevelData`); the slider's max is the
    // last sampled frame's `.f`. `editorStore.frameL{1,2,3}` stores
    // the sim frame directly, so `mapStore.scrollSimulator
    // .stateAtFrame(frameL2)` from `L2ObjectStream.render` reads the
    // exact per-frame state the SNES would compute.
    //
    // The L1 slider + Link button are gated on the SHOW VIEWPORT PATH
    // toggle — they're part of the L1-viewport visualization and only
    // make sense when the user has explicitly opted into path
    // controls. The L2 slider stays visible for any object-stream L2
    // because L2-plane scrubbing is independently useful. See
    // `refreshScrollSliderVisibility` for the live update path when
    // the toggle changes.
    const lastSimFrame = hasScrollPath ? scrollPath![scrollPath!.length - 1].f : 0
    if (hasScrollPath && isObjectStreamL2) {
      scrollMode = 'frame'
      // L1 slider: sim frame 0..lastSimFrame.
      rngScrollFrame.min = '0'
      rngScrollFrame.max = String(lastSimFrame)
      rngScrollFrame.value = '0'
      // L2 slider: same range as L1 in frame mode.
      rngL2y.min = '0'
      rngL2y.max = String(lastSimFrame)
      rngL2y.value = '0'
      rngL2y.disabled = false
      // Default linked. Visibility resolved by refreshScrollSliderVisibility.
      store.setScrollFramesLinked(true)
      refreshLinkButton()
      // Initialize all three frames to 0 so L2.render picks up
      // frame-accurate state immediately (sim.stateAtFrame(0)).
      store.setAllFrames(0)
    } else if (isObjectStreamL2) {
      // Object-stream L2 with no scroll sprite: raw Y override mode,
      // L2 slider only.
      scrollMode = 'rawY'
      rngL2y.min = '0'
      rngL2y.max = '255'
      const liveY = store.l2YOverride ?? initialY
      rngL2y.value = String(liveY)
      rngL2y.disabled = false
      store.setAllFrames(-1)
      store.setL2YOverride(liveY)
    } else if (hasScrollPath) {
      // Auto-scroll level without object-stream L2 (preset L2 / no L2):
      // L1 slider only — still useful for path-overlay previewing.
      scrollMode = 'frame'
      rngScrollFrame.min = '0'
      rngScrollFrame.max = String(lastSimFrame)
      rngScrollFrame.value = '0'
      store.setAllFrames(0)
    } else {
      // Neither auto-scroll nor object-stream L2.
      scrollMode = 'none'
      store.setAllFrames(-1)
    }
    refreshLoopButton()
    refreshScrollTabVisibility()
    refreshScrollSliderVisibility()
    updateFrameLabel()

    // L3 routine summary. Editable: layer3Setting (via selL3Setting). The
    // $009F88 byte / kind / init Y are derived from (tileset, layer3Setting)
    // and so stay read-only displays — they update when the provider re-emits
    // l3Routine after applying the override.
    const l3 = mapData.l3Routine
    if (l3) {
      selL3Setting.value = String(l3.layer3Setting ?? 0)
      infoL3Byte.textContent  = l3.settingsByte === null || l3.settingsByte === undefined
        ? '—'
        : `$${hex2(l3.settingsByte)}`
      // Tide gets a sub-kind suffix; other kinds map directly.
      let kindLabel: string = String(l3.kind ?? 'disabled')
      if (l3.kind === 'tide') {
        kindLabel = l3.isTideUpAndDown ? 'tide (up/down)' : 'tide (stationary)'
      }
      infoL3Kind.textContent  = kindLabel
      infoL3InitY.textContent = l3.initialYPx === null || l3.initialYPx === undefined
        ? '—'
        : `$${hex2(l3.initialYPx)}`
    } else {
      selL3Setting.value      = '0'
      infoL3Byte.textContent    = '—'
      infoL3Kind.textContent    = '—'
      infoL3InitY.textContent   = '—'
    }

    // Seed camera viewport Y from the ROM-derived Layer1YPos at level init
    // (bank_05.asm:7329-7335 for primary levels, 7129-7136 for sublevels via
    // secondary entrance). Falls back to 0 when the payload predates this field.
    const initCamYPx = mapData.header.initialCameraYPx ?? 0
    store.setCamera({ tileX: 0, tileY: Math.floor(initCamYPx / 16), focused: false })
    if (chkCamera.checked) scrollContainerToCamera(true)

    // Palette canvas — the model render effect will also render this
    // reactively once the model arrives, but this first paint keeps the
    // panel from showing stale content before `modelPayload` lands.
    drawPaletteCanvas()

    // Reset animation state. Animated chars and sprite appearances own
    // their own frame state internally; the timers just fire ticks. Stop
    // them here so reload starts paused.
    stopAnimTimer()
    stopPalAnimTimer()
    syncAnimButtons()
    mapAnimEnabled = !!(mapData.animation && mapData.animation.frameCount > 1)
    if (mapAnimEnabled && mapData.animation) {
      mapIntervalMs = mapData.animation.intervalMs
    }
    // Play button is always shown — sprite animation works on every level
    // regardless of whether tile animation is configured.
    for (const b of animPlayBtns) b.style.display = ''

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
        renderVramPage()
        const charNum = vramPage * VRAM_TILES_PER_PAGE + row * 16 + col
        clearSpriteSelection()
        setPropContext('empty', `8×8 char $${charNum.toString(16).padStart(3, '0').toUpperCase()}`)
      }
    }

    // ── Map16 tile pages — page structure only; render driven by model ──
    {
      map16Pages = []
      const l1DefCount = mapData.map16Defs?.length ?? 0
      const l1PageCount = l1DefCount > 0 ? Math.ceil(l1DefCount / 256) : 1
      for (let p = 0; p < l1PageCount; p++) {
        map16Pages.push({ pageInAtlas: p, pageNum: p, label: `L1 0x${p.toString(16).padStart(2,'0')}` })
      }
      const l2DefCount = mapData.map16BgDefs?.length ?? 0
      if (l2DefCount > 0) {
        const bgPageCount = Math.ceil(l2DefCount / 256)
        for (let p = 0; p < bgPageCount; p++) {
          map16Pages.push({ pageInAtlas: p, pageNum: 0x80 + p, label: `L2 0x${(0x80 + p).toString(16)}` })
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
        const tileWithinPage = row * 16 + col
        const tileId = hex3(entry.pageNum * 256 + tileWithinPage)
        m16Inspect.textContent = `tile ${tileWithinPage}  $${tileId}  (${entry.label})`
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
        renderMap16Page()
        const entry = map16Pages[map16PageIdx]
        const localTile = row * 16 + col
        const tileId = entry.pageInAtlas * 256 + localTile
        const globalId = entry.pageNum * 256 + localTile
        const label = `Map16 $${globalId.toString(16).padStart(3, '0').toUpperCase()} — Tile`
        const isL1 = entry.label.startsWith('L1')
        const def = isL1 ? mapData?.map16Defs?.[tileId] : mapData?.map16BgDefs?.[tileId]
        clearSpriteSelection()
        setPropContext('tile', label)
        populateTileProps(tileId, def)
      }
    }

    // Refresh tile detail preview (persists across palette/tileset changes)
    redrawDetail()

    // Reset palette animation timer. CyclingColorBehavior cells read
    // `ctx.palAnimFrame.value` directly, so every ref update invalidates
    // only the cells that actually moved.
    stopPalAnimTimer()
    applyPalAnimFrame(0)

  } else if (msg['type'] === 'error') {
    mapId.textContent   = 'Error'
    mapMeta.textContent = msg['message'] as string
  }
})

// Tear down animation + palette timers when the webview is disposed
// (preview-tab replacement, close, reload) so nothing keeps firing in a
// zombie context.
window.addEventListener('pagehide', () => {
  mapAnimTimer.stop()
  spriteAnimTimer.stop()
  palAnimTimer.stop()
})

// Pause animation loops whenever the webview becomes hidden. VS Code keeps
// replaced preview-tab webviews alive briefly (and sometimes for much
// longer) while they transition out — before pagehide fires. Without this,
// a stack of hidden-but-alive webviews each with an animation loop fights
// the visible tab's main thread and drops its FPS.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    mapAnimTimer.suspend()
    spriteAnimTimer.suspend()
    palAnimTimer.suspend()
  } else if (document.visibilityState === 'visible') {
    mapAnimTimer.resume()
    spriteAnimTimer.resume()
    palAnimTimer.resume()
  }
})

vscode.postMessage({ type: 'ready' })

export {}
