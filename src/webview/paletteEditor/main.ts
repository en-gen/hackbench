/**
 * SMW Palette Editor — global ROM palette viewer.
 *
 * Shows ALL palette groups that exist in the ROM, organized by category.
 * Each group may have multiple variants (e.g. sprite sets 0-7).
 * Variants may contain multiple CGRAM rows (e.g. sprite sets show 5 rows).
 * Groups with unverified addresses show grey swatches marked ⚠.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()

const COLS   = 16
const SWATCH = 20
const GAP    = 2

// ── Types ─────────────────────────────────────────────────────────────────────

interface Color { r: number; g: number; b: number; a: number }

interface PaletteVariant {
  label: string
  rows: Color[][]   // array of CGRAM rows; each row = 16 colors
  romAddr: number | null
}

interface PaletteGroup {
  id: string
  label: string
  description: string
  variants: PaletteVariant[]
  cgRamRow: number | null
}

interface SerializedPaletteAnimPatch { cgramIdx: number; r: number; g: number; b: number; a: number }
interface SerializedPaletteAnimData {
  frameCount: number
  intervalMs: number
  frames: SerializedPaletteAnimPatch[][]
}

interface LoadMsg {
  groups: PaletteGroup[]
  backAreaColor: Color
  romName: string
  paletteAnimation: SerializedPaletteAnimData | null
}

// ── DOM ───────────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!
app.style.cssText = 'display:flex;flex-direction:column;height:100vh;overflow:hidden;' +
  'font-family:var(--vscode-font-family,system-ui);font-size:12px;color:var(--vscode-foreground,#ccc);'

app.innerHTML = `
<div id="toolbar" style="
  display:flex;align-items:center;gap:12px;flex-shrink:0;
  padding:0 14px;height:36px;
  background:var(--vscode-editor-background,#1e1e1e);
  border-bottom:1px solid var(--vscode-panel-border,#3a3a3a);">
  <span style="font-weight:700;color:#5b9cf6;font-size:13px;">Color Palettes</span>
  <span id="rom-name" style="color:#666;font-family:monospace;font-size:11px;"></span>
  <span style="flex:1"></span>
  <span style="font-size:10px;color:#555;">⚠ = address unverified, colors unavailable</span>
</div>

<div style="display:flex;flex:1;overflow:hidden;">

  <!-- Left nav: group list -->
  <div id="nav" style="
    width:190px;flex-shrink:0;overflow-y:auto;
    background:var(--vscode-sideBar-background,#252526);
    border-right:1px solid var(--vscode-panel-border,#3a3a3a);
    padding:8px 0;">
  </div>

  <!-- Right: group detail -->
  <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
    <div id="group-header" style="
      flex-shrink:0;padding:10px 16px 6px;
      border-bottom:1px solid var(--vscode-panel-border,#333);">
      <div id="group-title" style="font-weight:700;font-size:13px;margin-bottom:3px;"></div>
      <div id="group-desc"  style="font-size:11px;color:#888;"></div>
    </div>

    <!-- Variant tabs -->
    <div id="variant-tabs" style="
      flex-shrink:0;display:flex;gap:0;
      border-bottom:1px solid var(--vscode-panel-border,#333);
      overflow-x:auto;padding:0 12px;background:var(--vscode-editor-background,#1e1e1e);">
    </div>

    <!-- Swatch area for active variant (may have multiple rows) -->
    <div id="swatch-area" style="flex:1;overflow-y:auto;padding:12px 16px;">
      <div id="swatch-rows"></div>
    </div>

    <!-- Detail bar -->
    <div id="detail" style="
      flex-shrink:0;display:flex;align-items:center;gap:14px;
      padding:8px 14px;height:52px;
      background:var(--vscode-editor-background,#1e1e1e);
      border-top:1px solid var(--vscode-panel-border,#3a3a3a);">
      <div id="detail-swatch" style="
        width:32px;height:32px;border-radius:3px;flex-shrink:0;
        border:1px solid #444;background:#111;"></div>
      <div>
        <div id="detail-label"  style="font-weight:600;margin-bottom:2px;font-size:12px;">—</div>
        <div id="detail-values" style="font-family:monospace;font-size:11px;color:#888;">—</div>
      </div>
    </div>
  </div>
</div>

<style>
  .nav-item {
    padding:6px 12px;cursor:pointer;font-size:11px;border-radius:0;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .nav-item:hover  { background:var(--vscode-list-hoverBackground,#2a2d2e); }
  .nav-item.active { background:var(--vscode-list-activeSelectionBackground,#094771);color:#fff; }
  .vtab {
    padding:6px 14px;cursor:pointer;font-size:11px;border:none;
    background:transparent;color:var(--vscode-foreground,#ccc);
    border-bottom:2px solid transparent;white-space:nowrap;flex-shrink:0;
  }
  .vtab:hover  { color:#fff; }
  .vtab.active { border-bottom-color:#5b9cf6;color:#5b9cf6;font-weight:600; }
  .swatch {
    width:${SWATCH}px;height:${SWATCH}px;border-radius:2px;cursor:pointer;
    flex-shrink:0;box-sizing:border-box;position:relative;
    border:1px solid rgba(255,255,255,0.07);transition:transform .07s;
  }
  .swatch:hover  { transform:scale(1.35);z-index:10;border-color:rgba(255,255,255,0.5); }
  .swatch.active { outline:2px solid #5b9cf6;outline-offset:1px;z-index:11; }
  .swatch.idx0::after, .swatch.unknown::after {
    content:'';position:absolute;inset:2px;
    background:repeating-linear-gradient(45deg,#555 0,#555 2px,transparent 2px,transparent 5px);
    border-radius:1px;pointer-events:none;opacity:.6;
  }
  .cgram-badge {
    display:inline-block;padding:1px 6px;border-radius:3px;margin-left:8px;
    font-size:10px;font-family:monospace;background:#1a3a1a;color:#4c8;border:1px solid #2a5a2a;
  }
  .unverified-badge {
    display:inline-block;padding:1px 6px;border-radius:3px;margin-left:8px;
    font-size:10px;font-family:monospace;background:#3a2a00;color:#ba8;border:1px solid #5a4a00;
  }
  .row-label {
    font-size:10px;color:#555;font-family:monospace;margin-bottom:4px;margin-top:10px;
  }
  .row-label:first-child { margin-top:0; }
</style>
`

// ── Element refs ──────────────────────────────────────────────────────────────

const navEl        = document.getElementById('nav')!
const groupTitle   = document.getElementById('group-title')!
const groupDesc    = document.getElementById('group-desc')!
const variantTabs  = document.getElementById('variant-tabs')!
const swatchRows   = document.getElementById('swatch-rows')!
const detailSwatch = document.getElementById('detail-swatch')!
const detailLabel  = document.getElementById('detail-label')!
const detailValues = document.getElementById('detail-values')!
const romNameEl    = document.getElementById('rom-name')!

// ── State ─────────────────────────────────────────────────────────────────────

let groups: PaletteGroup[] = []
let activeGroupId    = ''
let activeVariantIdx = 0
let selectedRowIdx   = 0
let selectedColIdx   = -1

// Palette animation
let paletteAnim: SerializedPaletteAnimData | null = null
let palAnimFrame   = 0
let palAnimRunning = false
let palAnimTimer: ReturnType<typeof setInterval> | null = null
// cgramIdx → live color overrides (updated each animation frame)
const animOverrides = new Map<number, Color>()

// ── Helpers ───────────────────────────────────────────────────────────────────

function toHex(c: Color): string {
  if (c.a === 0) return '#000000'
  return '#' + c.r.toString(16).padStart(2,'0') +
               c.g.toString(16).padStart(2,'0') +
               c.b.toString(16).padStart(2,'0')
}

function toBgr555(c: Color): number {
  return ((c.r >> 3) & 0x1F) | (((c.g >> 3) & 0x1F) << 5) | (((c.b >> 3) & 0x1F) << 10)
}

function isUnknown(c: Color): boolean {
  return c.a === 255 && c.r === 40 && c.g === 40 && c.b === 40
}

// ── Palette animation ─────────────────────────────────────────────────────────

function liveColorAt(group: PaletteGroup, rowIdx: number, col: number): Color {
  if (group.cgRamRow !== null) {
    const cgramIdx = ((group.cgRamRow + rowIdx) << 4) | col
    const override = animOverrides.get(cgramIdx)
    if (override) return override
  }
  const variant = group.variants[activeVariantIdx]
  return variant?.rows[rowIdx]?.[col] ?? { r: 0, g: 0, b: 0, a: 255 }
}

/** True if the group contains CGRAM rows targeted by FlashingColors ($6D/$7D = rows 6–7). */
function groupHasAnimation(group: PaletteGroup): boolean {
  if (!paletteAnim || group.cgRamRow === null) return false
  const rowCount = group.variants[0]?.rows.length ?? 0
  const rowMin = group.cgRamRow
  const rowMax = group.cgRamRow + rowCount - 1
  return rowMin <= 7 && rowMax >= 6
}

function applyPalFrame(f: number): void {
  if (!paletteAnim) return
  palAnimFrame = ((f % paletteAnim.frameCount) + paletteAnim.frameCount) % paletteAnim.frameCount

  const patches = paletteAnim.frames[palAnimFrame] ?? []
  for (const p of patches) {
    animOverrides.set(p.cgramIdx, { r: p.r, g: p.g, b: p.b, a: p.a })
  }

  // Refresh visible swatches for affected CGRAM indices
  const group = groups.find(g => g.id === activeGroupId)
  if (!group || group.cgRamRow === null) return
  for (const [cgramIdx, color] of animOverrides) {
    const absRow = cgramIdx >> 4
    const col    = cgramIdx & 15
    const rowIdx = absRow - group.cgRamRow
    if (rowIdx < 0 || rowIdx >= (group.variants[activeVariantIdx]?.rows.length ?? 0)) continue
    const el = swatchRows.querySelector<HTMLElement>(`.swatch[data-row="${rowIdx}"][data-col="${col}"]`)
    if (el && !isUnknown(color) && color.a !== 0) {
      el.style.background = toHex(color)
    }
  }

  // Refresh detail bar if selected swatch is animated
  if (selectedColIdx >= 0) {
    const cgramIdx = group.cgRamRow !== null
      ? ((group.cgRamRow + selectedRowIdx) << 4) | selectedColIdx
      : -1
    if (animOverrides.has(cgramIdx)) {
      const variant = group.variants[activeVariantIdx]
      if (variant) selectColor(selectedRowIdx, selectedColIdx, variant, group)
    }
  }
}

function setPalAnimRunning(running: boolean): void {
  palAnimRunning = running
  // Update whichever play button is currently in the group header
  const btn = document.getElementById('pal-play-btn')
  if (btn) btn.innerHTML = running ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'
  if (running) {
    if (palAnimTimer) clearInterval(palAnimTimer)
    palAnimTimer = setInterval(() => {
      if (!paletteAnim) return
      applyPalFrame(palAnimFrame + 1)
    }, paletteAnim?.intervalMs ?? 66)
  } else {
    if (palAnimTimer) { clearInterval(palAnimTimer); palAnimTimer = null }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function buildNav(): void {
  navEl.innerHTML = ''
  for (const g of groups) {
    const el = document.createElement('div')
    el.className = 'nav-item' + (g.id === activeGroupId ? ' active' : '')
    el.textContent = g.label
    el.title = g.description
    el.addEventListener('click', () => selectGroup(g.id))
    navEl.appendChild(el)
  }
}

function selectGroup(id: string): void {
  activeGroupId    = id
  activeVariantIdx = 0
  selectedRowIdx   = 0
  selectedColIdx   = -1
  buildNav()
  renderGroup()
}

// ── Group rendering ───────────────────────────────────────────────────────────

function renderGroup(): void {
  const group = groups.find(g => g.id === activeGroupId)
  if (!group) return

  const hasUnverified = group.variants.some(v => v.romAddr === null)
  const cgBadge = group.cgRamRow !== null
    ? `<span class="cgram-badge">CGRAM row ${group.cgRamRow}</span>`
    : ''
  const warnBadge = hasUnverified
    ? `<span class="unverified-badge">⚠ some addresses unverified</span>`
    : ''

  const animBtn = groupHasAnimation(group)
    ? `<button id="pal-play-btn" title="${palAnimRunning ? 'Pause' : 'Play'} palette animation" style="
        background:none;border:none;color:var(--vscode-foreground,#ccc);
        cursor:pointer;font-size:13px;padding:1px 6px;border-radius:3px;line-height:1;
        vertical-align:middle;margin-left:6px;">${palAnimRunning ? '<span class="codicon codicon-debug-pause"></span>' : '<span class="codicon codicon-play"></span>'}</button>`
    : ''
  groupTitle.innerHTML = group.label + cgBadge + warnBadge + animBtn
  groupTitle.querySelector('#pal-play-btn')?.addEventListener('click', () => setPalAnimRunning(!palAnimRunning))
  groupDesc.textContent = group.description

  // Variant tabs
  variantTabs.innerHTML = ''
  if (group.variants.length > 1) {
    group.variants.forEach((v, i) => {
      const tab = document.createElement('button')
      tab.className = 'vtab' + (i === activeVariantIdx ? ' active' : '')
      tab.textContent = v.label
      tab.addEventListener('click', () => { activeVariantIdx = i; selectedRowIdx = 0; selectedColIdx = -1; renderVariant(group) })
      variantTabs.appendChild(tab)
    })
    variantTabs.style.display = 'flex'
  } else {
    variantTabs.style.display = 'none'
  }

  renderVariant(group)
}

function renderVariant(group: PaletteGroup): void {
  // Update tab active state
  variantTabs.querySelectorAll('.vtab').forEach((t, i) =>
    t.classList.toggle('active', i === activeVariantIdx))

  const variant = group.variants[activeVariantIdx]
  if (!variant) return

  swatchRows.innerHTML = ''

  const addrText = variant.romAddr !== null
    ? `ROM: $${variant.romAddr.toString(16).toUpperCase().padStart(6,'0')}`
    : '⚠ ROM address unverified'

  // Meta header
  const meta = document.createElement('div')
  meta.style.cssText = 'font-size:10px;color:#555;font-family:monospace;margin-bottom:10px;'
  meta.textContent = addrText + (variant.rows.length > 1 ? `  (${variant.rows.length} CGRAM rows)` : '')
  swatchRows.appendChild(meta)

  // Render each CGRAM row as a separate swatch row
  variant.rows.forEach((rowColors, rowIdx) => {
    const cgRamRowNum = group.cgRamRow !== null ? group.cgRamRow + rowIdx : null

    // Row label
    const label = document.createElement('div')
    label.className = 'row-label'
    label.textContent = cgRamRowNum !== null
      ? `CGRAM row ${cgRamRowNum}  ·  ${variant.romAddr !== null
          ? '$' + (variant.romAddr + rowIdx * 24).toString(16).toUpperCase().padStart(6,'0')
          : '⚠'}`
      : `Row ${rowIdx}`
    swatchRows.appendChild(label)

    // Swatch row
    const row = document.createElement('div')
    row.style.cssText = `display:flex;gap:${GAP}px;margin-bottom:2px;`

    for (let col = 0; col < COLS; col++) {
      const c   = liveColorAt(group, rowIdx, col)
      const unk = isUnknown(c)
      const transparent = c.a === 0

      const el = document.createElement('div')
      el.className = 'swatch' +
        (col === 0 ? ' idx0' : '') +
        (unk ? ' unknown' : '') +
        (selectedRowIdx === rowIdx && selectedColIdx === col ? ' active' : '')
      el.dataset.row = String(rowIdx)
      el.dataset.col = String(col)

      el.style.background = (unk || transparent) ? '#1a1a1a' : toHex(c)
      el.title = col === 0 ? 'Index 0 (transparent)' : `Row ${rowIdx} Index ${col}: ${toHex(c)}`

      el.addEventListener('click', () => selectColor(rowIdx, col, variant, group))
      row.appendChild(el)
    }

    swatchRows.appendChild(row)
  })

  // Re-apply selection or default to row 0, col 1
  if (selectedColIdx >= 0 && selectedRowIdx < variant.rows.length) {
    selectColor(selectedRowIdx, selectedColIdx, variant, group)
  } else {
    selectColor(0, 1, variant, group)
  }
}

function selectColor(rowIdx: number, col: number, variant: PaletteVariant, group: PaletteGroup): void {
  selectedRowIdx = rowIdx
  selectedColIdx = col

  swatchRows.querySelectorAll('.swatch').forEach(e => e.classList.remove('active'))
  swatchRows.querySelector(`.swatch[data-row="${rowIdx}"][data-col="${col}"]`)?.classList.add('active')

  const c   = liveColorAt(group, rowIdx, col)
  const unk = isUnknown(c)
  const transparent = c.a === 0

  detailSwatch.style.background = (unk || transparent) ? '#1a1a1a' : toHex(c)

  const cgRamRowNum = group.cgRamRow !== null ? group.cgRamRow + rowIdx : rowIdx
  detailLabel.textContent = `${group.label}  ·  ${variant.label}  ·  CGRAM row ${cgRamRowNum}  ·  index ${col}` +
    (col === 0 ? '  (transparent)' : '')

  if (unk) {
    detailValues.textContent = 'ROM address not yet verified — color unknown'
  } else if (transparent) {
    detailValues.textContent = 'Transparent (SNES color index 0 is always transparent)'
  } else {
    detailValues.textContent =
      `RGB: ${c.r}, ${c.g}, ${c.b}  ·  ${toHex(c).toUpperCase()}  ·  BGR555: $${toBgr555(c).toString(16).toUpperCase().padStart(4,'0')}`
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data as Record<string, unknown>

  if (msg['type'] === 'load') {
    const data = msg as unknown as LoadMsg
    groups = data.groups
    romNameEl.textContent = data.romName

    // Initialize palette animation (button appears in group header when relevant)
    paletteAnim = data.paletteAnimation ?? null
    animOverrides.clear()
    palAnimRunning = false
    if (palAnimTimer) { clearInterval(palAnimTimer); palAnimTimer = null }

    if (groups.length > 0) {
      activeGroupId = groups[0].id
      buildNav()
      renderGroup()
    }
  } else if (msg['type'] === 'error') {
    groupTitle.textContent = 'Error'
    groupDesc.textContent  = String(msg['message'])
  }
})

vscode.postMessage({ type: 'ready' })
export {}
