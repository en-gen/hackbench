/**
 * SMW Level Editor — webview entry point.
 *
 * Layout:
 *   ┌─ toolbar ────────────────────────────────────────────────────┐
 *   │ [Level $XXX]  [meta]       [zoom −][1×][+]  [Grid] [Sprites] │
 *   ├─ workspace ──────────────────────────────────────────────────┤
 *   │ ┌─ panel ──┐ ┌─ canvas-wrap (scroll) ──────────────────────┐ │
 *   │ │ Objects  │ │                                              │ │
 *   │ │ Sprites  │ │   <canvas> (pixel-art, no fit-to-window)    │ │
 *   │ └──────────┘ └──────────────────────────────────────────────┘ │
 *   ├─ status ─────────────────────────────────────────────────────┤
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Messages FROM extension host:
 *   { type:'load', levelIndex, tileGrid, atlasData, atlasWidth, atlasHeight,
 *     tileUvMap, screens, sprites, header }
 *   { type:'error', message }
 *
 * Messages TO extension host:
 *   { type:'ready' }
 *   { type:'edit', kind:'place'|'erase', tileId, col, row }
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
  <span style="color:#555;margin:0 2px">|</span>
  <label style="${chkStyle()}">BG&nbsp;<select id="sel-bg-palette" style="${selStyle()}"></select></label>
  <label style="${chkStyle()}">SP&nbsp;<select id="sel-sprite-set"  style="${selStyle()}"></select></label>
  <label style="${chkStyle()}">GFX&nbsp;<select id="sel-tileset"    style="${selStyle()}"></select></label>
</div>

<div id="workspace" style="display:flex;flex:1;overflow:hidden;">
  <div id="panel" style="
    width:220px;flex-shrink:0;overflow-y:auto;
    background:var(--vscode-sideBar-background,#252526);
    border-right:1px solid var(--vscode-panel-border,#3a3a3a);
    font-family:var(--vscode-font-family,system-ui);font-size:12px;">
    <div style="padding:6px 0;">
      <div class="section-hdr">OBJECTS</div>
      <div id="object-list" style="padding:0 4px;"></div>
    </div>
    <div style="padding:6px 0;border-top:1px solid var(--vscode-panel-border,#3a3a3a);">
      <div class="section-hdr">SPRITES</div>
      <div id="sprite-list" style="padding:0 4px;"></div>
    </div>
  </div>

  <div id="canvas-wrap" style="flex:1;overflow:auto;background:#111111;cursor:crosshair;">
    <canvas id="level-canvas" style="display:block;image-rendering:pixelated;margin:8px;"></canvas>
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
  .lib-item {
    display:flex;align-items:center;gap:6px;padding:3px 8px;
    font-size:11px;cursor:pointer;border-radius:2px;
    color:var(--vscode-foreground,#ccc);
  }
  .lib-item:hover  { background:var(--vscode-list-hoverBackground,#2a2d2e); }
  .lib-item.active { background:var(--vscode-list-activeSelectionBackground,#094771); }
  .lib-dot { width:10px;height:10px;border-radius:2px;flex-shrink:0; }
</style>
`

function selStyle(): string {
  return 'background:var(--vscode-dropdown-background,#3c3c3c);' +
         'color:var(--vscode-dropdown-foreground,#ccc);' +
         'border:1px solid #555;border-radius:3px;height:20px;font-size:11px;cursor:pointer;'
}
function btnStyle(): string {
  return 'background:transparent;border:1px solid #555;color:#ccc;border-radius:3px;' +
         'width:22px;height:22px;font-size:14px;line-height:1;cursor:pointer;padding:0;'
}
function chkStyle(): string {
  return 'display:flex;align-items:center;gap:4px;cursor:pointer;' +
         'font-size:12px;color:#888;user-select:none;'
}

// ── Element refs ─────────────────────────────────────────────────────────────

const canvas     = document.getElementById('level-canvas') as HTMLCanvasElement
const ctx        = canvas.getContext('2d')!
const canvasWrap = document.getElementById('canvas-wrap')!
const levelId    = document.getElementById('level-id')!
const levelMeta  = document.getElementById('level-meta')!
const zoomLabel  = document.getElementById('zoom-label')!
const stPos      = document.getElementById('st-pos')!
const stTile     = document.getElementById('st-tile')!
const stInfo     = document.getElementById('st-info')!
const objectList = document.getElementById('object-list')!
const spriteList = document.getElementById('sprite-list')!
const chkGrid    = document.getElementById('chk-grid')    as HTMLInputElement
const chkSprites = document.getElementById('chk-sprites') as HTMLInputElement

// ── State ────────────────────────────────────────────────────────────────────

let zoomIdx      = ZOOM_DEFAULT_IDX
let zoom         = ZOOM_STEPS[zoomIdx]
let levelData: LevelPayload | null = null
let atlasImg:  ImageBitmap | null = null
let activeTileId = -1
let activeTool: 'place' | 'erase' = 'place'
let isPainting   = false

interface TileUv { col: number; row: number }

interface LevelPayload {
  levelIndex: number
  screens: number
  tileGrid: number[][]
  atlasData: number[]           // serialised Uint8ClampedArray
  atlasWidth: number
  atlasHeight: number
  tileUvMap: Record<number, TileUv>
  sprites: Array<{ x: number; y: number; spriteId: number }>
  backAreaColor: [number, number, number, number]  // RGBA canvas background
  header: {
    music: number
    spriteSet: number
    bgPalette: number
    bgColor: number
    gfxTilesetId: number
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

// ── Rendering ─────────────────────────────────────────────────────────────────

function redraw(): void {
  if (!levelData || !atlasImg) return

  const { tileGrid, screens, sprites, tileUvMap } = levelData
  const cols = screens * SCREEN_W
  const rows = SCREEN_H
  const px   = TILE_PX * zoom

  canvas.width  = Math.round(cols * px)
  canvas.height = Math.round(rows * px)
  ctx.imageSmoothingEnabled = false

  if (levelData?.backAreaColor) {
    const [r, g, b] = levelData.backAreaColor
    ctx.fillStyle = `rgb(${r},${g},${b})`
  } else {
    ctx.fillStyle = '#000'
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Tiles
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tileId = tileGrid[row]?.[col] ?? 0
      if (tileId === 0) continue  // empty sky — show canvas background color
      const uv = tileUvMap[tileId]
      if (!uv) continue
      ctx.drawImage(
        atlasImg,
        uv.col * TILE_PX, uv.row * TILE_PX, TILE_PX, TILE_PX,
        Math.round(col * px), Math.round(row * px), Math.round(px), Math.round(px),
      )
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

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  isPainting = true; paintAt(e)
})
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

// ── Drag-drop from library ────────────────────────────────────────────────────

canvas.addEventListener('dragover', (e) => { e.preventDefault() })
canvas.addEventListener('drop', (e) => {
  e.preventDefault()
  const tileId = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10)
  if (isNaN(tileId) || !levelData) return
  const rect   = canvas.getBoundingClientRect()
  const px     = TILE_PX * zoom
  const col    = Math.floor((e.clientX - rect.left) / px)
  const row    = Math.floor((e.clientY - rect.top)  / px)
  if (col < 0 || row < 0 || row >= SCREEN_H || col >= levelData.screens * SCREEN_W) return
  levelData.tileGrid[row][col] = tileId
  redraw()
  vscode.postMessage({ type: 'edit', kind: 'place', tileId, col, row })
})

// ── Library panel ─────────────────────────────────────────────────────────────

const OBJECT_ITEMS = [
  { id: 0x054, label: 'Ground',       color: '#7a5c3a' },
  { id: 0x012, label: 'Cement Block', color: '#888888' },
  { id: 0x011, label: 'Brick',        color: '#cc8844' },
  { id: 0x010, label: '? Block',      color: '#ffcc00' },
  { id: 0x001, label: 'Coin',         color: '#ffdd44' },
  { id: 0x10A, label: 'Pipe',         color: '#33aa88' },
  { id: 0x07F, label: 'Muncher',      color: '#228822' },
] as const

const SPRITE_ITEMS = [
  { id: 0x00, label: 'Goomba',        color: '#aa7744' },
  { id: 0x01, label: 'Koopa (green)', color: '#448844' },
  { id: 0x02, label: 'Koopa (red)',   color: '#aa4444' },
  { id: 0x03, label: 'Piranha Plant', color: '#448844' },
  { id: 0x0E, label: 'Boo',           color: '#eeeeee' },
  { id: 0x14, label: '1-Up Mushroom', color: '#448844' },
  { id: 0x74, label: 'Yoshi (green)', color: '#44aa44' },
] as const

type LibItem = { id: number; label: string; color: string }

function buildLibrary(container: HTMLElement, items: ReadonlyArray<LibItem>): void {
  container.innerHTML = ''
  for (const item of items) {
    const el = document.createElement('div')
    el.className = 'lib-item'
    el.draggable = true
    el.dataset.id = String(item.id)
    el.innerHTML =
      `<div class="lib-dot" style="background:${item.color}"></div>` +
      `<span>${item.label}</span>` +
      `<span style="margin-left:auto;font-size:10px;color:#666;font-family:monospace">` +
      `$${item.id.toString(16).toUpperCase().padStart(3,'0')}</span>`
    el.addEventListener('click', () => {
      document.querySelectorAll('.lib-item').forEach(e => e.classList.remove('active'))
      el.classList.add('active')
      activeTileId = item.id
      activeTool   = 'place'
    })
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(item.id))
    })
    container.appendChild(el)
  }
}

buildLibrary(objectList, OBJECT_ITEMS)
buildLibrary(spriteList, SPRITE_ITEMS)

// ── Message handler ───────────────────────────────────────────────────────────

// ── Override controls ─────────────────────────────────────────────────────────

const selBgPalette  = document.getElementById('sel-bg-palette')  as HTMLSelectElement
const selSpriteSet  = document.getElementById('sel-sprite-set')  as HTMLSelectElement
const selTileset    = document.getElementById('sel-tileset')      as HTMLSelectElement

function buildSelect(el: HTMLSelectElement, count: number, value: number): void {
  el.innerHTML = ''
  for (let i = 0; i < count; i++) {
    const opt = document.createElement('option')
    opt.value = String(i)
    opt.textContent = String(i)
    if (i === value) opt.selected = true
    el.appendChild(opt)
  }
}

function postRerender(): void {
  vscode.postMessage({
    type: 'rerender',
    bgVariant:  parseInt(selBgPalette.value),
    spriteSet:  parseInt(selSpriteSet.value),
    tilesetId:  parseInt(selTileset.value),
  })
}

selBgPalette.addEventListener('change', postRerender)
selSpriteSet.addEventListener('change', postRerender)
selTileset.addEventListener('change',   postRerender)

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', async (event) => {
  const msg = event.data as Record<string, unknown>
  if (msg['type'] === 'load') {
    levelData = msg as unknown as LevelPayload
    const hex     = levelData.levelIndex.toString(16).toUpperCase().padStart(3, '0')
    const screens = levelData.screens
    levelId.textContent   = `Level $${hex}`
    levelMeta.textContent =
      `${screens} screen${screens !== 1 ? 's' : ''} · ` +
      `${levelData.sprites.length} sprites`
    stInfo.textContent =
      `Music $${levelData.header.music.toString(16).toUpperCase()} · ` +
      `Tileset ${levelData.header.gfxTilesetId} · ` +
      `SP $${levelData.header.spriteSet.toString(16).toUpperCase()}`

    // Populate override selectors from header values (only on initial load)
    if (msg['_initial'] !== false) {
      buildSelect(selBgPalette, 8,  levelData.header.bgPalette)
      buildSelect(selSpriteSet, 16, levelData.header.spriteSet)
      buildSelect(selTileset,   16, levelData.header.gfxTilesetId)
    }

    // Decode atlas
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
