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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
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

    <div class="section-hdr">8x8 TILES (VRAM)</div>
    <div style="padding:4px;">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;">
        <button id="vram-prev" style="${btnStyle()}" title="Previous page">&#9664;</button>
        <span id="vram-page" style="flex:1;text-align:center;font-family:monospace;font-size:10px;color:#aaa;">Page 1</span>
        <button id="vram-next" style="${btnStyle()}" title="Next page">&#9654;</button>
      </div>
      <canvas id="vram-canvas" width="128" height="128" style="
        width:100%;image-rendering:pixelated;display:block;
        background:#000;border:1px solid #3a3a3a;box-sizing:border-box;"></canvas>
      <div id="vram-inspect" style="margin-top:2px;font-size:10px;
        font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
    </div>

    <div class="section-hdr">MAP16 TILES</div>
    <div style="padding:4px;">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px;">
        <button id="map16-prev" style="${btnStyle()}" title="Previous page">&#9664;</button>
        <span id="map16-page" style="flex:1;text-align:center;font-family:monospace;font-size:10px;color:#aaa;">Page 0</span>
        <button id="map16-next" style="${btnStyle()}" title="Next page">&#9654;</button>
      </div>
      <canvas id="map16-canvas" width="256" height="256" style="
        width:100%;image-rendering:pixelated;display:block;
        background:#000;border:1px solid #3a3a3a;box-sizing:border-box;"></canvas>
      <div id="map16-inspect" style="margin-top:2px;font-size:10px;
        font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
    </div>

  </div>

  <div id="canvas-wrap" style="flex:1;overflow:auto;background:#111111;cursor:crosshair;">
    <canvas id="level-canvas" style="display:block;image-rendering:pixelated;margin:8px;"></canvas>
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
      <div id="palette-inspect" style="margin-top:4px;font-size:10px;
        font-family:monospace;color:#666;min-height:14px;">hover to inspect</div>
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

// Tiles panel (left)
const vramCanvas     = document.getElementById('vram-canvas')     as HTMLCanvasElement
const vramCtx        = vramCanvas.getContext('2d')!
const vramInspect    = document.getElementById('vram-inspect')!
const vramPageLabel  = document.getElementById('vram-page')!
const vramPrev       = document.getElementById('vram-prev')       as HTMLButtonElement
const vramNext       = document.getElementById('vram-next')       as HTMLButtonElement
const map16Canvas    = document.getElementById('map16-canvas')    as HTMLCanvasElement
const map16Ctx       = map16Canvas.getContext('2d')!
const map16Inspect   = document.getElementById('map16-inspect')!
const map16PageLabel = document.getElementById('map16-page')!
const map16Prev      = document.getElementById('map16-prev')      as HTMLButtonElement
const map16Next      = document.getElementById('map16-next')      as HTMLButtonElement

// Props panel (right)
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
  map16AtlasData:  number[]     // RGBA pixels for all 512 Map16 tiles (16×16 each)
  vramSheetData:   number[]     // RGBA pixels for 8x8 VRAM tiles (chars $000-$1FF)
  vramSheetW:      number
  vramSheetH:      number
  sprites:         Array<{ x: number; y: number; spriteId: number }>
  backAreaColor:   [number, number, number, number]
  backAreaColors:  number[][]   // 8 variants × [r,g,b,a]
  paletteRows:     number[][][]   // 16 rows × 16 colors × [r,g,b,a]
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

// ── VRAM 8x8 Tile Panel ──────────────────────────────────────────────────────

let vramPage = 0  // 0 = chars $000-$0FF (FG1+FG2), 1 = chars $100-$1FF (FG3+AN1)
const VRAM_PAGES = 2
let vramBitmap: ImageBitmap | null = null

async function drawVramPanel(): Promise<void> {
  if (!levelData?.vramSheetData) return
  const w = levelData.vramSheetW   // 128
  const fullH = levelData.vramSheetH  // 256
  const raw = new Uint8ClampedArray(levelData.vramSheetData)

  // Cache full bitmap
  if (raw.length >= w * fullH * 4) {
    const imgData = new ImageData(raw.slice(0, w * fullH * 4), w, fullH)
    vramBitmap = await createImageBitmap(imgData)
  }
  drawVramPage()
}

function drawVramPage(): void {
  if (!vramBitmap) return
  const pageH = 128  // 256 tiles per page, 16 per row = 16 rows × 8px = 128px
  vramCanvas.width = 128
  vramCanvas.height = pageH
  // Draw the portion for the current page
  vramCtx.drawImage(vramBitmap, 0, vramPage * pageH, 128, pageH, 0, 0, 128, pageH)
  vramPageLabel.textContent = `Page ${vramPage + 1} / ${VRAM_PAGES}`
}

vramPrev.addEventListener('click', () => { vramPage = Math.max(0, vramPage - 1); drawVramPage() })
vramNext.addEventListener('click', () => { vramPage = Math.min(VRAM_PAGES - 1, vramPage + 1); drawVramPage() })

vramCanvas.addEventListener('mousemove', (e) => {
  const rect = vramCanvas.getBoundingClientRect()
  const scaleX = 128 / rect.width
  const scaleY = 128 / rect.height
  const col = Math.floor((e.clientX - rect.left) * scaleX / 8)
  const row = Math.floor((e.clientY - rect.top)  * scaleY / 8)
  const charNum = vramPage * 256 + row * 16 + col
  if (col < 0 || col > 15 || row < 0 || row > 15) return
  const slot = charNum < 128 ? 'FG1' : charNum < 256 ? 'FG2' : charNum < 384 ? 'FG3' : 'AN1'
  vramInspect.textContent = `char $${charNum.toString(16).padStart(3, '0').toUpperCase()} (${slot})`
})
vramCanvas.addEventListener('mouseleave', () => { vramInspect.textContent = 'hover to inspect' })

// ── Map16 Tile Panel ─────────────────────────────────────────────────────────

let map16Page = 0   // page in hex: 0x0, 0x1, ...
const MAP16_TOTAL_TILES = 512  // vanilla SMW: pages 0-1
const MAP16_TILES_PER_PAGE = 256
const MAP16_PAGES = Math.ceil(MAP16_TOTAL_TILES / MAP16_TILES_PER_PAGE)
let map16Bitmap: ImageBitmap | null = null

async function drawMap16Panel(): Promise<void> {
  if (!levelData?.map16AtlasData) return
  const PX = 16
  const COLS = 16
  const atlasW = COLS * PX  // 256
  const raw = new Uint8ClampedArray(levelData.map16AtlasData)
  const totalRows = Math.ceil(MAP16_TOTAL_TILES / COLS)
  const atlasH = totalRows * PX

  if (raw.length >= atlasW * atlasH * 4) {
    const imgData = new ImageData(raw.slice(0, atlasW * atlasH * 4), atlasW, atlasH)
    map16Bitmap = await createImageBitmap(imgData)
  }
  drawMap16Page()
}

function drawMap16Page(): void {
  if (!map16Bitmap) return
  const pageH = 256  // 256 tiles per page, 16 per row = 16 rows × 16px = 256px
  map16Canvas.width = 256
  map16Canvas.height = pageH
  map16Ctx.fillStyle = '#000'
  map16Ctx.fillRect(0, 0, 256, pageH)
  // Draw the portion for the current page
  const srcY = map16Page * pageH
  const srcH = Math.min(pageH, map16Bitmap.height - srcY)
  if (srcH > 0) {
    map16Ctx.drawImage(map16Bitmap, 0, srcY, 256, srcH, 0, 0, 256, srcH)
  }
  map16PageLabel.textContent = `Page 0x${map16Page.toString(16).toUpperCase()}`
}

map16Prev.addEventListener('click', () => { map16Page = Math.max(0, map16Page - 1); drawMap16Page() })
map16Next.addEventListener('click', () => { map16Page = Math.min(MAP16_PAGES - 1, map16Page + 1); drawMap16Page() })

map16Canvas.addEventListener('mousemove', (e) => {
  const rect = map16Canvas.getBoundingClientRect()
  const scaleX = 256 / rect.width
  const scaleY = 256 / rect.height
  const col = Math.floor((e.clientX - rect.left) * scaleX / 16)
  const row = Math.floor((e.clientY - rect.top)  * scaleY / 16)
  if (col < 0 || col > 15 || row < 0 || row > 15) return
  const tileId = map16Page * MAP16_TILES_PER_PAGE + row * 16 + col
  map16Inspect.textContent = `tile $${tileId.toString(16).padStart(3, '0').toUpperCase()}`
})
map16Canvas.addEventListener('mouseleave', () => { map16Inspect.textContent = 'hover to inspect' })

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

  const { tileGrid, screens, sprites, tileUvMap } = levelData
  const cols = screens * SCREEN_W
  const rows = SCREEN_H
  const px   = TILE_PX * zoom

  canvas.width  = Math.round(cols * px)
  canvas.height = Math.round(rows * px)
  ctx.imageSmoothingEnabled = false

  // Background fill
  if (levelData.backAreaColor) {
    const [r, g, b] = levelData.backAreaColor
    ctx.fillStyle = `rgb(${r},${g},${b})`
  } else {
    ctx.fillStyle = '#000'
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Tile layers
  if (chkBlock.checked) {
    if (chkL2.checked && l2TileGrid) drawBlockGrid(l2TileGrid, cols, rows, px, 0.55)
    if (chkL1.checked)               drawBlockGrid(tileGrid,   cols, rows, px, 1.0)
  } else if (atlasImg) {
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

  // Tile grid — use dark lines for contrast against any background
  if (chkGrid.checked) {
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'
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

    // Tile panels
    drawVramPanel()
    drawMap16Panel()

    // Decode atlas and redraw
    const raw     = new Uint8ClampedArray(levelData.atlasData)
    const imgData = new ImageData(raw, levelData.atlasWidth, levelData.atlasHeight)
    atlasImg      = await createImageBitmap(imgData)
    redraw()

  } else if (msg['type'] === 'error') {
    levelId.textContent   = 'Error'
    levelMeta.textContent = msg['message'] as string
    canvas.width = canvas.height = 1
  }
})

vscode.postMessage({ type: 'ready' })

export {}
