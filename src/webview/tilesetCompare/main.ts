/**
 * Tileset comparison webview.
 *
 * Shows Map16 page 0 (tiles $000–$0FF) for two user-selected tilesets side
 * by side. Each cell renders the actual tile pixels (16×16 RGBA, base64-encoded
 * frames from the extension host). Animated tiles cycle through 4 frames at
 * ~133ms per frame, matching the SNES animation speed. Tiles that differ
 * between tilesets are highlighted. Clicking a tile requests a palette preview
 * from the extension host showing the tile in each BG palette row (0-7).
 *
 * Message protocol:
 *   Webview → Extension:
 *     { type:'ready' }
 *     { type:'compare', tilesetA: number, tilesetB: number }
 *     { type:'tilePreview', tileId: number, side: 'a'|'b' }
 *   Extension → Webview:
 *     { type:'load', tilesetA, tilesetB, tiles: TileCompEntry[] }
 *     { type:'tilePreview', tileId, side, nativePalette, renders: {row,rgba}[] }
 *     { type:'error', message }
 */

import { frameClock } from '../shared/frameClock'
import { hex3 } from '../shared/hex'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
export {}

interface SubTileData {
  charNum: number
  palette: number
  flipX: boolean
  flipY: boolean
  priority: boolean
}

interface TileSideData {
  tl: SubTileData; tr: SubTileData; bl: SubTileData; br: SubTileData
  /** Base64-encoded RGBA frames. 1 frame for static tiles, 4 for animated. */
  rgbaFrames: string[]
}

interface TileCompEntry {
  id: number
  equal: boolean
  a: TileSideData
  b: TileSideData
}

interface TilePreviewRender { row: number; rgba: number[] }

const vscode = acquireVsCodeApi()

const TILES_PER_ROW = 16
const PAGE0_TILES   = 256
const CELL_SIZE     = 22
const PREVIEW_SCALE = 5   // 16 × 5 = 80px per palette-row swatch
/** Tile animation advances every 8 game frames
 *  (bits 3-4 of `EffFrame`, `SMWDisX bank_05.asm:4396-4398`). */
const ANIM_INTERVAL_FRAMES = 8

// ── Animation state ───────────────────────────────────────────────────────────

/** Pre-decoded frames (ImageData) + cached 2d context, populated on each renderGrid. */
const animCells: Array<{ ctx: CanvasRenderingContext2D; frames: ImageData[] }> = []
let currentAnimFrame = 0

function b64ToImageData(b64: string): ImageData {
  const binary = atob(b64)
  const bytes = new Uint8ClampedArray(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new ImageData(bytes, 16, 16)
}

const animTimer = frameClock.every(
  () => ANIM_INTERVAL_FRAMES,
  () => {
    currentAnimFrame = (currentAnimFrame + 1) % 4
    for (const { ctx, frames } of animCells) {
      if (frames.length <= 1) continue
      ctx.putImageData(frames[currentAnimFrame % frames.length]!, 0, 0)
    }
  },
)

function setAnimPlaying(playing: boolean): void {
  if (playing) { animTimer.start() } else { animTimer.stop() }
  const btn = document.getElementById('btnAnim')
  if (btn) btn.textContent = playing ? '\u23F8 Pause' : '\u25B6 Play'
}

// ── Selection state ───────────────────────────────────────────────────────────

let selectedTileId: number | null = null
let selectedSide:   'a' | 'b' | null = null

function subtileHtml(st: SubTileData): string {
  const flip = [st.flipX ? 'X' : '', st.flipY ? 'Y' : ''].filter(Boolean).join('')
  const parts = [
    `Char: $${hex3(st.charNum)}`,
    `Pal: ${st.palette}`,
    flip ? `Flip: ${flip}` : '',
    st.priority ? 'Pri' : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

function tileTooltip(entry: TileCompEntry, ab: 'a' | 'b'): string {
  const d = entry[ab]
  return [
    `Tile $${hex3(entry.id)}`,
    `TL: ${subtileHtml(d.tl)}`,
    `BL: ${subtileHtml(d.bl)}`,
    `TR: ${subtileHtml(d.tr)}`,
    `BR: ${subtileHtml(d.br)}`,
  ].join('\n')
}

// ── Grid rendering ────────────────────────────────────────────────────────────

function cellBorderStyle(entry: TileCompEntry): string {
  const isSelected = entry.id === selectedTileId
  if (isSelected) return `border:2px solid var(--vscode-focusBorder,#007fd4);box-sizing:border-box;`
  if (!entry.equal) return `border:1px solid var(--vscode-editorWarning-foreground,#cca700);box-sizing:border-box;`
  return ''
}

function renderGrid(
  container: HTMLElement,
  tiles: TileCompEntry[],
  side: 'a' | 'b',
): void {
  container.innerHTML = ''
  const grid = document.createElement('div')
  grid.style.cssText = [
    `display:grid`,
    `grid-template-columns:repeat(${TILES_PER_ROW},${CELL_SIZE}px)`,
    `gap:1px`,
    `background:var(--vscode-editorGroup-border,#333)`,
    `border:1px solid var(--vscode-editorGroup-border,#333)`,
    `width:fit-content`,
  ].join(';')

  for (let i = 0; i < PAGE0_TILES; i++) {
    const entry = tiles[i]!
    const sideData = entry[side]
    const cell = document.createElement('div')

    const bg = entry.equal
      ? 'var(--vscode-editor-inactiveSelectionBackground,#3a3a3a)'
      : 'var(--vscode-editorWarning-background,#4a3a00)'

    cell.style.cssText = [
      `width:${CELL_SIZE}px`,
      `height:${CELL_SIZE}px`,
      `background:${bg}`,
      `display:flex`,
      `align-items:center`,
      `justify-content:center`,
      `cursor:pointer`,
      `position:relative`,
      cellBorderStyle(entry),
    ].join(';')

    cell.title = tileTooltip(entry, side)

    // Pixel art canvas
    const canvas = document.createElement('canvas')
    canvas.width  = 16
    canvas.height = 16
    const displayPx = CELL_SIZE - 2
    canvas.style.cssText = [
      `width:${displayPx}px`,
      `height:${displayPx}px`,
      `image-rendering:pixelated`,
      `display:block`,
    ].join(';')

    const ctx2d = canvas.getContext('2d')!
    const frames = sideData.rgbaFrames.map(b64ToImageData)
    ctx2d.putImageData(frames[0]!, 0, 0)

    animCells.push({ ctx: ctx2d, frames })
    cell.appendChild(canvas)

    cell.addEventListener('click', () => {
      selectedTileId = entry.id
      selectedSide   = side
      updateSelectionBorders(tiles)
      vscode.postMessage({ type: 'tilePreview', tileId: entry.id, side: 'a' })
      vscode.postMessage({ type: 'tilePreview', tileId: entry.id, side: 'b' })
    })
    cell.addEventListener('mouseenter', () => {
      const otherId = side === 'a' ? 'gridB' : 'gridA'
      const peer = document.querySelector<HTMLElement>(`#${otherId} [data-tile-id="${i}"]`)
      const outline = '2px solid var(--vscode-descriptionForeground,#999)'
      cell.style.outline = outline
      if (peer) peer.style.outline = outline
    })
    cell.addEventListener('mouseleave', () => {
      const otherId = side === 'a' ? 'gridB' : 'gridA'
      const peer = document.querySelector<HTMLElement>(`#${otherId} [data-tile-id="${i}"]`)
      cell.style.outline = ''
      if (peer) peer.style.outline = ''
    })

    cell.dataset['tileId'] = String(i)
    cell.dataset['side']   = side
    grid.appendChild(cell)
  }
  container.appendChild(grid)
}

function updateSelectionBorders(tiles: TileCompEntry[]): void {
  for (const side of ['a', 'b'] as const) {
    const gridEl = document.getElementById(`grid${side === 'a' ? 'A' : 'B'}`)
    if (!gridEl) continue
    const cells = gridEl.querySelectorAll<HTMLElement>('[data-tile-id]')
    cells.forEach(cell => {
      const id = Number(cell.dataset['tileId'])
      const entry = tiles[id]
      if (!entry) return
      const isSelected = id === selectedTileId
      const isDiff = !entry.equal
      if (isSelected) {
        cell.style.border = '2px solid var(--vscode-focusBorder,#007fd4)'
        cell.style.boxSizing = 'border-box'
      } else if (isDiff) {
        cell.style.border = '1px solid var(--vscode-editorWarning-foreground,#cca700)'
        cell.style.boxSizing = 'border-box'
      } else {
        cell.style.border = ''
        cell.style.boxSizing = ''
      }
    })
  }
}

// ── Preview panel ─────────────────────────────────────────────────────────────

function renderPreview(
  container: HTMLElement,
  tileId: number,
  side: 'a' | 'b',
  tilesetLabel: string,
  nativePalette: number,
  renders: TilePreviewRender[],
): void {
  container.innerHTML = ''

  const header = document.createElement('div')
  header.style.cssText = 'font-weight:600;margin-bottom:10px;font-size:0.9em'
  header.textContent = `Tile $${hex3(tileId)} — ${tilesetLabel} (Side ${side.toUpperCase()})`
  container.appendChild(header)

  const swatchRow = document.createElement('div')
  swatchRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end'

  for (const r of renders) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px'

    const canvas = document.createElement('canvas')
    canvas.width  = 16
    canvas.height = 16
    const px = 16 * PREVIEW_SCALE
    const isNative = r.row === nativePalette
    canvas.style.cssText = [
      `width:${px}px`,
      `height:${px}px`,
      `image-rendering:pixelated`,
      `border:2px solid ${isNative ? 'var(--vscode-focusBorder,#007fd4)' : 'var(--vscode-editorGroup-border,#444)'}`,
      `box-sizing:border-box`,
    ].join(';')

    const ctx2d = canvas.getContext('2d')!
    const imageData = ctx2d.createImageData(16, 16)
    for (let j = 0; j < r.rgba.length; j++) imageData.data[j] = r.rgba[j]!
    ctx2d.putImageData(imageData, 0, 0)

    const label = document.createElement('span')
    label.style.cssText = [
      `font-size:9px`,
      `font-family:var(--vscode-editor-font-family,monospace)`,
      `color:${isNative ? 'var(--vscode-foreground,#ccc)' : 'var(--vscode-descriptionForeground,#888)'}`,
    ].join(';')
    label.textContent = `Row ${r.row}`

    wrap.appendChild(canvas)
    wrap.appendChild(label)
    swatchRow.appendChild(wrap)
  }

  container.appendChild(swatchRow)
}

// ── Main comparison view ──────────────────────────────────────────────────────

function renderComparison(
  app: HTMLElement,
  tiles: TileCompEntry[],
  tilesetA: number,
  tilesetB: number,
): void {
  const main = app.querySelector<HTMLDivElement>('#main')
  if (!main) return

  const diffCount = tiles.filter(t => !t.equal).length

  const labelA   = main.querySelector<HTMLSpanElement>('#labelA')
  const labelB   = main.querySelector<HTMLSpanElement>('#labelB')
  const diffInfo = main.querySelector<HTMLSpanElement>('#diffInfo')
  const gridA    = main.querySelector<HTMLDivElement>('#gridA')
  const gridB    = main.querySelector<HTMLDivElement>('#gridB')

  if (labelA) labelA.textContent = `Tileset ${tilesetA}`
  if (labelB) labelB.textContent = `Tileset ${tilesetB}`
  if (diffInfo) {
    diffInfo.textContent = diffCount === 0
      ? 'Tilesets are identical'
      : `${diffCount} of ${PAGE0_TILES} tiles differ`
  }

  // Reset animation state before building new grids.
  animTimer.suspend()
  animCells.length = 0
  currentAnimFrame = 0

  if (gridA) renderGrid(gridA, tiles, 'a')
  if (gridB) renderGrid(gridB, tiles, 'b')

  // Restore running state (or stay paused on first load).
  animTimer.resume()
}

function buildUi(app: HTMLElement): void {
  app.innerHTML = `
<style>
  body { font-family: var(--vscode-font-family,sans-serif); font-size: var(--vscode-font-size,13px); color: var(--vscode-foreground,#ccc); padding: 12px 16px; }
  h2 { margin: 0 0 12px; font-size: 1.1em; font-weight: 600; }
  .controls { display: flex; gap: 24px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .ctrl-group { display: flex; align-items: center; gap: 8px; }
  label { font-size: 0.9em; color: var(--vscode-descriptionForeground,#999); }
  select { background: var(--vscode-dropdown-background,#3c3c3c); color: var(--vscode-dropdown-foreground,#ccc); border: 1px solid var(--vscode-dropdown-border,#555); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  .diff-info { font-size: 0.85em; color: var(--vscode-descriptionForeground,#999); }
  #main { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .grid-col { display: flex; flex-direction: column; gap: 6px; }
  .grid-label { font-weight: 600; font-size: 0.9em; }
  .legend { display: flex; gap: 12px; margin-top: 10px; font-size: 0.8em; color: var(--vscode-descriptionForeground,#888); }
  .legend-dot { width: 12px; height: 12px; display: inline-block; margin-right: 4px; vertical-align: middle; }
  #previewRow { display:flex; gap:32px; flex-wrap:wrap; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-editorGroup-border,#333); }
  .preview-col { display:flex; flex-direction:column; gap:8px; min-width:0; }
</style>
<h2>Map16 Tileset Comparison — Page 0 ($000–$0FF)</h2>
<div class="controls">
  <div class="ctrl-group">
    <label for="selA">Tileset A:</label>
    <select id="selA">${Array.from({length:15},(_,i)=>`<option value="${i}">${i}</option>`).join('')}</select>
  </div>
  <div class="ctrl-group">
    <label for="selB">Tileset B:</label>
    <select id="selB">${Array.from({length:15},(_,i)=>`<option value="${i}" ${i===7?'selected':''}>${i}</option>`).join('')}</select>
  </div>
  <button id="btnAnim" style="background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;padding:3px 10px;border-radius:3px;font-size:0.9em;cursor:pointer">&#9654; Play</button>
  <span class="diff-info" id="diffInfo"></span>
</div>
<div id="main">
  <div class="grid-col"><span class="grid-label" id="labelA">Tileset 0</span><div id="gridA"></div></div>
  <div class="grid-col"><span class="grid-label" id="labelB">Tileset 7</span><div id="gridB"></div></div>
</div>
<div class="legend">
  <span><span class="legend-dot" style="background:var(--vscode-editor-inactiveSelectionBackground,#3a3a3a)"></span>Identical</span>
  <span><span class="legend-dot" style="background:var(--vscode-editorWarning-background,#4a3a00);border:1px solid var(--vscode-editorWarning-foreground,#cca700)"></span>Different</span>
  <span><span class="legend-dot" style="border:2px solid var(--vscode-focusBorder,#007fd4);box-sizing:border-box"></span>Selected</span>
</div>
<div id="previewRow">
  <div class="preview-col"><div id="previewA"></div></div>
  <div class="preview-col"><div id="previewB"></div></div>
</div>
`

  const selA = app.querySelector<HTMLSelectElement>('#selA')!
  const selB = app.querySelector<HTMLSelectElement>('#selB')!

  const requestCompare = () => {
    selectedTileId = null
    selectedSide   = null
    const pa = app.querySelector<HTMLDivElement>('#previewA')
    const pb = app.querySelector<HTMLDivElement>('#previewB')
    if (pa) pa.innerHTML = ''
    if (pb) pb.innerHTML = ''
    vscode.postMessage({ type: 'compare', tilesetA: Number(selA.value), tilesetB: Number(selB.value) })
  }

  selA.addEventListener('change', requestCompare)
  selB.addEventListener('change', requestCompare)

  const btnAnim = app.querySelector<HTMLButtonElement>('#btnAnim')!
  btnAnim.addEventListener('click', () => setAnimPlaying(!animTimer.running))
}

// ── Message handling ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')!
  buildUi(app)

  let lastTiles: TileCompEntry[] = []
  let lastTilesetA = 0
  let lastTilesetB = 1

  window.addEventListener('message', (event) => {
    const msg = event.data as {
      type: string
      tiles?: TileCompEntry[]
      tilesetA?: number
      tilesetB?: number
      message?: string
      tileId?: number
      side?: 'a' | 'b'
      nativePalette?: number
      renders?: TilePreviewRender[]
    }

    if (msg.type === 'error') {
      const info = app.querySelector<HTMLSpanElement>('#diffInfo')
      if (info) info.textContent = `Error: ${msg.message ?? 'unknown'}`
      return
    }

    if (msg.type === 'load' && msg.tiles) {
      lastTiles    = msg.tiles
      lastTilesetA = msg.tilesetA ?? 0
      lastTilesetB = msg.tilesetB ?? 0
      renderComparison(app, lastTiles, lastTilesetA, lastTilesetB)
    }

    if (msg.type === 'tilePreview' && msg.renders) {
      const side = msg.side ?? 'a'
      const container = app.querySelector<HTMLDivElement>(side === 'a' ? '#previewA' : '#previewB')
      if (!container) return
      const tilesetId = side === 'a' ? lastTilesetA : lastTilesetB
      renderPreview(container, msg.tileId ?? 0, side, `Tileset ${tilesetId}`, msg.nativePalette ?? 0, msg.renders)
    }
  })

  const selA0 = app.querySelector<HTMLSelectElement>('#selA')!
  const selB0 = app.querySelector<HTMLSelectElement>('#selB')!
  vscode.postMessage({ type: 'ready', tilesetA: Number(selA0.value), tilesetB: Number(selB0.value) })
})
