/**
 * SMW GFX Viewer — webview entry point.
 *
 * Displays a single GFX file in a 16-column grid (standard SMW layout).
 * Standard 4bpp files have 128 tiles (16×8); GFX32 (3bpp) has 64 tiles (16×4).
 * Tile count is dynamic from the payload — the grid adjusts automatically.
 *
 * Messages FROM extension host:
 *   { type:'load', gfxIndex, gfxHex, tilePixels, tileCount, paletteRows,
 *                  rawBytes, defaultBpp, suggestedPaletteRow }
 *   { type:'error', message }
 *
 * Messages TO extension host:
 *   { type:'ready' }
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()

// ── Constants ─────────────────────────────────────────────────────────────────

const TILE_PX   = 8   // native pixels per tile side
const TILE_COLS = 16  // tiles per row (standard SMW sheet layout)
const ZOOM_STEPS   = [1, 2, 3, 4, 6, 8]
const ZOOM_DEFAULT = 3   // 3× → 24×24 px displayed per tile

// CGRAM row names matching SMW's runtime layout
const ROW_LABELS: string[] = [
  'Row  0 — BG Layer 2',
  'Row  1 — BG Layer 2',
  'Row  2 — FG Layer 1',
  'Row  3 — FG Layer 1',
  'Row  4 — Sprite',
  'Row  5 — Sprite',
  'Row  6 — Sprite',
  'Row  7 — Sprite',
  'Row  8 — Player/Sprite',
  'Row  9 — Sprite',
  'Row 10 — Sprite (Ludwig)',
  'Row 11 — Sprite (Roy)',
  'Row 12 — Sprite',
  'Row 13 — Sprite (Morton)',
  'Row 14 — Sprite E',
  'Row 15 — Sprite F',
]

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
  <span id="gfx-id" style="font-family:monospace;color:#5b9cf6;font-weight:600;min-width:70px"></span>
  <span id="tile-count" style="font-family:monospace;font-size:11px;color:#666;min-width:60px"></span>
  <span style="color:#555;margin:0 2px">|</span>
  <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;">
    Palette&nbsp;Row
    <select id="sel-palette-row" style="
      background:var(--vscode-dropdown-background,#3c3c3c);
      color:var(--vscode-dropdown-foreground,#ccc);
      border:1px solid #555;border-radius:3px;height:20px;font-size:11px;cursor:pointer;
      font-family:monospace;"></select>
  </label>
  <div id="swatch-row" style="display:flex;gap:2px;align-items:center;margin-left:4px;"></div>
  <span style="color:#555;margin:0 2px">|</span>
  <label id="fg-var-label" style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;">
    FG&nbsp;Variant
    <select id="sel-fg-variant" style="
      background:var(--vscode-dropdown-background,#3c3c3c);
      color:var(--vscode-dropdown-foreground,#ccc);
      border:1px solid #555;border-radius:3px;height:20px;font-size:11px;cursor:pointer;
      font-family:monospace;"></select>
  </label>
  <span style="color:#555;margin:0 2px">|</span>
  <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#888;">
    BPP
    <select id="sel-bpp" style="
      background:var(--vscode-dropdown-background,#3c3c3c);
      color:var(--vscode-dropdown-foreground,#ccc);
      border:1px solid #555;border-radius:3px;height:20px;font-size:11px;cursor:pointer;
      font-family:monospace;">
      <option value="4">4bpp</option>
      <option value="3">3bpp</option>
      <option value="2">2bpp</option>
    </select>
  </label>
  <span style="flex:1"></span>
  <button id="zoom-out" style="${btnStyle()}">&#8722;</button>
  <span id="zoom-label" style="font-family:monospace;font-size:11px;min-width:32px;text-align:center">3&#215;</span>
  <button id="zoom-in"  style="${btnStyle()}">&#43;</button>
  <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#888;cursor:pointer;user-select:none;">
    <input type="checkbox" id="chk-grid"> Grid
  </label>
</div>

<div id="canvas-wrap" style="flex:1;overflow:auto;background:#1a1a1a;cursor:crosshair;">
  <canvas id="gfx-canvas" style="display:block;image-rendering:pixelated;margin:12px;"></canvas>
</div>

<div id="status" style="
  display:flex;gap:16px;align-items:center;flex-shrink:0;
  padding:3px 12px;height:22px;
  background:var(--vscode-statusBar-background,#007acc);
  font-family:monospace;font-size:11px;
  color:var(--vscode-statusBar-foreground,#fff);">
  <span id="st-tile">—</span>
  <span id="st-vram">—</span>
  <span id="st-color">—</span>
</div>
`

function btnStyle(): string {
  return 'background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;' +
         'width:22px;height:22px;font-size:14px;line-height:1;cursor:pointer;padding:0;'
}

// ── Element refs ─────────────────────────────────────────────────────────────

const canvas      = document.getElementById('gfx-canvas') as HTMLCanvasElement
const ctx         = canvas.getContext('2d')!
const gfxId       = document.getElementById('gfx-id')!
const tileCountEl = document.getElementById('tile-count')!
const zoomLabel   = document.getElementById('zoom-label')!
const swatchRow   = document.getElementById('swatch-row')!
const stTile      = document.getElementById('st-tile')!
const stVram      = document.getElementById('st-vram')!
const stColor     = document.getElementById('st-color')!
const selRow      = document.getElementById('sel-palette-row') as HTMLSelectElement
const selBpp      = document.getElementById('sel-bpp') as HTMLSelectElement
const selFgVar    = document.getElementById('sel-fg-variant') as HTMLSelectElement
const fgVarLabel  = document.getElementById('fg-var-label')!
const chkGrid     = document.getElementById('chk-grid') as HTMLInputElement

// ── State ────────────────────────────────────────────────────────────────────

interface GfxPayload {
  gfxIndex:   number
  gfxHex:     string
  tilePixels: number[][]     // [tileIdx][pixelIdx] = palette color index 0–15 (server-decoded)
  tileCount:  number
  paletteRows: number[][][]  // [rowIdx][colorIdx] = [r, g, b, a]
  /** FG palette variants: [[row2colors, row3colors], …] per variant index. ⚠ Addresses unverified beyond variant 0. */
  fgVariants: number[][][][]
  suggestedPaletteRow: number  // best guess at which CGRAM row applies to this file
  rawBytes:   number[]       // decompressed GFX bytes — for client-side re-decode
  defaultBpp: 2 | 3 | 4     // server's decode format for this file
}

// ── Client-side tile decoders ─────────────────────────────────────────────────

/** Decode one 2bpp tile (16 bytes) → 64 palette indices 0–3. */
function decode2bpp(data: number[], offset: number): number[] {
  const px: number[] = new Array(64)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1) |
        (((p0hi >> bit) & 1) << 1)
    }
  }
  return px
}

/** Decode one 4bpp tile (32 bytes) → 64 palette indices 0–15. */
function decode4bpp(data: number[], offset: number): number[] {
  const px: number[] = new Array(64)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    const p1lo = data[offset + 16 + row * 2]
    const p1hi = data[offset + 16 + row * 2 + 1]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1)        |
        (((p0hi >> bit) & 1) << 1) |
        (((p1lo >> bit) & 1) << 2) |
        (((p1hi >> bit) & 1) << 3)
    }
  }
  return px
}

/** Decode one 3bpp tile (24 bytes) → 64 palette indices 0–7. */
function decode3bpp(data: number[], offset: number): number[] {
  const px: number[] = new Array(64)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    const p2   = data[offset + 16 + row]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1)        |
        (((p0hi >> bit) & 1) << 1) |
        (((p2   >> bit) & 1) << 2)
    }
  }
  return px
}

/** Decode all tiles from rawBytes using the given bpp mode. */
function decodeTiles(rawBytes: number[], bpp: 2 | 3 | 4): number[][] {
  const bpt    = bpp === 4 ? 32 : bpp === 3 ? 24 : 16
  const count  = Math.floor(rawBytes.length / bpt)
  const decode = bpp === 4 ? decode4bpp : bpp === 3 ? decode3bpp : decode2bpp
  const tiles: number[][] = []
  for (let t = 0; t < count; t++) tiles.push(decode(rawBytes, t * bpt))
  return tiles
}

let payload:    GfxPayload | null = null
let zoomIdx    = ZOOM_DEFAULT
// Overridden per-file by suggestedPaletteRow from the extension host.
let paletteRow = 2
// Active decoded tiles — rebuilt when payload changes or bpp mode is toggled.
let activeTiles: number[][] = []
// Current bpp decoding mode — overridden per-file by defaultBpp from the host.
let activeBpp: 2 | 3 | 4 = 3
// Active FG variant (0 = vanilla/plains; higher = other level types ⚠ unverified).
let activeFgVariant = 0
// Effective palette rows — payload.paletteRows with rows 2-3 swapped per FG variant.
let effectivePaletteRows: number[][][] = []

// ── Offscreen tile buffer (rebuilt when tile count changes) ───────────────────

const offscreen = document.createElement('canvas')
let offCtx      = offscreen.getContext('2d')!

function ensureOffscreen(tileCount: number): void {
  const rows = Math.ceil(tileCount / TILE_COLS)
  const w = TILE_COLS * TILE_PX
  const h = rows * TILE_PX
  if (offscreen.width !== w || offscreen.height !== h) {
    offscreen.width  = w
    offscreen.height = h
    offCtx = offscreen.getContext('2d')!
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function redraw(): void {
  if (!payload) return

  const tileCount = activeTiles.length
  const tileRows  = Math.ceil(tileCount / TILE_COLS)
  ensureOffscreen(tileCount)

  const zoom = ZOOM_STEPS[zoomIdx]
  const pw   = TILE_COLS * TILE_PX
  const ph   = tileRows  * TILE_PX

  const imgData = offCtx.createImageData(pw, ph)
  const d       = imgData.data
  const palRow  = effectivePaletteRows[paletteRow] ?? effectivePaletteRows[0]

  for (let t = 0; t < tileCount; t++) {
    const tileCol = t % TILE_COLS
    const tileRow = Math.floor(t / TILE_COLS)
    const pixels  = activeTiles[t]

    for (let py = 0; py < TILE_PX; py++) {
      for (let px = 0; px < TILE_PX; px++) {
        const colorIdx = pixels[py * TILE_PX + px]
        const cx = tileCol * TILE_PX + px
        const cy = tileRow * TILE_PX + py
        const i  = (cy * pw + cx) * 4

        if (colorIdx === 0) {
          // transparent — checkerboard background
          const checker = ((cx >> 2) + (cy >> 2)) & 1
          const v = checker ? 60 : 40
          d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255
        } else {
          const c = palRow[colorIdx] ?? [255, 0, 255, 255]
          d[i] = c[0]; d[i+1] = c[1]; d[i+2] = c[2]; d[i+3] = c[3]
        }
      }
    }
  }

  offCtx.putImageData(imgData, 0, 0)

  canvas.width  = pw * zoom
  canvas.height = ph * zoom
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)

  // Tile grid overlay
  if (chkGrid.checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth   = 1
    const tw = TILE_PX * zoom
    for (let c = 0; c <= TILE_COLS; c++) {
      const x = Math.round(c * tw) + 0.5
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke()
    }
    for (let r = 0; r <= tileRows; r++) {
      const y = Math.round(r * tw) + 0.5
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke()
    }
  }

  zoomLabel.textContent = `${zoom}×`
}

// ── Palette row swatches ──────────────────────────────────────────────────────

function buildSwatches(): void {
  if (!payload) return
  const row = effectivePaletteRows[paletteRow] ?? []
  swatchRow.innerHTML = ''
  for (let i = 0; i < 16; i++) {
    const c  = row[i]
    const el = document.createElement('div')
    el.title = `Color ${i}`
    el.style.cssText = `width:11px;height:11px;border-radius:2px;border:1px solid #333;` +
      (c && c[3] > 0
        ? `background:rgb(${c[0]},${c[1]},${c[2]});`
        : 'background:repeating-linear-gradient(45deg,#444 0 2px,#222 2px 4px);')
    swatchRow.appendChild(el)
  }
}

// ── Palette row selector ──────────────────────────────────────────────────────

function buildPaletteSelector(): void {
  selRow.innerHTML = ''
  for (let i = 0; i < 16; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = ROW_LABELS[i] ?? `Row ${i}`
    if (i === paletteRow) opt.selected = true
    selRow.appendChild(opt)
  }
  selRow.value = String(paletteRow)
}

selRow.addEventListener('change', () => {
  paletteRow = parseInt(selRow.value)
  buildSwatches()
  redraw()
})

// ── FG variant selector ───────────────────────────────────────────────────────

/** Rebuild effectivePaletteRows by swapping rows 2-3 from the selected FG variant. */
function applyFgVariant(variantIdx: number): void {
  if (!payload) return
  effectivePaletteRows = payload.paletteRows.map(r => r)  // shallow copy
  const fg = payload.fgVariants?.[variantIdx]
  if (fg) {
    effectivePaletteRows = effectivePaletteRows.slice()
    effectivePaletteRows[2] = fg[0]  // row 2
    effectivePaletteRows[3] = fg[1]  // row 3
  }
}

function buildFgVariantSelector(): void {
  selFgVar.innerHTML = ''
  const count = payload?.fgVariants?.length ?? 1
  const hasMultiple = count > 1
  fgVarLabel.style.display = hasMultiple ? 'flex' : 'none'
  if (!hasMultiple) return
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = i === 0 ? `0 (plains)` : `${i} ⚠`
    if (i === activeFgVariant) opt.selected = true
    selFgVar.appendChild(opt)
  }
  selFgVar.value = String(activeFgVariant)
}

selFgVar.addEventListener('change', () => {
  activeFgVariant = parseInt(selFgVar.value)
  applyFgVariant(activeFgVariant)
  buildSwatches()
  redraw()
})

// ── Zoom controls ─────────────────────────────────────────────────────────────

document.getElementById('zoom-in')!.addEventListener('click', () => {
  if (zoomIdx < ZOOM_STEPS.length - 1) { zoomIdx++; redraw() }
})
document.getElementById('zoom-out')!.addEventListener('click', () => {
  if (zoomIdx > 0) { zoomIdx--; redraw() }
})
document.getElementById('canvas-wrap')!.addEventListener('wheel', (e) => {
  const we = e as WheelEvent
  if (!we.ctrlKey) return
  we.preventDefault()
  const next = zoomIdx + (we.deltaY < 0 ? 1 : -1)
  if (next >= 0 && next < ZOOM_STEPS.length) { zoomIdx = next; redraw() }
}, { passive: false })

chkGrid.addEventListener('change', redraw)

// ── Mouse hover ───────────────────────────────────────────────────────────────

canvas.addEventListener('mousemove', (e) => {
  if (!payload) return
  const zoom     = ZOOM_STEPS[zoomIdx]
  const tw       = TILE_PX * zoom
  const tileRows = Math.ceil(activeTiles.length / TILE_COLS)
  const rect     = canvas.getBoundingClientRect()
  const cx       = Math.floor((e.clientX - rect.left) / tw)
  const cy       = Math.floor((e.clientY - rect.top)  / tw)
  if (cx < 0 || cy < 0 || cx >= TILE_COLS || cy >= tileRows) return

  const tileIdx  = cy * TILE_COLS + cx
  if (tileIdx >= activeTiles.length) return

  const localX   = Math.floor(((e.clientX - rect.left) - cx * tw) / zoom)
  const localY   = Math.floor(((e.clientY - rect.top)  - cy * tw) / zoom)
  const pixelIdx = localY * TILE_PX + localX
  const colorIdx = activeTiles[tileIdx]?.[pixelIdx] ?? 0

  // Char number = base char for this GFX file + tile index within the file.
  // Base = gfxIndex * 128 for standard 4bpp files (approximate; exact base
  // depends on which VRAM slot this file is loaded into).
  const charNum = payload.gfxIndex * 128 + tileIdx
  const vramWord = charNum * 16  // each 4bpp tile = 32 bytes = 16 VRAM words

  stTile.textContent  = `Tile $${tileIdx.toString(16).toUpperCase().padStart(2,'0')}`
  stVram.textContent  = `char $${charNum.toString(16).toUpperCase().padStart(3,'0')}  VRAM $${vramWord.toString(16).toUpperCase().padStart(4,'0')}.w`
  stColor.textContent = `color ${colorIdx} (${activeBpp}bpp)`
})

canvas.addEventListener('mouseleave', () => {
  stTile.textContent  = '—'
  stVram.textContent  = '—'
  stColor.textContent = '—'
})

// ── BPP selector ─────────────────────────────────────────────────────────────

selBpp.addEventListener('change', () => {
  if (!payload) return
  activeBpp   = parseInt(selBpp.value) as 2 | 3 | 4
  activeTiles = decodeTiles(payload.rawBytes, activeBpp)
  tileCountEl.textContent = `(${activeTiles.length} tiles)`
  redraw()
})

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data as Record<string, unknown>

  if (msg['type'] === 'load') {
    payload    = msg as unknown as GfxPayload
    paletteRow = payload.suggestedPaletteRow ?? 2   // apply per-file suggestion

    // Decode tiles client-side using the default bpp for this file
    activeBpp   = payload.defaultBpp ?? 3
    selBpp.value = String(activeBpp)
    activeTiles = decodeTiles(payload.rawBytes, activeBpp)

    // Initialize FG variant (start at 0 for each new file)
    activeFgVariant = 0
    applyFgVariant(0)

    gfxId.textContent       = `GFX ${payload.gfxHex}`
    tileCountEl.textContent = `(${activeTiles.length} tiles)`
    buildPaletteSelector()
    buildFgVariantSelector()
    buildSwatches()
    redraw()

  } else if (msg['type'] === 'error') {
    gfxId.textContent   = 'Error'
    stTile.textContent  = msg['message'] as string
  }
})

vscode.postMessage({ type: 'ready' })

export {}
