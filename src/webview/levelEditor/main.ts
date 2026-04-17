/**
 * SMW Level Editor — webview entry point.
 *
 * Layout:
 *   ┌─ toolbar ──────────────────────────────────────────────────────────┐
 *   │ [Level $XXX]  [meta]   [zoom −][1×][+]  [Grid][Sprites][Block][L1][L2] │
 *   ├─ workspace ────────────────────────────────────────────────────────┤
 *   │ ┌─ canvas-wrap (scroll) ──────────────────────┐ ┌─ props (220px) ─┐ │
 *   │ │                                              │ │ PALETTE         │ │
 *   │ │   <canvas> (pixel-art, no fit-to-window)    │ │ LEVEL HEADER    │ │
 *   │ │                                              │ │ ROOM INFO       │ │
 *   │ └──────────────────────────────────────────────┘ └─────────────────┘ │
 *   ├─ status ───────────────────────────────────────────────────────────┤
 *   └────────────────────────────────────────────────────────────────────┘
 */

import { createTransportBar, TRANSPORT_CSS } from '../shared/transportBar'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const SMWCentral: any
const vscode = acquireVsCodeApi()

// ── Constants ─────────────────────────────────────────────────────────────────

const TILE_PX    = 16
const SCREEN_W   = 16
const SCREEN_H   = 27
const ZOOM_STEPS = [0.25, 0.5, 1, 2, 3, 4]
const ZOOM_DEFAULT_IDX = 2  // 1×
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
  <span id="level-id" style="font-family:monospace;color:#5b9cf6;font-weight:600;min-width:90px"></span>
  <span id="level-meta" style="color:#888;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
    <button id="zoom-out" title="Zoom out (Ctrl+scroll)" style="${btnStyle()}">&#8722;</button>
    <span id="zoom-label" style="font-family:monospace;font-size:11px;min-width:32px;text-align:center">1&#215;</span>
    <button id="zoom-in"  title="Zoom in (Ctrl+scroll)"  style="${btnStyle()}">&#43;</button>
  </div>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-grid" checked> Grid</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-sprites" checked> Sprites</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-block"> Block</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-l1" checked> L1</label>
  <label style="${chkStyle()}"><input type="checkbox" id="chk-l2" checked> L2</label>
</div>

<div id="workspace" style="display:flex;flex:1;overflow:hidden;">

  <div id="tiles-panel" style="
    width:220px;flex-shrink:0;overflow-y:auto;
    background:var(--vscode-sideBar-background,#252526);
    border-right:1px solid var(--vscode-panel-border,#3a3a3a);
    font-family:var(--vscode-font-family,system-ui);font-size:12px;">

    <div class="section-hdr">8×8 TILES (VRAM)</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
      <button id="vram-prev" style="${btnStyle()}" title="Previous page">◀</button>
      <span id="vram-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 6</span>
      <button id="vram-next" style="${btnStyle()}" title="Next page">▶</button>
    </div>
    <div style="padding:4px 8px 8px;">
      <canvas id="vram-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;display:block;cursor:default;
        border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
        <div id="vram-inspect" style="font-size:10px;font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
        <div style="display:flex;gap:2px;">
          <button id="btn-anim-prev" style="${btnStyle()}border:none;" title="Previous frame">⏮</button>
          <button id="btn-anim" style="${btnStyle()}border:none;" title="Play animation">▶</button>
          <button id="btn-anim-next" style="${btnStyle()}border:none;" title="Next frame">⏭</button>
          <button id="btn-vram-grid" style="${btnStyle()}border:none;" title="Toggle grid">⊞</button>
        </div>
      </div>
    </div>

    <div class="section-hdr">16×16 TILES (MAP16)</div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:4px 8px;">
      <button id="map16-prev" style="${btnStyle()}" title="Previous page">◀</button>
      <span id="map16-page-label" style="font-size:11px;font-family:monospace;color:#aaa;min-width:70px;text-align:center;">Page 1 / 2</span>
      <button id="map16-next" style="${btnStyle()}" title="Next page">▶</button>
    </div>
    <div style="padding:4px 8px 8px;">
      <canvas id="map16-canvas" width="256" height="256" style="
        width:100%;image-rendering:pixelated;display:block;cursor:default;
        border:1px solid #3a3a3a;box-sizing:border-box;background:repeating-conic-gradient(#333 0% 25%,#222 0% 50%) 0 0/8px 8px;"></canvas>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;">
        <div id="map16-inspect" style="font-size:10px;font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
        <div style="display:flex;gap:2px;">
          <button id="btn-anim-prev2" style="${btnStyle()}border:none;" title="Previous frame">⏮</button>
          <button id="btn-anim2" style="${btnStyle()}border:none;" title="Play animation">▶</button>
          <button id="btn-anim-next2" style="${btnStyle()}border:none;" title="Next frame">⏭</button>
          <button id="btn-map16-grid" style="${btnStyle()}border:none;" title="Toggle grid">⊞</button>
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
    <div id="canvas-wrap" style="flex:1;overflow:auto;background:#111111;cursor:crosshair;">
      <canvas id="level-canvas" style="display:block;image-rendering:pixelated;margin:8px;"></canvas>
    </div>
    <div id="music-transport"></div>
  </div>

  <div id="props-panel" style="
    width:220px;flex-shrink:0;overflow-y:auto;
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
          <button id="btn-pal-grid" style="${btnStyle()}border:none;" title="Toggle palette grid">⊞</button>
          <div id="pal-anim-controls" style="display:none;align-items:center;gap:2px;">
            <button id="btn-pal-play" style="${btnStyle()}border:none;" title="Play palette animation">▶</button>
          </div>
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

  </div>
</div>

<div id="status" style="
  display:flex;gap:16px;align-items:center;flex-shrink:0;
  padding:3px 12px;height:22px;
  background:var(--vscode-statusBar-background,#007acc);
  font-family:monospace;font-size:11px;
  color:var(--vscode-statusBar-foreground,#fff);">
  <span id="st-pos">—</span>
  <span id="st-tile">—</span>
  <span id="st-info" style="margin-left:auto"></span>
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
  ${TRANSPORT_CSS}
</style>
`

// ── Element refs ─────────────────────────────────────────────────────────────

const canvas         = document.getElementById('level-canvas')   as HTMLCanvasElement
const ctx            = canvas.getContext('2d')!
const canvasWrap     = document.getElementById('canvas-wrap')!
const levelId        = document.getElementById('level-id')!
const levelMeta      = document.getElementById('level-meta')!
const zoomLabel      = document.getElementById('zoom-label')!
const stPos          = document.getElementById('st-pos')!
const stTile         = document.getElementById('st-tile')!
const stInfo         = document.getElementById('st-info')!
const chkGrid        = document.getElementById('chk-grid')        as HTMLInputElement
const chkSprites     = document.getElementById('chk-sprites')     as HTMLInputElement
const chkBlock       = document.getElementById('chk-block')       as HTMLInputElement
const chkL1          = document.getElementById('chk-l1')          as HTMLInputElement
const chkL2          = document.getElementById('chk-l2')          as HTMLInputElement

// ── Tile detail preview state ─────────────────────────────────────────────────
let selectedDetail: { type: 'vram'; page: number; col: number; row: number } |
                    { type: 'map16'; page: number; col: number; row: number } | null = null
let selectedDetailTileId: number | null = null

function redrawDetail(): void {
  if (!selectedDetail) return
  const dc = document.getElementById('detail-canvas') as HTMLCanvasElement
  const dctx = dc.getContext('2d')!
  const info = document.getElementById('detail-info')!
  if (selectedDetail.type === 'vram' && vramFullImageData) {
    dc.width = 8; dc.height = 8
    const pageH = (VRAM_TILES_PER_PAGE / 16) * 8
    const srcX = selectedDetail.col * 8
    const srcTileY = selectedDetail.page * pageH + selectedDetail.row * 8
    const tileData = dctx.createImageData(8, 8)
    for (let ty = 0; ty < 8; ty++)
      for (let tx = 0; tx < 8; tx++) {
        const si = ((srcTileY + ty) * vramFullImageData.width + (srcX + tx)) * 4
        const di = (ty * 8 + tx) * 4
        for (let c = 0; c < 4; c++) tileData.data[di+c] = vramFullImageData.data[si+c]
      }
    dctx.putImageData(tileData, 0, 0)
    const globalChar = selectedDetail.page * VRAM_TILES_PER_PAGE + selectedDetail.row * 16 + selectedDetail.col
    const slot = globalChar < 0x80 ? 'FG1' : globalChar < 0x100 ? 'FG2' : globalChar < 0x180 ? 'FG3' : globalChar < 0x200 ? 'AN1' : globalChar < 0x400 ? '—' : 'SP'
    info.innerHTML = `<b>8×8 char $${globalChar.toString(16).padStart(3,'0')}</b><br>slot: ${slot}`
  } else if (selectedDetail.type === 'map16' && map16Pages[selectedDetail.page]) {
    const entry = map16Pages[selectedDetail.page]
    dc.width = 16; dc.height = 16
    const srcX = selectedDetail.col * 16
    const srcY = entry.pageInAtlas * 256 + selectedDetail.row * 16
    const tileData = dctx.createImageData(16, 16)
    const w = entry.atlas.width
    for (let ty = 0; ty < 16; ty++)
      for (let tx = 0; tx < 16; tx++) {
        const si = ((srcY + ty) * w + (srcX + tx)) * 4
        const di = (ty * 16 + tx) * 4
        for (let c = 0; c < 4; c++) tileData.data[di+c] = entry.atlas.data[si+c]
      }
    dctx.putImageData(tileData, 0, 0)
    const localTile = selectedDetail.row * 16 + selectedDetail.col
    const tileId = entry.label.startsWith('L1') ? entry.pageInAtlas * 256 + localTile : localTile
    const frameInfo = animFrameCount > 1 ? `<br>frame: ${animFrame + 1} / ${animFrameCount}` : ''
    info.innerHTML = `<b>Map16 tile $${tileId.toString(16).padStart(3,'0')}</b>${frameInfo}`
  }
}

// ── Tile viewer hover highlight ───────────────────────────────────────────────
let vramHoverTile: { col: number; row: number } | null = null
let map16HoverTile: { col: number; row: number } | null = null

// ── Tile viewer grid toggles ─────────────────────────────────────────────────
let vramGridOn = false
let map16GridOn = false
let palGridOn = false
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

// ── Animation ────────────────────────────────────────────────────────────────
// Animation happens at the VRAM level. The provider sends per-frame 8×8 VRAM sheets.
// Frame 0 is the base vramSheetData. Extra frames are in animation.extraVramSheets.
// The timer swaps VRAM sheets; both the 8×8 viewer and Map16 viewer redraw from
// the current sheet. Map16 tiles are static references — they don't change.
let animRunning = false
let animTimer: ReturnType<typeof setInterval> | null = null
let animIntervalMs = 133
let animFrameCount = 1
let animFrame = 0
let vramSheets: ImageData[] = []         // frame 0 = base, frames 1+ = extra (RGBA for 8×8 viewer)
let vramIndexedFrames: Uint8Array[] = [] // frame 0 = base, frames 1+ (raw indexed for Map16 composition)
let activeVramIndexed: Uint8Array | null = null  // current frame's indexed data

// Palette animation state (FlashingColors CGRAM cycling)
let palAnimTimer: ReturnType<typeof setInterval> | null = null
let palAnimFrame   = 0
let palAnimRunning = false
let palAnimOriginals: Map<number, number[]> | null = null

/**
 * Rebuild the 8×8 VRAM tile sheet from raw indexed VRAM + current palette.
 * Mirrors server-side buildVramSheet but runs on the live palette so palette
 * animation is reflected immediately. Palette row selection: FG/AN chars
 * (i < $300) use row 2; SP chars use row 8. Same logic as the server.
 */
function rebuildVramSheet(indexed: Uint8Array, palRows: number[][][]): ImageData {
  const VRAM_TILES = 1536
  const VR_PER_ROW = 16
  const sheetW = VR_PER_ROW * 8
  const sheetH = Math.ceil(VRAM_TILES / VR_PER_ROW) * 8
  const buf = new Uint8ClampedArray(sheetW * sheetH * 4)
  for (let i = 0; i < VRAM_TILES; i++) {
    const tileCol = i % VR_PER_ROW
    const tileRow = Math.floor(i / VR_PER_ROW)
    // FG1/FG2/FG3 ($000–$17F): row 2 (terrain). AN1/AN2/BG1 ($180–$2FF): row 6
    // (animation/sprite slots — FlashingColors writes here). SP ($300+): row 8.
    const palRowIdx = i < 0x180 ? 2 : i < 0x300 ? 6 : 8
    const pal = palRows[palRowIdx] ?? palRows[0]
    const srcOff = i * 64
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const palIdx = indexed[srcOff + py * 8 + px] ?? 0
        const dx = tileCol * 8 + px
        const dy = tileRow * 8 + py
        const di = (dy * sheetW + dx) * 4
        if (palIdx === 0) {
          buf[di] = buf[di + 1] = buf[di + 2] = 0; buf[di + 3] = 0
        } else {
          const c = pal[palIdx] ?? [255, 0, 255, 255]
          buf[di] = c[0]; buf[di + 1] = c[1]; buf[di + 2] = c[2]; buf[di + 3] = 255
        }
      }
    }
  }
  return new ImageData(buf, sheetW, sheetH)
}

// ── Reactive rendering chain ─────────────────────────────────────────────────
// Each layer rebuilds from its dependencies and notifies the next layer down.
//   palette rows change  →  invalidatePalette()
//   vram indexed changes →  invalidateVram()     (palette already live)
//   map16 defs change    →  invalidateMap16()    (vram + palette already live)

function invalidateMap16(): void {
  if (!activeVramIndexed || !levelData?.paletteRows || !levelData.map16Defs) return
  const newAtlas = rebuildMap16Atlas(activeVramIndexed, levelData.paletteRows, levelData.map16Defs)
  for (const entry of map16Pages) {
    if (entry.label.startsWith('L1')) entry.atlas = newAtlas
  }
  renderMap16Page()
  redrawDetail()
}

function invalidateVram(): void {
  if (!activeVramIndexed || !levelData?.paletteRows) return
  vramFullImageData = rebuildVramSheet(activeVramIndexed, levelData.paletteRows)
  renderVramPage()
  invalidateMap16()
}

function invalidatePalette(): void {
  drawPaletteCanvas()
  invalidateVram()
}

function applyPalAnimFrame(f: number): void {
  if (!levelData?.paletteAnimation || !levelData.paletteRows) return
  const anim = levelData.paletteAnimation
  const patches = anim.frames[f % anim.frameCount] ?? []
  for (const p of patches) {
    const row = p.cgramIdx >> 4
    const col = p.cgramIdx & 15
    if (levelData.paletteRows[row]) {
      levelData.paletteRows[row][col] = [p.r, p.g, p.b, p.a]
    }
  }
  invalidatePalette()
}

function syncPalAnimButton(): void {
  const btn = document.getElementById('btn-pal-play')
  if (btn) btn.textContent = palAnimRunning ? '⏸' : '▶'
}

function startPalAnimTimer(): void {
  if (palAnimTimer) { clearInterval(palAnimTimer); palAnimTimer = null }
  if (!levelData?.paletteAnimation) return
  palAnimRunning = true
  syncPalAnimButton()
  palAnimTimer = setInterval(() => {
    palAnimFrame = (palAnimFrame + 1) % (levelData?.paletteAnimation?.frameCount ?? 8)
    applyPalAnimFrame(palAnimFrame)
  }, levelData.paletteAnimation.intervalMs)
}

function stopPalAnimTimer(): void {
  if (palAnimTimer) { clearInterval(palAnimTimer); palAnimTimer = null }
  palAnimRunning = false
  syncPalAnimButton()
}

function togglePalAnim(): void {
  if (palAnimRunning) stopPalAnimTimer()
  else startPalAnimTimer()
}

document.getElementById('btn-pal-play')!.addEventListener('click', togglePalAnim)

const animPlayBtns = [document.getElementById('btn-anim')!, document.getElementById('btn-anim2')!]

function syncAnimButtons(): void {
  for (const btn of animPlayBtns) {
    btn.textContent = animRunning ? '⏸' : '▶'
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

function updateAnimLabel(): void {
  const lbl = document.getElementById('anim-frame-label')
  if (lbl) lbl.textContent = animFrameCount > 1 ? `${animFrame + 1}/${animFrameCount}` : ''
}

function stepFrame(delta: number): void {
  if (animFrameCount <= 1) return
  if (animRunning) { stopAnimTimer(); stopPalAnimTimer(); animRunning = false; syncAnimButtons() }
  animFrame = ((animFrame + delta) % animFrameCount + animFrameCount) % animFrameCount
  if (vramIndexedFrames[animFrame]) activeVramIndexed = vramIndexedFrames[animFrame]
  invalidateVram()
  updateAnimLabel()
}

document.getElementById('btn-anim-prev')!.addEventListener('click', () => stepFrame(-1))
document.getElementById('btn-anim-next')!.addEventListener('click', () => stepFrame(1))
document.getElementById('btn-anim-prev2')!.addEventListener('click', () => stepFrame(-1))
document.getElementById('btn-anim-next2')!.addEventListener('click', () => stepFrame(1))

function startAnimTimer(): void {
  if (animTimer) { clearInterval(animTimer); animTimer = null }
  animFrame = 0
  animTimer = setInterval(() => {
    animFrame = (animFrame + 1) % animFrameCount
    if (vramIndexedFrames[animFrame]) activeVramIndexed = vramIndexedFrames[animFrame]
    invalidateVram()
  }, animIntervalMs)
}

function stopAnimTimer(): void {
  if (animTimer) { clearInterval(animTimer); animTimer = null }
  animFrame = 0
  if (vramIndexedFrames[0]) activeVramIndexed = vramIndexedFrames[0]
  invalidateVram()
}

// ── Tile panel page navigation ───────────────────────────────────────────────
// VRAM pages: 256 tiles per page (16×16 grid = 128×128px), matching Mesen/LM.
// Page count derived from data height, not hardcoded.
const VRAM_TILES_PER_PAGE = 256
let vramPage = 0
let vramTotalPages = 0
let vramFullImageData: ImageData | null = null

function renderVramPage(): void {
  if (!vramFullImageData) return
  const vc = document.getElementById('vram-canvas') as HTMLCanvasElement
  const vctx = vc.getContext('2d')!
  const tilesPerRow = 16
  const rows = VRAM_TILES_PER_PAGE / tilesPerRow  // 16
  vc.width = tilesPerRow * 8   // 128
  vc.height = rows * 8          // 128
  const srcY = vramPage * rows * 8
  const srcH = rows * 8
  const sw = vramFullImageData.width
  if (srcY + srcH > vramFullImageData.height) { vctx.clearRect(0, 0, vc.width, vc.height); return }
  const slice = new Uint8ClampedArray(sw * srcH * 4)
  for (let row = 0; row < srcH; row++) {
    const srcOff = ((srcY + row) * sw) * 4
    const dstOff = (row * sw) * 4
    slice.set(vramFullImageData.data.subarray(srcOff, srcOff + sw * 4), dstOff)
  }
  vctx.putImageData(new ImageData(slice, sw, srcH), 0, 0)
  if (vramGridOn) {
    vctx.strokeStyle = 'rgba(0,0,0,0.5)'
    vctx.lineWidth = 0.5
    for (let x = 0; x <= vc.width; x += 8) { vctx.beginPath(); vctx.moveTo(x, 0); vctx.lineTo(x, vc.height); vctx.stroke() }
    for (let y = 0; y <= vc.height; y += 8) { vctx.beginPath(); vctx.moveTo(0, y); vctx.lineTo(vc.width, y); vctx.stroke() }
  }
  if (vramHoverTile) {
    vctx.fillStyle = 'rgba(0,0,0,0.55)'
    vctx.fillRect(0, 0, vc.width, vc.height)
    vctx.clearRect(vramHoverTile.col * 8, vramHoverTile.row * 8, 8, 8)
    // Re-draw just the hovered tile from the slice
    const hx = vramHoverTile.col * 8, hy = vramHoverTile.row * 8
    const tileSlice = new Uint8ClampedArray(8 * 8 * 4)
    for (let py = 0; py < 8; py++)
      for (let px = 0; px < 8; px++) {
        const si = ((hy + py) * sw + (hx + px)) * 4
        const di = (py * 8 + px) * 4
        for (let c = 0; c < 4; c++) tileSlice[di+c] = slice[si+c]
      }
    vctx.putImageData(new ImageData(tileSlice, 8, 8), hx, hy)
  }
  const lbl = document.getElementById('vram-page-label')!
  lbl.textContent = `Page ${vramPage + 1} / ${vramTotalPages}`
}

document.getElementById('vram-prev')!.addEventListener('click', () => {
  if (vramTotalPages > 0) { vramPage = (vramPage - 1 + vramTotalPages) % vramTotalPages; renderVramPage() }
})
document.getElementById('vram-next')!.addEventListener('click', () => {
  if (vramTotalPages > 0) { vramPage = (vramPage + 1) % vramTotalPages; renderVramPage() }
})

// ── Map16 client-side composition from indexed VRAM chars ────────────────────

/** Composite a single 8x8 subtile from indexed VRAM into an RGBA ImageData. */
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
      const dx = destX + px, dy = destY + py
      const di = (dy * destW + dx) * 4
      if (palIdx === 0) {
        dest[di] = dest[di + 1] = dest[di + 2] = 0; dest[di + 3] = 0
      } else {
        const c = pal[palIdx] ?? [255, 0, 255, 255]
        dest[di] = c[0]; dest[di + 1] = c[1]; dest[di + 2] = c[2]; dest[di + 3] = 255
      }
    }
  }
}

/** Rebuild the L1 Map16 atlas from indexed VRAM + palette + tile defs. */
function rebuildMap16Atlas(
  indexed: Uint8Array, palRows: number[][][],
  defs: LevelPayload['map16Defs'],
): ImageData {
  if (!defs || defs.length === 0) return new ImageData(256, 256)
  const cols = 16, tileW = 16
  const rows = Math.ceil(defs.length / cols)
  const w = cols * tileW, h = rows * tileW
  const buf = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i]
    const tx = (i % cols) * tileW, ty = Math.floor(i / cols) * tileW
    blitSubTile(indexed, palRows, def.tl, buf, tx, ty, w)
    blitSubTile(indexed, palRows, def.tr, buf, tx + 8, ty, w)
    blitSubTile(indexed, palRows, def.bl, buf, tx, ty + 8, w)
    blitSubTile(indexed, palRows, def.br, buf, tx + 8, ty + 8, w)
  }
  return new ImageData(buf, w, h)
}

// MAP16 page viewer — pages derived from atlas data, blank pages skipped.
// Each page entry has an atlas ImageData and a page-within-atlas index.
interface Map16PageEntry { atlas: ImageData; pageInAtlas: number; label: string }
let map16Pages: Map16PageEntry[] = []
let map16PageIdx = 0
let map16FullImageData: ImageData | null = null  // kept for detail preview (L1 atlas)

function renderMap16Page(): void {
  const mc = document.getElementById('map16-canvas') as HTMLCanvasElement
  const mctx = mc.getContext('2d')!
  mc.width = 256; mc.height = 256
  if (map16Pages.length === 0) { mctx.clearRect(0, 0, 256, 256); return }

  const entry = map16Pages[map16PageIdx]
  const srcY = entry.pageInAtlas * 256
  const srcH = 256
  const sw = entry.atlas.width
  if (srcY + srcH > entry.atlas.height) { mctx.clearRect(0, 0, 256, 256); return }

  // Start with the base atlas page
  const pageImg = new Uint8ClampedArray(256 * 256 * 4)
  for (let row = 0; row < srcH; row++) {
    const srcOff = ((srcY + row) * sw) * 4
    const dstOff = (row * 256) * 4
    pageImg.set(entry.atlas.data.subarray(srcOff, srcOff + 256 * 4), dstOff)
  }



  mctx.putImageData(new ImageData(pageImg, 256, 256), 0, 0)
  if (map16GridOn) {
    mctx.strokeStyle = 'rgba(0,0,0,0.5)'
    mctx.lineWidth = 0.5
    for (let x = 0; x <= mc.width; x += 16) { mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, mc.height); mctx.stroke() }
    for (let y = 0; y <= mc.height; y += 16) { mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(mc.width, y); mctx.stroke() }
  }
  if (map16HoverTile) {
    mctx.fillStyle = 'rgba(0,0,0,0.55)'
    mctx.fillRect(0, 0, mc.width, mc.height)
    const hx = map16HoverTile.col * 16, hy = map16HoverTile.row * 16
    mctx.clearRect(hx, hy, 16, 16)
    const tileSlice = new Uint8ClampedArray(16 * 16 * 4)
    for (let py = 0; py < 16; py++)
      for (let px = 0; px < 16; px++) {
        const si = ((hy + py) * 256 + (hx + px)) * 4
        const di = (py * 16 + px) * 4
        for (let c = 0; c < 4; c++) tileSlice[di+c] = pageImg[si+c]
      }
    mctx.putImageData(new ImageData(tileSlice, 16, 16), hx, hy)
  }
  const lbl = document.getElementById('map16-page-label')!
  lbl.textContent = `Page ${map16PageIdx + 1} / ${map16Pages.length}`
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

// ── State ────────────────────────────────────────────────────────────────────

let zoomIdx      = ZOOM_DEFAULT_IDX
let zoom         = ZOOM_STEPS[zoomIdx]
let levelData: LevelPayload | null = null
let l2TileGrid:  number[][] | null = null
let atlasImg:    ImageBitmap | null = null
let activeTileId = -1
let activeTool: 'place' | 'erase' = 'place'
let isPainting   = false
// Which CGRAM cells to highlight in the palette panel (null = all at full brightness)
// Each entry: { row, colStart, colEnd } — highlights cols colStart..colEnd (inclusive)
interface PaletteHighlight { row: number; colStart: number; colEnd: number }
let paletteHighlightCells: PaletteHighlight[] | null = null

interface TileUv { col: number; row: number }

interface LevelPayload {
  levelIndex:      number
  screens:         number
  tileGrid:        number[][]
  l2TileGrid:      number[][] | null
  atlasData:       number[]
  atlasWidth:      number
  atlasHeight:     number
  tileUvMap:       Record<number, TileUv>
  sprites:         Array<{ x: number; y: number; spriteId: number }>
  backAreaColor:   [number, number, number, number]
  backAreaColors:  number[][]   // 8 variants × [r,g,b,a]
  paletteRows:     number[][][]   // 16 rows × 16 colors × [r,g,b,a]
  // 8x8 VRAM tile sheet (chars $000-$2FF, rendered with palette row 2)
  vramSheetData?:  number[]   // RGBA pixels, 128px wide × Npx tall
  vramSheetW?:     number
  vramSheetH?:     number
  // L1 Map16 atlas (from tileset-aware pointer table)
  map16AtlasData?: number[]
  // L2/BG Map16 atlas (from Map16BGTiles)
  map16BgAtlasData?: number[]
  // Animation: VRAM-level frame data. Frame 0 is the base vramSheetData.
  // extraVramSheets contains frames 1+ as RGBA pixel arrays (same format as vramSheetData).
  // The webview cycles VRAM sheets; Map16 tiles are static references into VRAM chars.
  // Map16 tile definitions for client-side composition
  map16Defs?: Array<{
    id: number
    tl: { c: number; p: number; fx: boolean; fy: boolean }
    bl: { c: number; p: number; fx: boolean; fy: boolean }
    tr: { c: number; p: number; fx: boolean; fy: boolean }
    br: { c: number; p: number; fx: boolean; fy: boolean }
  }>
  // Raw indexed VRAM: 1 byte per pixel, 64 bytes per char, 1536 chars
  vramIndexedData?: number[]
  animation?: {
    frameCount: number
    intervalMs: number
    extraVramSheets: number[][]
    extraVramIndexed: number[][]
  }
  // Palette animation: FlashingColors CGRAM cycling ($6D/$7D)
  paletteAnimation?: {
    frameCount: number
    intervalMs: number
    frames: Array<Array<{ cgramIdx: number; r: number; g: number; b: number; a: number }>>
  } | null
  // SPC music data for this level
  spcData?:        number[] | null
  spcBgmCommand?:  number
  header: {
    music:          number
    spriteSet:      number
    bgPalette:      number
    fgPalette:      number
    bgColor:        number
    spritePalette:  number
    marioVariant:   number
    gfxTilesetId:   number
  }
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

function applyZoom(): void {
  zoom = ZOOM_STEPS[zoomIdx]
  zoomLabel.textContent = `${zoom}×`
  if (levelData) redraw()
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
  if (next >= 0 && next < ZOOM_STEPS.length) { zoomIdx = next; applyZoom() }
}, { passive: false })

// ── Palette canvas ────────────────────────────────────────────────────────────

function drawPaletteCanvas(): void {
  if (!levelData?.paletteRows) return
  const rows = levelData.paletteRows
  palCtx.clearRect(0, 0, 128, 128)

  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      const c = rows[row]?.[col] ?? [0, 0, 0, 0]
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

  // Dim cells that are NOT part of the currently focused palette group
  if (paletteHighlightCells !== null) {
    palCtx.fillStyle = 'rgba(0,0,0,0.65)'
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const isHighlighted = paletteHighlightCells.some(
          h => h.row === row && col >= h.colStart && col <= h.colEnd
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
  if (!levelData?.paletteRows) return
  const rect = palCanvas.getBoundingClientRect()
  const scaleX = 128 / rect.width
  const col = Math.floor((e.clientX - rect.left) * scaleX / PAL_CELL)
  const row = Math.floor((e.clientY - rect.top)  * scaleX / PAL_CELL)
  if (col < 0 || col > 15 || row < 0 || row > 15) return
  const c = levelData.paletteRows[row]?.[col] ?? [0, 0, 0, 0]
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
        ctx.fillText(`$${tileId.toString(16).toUpperCase().padStart(3,'0')}`,
          Math.round(col * px) + Math.round(px / 2),
          Math.round(row * px) + Math.round(px / 2))
      }
    }
  }
  ctx.restore()
}

function redraw(): void {
  if (!levelData) return
  if (!chkBlock.checked && !atlasImg) return

  const { tileGrid, screens, sprites, tileUvMap } = levelData
  const cols = screens * SCREEN_W
  const rows = SCREEN_H
  const px   = TILE_PX * zoom

  canvas.width  = Math.round(cols * px)
  canvas.height = Math.round(rows * px)
  ctx.imageSmoothingEnabled = false

  if (levelData.backAreaColor) {
    const [r, g, b] = levelData.backAreaColor
    ctx.fillStyle = `rgb(${r},${g},${b})`
  } else {
    ctx.fillStyle = '#000'
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (chkBlock.checked) {
    if (chkL2.checked && l2TileGrid) drawBlockGrid(l2TileGrid, cols, rows, px, 0.55)
    if (chkL1.checked)               drawBlockGrid(tileGrid,   cols, rows, px, 1.0)
  } else {
    if (!atlasImg) return
    // TODO: L2 atlas rendering not yet implemented; L2 toggle only works in Block mode.
    if (chkL1.checked) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const tileId = tileGrid[row]?.[col] ?? 0
          if (tileId === 0) continue
          const uv = tileUvMap[tileId]
          if (!uv) continue
          ctx.drawImage(atlasImg,
            uv.col * TILE_PX, uv.row * TILE_PX, TILE_PX, TILE_PX,
            Math.round(col * px), Math.round(row * px), Math.round(px), Math.round(px))
        }
      }
    }
  }

  // Screen dividers
  ctx.strokeStyle = 'rgba(100,120,255,0.4)'
  ctx.lineWidth = 1
  for (let s = 1; s < screens; s++) {
    const x = Math.round(s * SCREEN_W * px) + 0.5
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
  }

  // Tile grid
  if (chkGrid.checked) {
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
        ctx.fillText(spr.spriteId.toString(16).toUpperCase().padStart(2,'0'), sx + 2, sy + Math.round(px) - 3)
      }
    }
  }
}

chkGrid.addEventListener('change',    redraw)
chkSprites.addEventListener('change', redraw)
chkBlock.addEventListener('change',   redraw)
chkL1.addEventListener('change',      redraw)
chkL2.addEventListener('change',      redraw)

// ── Mouse / edit interactions ─────────────────────────────────────────────────

function canvasTileAt(e: MouseEvent): { col: number; row: number } | null {
  if (!levelData) return null
  const rect = canvas.getBoundingClientRect()
  const px   = TILE_PX * zoom
  const col  = Math.floor((e.clientX - rect.left) / px)
  const row  = Math.floor((e.clientY - rect.top)  / px)
  if (col < 0 || row < 0 || row >= SCREEN_H || col >= levelData.screens * SCREEN_W) return null
  return { col, row }
}

function paintAt(e: MouseEvent): void {
  const pos = canvasTileAt(e)
  if (!pos || !levelData) return
  const tileId = activeTool === 'erase' ? 0 : activeTileId
  if (tileId < 0) return
  if (levelData.tileGrid[pos.row][pos.col] === tileId) return
  levelData.tileGrid[pos.row][pos.col] = tileId
  redraw()
  vscode.postMessage({ type: 'edit', kind: activeTool, tileId, col: pos.col, row: pos.row })
}

canvas.addEventListener('mousedown', (e) => { if (e.button !== 0) return; isPainting = true; paintAt(e) })
canvas.addEventListener('mousemove', (e) => {
  const pos = canvasTileAt(e)
  if (pos) {
    const tileId = levelData?.tileGrid[pos.row]?.[pos.col] ?? 0
    stPos.textContent  = `col ${pos.col}  row ${pos.row}`
    stTile.textContent = `tile $${tileId.toString(16).toUpperCase().padStart(3,'0')}`
  }
  if (isPainting) paintAt(e)
})
canvas.addEventListener('mouseup',    () => { isPainting = false })
canvas.addEventListener('mouseleave', () => { isPainting = false })
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const prev = activeTool; activeTool = 'erase'; paintAt(e); activeTool = prev
})

canvas.addEventListener('dragover', (e) => { e.preventDefault() })
canvas.addEventListener('drop', (e) => {
  e.preventDefault()
  const tileId = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10)
  if (isNaN(tileId) || !levelData) return
  const rect = canvas.getBoundingClientRect()
  const px   = TILE_PX * zoom
  const col  = Math.floor((e.clientX - rect.left) / px)
  const row  = Math.floor((e.clientY - rect.top)  / px)
  if (col < 0 || row < 0 || row >= SCREEN_H || col >= levelData.screens * SCREEN_W) return
  levelData.tileGrid[row][col] = tileId
  redraw()
  vscode.postMessage({ type: 'edit', kind: 'place', tileId, col, row })
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
  const colors = levelData?.backAreaColors
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
  if (msg['type'] === 'load') {
    levelData  = msg as unknown as LevelPayload
    l2TileGrid = levelData.l2TileGrid ?? null

    const hex     = levelData.levelIndex.toString(16).toUpperCase().padStart(3, '0')
    const screens = levelData.screens
    levelId.textContent   = `Level $${hex}`
    levelMeta.textContent = `${screens} screen${screens !== 1 ? 's' : ''}`
    stInfo.textContent    =
      `Music $${levelData.header.music.toString(16).toUpperCase()} · ` +
      `Tileset ${levelData.header.gfxTilesetId}`

    // Populate props panel selectors (only on initial load)
    if (msg['_initial'] !== false) {
      buildSelect(selBgColor,   8,  levelData.header.bgColor,       i => `Color ${i}`)
      buildSelect(selFgPalette, 8,  levelData.header.fgPalette,     i => `FG ${i}`)
      buildSelect(selBgPalette, 8,  levelData.header.bgPalette,     i => `BG ${i}`)
      buildSelect(selSpritePal, 4,  levelData.header.spritePalette, i => `Set ${i}`)
      buildSelect(selMarioPal,  4,  levelData.header.marioVariant,
        i => ['Mario', 'Luigi', 'Fire Mario', 'Fire Luigi'][i] ?? String(i))
      buildSelect(selTileset,   16, levelData.header.gfxTilesetId)
      buildSelect(selSpriteSet, 16, levelData.header.spriteSet)
    }

    // Back area color swatch — use the selected variant from backAreaColors
    const bac = levelData.backAreaColors
    const bacIdx = levelData.header.bgColor
    const bacColor = (bac && bac[bacIdx]) ? bac[bacIdx] : levelData.backAreaColor
    backAreaSwatch.style.background = `rgb(${bacColor[0]},${bacColor[1]},${bacColor[2]})`

    // Room info
    infoScreens.textContent = String(screens)
    infoSprites.textContent = String(levelData.sprites.length)

    // Palette canvas
    drawPaletteCanvas()

    // Decode atlas and redraw
    const raw     = new Uint8ClampedArray(levelData.atlasData)
    const imgData = new ImageData(raw, levelData.atlasWidth, levelData.atlasHeight)
    atlasImg      = await createImageBitmap(imgData)
    // Build VRAM animation sheets — frame 0 is the base vramSheetData,
    // extra frames come from animation.extraVramSheets
    stopAnimTimer()
    vramSheets = []
    animFrameCount = 1

    redraw()

    // ── VRAM 8×8 tile sheet (paged by slot) ──────────────────────────
    if (levelData.vramSheetData && levelData.vramSheetW && levelData.vramSheetH) {
      const vh = levelData.vramSheetH
      const pxPerPage = (VRAM_TILES_PER_PAGE / 16) * 8
      vramTotalPages = Math.ceil(vh / pxPerPage)
      vramPage = 0

      // Build indexed VRAM frames for all animation frames
      vramIndexedFrames = []
      if (levelData.vramIndexedData) {
        activeVramIndexed = new Uint8Array(levelData.vramIndexedData)
        vramIndexedFrames = [activeVramIndexed]
      }
      if (levelData.animation && levelData.animation.frameCount > 1) {
        animFrameCount = levelData.animation.frameCount
        animIntervalMs = levelData.animation.intervalMs
        if (levelData.animation.extraVramIndexed) {
          for (const idxData of levelData.animation.extraVramIndexed) {
            vramIndexedFrames.push(new Uint8Array(idxData))
          }
        }
        for (const b of animPlayBtns) b.style.display = ''
      } else {
        for (const b of animPlayBtns) b.style.display = 'none'
      }


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
      }
    }

    // ── Map16 tile atlases — build page structure, then reactive chain fills content ──
    {
      map16Pages = []
      // L1: placeholder atlas sized from defs count; invalidateVram() will fill it reactively
      {
        const l1PageCount = levelData.map16Defs
          ? Math.ceil(levelData.map16Defs.length / 256)
          : (levelData.map16AtlasData ? Math.floor(levelData.map16AtlasData.length / (256 * 256 * 4)) : 1)
        const placeholderH = l1PageCount * 256
        const placeholder = new ImageData(256, placeholderH)
        map16FullImageData = placeholder
        for (let p = 0; p < l1PageCount; p++) {
          map16Pages.push({ atlas: placeholder, pageInAtlas: p, label: `L1 0x${p.toString(16).padStart(2,'0')}` })
        }
      }
      // L2/BG pages (from Map16BGTiles, pages labeled 0x80+)
      if (levelData.map16BgAtlasData) {
        const h = Math.floor(levelData.map16BgAtlasData.length / (256 * 4))
        const bgAtlas = new ImageData(new Uint8ClampedArray(levelData.map16BgAtlasData), 256, h)
        const bgPageCount = Math.ceil(h / 256)
        for (let p = 0; p < bgPageCount; p++) {
          map16Pages.push({ atlas: bgAtlas, pageInAtlas: p, label: `L2 0x${(0x80 + p).toString(16)}` })
        }
      }
      map16PageIdx = 0
      // Full reactive rebuild: palette → invalidatePalette → vram → invalidateVram → map16
      invalidatePalette()

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
      }
    }

    // Refresh tile detail preview (persists across palette/tileset changes)
    redrawDetail()

    // Reset palette animation state (user must press play to start)
    palAnimOriginals = null
    stopPalAnimTimer()
    palAnimFrame = 0
    const palAnimEl = document.getElementById('pal-anim-controls') as HTMLElement
    palAnimEl.style.display = levelData.paletteAnimation ? 'flex' : 'none'

    // Apply frame 0 immediately so the initial render shows the correct animated
    // color — the ROM's static value at those CGRAM slots is overwritten by the
    // NMI handler on the first game frame and is never actually visible in-game.
    if (levelData.paletteAnimation && levelData.paletteRows) {
      palAnimOriginals = new Map()
      for (const frame of levelData.paletteAnimation.frames) {
        for (const p of frame) {
          if (!palAnimOriginals.has(p.cgramIdx)) {
            const row = p.cgramIdx >> 4, col = p.cgramIdx & 15
            const orig = levelData.paletteRows[row]?.[col]
            if (orig) palAnimOriginals.set(p.cgramIdx, [...orig])
          }
        }
      }
      applyPalAnimFrame(0)
    }

  } else if (msg['type'] === 'error') {
    levelId.textContent   = 'Error'
    levelMeta.textContent = msg['message'] as string
    canvas.width = canvas.height = 1
  }
})

// ── Music transport bar ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spcBackend: any = null
let spcPlaying = false
let spcData: Uint8Array | null = null

const musicTransport = createTransportBar({
  onPlay() {
    if (!spcBackend || !spcData) return
    if (spcPlaying && spcBackend.context?.state === 'running') {
      spcBackend.context.suspend()
      musicTransport.setPaused(true)
    } else if (spcPlaying && spcBackend.context?.state === 'suspended') {
      spcBackend.context.resume()
      musicTransport.setPaused(false)
    } else {
      spcBackend.locked = false
      const ctx = spcBackend.context as AudioContext
      if (ctx?.state === 'suspended') {
        ctx.resume().then(() => {
          spcBackend.loadSPC(spcData!)
          if (spcBackend.gainNode) spcBackend.gainNode.gain.value = 1.0
          spcPlaying = true
          musicTransport.setPlaying(true)
        })
      } else {
        spcBackend.loadSPC(spcData!)
        if (spcBackend.gainNode) spcBackend.gainNode.gain.value = 1.0
        spcPlaying = true
        musicTransport.setPlaying(true)
      }
    }
  },
  onStop() {
    if (spcBackend && spcPlaying) spcBackend.stopSPC(false)
    spcPlaying = false
    musicTransport.setPlaying(false)
    musicTransport.updateTime(0)
  },
  onPrev() { /* single track per level — no-op */ },
  onNext() { /* single track per level — no-op */ },
  onStateChange(playing: boolean) { vscode.postMessage({ type: 'musicState', playing }) },
  hidePrevNext: true,
})
document.getElementById('music-transport')!.appendChild(musicTransport.element)

// Time display
setInterval(() => {
  if (spcPlaying && spcBackend?.getTime) {
    musicTransport.updateTime(spcBackend.getTime())
  }
}, 500)

// Init SPC backend after spc.js loads
setTimeout(() => {
  spcBackend = SMWCentral?.SPCPlayer?.Backend ?? null
  if (spcBackend && spcBackend.status === 0) spcBackend.initialize()
}, 500)

// Load SPC data when level loads (in the message handler above, levelData.spcData is set)
// We hook into the existing message handler by watching levelData changes
const _origHandler = window.onmessage
window.addEventListener('message', (event) => {
  const msg = event.data
  if (msg.type === 'load' && msg.spcData) {
    spcData = new Uint8Array(msg.spcData)
    const bgm = msg.spcBgmCommand ?? 0
    musicTransport.setTrackLabel(`BGM $${bgm.toString(16).toUpperCase().padStart(2, '0')}`)
    // Stop previous playback on level change
    if (spcPlaying && spcBackend) {
      spcBackend.stopSPC(false)
      spcPlaying = false
      musicTransport.setPlaying(false)
      musicTransport.updateTime(0)
    }
  }
})

vscode.postMessage({ type: 'ready' })

export {}
