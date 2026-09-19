/**
 * SMW Overworld Viewer — webview entry point.
 *
 * Layout mirrors `src/webview/mapEditor/main.ts` so OW areas inherit the same
 * navigation feel: left tab panel (8×8 / Map16 / Sprites + selected preview +
 * palette), top toolbar, main canvas, right inspector panel.
 *
 * Renders ONE area (per the descriptor's `areaIndex`) at its real BG
 * coordinates out of the shared overworld staging buffer. The buffer holds
 * two 64×64 BG layouts in standard SNES 4-screen quadrant memory order;
 * `tilemapByteOffset` (mirrored from `OverworldLoader.ts`) translates
 * `(layout, row, col)` to a byte offset.
 *
 * Messages FROM extension host:
 *   { type:'load', area, region, l2Tilemap, l1Map16Indices, l1CharData,
 *     vramTiles, paletteRows, animation, events, warpStarts,
 *     marioStart, luigiStart, l2LayoutBytes, l2ScreenBytes }
 *   { type:'error', message }
 *
 * Messages TO extension host:
 *   { type:'ready' }
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()
void vscode

import {
  paintBlockFill,
  paintBlockLabel,
  BLOCK_LABEL_MIN_PX,
} from '../shared/blockView'
import { frameClock } from '../shared/frameClock'
import { msToFrames } from '../../rom/timing'
import { hex2, hex3, hex4, hex6 } from '../shared/hex'

// ── Constants (mirror OverworldLoader.ts so the webview is self-contained) ──

const SNES_TILE_PX  = 8
const MAP16_PX      = 16
const MAP16_SNES    = 2
const ZOOM_STEPS    = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]
const ZOOM_DEFAULT  = 2 // 1×
const PAL_CELL      = 8

// ── Types ────────────────────────────────────────────────────────────────────

interface OwPosition { x: number; y: number }

interface OwArea {
  index: number
  widthTiles: number
  heightTiles: number
  cameraX: number
  cameraY: number
  objectTileset: number
  paletteIndex: number
  paletteAddrNormal: number
  paletteAddrSpecial: number
  marioStart: OwPosition | null
  luigiStart: OwPosition | null
}

interface OwAnimFrameTable { framePointers: number[] }
interface OwEvent { bitIndex: number; primaryOffset: number; secondaryOffset: number }
interface OwEventTables {
  events: OwEvent[]
  fromTiles: number[] | Uint8Array
  toTiles: number[] | Uint8Array
}

interface OwBufferRegion {
  layout: 0 | 1
  rowStart: number
  colStart: number
  widthTiles: number
  heightTiles: number
}

interface OwL3Mask {
  topRows:    number
  bottomRows: number
  colLeft:    number
  colRight:   number
}

/** Mirrors `SerializedPaletteAnimData` from `PaletteAnimationLoader.ts`. */
interface OwPaletteAnim {
  frameCount: number
  intervalMs: number
  frames: Array<Array<{ cgramIdx: number; r: number; g: number; b: number; a: number }>>
}

interface OwPayload {
  area: OwArea
  region: OwBufferRegion
  l2Tilemap:      number[]
  l1Map16Indices: number[]
  l1CharData:     number[]
  vramTiles:      number[][]
  paletteRows:    number[][][]
  animation:        OwAnimFrameTable
  /** Per-frame CGRAM patches for the OW NMI palette cycle (`$6D` yellow,
   *  `$7D` red). Same loader as the level path, mode='overworld'. */
  paletteAnimation: OwPaletteAnim | null
  events:         OwEventTables
  warpStarts:     { mario: OwPosition[]; luigi: OwPosition[] }
  marioStart:     OwPosition | null
  luigiStart:     OwPosition | null
  l2LayoutBytes:  number
  l2ScreenBytes:  number
  /** Mask for sub-areas: top/bottom rows + left/right cols hidden by the L3 border frame.
   *  null for the Main map (Area 0). Masked cells always show the checker pattern. */
  l3Mask:         OwL3Mask | null
}

// ── Tilemap-quadrant addressing (mirror OverworldLoader.tilemapByteOffset) ──

function tilemapByteOffset(layout: 0 | 1, row: number, col: number, layoutBytes: number, screenBytes: number): number {
  const layoutBase = layout * layoutBytes
  const r = ((row % 64) + 64) % 64
  const c = ((col % 64) + 64) % 64
  const screenIdx  = ((r >> 5) << 1) | (c >> 5)
  return layoutBase + screenIdx * screenBytes + (r & 31) * 0x40 + (c & 31) * 2
}

function map16ByteOffset(layout: 0 | 1, row: number, col: number): number {
  const layoutBase = layout * 0x0400
  const r = ((row % 32) + 32) % 32
  const c = ((col % 32) + 32) % 32
  const chunkIdx   = ((r >> 4) << 1) | (c >> 4)
  return layoutBase + chunkIdx * 0x100 + (r & 15) * 0x10 + (c & 15)
}

interface TilemapWord {
  charNum: number
  palette: number
  flipX: boolean
  flipY: boolean
}

function decodeTilemapWord(lo: number, hi: number): TilemapWord {
  const word = (hi << 8) | lo
  return {
    charNum:  word & 0x03FF,
    palette: (word >> 10) & 0x07,
    flipX:   ((word >> 14) & 0x01) === 1,
    flipY:   ((word >> 15) & 0x01) === 1,
  }
}

// ── Style helpers (match map editor) ────────────────────────────────────────

function selStyle(): string {
  return 'width:100%;background:var(--vscode-dropdown-background,#3c3c3c);' +
         'color:var(--vscode-dropdown-foreground,#ccc);' +
         'border:1px solid #555;border-radius:3px;height:22px;font-size:11px;cursor:pointer;'
}
function propLabelStyle(): string {
  return 'font-size:9px;font-weight:700;letter-spacing:.08em;' +
         'color:var(--vscode-descriptionForeground,#888);margin-bottom:3px;'
}

// ── Build DOM (CSS grid mirrors map editor) ─────────────────────────────────

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
      <button class="tab-btn active" id="tab-vram"   data-tab="vram">8×8</button>
      <button class="tab-btn"        id="tab-map16"  data-tab="map16">Map16</button>
      <button class="tab-btn"        id="tab-warps"  data-tab="warps">Warps</button>
    </div>

    <div style="flex:1;overflow-y:auto;min-height:0;">

      <!-- 8×8 VRAM -->
      <div id="panel-vram" style="padding:4px 0;">
        <div style="padding:4px 8px;display:flex;align-items:center;gap:6px;">
          <span style="font-size:10px;color:#888;">Pal row</span>
          <select id="tiles-row" style="${selStyle()};flex:1"></select>
        </div>
        <div style="padding:0 8px 8px;">
          <canvas id="tiles-canvas" style="
            width:100%;image-rendering:pixelated;display:block;cursor:default;
            border:1px solid #3a3a3a;box-sizing:border-box;
            background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="tiles-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

      <!-- Map16 -->
      <div id="panel-map16" style="display:none;padding:4px 0;">
        <div style="padding:0 8px 8px;">
          <canvas id="map16-canvas" style="
            width:100%;image-rendering:pixelated;display:block;cursor:default;
            border:1px solid #3a3a3a;box-sizing:border-box;
            background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
          <div id="map16-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
        </div>
      </div>

      <!-- Warps -->
      <div id="panel-warps" style="display:none;padding:8px;">
        <div style="${propLabelStyle()};margin-bottom:4px;">WARPS TO THIS AREA</div>
        <div id="warp-list" style="font-family:monospace;font-size:11px;color:#bbb;line-height:1.5;">—</div>
      </div>

    </div><!-- left scroll wrapper -->

    <!-- Selected preview -->
    <div style="border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:8px;">
      <div style="${propLabelStyle()}">SELECTED</div>
      <div style="display:flex;gap:8px;align-items:flex-start;">
        <canvas id="detail-canvas" width="16" height="16" style="
          width:64px;height:64px;image-rendering:pixelated;flex-shrink:0;
          border:1px solid #555;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
        <div id="detail-info" style="font-size:10px;font-family:monospace;color:#aaa;line-height:1.6;">click a tile to inspect</div>
      </div>
    </div>

    <!-- Palette CGRAM -->
    <div style="border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:4px 8px 8px;">
      <canvas id="palette-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;cursor:crosshair;display:block;
        background:repeating-conic-gradient(#555 0% 25%,#444 0% 50%) 0 0/8px 8px;
        border:1px solid #3a3a3a;box-sizing:border-box;"></canvas>
      <div id="palette-inspect" style="font-size:11px;font-family:monospace;color:#666;min-height:14px;margin-top:4px;">hover to inspect</div>
    </div>

    <!-- Pos status bar -->
    <div style="flex-shrink:0;border-top:1px solid var(--vscode-panel-border,#3a3a3a);padding:3px 8px;display:flex;flex-direction:column;gap:1px;background:var(--vscode-sideBar-background,#252526);">
      <span id="st-tile" style="font-family:monospace;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
      <span id="st-pos"  style="font-family:monospace;font-size:11px;color:#666;white-space:nowrap;"></span>
    </div>

  </div><!-- #left-panel -->

  <!-- ── TOOLBAR (top center) ─────────────────────────────────────────────── -->
  <div id="toolbar" style="
    grid-area:toolbar;display:flex;align-items:center;gap:4px;padding:0 8px;
    background:var(--vscode-editor-background,#1e1e1e);
    border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);">

    <button id="btn-l2" class="iconBtn layerBtn on" title="Layer 2 (BG)">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="currentColor"/>
      </svg>
    </button>
    <button id="btn-l1" class="iconBtn layerBtn on" title="Layer 1 (icons)">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="currentColor"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="#666"/>
      </svg>
    </button>
    <button id="btn-l3" class="iconBtn layerBtn on" title="Layer 3 — show/hide OW border row mask">
      <svg width="16" height="14" viewBox="0 0 16 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1"  width="14" height="3" rx="1" fill="currentColor"/>
        <rect x="1" y="6"  width="14" height="3" rx="1" fill="#666"/>
        <rect x="1" y="11" width="14" height="3" rx="1" fill="#666"/>
      </svg>
    </button>

    <div class="tb-sep"></div>

    <button id="btn-block" class="iconBtn" title="Block view — color/label each tile by ID"><span class="codicon codicon-symbol-method"></span></button>
    <button id="btn-grid"  class="iconBtn" title="Tile grid (8×8)"><span class="codicon codicon-table"></span></button>

    <div class="tb-sep"></div>

    <button id="btn-anim"   class="iconBtn"    title="Play / pause palette animation"><span class="codicon codicon-play"></span></button>
    <button id="btn-events" class="iconBtn"    title="Switch state — apply OW event tile swaps"><span class="codicon codicon-symbol-event"></span></button>

    <div class="tb-sep"></div>

    <button id="zoom-out" class="iconBtn" title="Zoom out"><span class="codicon codicon-zoom-out"></span></button>
    <span id="zoom-label" style="font-family:monospace;font-size:11px;min-width:28px;text-align:center;flex-shrink:0;">1×</span>
    <button id="zoom-in"  class="iconBtn" title="Zoom in"><span class="codicon codicon-zoom-in"></span></button>

    <div style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0;">
      <span id="area-id" style="font-family:monospace;font-size:11px;color:#aaa;white-space:nowrap;"></span>
    </div>

  </div><!-- #toolbar -->

  <!-- ── MAIN CANVAS ──────────────────────────────────────────────────────── -->
  <div id="main" style="grid-area:main;display:flex;flex-direction:column;overflow:hidden;position:relative;">
    <div id="canvas-wrap" style="flex:1;overflow:auto;position:relative;background:#111;cursor:crosshair;min-height:0;">
      <canvas id="ow-canvas" style="display:block;image-rendering:pixelated;margin:12px;"></canvas>
    </div>
  </div><!-- #main -->

  <!-- ── RIGHT PANEL ──────────────────────────────────────────────────────── -->
  <div id="right-panel" style="
    grid-area:right;display:flex;flex-direction:column;overflow:hidden;
    background:var(--vscode-sideBar-background,#252526);
    border-left:1px solid var(--vscode-panel-border,#3a3a3a);">

    <div id="props-hdr" style="
      padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);
      font-size:11px;min-height:30px;flex-shrink:0;display:flex;align-items:center;">
      <span id="props-ctx" style="color:#bbb;font-weight:600;">Area —</span>
    </div>

    <!-- Inspector (selected tile / sprite) -->
    <div id="pp-empty" style="flex:1 1 0;display:flex;align-items:center;justify-content:center;color:#444;font-size:11px;padding:16px;text-align:center;min-height:80px;">Hover the canvas for tile info.</div>
    <div id="pp-tile"  style="display:none;flex:1 1 0;padding:8px;overflow-y:auto;min-height:80px;font-size:11px;color:#ccc;"></div>

    <!-- Tab strip -->
    <div class="tab-strip" role="tablist">
      <button class="tab-btn active" data-tab="general" role="tab">General</button>
      <button class="tab-btn"        data-tab="camera"  role="tab">Camera</button>
    </div>
    <div class="tab-content-wrap">

      <div class="tab-pane" data-tab="general" style="padding:8px;display:flex;flex-direction:column;gap:8px;">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">AREA</div>
            <div id="info-area" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
          <div>
            <div style="${propLabelStyle()}">SIZE (TILES)</div>
            <div id="info-size" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">OBJ TILESET</div>
            <div id="info-tileset" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
          <div>
            <div style="${propLabelStyle()}">PAL INDEX</div>
            <div id="info-palix" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
        </div>

        <div>
          <div style="${propLabelStyle()}">PALETTE BLOCK (NORMAL)</div>
          <div id="info-paddr" style="font-family:monospace;font-size:11px;color:#aaa;">—</div>
        </div>

      </div><!-- /tab-pane general -->

      <div class="tab-pane" data-tab="camera" style="padding:8px;display:none;flex-direction:column;gap:8px;">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div>
            <div style="${propLabelStyle()}">CAMERA X (PX)</div>
            <div id="info-camx" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
          <div>
            <div style="${propLabelStyle()}">CAMERA Y (PX)</div>
            <div id="info-camy" style="font-family:monospace;font-size:12px;color:#ccc;">—</div>
          </div>
        </div>

        <div>
          <div style="${propLabelStyle()}">BG REGION</div>
          <div id="info-region" style="font-family:monospace;font-size:11px;color:#aaa;line-height:1.6;">—</div>
        </div>

      </div><!-- /tab-pane camera -->

    </div><!-- /tab-content-wrap -->

  </div><!-- #right-panel -->
</div>

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

  .layerBtn { transition: opacity 0.15s; }
  .layerBtn:not(.on) { opacity: 0.4; }

  .tb-sep { width:1px;height:20px;background:var(--vscode-panel-border,#444);margin:0 2px;flex-shrink:0; }

  .tab-btn {
    background: transparent; border: none; border-bottom: 2px solid transparent;
    color: #888; padding: 0 8px; height: 100%; cursor: pointer;
    font-size: 11px; font-family: var(--vscode-font-family, system-ui);
    transition: color 0.15s, border-bottom-color 0.15s; flex-shrink: 0;
  }
  .tab-btn.active { color: #e0e0e0; border-bottom-color: #007acc; }
  .tab-btn:hover:not(.active) { color: #ccc; }

  #right-panel .tab-strip {
    display: flex; flex-shrink: 0; height: 30px; overflow: hidden;
    border-top: 1px solid var(--vscode-panel-border, #3a3a3a);
    border-bottom: 1px solid var(--vscode-panel-border, #3a3a3a);
  }
  #right-panel .tab-strip .tab-btn { flex: 1 1 0; }
  #right-panel .tab-content-wrap {
    flex: 0 1 auto; min-height: 0; overflow-y: auto;
    max-height: 50vh;
  }
</style>
`

// ── Element refs ────────────────────────────────────────────────────────────

const canvas       = document.getElementById('ow-canvas')        as HTMLCanvasElement
const ctx          = canvas.getContext('2d')!
const canvasWrap   = document.getElementById('canvas-wrap')!
const areaIdEl     = document.getElementById('area-id')!
const propsCtx     = document.getElementById('props-ctx')!
const stTile       = document.getElementById('st-tile')!
const stPos        = document.getElementById('st-pos')!
const ppEmpty      = document.getElementById('pp-empty')!
const ppTile       = document.getElementById('pp-tile')!

const btnL1        = document.getElementById('btn-l1')        as HTMLButtonElement
const btnL2        = document.getElementById('btn-l2')        as HTMLButtonElement
const btnL3        = document.getElementById('btn-l3')        as HTMLButtonElement
const btnBlock     = document.getElementById('btn-block')     as HTMLButtonElement
const btnGrid      = document.getElementById('btn-grid')      as HTMLButtonElement
const btnAnim      = document.getElementById('btn-anim')      as HTMLButtonElement
const btnEvents    = document.getElementById('btn-events')    as HTMLButtonElement
const zoomOutBtn   = document.getElementById('zoom-out')      as HTMLButtonElement
const zoomInBtn    = document.getElementById('zoom-in')       as HTMLButtonElement
const zoomLabel    = document.getElementById('zoom-label')!

const tabBtns      = Array.from(document.querySelectorAll('.tab-btn')) as HTMLButtonElement[]
const tilesRowSel  = document.getElementById('tiles-row')     as HTMLSelectElement
const tilesCanvas  = document.getElementById('tiles-canvas')  as HTMLCanvasElement
const map16Canvas  = document.getElementById('map16-canvas')  as HTMLCanvasElement
const tilesInspect = document.getElementById('tiles-inspect')!
const map16Inspect = document.getElementById('map16-inspect')!
const detailCanvas = document.getElementById('detail-canvas') as HTMLCanvasElement
const detailInfo   = document.getElementById('detail-info')!
const palCanvas    = document.getElementById('palette-canvas') as HTMLCanvasElement
const palInspect   = document.getElementById('palette-inspect')!
const warpList     = document.getElementById('warp-list')!

const infoArea     = document.getElementById('info-area')!
const infoSize     = document.getElementById('info-size')!
const infoTileset  = document.getElementById('info-tileset')!
const infoPalIx    = document.getElementById('info-palix')!
const infoPAddr    = document.getElementById('info-paddr')!
const infoCamX     = document.getElementById('info-camx')!
const infoCamY     = document.getElementById('info-camy')!
const infoRegion   = document.getElementById('info-region')!

// ── State ───────────────────────────────────────────────────────────────────

let payload: OwPayload | null = null
let zoomIdx                = ZOOM_DEFAULT
let highlightedPalRow: number | null = null

const toggle = {
  l1: true, l2: true, l3: true,         // L3 frame mask visible by default
  block: false, grid: false,
  events: false,
  anim: false,                          // animation off until user opts in
}

// OW animation: split into two cadences, mirroring the level path's
// `mapAnimTimer` + `palAnimTimer` (see `mapEditor/main.ts:1697-1721`).
//   - palAnimTimer:  CGRAM $6D/$7D cycle from the OW NMI
//                    (`bank_00.asm:80/A4E3-A51E`). Driven by per-frame
//                    patches in `payload.paletteAnimation.frames` from
//                    the shared `loadPaletteAnimData(rom, 'overworld')`.
//   - animationTimer: tile-shimmer cadence from `OW_Tile_Animation`
//                    (`bank_04.asm:74-148`) — water bitplane rotation
//                    and crumbling-castle frame swap. Tile-byte
//                    rendering for these is still TODO; the timer
//                    advances the frame index so the webview is ready
//                    to consume that data when it lands.
//
// Both timers share the single `toggle.anim` button — start/stop in
// lockstep so the user sees one consistent "playing/paused" state.

// Palette animation — applies `paletteAnimation.frames[palAnimFrame]`
// to the live `paletteRows` (overwriting CGRAM $6D and $7D each tick).
// The base palette stays in `payload.paletteRows` and gets re-overwritten
// each tick, so rolling back is automatic when we apply the next frame.
// Initial render kicks off frame 0 to match the level path's
// `applyPalAnimFrame(0)` warm-up at load.
let palAnimFrame = 0

function applyPalAnimFrame(): void {
  if (!payload?.paletteAnimation) return
  const anim = payload.paletteAnimation
  const frame = anim.frames[palAnimFrame % anim.frameCount] ?? []
  for (const patch of frame) {
    const r = (patch.cgramIdx >> 4) & 0x0F
    const c =  patch.cgramIdx       & 0x0F
    const row = payload.paletteRows[r]
    if (row) row[c] = [patch.r, patch.g, patch.b, patch.a]
  }
}

const palAnimTimer = frameClock.every(
  () => msToFrames(payload?.paletteAnimation?.intervalMs ?? 67),
  () => {
    if (!payload?.paletteAnimation) return
    palAnimFrame = (palAnimFrame + 1) % payload.paletteAnimation.frameCount
    applyPalAnimFrame()
    renderArea()
    renderPaletteCanvas()
  },
)

let animationFrameIdx = 0
/** The tile-animation frame advances every 8 game frames: bits 3-4 of
 *  `EffFrame` select it (`SMWDisX bank_05.asm:4396-4398`). NOT
 *  `CODE_00A5F9`, which is an 8-iteration pre-run called only from two
 *  load paths (`bank_00.asm:2527`, `:4871`); the per-frame work is the
 *  NMI call at `bank_00.asm:271`. Whether the overworld uses this same
 *  stride is untraced: these are level-mode routines. */
const ANIM_TICK_FRAMES = 8
const animationTimer = frameClock.every(
  () => ANIM_TICK_FRAMES,
  () => {
    if (!payload) return
    animationFrameIdx = (animationFrameIdx + 1)
      % Math.max(1, payload.animation.framePointers.length)
    // TODO: wire GFX bitplane rotation for water tiles + crumbling
    // castle frame swap from `DATA_048006`. The frame counter is
    // already advancing so the renderer just needs to consume it.
  },
)

const offscreen = document.createElement('canvas')
let offCtx       = offscreen.getContext('2d')!

// ── Lookups ─────────────────────────────────────────────────────────────────

function readL2Word(layout: 0 | 1, row: number, col: number): TilemapWord | null {
  if (!payload) return null
  const off = tilemapByteOffset(layout, row, col, payload.l2LayoutBytes, payload.l2ScreenBytes)
  const lo = payload.l2Tilemap[off]     ?? 0
  const hi = payload.l2Tilemap[off + 1] ?? 0
  if (lo === 0 && hi === 0) return null
  return decodeTilemapWord(lo, hi)
}

function readL1Map16Index(layout: 0 | 1, mrow: number, mcol: number): number {
  if (!payload) return 0
  const off = map16ByteOffset(layout, mrow, mcol)
  return payload.l1Map16Indices[off] ?? 0
}

// ── Tile blitting ───────────────────────────────────────────────────────────

function blitChar(
  imgData: ImageData,
  imgW: number,
  px: number,
  py: number,
  word: TilemapWord,
  transparent: boolean,
): void {
  if (!payload) return
  const tile = payload.vramTiles[word.charNum]
  const palRow = payload.paletteRows[word.palette]
  if (!tile || tile.length === 0 || !palRow) return
  const d = imgData.data
  const W = SNES_TILE_PX

  for (let y = 0; y < W; y++) {
    const sy = word.flipY ? (W - 1 - y) : y
    for (let x = 0; x < W; x++) {
      const sx   = word.flipX ? (W - 1 - x) : x
      const idx  = tile[sy * W + sx]
      if (idx === 0 && transparent) continue
      const c = palRow[idx] ?? [255, 0, 255, 255]
      const dx = px + x
      const dy = py + y
      if (dx < 0 || dy < 0 || dx >= imgW || dy >= imgData.height) continue
      const o = (dy * imgW + dx) * 4
      d[o]     = c[0]
      d[o + 1] = c[1]
      d[o + 2] = c[2]
      d[o + 3] = 255
    }
  }
}

// ── L3 mask helpers ─────────────────────────────────────────────────────────

function isMaskedRow(localRow: number): boolean {
  if (!payload?.l3Mask) return false
  const m = payload.l3Mask
  const h = payload.region.heightTiles
  return localRow < m.topRows || localRow >= h - m.bottomRows
}

/** Paint one 8×8 cell as the transparency-grid checker pattern used in
 *  the side panels (matches `repeating-conic-gradient(#333,#222)`). */
function fillCheckerCell(imgData: ImageData, imgW: number, px: number, py: number): void {
  const W = SNES_TILE_PX
  const d = imgData.data
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dark = (((px + x) >> 2) + ((py + y) >> 2)) & 1
      const v = dark ? 0x22 : 0x33
      const o = ((py + y) * imgW + (px + x)) * 4
      d[o]     = v
      d[o + 1] = v
      d[o + 2] = v
      d[o + 3] = 255
    }
  }
}

// ── Render the area ─────────────────────────────────────────────────────────

function renderArea(): void {
  if (!payload) return

  const layout    = payload.region.layout
  const rowOffset = payload.region.rowStart
  const colOffset = payload.region.colStart

  const widthTiles  = payload.region.widthTiles
  const heightTiles = payload.region.heightTiles
  const imgW = widthTiles  * SNES_TILE_PX
  const imgH = heightTiles * SNES_TILE_PX

  if (offscreen.width !== imgW || offscreen.height !== imgH) {
    offscreen.width  = imgW
    offscreen.height = imgH
    offCtx = offscreen.getContext('2d')!
  }

  const imgData = offCtx.createImageData(imgW, imgH)

  // Back-area baseline
  const back = payload.paletteRows[0]?.[0] ?? [0, 0, 0, 255]
  for (let i = 0; i < imgData.data.length; i += 4) {
    imgData.data[i]     = back[0]
    imgData.data[i + 1] = back[1]
    imgData.data[i + 2] = back[2]
    imgData.data[i + 3] = 255
  }

  // Overlap row mask: the top-N and bottom-M rows contain spillover BG
  // content from neighboring sub-areas. When L3 is off, replace them with
  // the transparency checker. When L3 is on, the actual L3 overlay renders
  // there instead. Border columns (colLeft/colRight) are NOT masked here —
  // L1/L2 renders normally in those columns; isMaskedCol is reserved for
  // the future L3 overlay pass.
  if (payload.l3Mask && !toggle.l3) {
    for (let row = 0; row < heightTiles; row++) {
      if (!isMaskedRow(row)) continue
      for (let col = 0; col < widthTiles; col++) {
        fillCheckerCell(imgData, imgW, col * SNES_TILE_PX, row * SNES_TILE_PX)
      }
    }
  }

  // L2 BG
  if (toggle.l2) {
    for (let row = 0; row < heightTiles; row++) {
      if (isMaskedRow(row)) continue
      for (let col = 0; col < widthTiles; col++) {
        const word = readL2Word(layout, rowOffset + row, colOffset + col)
        if (!word) continue
        blitChar(imgData, imgW, col * SNES_TILE_PX, row * SNES_TILE_PX, word, false)
      }
    }
  }

  // L1 icons (per-SNES-tile so odd camera-Y rows like 59 crop correctly)
  if (toggle.l1) {
    for (let row = 0; row < heightTiles; row++) {
      if (isMaskedRow(row)) continue
      for (let col = 0; col < widthTiles; col++) {
        const bgRow = rowOffset + row
        const bgCol = colOffset + col
        const mrow = bgRow >> 1
        const mcol = bgCol >> 1
        const idx = readL1Map16Index(layout,mrow, mcol)
        if (idx === 0) continue
        const subtileSlot = ((bgCol & 1) << 1) | (bgRow & 1) // 0..3
        const charBytePair = idx * 8 + subtileSlot * 2
        const word = decodeTilemapWord(
          payload.l1CharData[charBytePair],
          payload.l1CharData[charBytePair + 1],
        )
        blitChar(imgData, imgW, col * SNES_TILE_PX, row * SNES_TILE_PX, word, true)
      }
    }
  }

  // L3 overlay — wiring is stubbed; toggle is visible but inert until
  // actual L3 tile rendering is implemented.
  void toggle.l3

  offCtx.putImageData(imgData, 0, 0)

  const zoom = ZOOM_STEPS[zoomIdx]
  canvas.width  = imgW * zoom
  canvas.height = imgH * zoom
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)

  // Grid (8×8)
  if (toggle.grid) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 1
    const tw = SNES_TILE_PX * zoom
    for (let c = 0; c <= widthTiles; c++) {
      const x = Math.round(c * tw) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
    }
    for (let r = 0; r <= heightTiles; r++) {
      const y = Math.round(r * tw) + 0.5
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
    }
    ctx.restore()
  }

  // Block view: hashed colors + $XXX labels per tile, matching the
  // map editor's block view semantics. L2 paints first at 55% alpha
  // (8×8 cells, char-num labels), L1 paints on top at full alpha
  // (16×16 Map16 cells with Map16-id labels). L3-masked rows are
  // skipped so the checker keeps showing through.
  if (toggle.block) renderBlockView(layout, rowOffset, colOffset, widthTiles, heightTiles, zoom)

  zoomLabel.textContent = formatZoom(zoom)
}

function renderBlockView(
  layout: 0 | 1,
  rowOffset: number,
  colOffset: number,
  widthTiles: number,
  heightTiles: number,
  zoom: number,
): void {
  if (!payload) return
  const tilePx   = SNES_TILE_PX * zoom
  const map16Px  = MAP16_PX     * zoom

  // L2: per-SNES-tile colored fill (55% alpha) keyed on tilemap char num.
  ctx.save()
  ctx.globalAlpha = 0.55
  for (let row = 0; row < heightTiles; row++) {
    if (isMaskedRow(row)) continue
    for (let col = 0; col < widthTiles; col++) {
      const word = readL2Word(layout, rowOffset + row, colOffset + col)
      if (!word) continue
      paintBlockFill(ctx, col * tilePx, row * tilePx, tilePx, word.charNum)
    }
  }
  ctx.restore()

  // L1: 16×16 Map16 cells at full alpha. Step in Map16 units (= 2×2
  // SNES tiles). Use the Map16-grid coordinates (BG row/col >> 1) to
  // index into Map16TilesLow.
  for (let row = 0; row < heightTiles; row += MAP16_SNES) {
    if (isMaskedRow(row)) continue
    for (let col = 0; col < widthTiles; col += MAP16_SNES) {
      const bgRow = rowOffset + row
      const bgCol = colOffset + col
      const idx   = readL1Map16Index(layout,bgRow >> 1, bgCol >> 1)
      if (idx === 0) continue
      paintBlockFill(ctx, col * tilePx, row * tilePx, map16Px, idx)
    }
  }

  // Labels: L1 (Map16 id) takes priority over L2 (char num) at each
  // covered cell. Render at the cell-of-record's pixel size so the
  // text auto-sizes correctly. Skip entirely below the legibility floor.
  if (tilePx >= BLOCK_LABEL_MIN_PX) {
    for (let row = 0; row < heightTiles; row++) {
      if (isMaskedRow(row)) continue
      for (let col = 0; col < widthTiles; col++) {
        // L1 dominates: a covered Map16 cell labels at 16×16, and we
        // only label its top-left SNES sub-tile so the $XXX appears
        // once per Map16 (not 4×).
        const bgRow = rowOffset + row
        const bgCol = colOffset + col
        const isMap16TopLeft = (row & 1) === 0 && (col & 1) === 0
        if (isMap16TopLeft) {
          const m16 = readL1Map16Index(layout,bgRow >> 1, bgCol >> 1)
          if (m16 !== 0) {
            paintBlockLabel(ctx, col * tilePx, row * tilePx, map16Px, m16, 3)
            continue
          }
        }
        // L2 fallback at 8×8 — only if no L1 Map16 covers this cell.
        const m16Cover = readL1Map16Index(layout,bgRow >> 1, bgCol >> 1)
        if (m16Cover !== 0) continue
        const word = readL2Word(layout, bgRow, bgCol)
        if (!word) continue
        paintBlockLabel(ctx, col * tilePx, row * tilePx, tilePx, word.charNum, 3)
      }
    }
  }
}

function formatZoom(z: number): string {
  return Number.isInteger(z) ? `${z}×` : `${z.toFixed(2).replace(/0+$/,'').replace(/\.$/,'')}×`
}

// ── Side panels ─────────────────────────────────────────────────────────────

function renderPaletteCanvas(): void {
  if (!payload) return
  const pctx = palCanvas.getContext('2d')!
  pctx.clearRect(0, 0, 128, 128)

  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 16; c++) {
      const cell = payload.paletteRows[r]?.[c] ?? [0, 0, 0, 0]
      const x = c * PAL_CELL
      const y = r * PAL_CELL
      const a = cell[3] ?? 255
      if (a < 255) {
        pctx.fillStyle = (c + r) % 2 === 0 ? '#666' : '#444'
        pctx.fillRect(x, y, PAL_CELL, PAL_CELL)
      }
      if (a > 0) {
        pctx.fillStyle = `rgba(${cell[0]},${cell[1]},${cell[2]},${(a / 255).toFixed(3)})`
        pctx.fillRect(x, y, PAL_CELL, PAL_CELL)
      }
    }
  }

  // Highlight the row being used by the hovered L1 / L2 tile so the user
  // can see at a glance which 16-color (4bpp Mode 1) palette feeds the tile.
  if (highlightedPalRow !== null) {
    const y = highlightedPalRow * PAL_CELL
    pctx.save()
    pctx.strokeStyle = '#ffd040'
    pctx.lineWidth   = 1
    pctx.strokeRect(0.5, y + 0.5, 128 - 1, PAL_CELL - 1)
    pctx.restore()
  }
}

function renderTilesPanel(): void {
  if (!payload) return
  if (tilesRowSel.options.length === 0) {
    for (let r = 0; r < 16; r++) {
      const opt = document.createElement('option')
      opt.value = String(r)
      opt.textContent = `Row ${r.toString(16).toUpperCase()}`
      if (r === 4) opt.selected = true // OW area-specific palette starts at row 4
      tilesRowSel.appendChild(opt)
    }
  }
  drawTilesCanvas(parseInt(tilesRowSel.value, 10))
}

function drawTilesCanvas(paletteRow: number): void {
  if (!payload) return
  const COLS = 16
  const tiles = payload.vramTiles
  const filled = tiles.filter(t => t.length > 0)
  const rowsCnt = Math.ceil(filled.length / COLS)
  const w = COLS * SNES_TILE_PX
  const h = rowsCnt * SNES_TILE_PX
  tilesCanvas.width  = w
  tilesCanvas.height = h
  const tctx = tilesCanvas.getContext('2d')!
  const img = tctx.createImageData(w, h)
  const palRow = payload.paletteRows[paletteRow] ?? []
  let drawn = 0
  for (let i = 0; i < tiles.length && drawn < filled.length; i++) {
    if (tiles[i].length === 0) continue
    const col = drawn % COLS
    const row = Math.floor(drawn / COLS)
    for (let y = 0; y < SNES_TILE_PX; y++) {
      for (let x = 0; x < SNES_TILE_PX; x++) {
        const idx = tiles[i][y * SNES_TILE_PX + x] ?? 0
        const cx = col * SNES_TILE_PX + x
        const cy = row * SNES_TILE_PX + y
        const o = (cy * w + cx) * 4
        if (idx === 0) {
          const ck = ((cx >> 2) + (cy >> 2)) & 1
          const v = ck ? 60 : 40
          img.data[o] = v; img.data[o+1] = v; img.data[o+2] = v; img.data[o+3] = 255
        } else {
          const c = palRow[idx] ?? [255, 0, 255, 255]
          img.data[o] = c[0]; img.data[o+1] = c[1]; img.data[o+2] = c[2]; img.data[o+3] = 255
        }
      }
    }
    drawn++
  }
  tctx.putImageData(img, 0, 0)
}

function renderMap16Panel(): void {
  if (!payload) return
  const COLS = 16
  const COUNT = 512
  const rowsCnt = Math.ceil(COUNT / COLS)
  const w = COLS * MAP16_PX
  const h = rowsCnt * MAP16_PX
  map16Canvas.width  = w
  map16Canvas.height = h
  const mctx = map16Canvas.getContext('2d')!
  const img = mctx.createImageData(w, h)

  for (let i = 0; i < COUNT; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const off = i * 8
    if (off + 8 > payload.l1CharData.length) break
    const tl = decodeTilemapWord(payload.l1CharData[off + 0], payload.l1CharData[off + 1])
    const bl = decodeTilemapWord(payload.l1CharData[off + 2], payload.l1CharData[off + 3])
    const tr = decodeTilemapWord(payload.l1CharData[off + 4], payload.l1CharData[off + 5])
    const br = decodeTilemapWord(payload.l1CharData[off + 6], payload.l1CharData[off + 7])
    const baseX = col * MAP16_PX
    const baseY = row * MAP16_PX
    blitToImage(img, w, baseX,                baseY,                tl)
    blitToImage(img, w, baseX + SNES_TILE_PX, baseY,                tr)
    blitToImage(img, w, baseX,                baseY + SNES_TILE_PX, bl)
    blitToImage(img, w, baseX + SNES_TILE_PX, baseY + SNES_TILE_PX, br)
  }
  mctx.putImageData(img, 0, 0)
}

function blitToImage(img: ImageData, imgW: number, px: number, py: number, word: TilemapWord): void {
  if (!payload) return
  const tile = payload.vramTiles[word.charNum]
  const palRow = payload.paletteRows[word.palette]
  if (!tile || tile.length === 0 || !palRow) return
  for (let y = 0; y < SNES_TILE_PX; y++) {
    const sy = word.flipY ? SNES_TILE_PX - 1 - y : y
    for (let x = 0; x < SNES_TILE_PX; x++) {
      const sx = word.flipX ? SNES_TILE_PX - 1 - x : x
      const idx = tile[sy * SNES_TILE_PX + sx] ?? 0
      const dx = px + x
      const dy = py + y
      if (dx < 0 || dy < 0 || dx >= imgW || dy >= img.height) continue
      const o = (dy * imgW + dx) * 4
      if (idx === 0) {
        const ck = ((dx >> 2) + (dy >> 2)) & 1
        const v = ck ? 50 : 30
        img.data[o] = v; img.data[o+1] = v; img.data[o+2] = v; img.data[o+3] = 255
      } else {
        const c = palRow[idx] ?? [255, 0, 255, 255]
        img.data[o] = c[0]; img.data[o+1] = c[1]; img.data[o+2] = c[2]; img.data[o+3] = 255
      }
    }
  }
}

function renderWarpsPanel(): void {
  if (!payload) return
  const m = payload.warpStarts.mario
  if (m.length === 0) {
    warpList.innerHTML = '<span style="color:#666;font-style:italic;">No warps target this area</span>'
    return
  }
  warpList.innerHTML = m.map((p, i) =>
    `<div>#${i}: x=$${hex4(p.x)} y=$${hex4(p.y)}</div>`,
  ).join('')
}

function renderInspector(): void {
  if (!payload) return
  const a = payload.area
  const r = payload.region
  propsCtx.textContent = `Area ${a.index} (${a.widthTiles}×${a.heightTiles})`

  infoArea.textContent    = `$${hex2(a.index)}`
  infoSize.textContent    = `${a.widthTiles}×${a.heightTiles}`
  infoTileset.textContent = `$${hex2(a.objectTileset)}`
  infoPalIx.textContent   = `$${hex2(a.paletteIndex)}`
  infoPAddr.textContent   = `$${hex6(a.paletteAddrNormal)}`

  infoCamX.textContent = `${a.cameraX} (signed)`
  infoCamY.textContent = `${a.cameraY} (signed)`
  infoRegion.textContent =
    `layout ${r.layout}\n` +
    `start  (col=${r.colStart}, row=${r.rowStart})\n` +
    `size   ${r.widthTiles}×${r.heightTiles}`
}

// ── Animation timer ─────────────────────────────────────────────────────────

function syncAnimButton(): void {
  // Both timers run in lockstep — palette is always running with
  // tile, so either one's `running` state reflects the toggle.
  const running = animationTimer.running || palAnimTimer.running
  toggle.anim = running
  btnAnim.classList.toggle('on', running)
  const codicon = btnAnim.querySelector('.codicon')
  if (codicon) {
    codicon.classList.toggle('codicon-debug-pause', running)
    codicon.classList.toggle('codicon-play', !running)
  }
}

function startAnimation(): void {
  animationTimer.start()
  if (payload?.paletteAnimation) palAnimTimer.start()
  syncAnimButton()
}

function pauseAnimation(): void {
  animationTimer.stop()
  palAnimTimer.stop()
  syncAnimButton()
}

// ── UI wiring ───────────────────────────────────────────────────────────────

function wireToggle(btn: HTMLButtonElement, key: keyof typeof toggle, defaultOn: boolean): void {
  if (defaultOn) btn.classList.add('on')
  else btn.classList.remove('on')
  btn.addEventListener('click', () => {
    toggle[key] = !toggle[key]
    btn.classList.toggle('on', toggle[key])
    renderArea()
  })
}

wireToggle(btnL1,    'l1',     toggle.l1)
wireToggle(btnL2,    'l2',     toggle.l2)
wireToggle(btnL3,    'l3',     toggle.l3)
wireToggle(btnBlock, 'block',  toggle.block)
wireToggle(btnGrid,  'grid',   toggle.grid)
wireToggle(btnEvents,'events', toggle.events)

btnAnim.addEventListener('click', () => {
  if (toggle.anim) pauseAnimation()
  else             startAnimation()
})

zoomInBtn.addEventListener('click', () => {
  if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; renderArea() }
})
zoomOutBtn.addEventListener('click', () => {
  if (zoomIdx > 0) { zoomIdx--; renderArea() }
})

canvasWrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  if (e.deltaY < 0 && zoomIdx < ZOOM_STEPS.length - 1) zoomIdx++
  else if (e.deltaY > 0 && zoomIdx > 0)                 zoomIdx--
  else return
  renderArea()
}, { passive: false })

tilesRowSel.addEventListener('change', () => {
  drawTilesCanvas(parseInt(tilesRowSel.value, 10))
})

tabBtns.forEach(b => {
  b.addEventListener('click', () => {
    const tab = b.dataset.tab!
    const scope = b.closest('#left-panel') ? 'left' : 'right'
    if (scope === 'left') {
      Array.from(document.querySelectorAll('#left-panel .tab-btn'))
        .forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.tab === tab))
      const panels: Record<string,string> = {
        vram: 'panel-vram', map16: 'panel-map16', warps: 'panel-warps',
      }
      Object.entries(panels).forEach(([k, id]) => {
        const el = document.getElementById(id)
        if (el) el.style.display = k === tab ? '' : 'none'
      })
    } else {
      Array.from(document.querySelectorAll('#right-panel .tab-btn'))
        .forEach(x => x.classList.toggle('active', (x as HTMLElement).dataset.tab === tab))
      Array.from(document.querySelectorAll('#right-panel .tab-pane'))
        .forEach(x => {
          const el = x as HTMLElement
          el.style.display = el.dataset.tab === tab ? 'flex' : 'none'
        })
    }
  })
})

map16Canvas.addEventListener('mousemove', (ev) => {
  if (!payload) return
  const rect = map16Canvas.getBoundingClientRect()
  const sx = map16Canvas.width  / rect.width
  const sy = map16Canvas.height / rect.height
  const col = Math.floor((ev.clientX - rect.left) * sx / MAP16_PX)
  const row = Math.floor((ev.clientY - rect.top)  * sy / MAP16_PX)
  const idx = row * 16 + col
  if (idx >= 0 && idx < 512) {
    map16Inspect.textContent = `Map16 #$${hex3(idx)}`
  }
})

tilesCanvas.addEventListener('mousemove', (ev) => {
  if (!payload) return
  const rect = tilesCanvas.getBoundingClientRect()
  const sx = tilesCanvas.width  / rect.width
  const sy = tilesCanvas.height / rect.height
  const col = Math.floor((ev.clientX - rect.left) * sx / SNES_TILE_PX)
  const row = Math.floor((ev.clientY - rect.top)  * sy / SNES_TILE_PX)
  // Map back from "filled tile sequence" to actual char index
  const filled = payload.vramTiles
    .map((t, i) => t.length > 0 ? i : -1)
    .filter(i => i >= 0)
  const idx = row * 16 + col
  const charNum = filled[idx]
  if (charNum !== undefined) {
    tilesInspect.textContent = `char $${hex3(charNum)}`
  }
})

palCanvas.addEventListener('mousemove', (ev) => {
  if (!payload) return
  const rect = palCanvas.getBoundingClientRect()
  const sx = 128 / rect.width
  const sy = 128 / rect.height
  const col = Math.floor((ev.clientX - rect.left) * sx / PAL_CELL)
  const row = Math.floor((ev.clientY - rect.top)  * sy / PAL_CELL)
  if (row < 0 || row >= 16 || col < 0 || col >= 16) return
  const c = payload.paletteRows[row]?.[col] ?? [0, 0, 0, 0]
  const bgr555 = (Math.round(c[2] * 31 / 255) << 10)
               | (Math.round(c[1] * 31 / 255) << 5)
               | (Math.round(c[0] * 31 / 255))
  const idx = row * 16 + col
  palInspect.textContent =
    `$${hex2(idx)} ` +
    `R${hex2(row)}C${hex2(col)} ` +
    `RGB(${c[0]},${c[1]},${c[2]}) ` +
    `BGR=$${hex4(bgr555)}`
})

palCanvas.addEventListener('click', (ev) => {
  if (!payload) return
  const rect = palCanvas.getBoundingClientRect()
  const sy = 128 / rect.height
  const row = Math.floor((ev.clientY - rect.top)  * sy / PAL_CELL)
  if (row < 0 || row >= 16) return
  // Click a row to switch the 8×8 viewer to that palette
  for (let i = 0; i < tilesRowSel.options.length; i++) {
    if (parseInt(tilesRowSel.options[i].value, 10) === row) {
      tilesRowSel.selectedIndex = i
      drawTilesCanvas(row)
      break
    }
  }
})

/** Decode the L1 subtile tilemap word at the given BG (row, col). */
function readL1Word(layout: 0 | 1, bgRow: number, bgCol: number): { word: TilemapWord; m16: number } | null {
  if (!payload) return null
  const mrow = bgRow >> 1
  const mcol = bgCol >> 1
  const m16 = readL1Map16Index(layout,mrow, mcol)
  if (m16 === 0) return null
  const subtileSlot = ((bgCol & 1) << 1) | (bgRow & 1) // 0..3
  const charBytePair = m16 * 8 + subtileSlot * 2
  const word = decodeTilemapWord(
    payload.l1CharData[charBytePair] ?? 0,
    payload.l1CharData[charBytePair + 1] ?? 0,
  )
  return { word, m16 }
}

canvas.addEventListener('mousemove', (ev) => {
  if (!payload) return
  const rect = canvas.getBoundingClientRect()
  const zoom = ZOOM_STEPS[zoomIdx]
  const cx   = Math.floor((ev.clientX - rect.left) / zoom)
  const cy   = Math.floor((ev.clientY - rect.top)  / zoom)
  if (cx < 0 || cy < 0) return

  const tileCol = Math.floor(cx / SNES_TILE_PX)
  const tileRow = Math.floor(cy / SNES_TILE_PX)
  const w = payload.region.widthTiles
  const h = payload.region.heightTiles
  if (tileCol >= w || tileRow >= h) return

  const bgRow = payload.region.rowStart + tileRow
  const bgCol = payload.region.colStart + tileCol
  const l2word = readL2Word(payload.region.layout, bgRow, bgCol)
  const l1     = readL1Word(payload.region.layout, bgRow, bgCol)

  // L1 icons take priority for inspection (the user is usually selecting the
  // foreground icon, not the BG). Fall back to L2 if no L1 tile here.
  const inspect = l1 ? { word: l1.word, layer: 'L1' as const, m16: l1.m16 } :
                  l2word ? { word: l2word, layer: 'L2' as const, m16: 0 } :
                  null

  stPos.textContent = `(${cx},${cy}) tile (${tileCol},${tileRow})`
  if (inspect) {
    const m16Str = l1 ? ` | L1 #$${hex2(l1.m16)}` : ''
    stTile.textContent = `${inspect.layer} $${hex3(inspect.word.charNum)} pal ${inspect.word.palette}${m16Str}`
  } else {
    stTile.textContent = '—'
  }

  // Right panel hover inspector
  if (inspect) {
    ppEmpty.style.display = 'none'
    ppTile.style.display  = ''
    ppTile.innerHTML = `
      <div style="${propLabelStyle()}">${inspect.layer} TILE</div>
      <div style="font-family:monospace;font-size:11px;line-height:1.6;color:#bbb;">
        char    $${hex3(inspect.word.charNum)}<br>
        palette ${inspect.word.palette} (CGRAM row ${inspect.word.palette})<br>
        flipX   ${inspect.word.flipX ? 'yes' : '—'}<br>
        flipY   ${inspect.word.flipY ? 'yes' : '—'}
      </div>
      ${l1 ? `<div style="${propLabelStyle()};margin-top:8px;">L1 MAP16</div>
      <div style="font-family:monospace;font-size:11px;color:#bbb;">
        index #$${hex2(l1.m16)}
      </div>` : ''}
      <div style="${propLabelStyle()};margin-top:8px;">BG POSITION</div>
      <div style="font-family:monospace;font-size:11px;color:#bbb;">
        row=${bgRow}  col=${bgCol}
      </div>
    `

    drawDetail(inspect.word)

    // Sync the side-panel palette row to the hovered tile so the
    // 8×8 sheet and palette grid both show the row this tile uses.
    if (highlightedPalRow !== inspect.word.palette) {
      highlightedPalRow = inspect.word.palette
      tilesRowSel.value = String(inspect.word.palette)
      drawTilesCanvas(inspect.word.palette)
      renderPaletteCanvas()
    }
  }
})

function drawDetail(word: TilemapWord): void {
  if (!payload) return
  detailCanvas.width  = SNES_TILE_PX
  detailCanvas.height = SNES_TILE_PX
  const dctx = detailCanvas.getContext('2d')!
  const img  = dctx.createImageData(SNES_TILE_PX, SNES_TILE_PX)
  const tile = payload.vramTiles[word.charNum]
  const palRow = payload.paletteRows[word.palette]
  if (!tile || tile.length === 0) return
  for (let y = 0; y < SNES_TILE_PX; y++) {
    const sy = word.flipY ? SNES_TILE_PX - 1 - y : y
    for (let x = 0; x < SNES_TILE_PX; x++) {
      const sx = word.flipX ? SNES_TILE_PX - 1 - x : x
      const idx = tile[sy * SNES_TILE_PX + sx] ?? 0
      const o = (y * SNES_TILE_PX + x) * 4
      if (idx === 0) {
        const ck = ((x >> 1) + (y >> 1)) & 1
        const v = ck ? 60 : 40
        img.data[o] = v; img.data[o+1] = v; img.data[o+2] = v; img.data[o+3] = 255
      } else {
        const c = palRow?.[idx] ?? [255, 0, 255, 255]
        img.data[o] = c[0]; img.data[o+1] = c[1]; img.data[o+2] = c[2]; img.data[o+3] = 255
      }
    }
  }
  dctx.putImageData(img, 0, 0)
  detailInfo.innerHTML = `
    char $${hex3(word.charNum)}<br>
    pal  ${word.palette}<br>
    flip ${word.flipX ? 'X' : '—'}${word.flipY ? 'Y' : ''}
  `
}

window.addEventListener('error', (ev) => {
  console.error('overworldViewer error:', ev.message)
})

// ── Inbound messages ────────────────────────────────────────────────────────

window.addEventListener('message', (ev) => {
  const msg = ev.data
  if (msg.type === 'load') {
    payload = msg as OwPayload
    areaIdEl.textContent = `Area ${payload.area.index} (${payload.area.widthTiles}×${payload.area.heightTiles})`

    // Kick off palette animation at frame 0 before the first render so
    // CGRAM $6D/$7D show their cycle-start values instead of whatever
    // `loadAreaPalette` left there. Mirrors the level path's
    // `applyPalAnimFrame(0)` warm-up at load (`mapEditor/main.ts`).
    palAnimFrame = 0
    applyPalAnimFrame()

    renderArea()
    renderPaletteCanvas()
    renderTilesPanel()
    renderMap16Panel()
    renderWarpsPanel()
    renderInspector()

    // Animation defaults to off. The user opts in via the toolbar
    // play button. Sync the button glyph in case the timer was left
    // running by a previous payload (defensive).
    syncAnimButton()
  } else if (msg.type === 'error') {
    areaIdEl.textContent = `Error: ${msg.message}`
    areaIdEl.style.color = '#f06262'
  }
})

vscode.postMessage({ type: 'ready' })

export {}
