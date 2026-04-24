/**
 * SMW ROM Map - webview entry point.
 *
 * Renders a 16x16 grid of 2 KB cells covering the full 512 KB LoROM space.
 * Legend on the right identifies pointer tables, palette groups, Map16 pages,
 * level data, GFX files, and free/padding regions. Click a cell to open a
 * detail panel with a 16-byte sub-grid and a per-region schema in its own
 * boxed panel. When the clicked cell is level data (banks $06-$07), sub-cells
 * are painted by the actual L1 / L2 / sprite block that covers them, driven
 * by the block list sent from the extension (see RomMapProvider).
 *
 * Messages FROM extension host:
 *   { type: 'load', romSize, hasHeader, blocks: Block[] }
 *   { type: 'error', message }
 *
 * Messages TO extension host:
 *   { type: 'ready' }
 *
 * The region catalog (REGIONS + STARTS) is derived from src/rom/ constants
 * and held here verbatim; it does not need the ROM to render the grid or
 * legend. Block boundaries require the ROM and arrive via `load`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function acquireVsCodeApi(): any
const vscode = acquireVsCodeApi()

// ── Types ──────────────────────────────────────────────────────────────────────

interface Block {
  kind: 'L1' | 'L2' | 'Sprite'
  snes: number
  fileStart: number
  fileEnd: number
  size: number
  indices: number[]
}

interface Region { label: string; color: string; sub: string }
interface Start { region: string; snes: number; size: number; name: string }

interface Cell {
  index: number
  row: number
  col: number
  fileStart: number
  fileEnd: number
  snesStart: number
  snesEnd: number
  regionId: string
  starts: Start[]
}

interface SubInfo {
  regionId: string
  name: string
  start: Start | null
  full: boolean
}

interface SubcellInfo {
  index: number
  snesStart: number
  fileStart: number
  fileEnd: number
  sub: SubInfo
  block: Block | null
}

// ── Region catalog ─────────────────────────────────────────────────────────────

const REGIONS: Record<string, Region> = {
  code:          { label: 'Game code (65816)',             color: '#3b4252', sub: 'banks $00-$04, $0E' },
  header:        { label: 'ROM header & vectors',          color: '#6b7280', sub: '$00FFC0' },
  gfxAssign:     { label: 'GFX assignment tables',         color: '#14b8a6', sub: 'sprite / FG-BG slots' },
  palettes:      { label: 'Palette data',                  color: '#f59e0b', sub: '$00B0A0-$00B6D1' },
  gfxPtr:        { label: 'GFX pointer tables (lo/hi/bnk)',color: '#ea580c', sub: '$00B992 +50 +50' },
  spriteTables:  { label: 'Sprite tile / property tables', color: '#92400e', sub: 'bank $01' },
  music:         { label: 'Music (level track table)',     color: '#ec4899', sub: '$0584DB' },
  animation:     { label: 'Animation tables',              color: '#a78bfa', sub: '$05B93B-$05B999' },
  tilesetId:     { label: 'Tileset ID table',              color: '#10b981', sub: '$05D760' },
  levelPtrs:     { label: 'L1 / L2 / Sprite pointer tables', color: '#dc2626', sub: '$05E000 $05E600 $05EC00' },
  secExits:      { label: 'Secondary exit tables',         color: '#991b1b', sub: '$05F800-$05FE00' },
  levelData:     { label: 'Level object / sprite data',    color: '#7e22ce', sub: 'banks $06-$07' },
  gfxFiles:      { label: 'GFX files (LC_LZ2 compressed)', color: '#16a34a', sub: 'banks $08-$0B, 50 files' },
  secCode:       { label: 'Secondary code / data',         color: '#475569', sub: 'bank $0C' },
  map16:         { label: 'Map16 tile definitions',        color: '#eab308', sub: '$0D8000 + $0DC000' },
  objDispatch:   { label: 'Object handler dispatch',       color: '#06b6d4', sub: '$0DA10F + $0DA41E' },
  secExitPtrs:   { label: 'Sec exit relocator pointers',   color: '#991b1b', sub: '$0DE191' },
  freeSpace:     { label: 'Free / padding (vanilla)',      color: '#17171b', sub: 'Lunar Magic reuses some of this' },
}

const STARTS: Start[] = [
  // Bank $00 data tables
  { region: 'gfxAssign',    snes: 0x00A8C3, size:   64, name: 'GFX sprite assignment (16 sets x 4 bytes)' },
  { region: 'gfxAssign',    snes: 0x00A92B, size:   64, name: 'GFX FG/BG assignment (16 sets x 4 bytes)' },
  { region: 'palettes',     snes: 0x00B0A0, size:   16, name: 'Back area color variants (8 x 2 B)' },
  { region: 'palettes',     snes: 0x00B0B0, size:  192, name: 'BG palette pairs, rows 0-1 (8 x 24 B)' },
  { region: 'palettes',     snes: 0x00B170, size:   32, name: 'BG secondary cols 8-15' },
  { region: 'palettes',     snes: 0x00B190, size:  192, name: 'FG palette pairs, rows 2-3 (8 x 24 B)' },
  { region: 'palettes',     snes: 0x00B250, size:  120, name: 'Shared sprite colors rows 4-13 cols 2-7' },
  { region: 'palettes',     snes: 0x00B2C8, size:   80, name: 'Player palettes (Mario, Luigi, Fire)' },
  { region: 'palettes',     snes: 0x00B318, size:  192, name: 'Sprite palettes E & F (8 x 24 B)' },
  { region: 'palettes',     snes: 0x00B552, size:   42, name: 'Sprite secondary colors rows 5-7' },
  { region: 'palettes',     snes: 0x00B674, size:   42, name: 'Berry colors (3 rows x 7 cols)' },
  { region: 'gfxPtr',       snes: 0x00B992, size:   50, name: 'GFX pointer LO bytes (50 files)' },
  { region: 'gfxPtr',       snes: 0x00B9C4, size:   50, name: 'GFX pointer HI bytes (50 files)' },
  { region: 'gfxPtr',       snes: 0x00B9F6, size:   50, name: 'GFX pointer BANK bytes (50 files)' },
  { region: 'header',       snes: 0x00FFC0, size:   64, name: 'ROM header (name, speed, size, vectors)' },

  // Bank $01 sprite infrastructure
  { region: 'spriteTables', snes: 0x0188F0, size:   40, name: 'Sprite 0-19 properties' },
  { region: 'spriteTables', snes: 0x019B83, size:  252, name: 'Sprite tilemap base' },
  { region: 'spriteTables', snes: 0x019C7F, size:   84, name: 'Sprite tilemap offsets (84 entries)' },
  { region: 'spriteTables', snes: 0x019CD3, size:   96, name: 'General sprite X/Y displacement tables' },

  // Bank $05 tables
  { region: 'music',        snes: 0x0584DB, size:  512, name: 'Level music track selection (512 levels)' },
  { region: 'animation',    snes: 0x05B93B, size:    6, name: 'VRAM dest tables (A/B/C for animated tiles)' },
  { region: 'animation',    snes: 0x05B96B, size:   32, name: 'Tile behavior table' },
  { region: 'animation',    snes: 0x05B98B, size:   14, name: 'Tileset offset table' },
  { region: 'animation',    snes: 0x05B999, size:    4, name: 'Animated tile data base address' },
  { region: 'tilesetId',    snes: 0x05D760, size:   16, name: 'Tileset ID lookup (sprite-set to tileset)' },
  { region: 'levelPtrs',    snes: 0x05E000, size: 1536, name: 'Layer 1 pointer table (512 x 3 bytes)' },
  { region: 'levelPtrs',    snes: 0x05E600, size: 1536, name: 'Layer 2 pointer table (512 x 3 bytes)' },
  { region: 'levelPtrs',    snes: 0x05EC00, size: 1024, name: 'Sprite pointer table (512 x 2 bytes)' },
  { region: 'secExits',     snes: 0x05F800, size:  512, name: 'Sec exit: destination level low byte' },
  { region: 'secExits',     snes: 0x05FA00, size:  512, name: 'Sec exit: Y pos / BG / FG info' },
  { region: 'secExits',     snes: 0x05FC00, size:  512, name: 'Sec exit: X pos / screen' },
  { region: 'secExits',     snes: 0x05FE00, size:  512, name: 'Sec exit: flags (action, slippery)' },

  // Banks $06-$07 level data (entire range)
  { region: 'levelData',    snes: 0x068000, size: 32768, name: 'Layer 1 object data (bank $06)' },
  { region: 'levelData',    snes: 0x078000, size: 32768, name: 'Layer 2 + sprite + L1 overflow (bank $07)' },

  // Banks $08-$0B GFX
  { region: 'gfxFiles',     snes: 0x088000, size: 32768, name: 'Compressed GFX files (part 1/4)' },
  { region: 'gfxFiles',     snes: 0x098000, size: 32768, name: 'Compressed GFX files (part 2/4)' },
  { region: 'gfxFiles',     snes: 0x0A8000, size: 32768, name: 'Compressed GFX files (part 3/4)' },
  { region: 'gfxFiles',     snes: 0x0B8000, size: 32768, name: 'Compressed GFX files (part 4/4)' },

  // Bank $0C secondary code
  { region: 'secCode',      snes: 0x0C8000, size: 32768, name: 'Secondary code / data (bank $0C)' },

  // Bank $0D Map16 + dispatch
  { region: 'map16',        snes: 0x0D8000, size: 2048, name: 'Map16 page 0 (tiles $000-$0FF, 8 B each)' },
  { region: 'objDispatch',  snes: 0x0DA10F, size:  256, name: 'Extended object handler dispatch' },
  { region: 'objDispatch',  snes: 0x0DA41E, size:  256, name: 'Tileset object handler dispatch' },
  { region: 'map16',        snes: 0x0DC000, size: 2048, name: 'Map16 page 1 (tiles $100-$1FF, 8 B each)' },
  { region: 'secExitPtrs',  snes: 0x0DE191, size:   24, name: 'Sec exit relocator pointers (LM-aware)' },

  // Known vanilla free space (approximate at 2 KB granularity)
  { region: 'freeSpace',    snes: 0x06F624, size:  2524, name: 'End of bank $06 (vanilla padding)' },
  { region: 'freeSpace',    snes: 0x07F0DB, size:  3877, name: 'End of bank $07 (vanilla padding)' },
  { region: 'freeSpace',    snes: 0x0DE1A9, size:  7767, name: 'Bank $0D tail (vanilla padding)' },
  { region: 'freeSpace',    snes: 0x0EE04B, size:  8117, name: 'Bank $0E tail (vanilla; LM writes custom palette table here at $0EF600)' },
  { region: 'freeSpace',    snes: 0x0F8000, size: 32768, name: 'Bank $0F entirely free in vanilla (LM ExGFX slot)' },
]

// ── Constants ──────────────────────────────────────────────────────────────────

const CELL_BYTES = 0x800
const BANK_BYTES = 0x8000
const COLS = 16
const ROWS = 16

// ── Helpers ────────────────────────────────────────────────────────────────────

function snesToFile(snes: number): number {
  const bank = (snes >>> 16) & 0xFF
  const addr = snes & 0xFFFF
  return (bank & 0x7F) * BANK_BYTES + (addr & 0x7FFF)
}

function fileToSnes(file: number): number {
  const bank = Math.floor(file / BANK_BYTES) & 0xFF
  const offs = (file % BANK_BYTES) | 0x8000
  return (bank << 16) | offs
}

function cellIndex(fileOffset: number): number {
  return Math.floor(fileOffset / CELL_BYTES)
}

const toHex = (n: number, pad: number): string =>
  n.toString(16).toUpperCase().padStart(pad, '0')

function shadeColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const adj = (c: number): number => {
    const n = amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)
    return Math.max(0, Math.min(255, Math.round(n)))
  }
  const hh = (n: number): string => n.toString(16).padStart(2, '0')
  return '#' + hh(adj(r)) + hh(adj(g)) + hh(adj(b))
}

function defaultRegionForRow(row: number): string {
  if (row >= 0x06 && row <= 0x07) return 'levelData'
  if (row >= 0x08 && row <= 0x0B) return 'gfxFiles'
  if (row === 0x0C) return 'secCode'
  if (row === 0x0F) return 'freeSpace'
  return 'code'
}

function findBlockAt(fileStart: number, fileEnd: number): Block | null {
  for (const b of romBlocks) {
    if (fileStart <= b.fileEnd - 1 && fileEnd >= b.fileStart) return b
  }
  return null
}

function findBlocksIn(fileStart: number, fileEnd: number): Block[] {
  return romBlocks.filter(b => fileStart <= b.fileEnd - 1 && fileEnd >= b.fileStart)
}

function colorForBlock(block: Block): string {
  const base =
    block.kind === 'L1'     ? '#7e22ce' :
    block.kind === 'L2'     ? '#9333ea' :
                              '#c084fc'
  const ord = block.indices[0] % 8
  const amount = (ord / 7) * 0.55 - 0.275
  return shadeColor(base, amount)
}

function findSubRegion(cell: Cell, subFileStart: number, subFileEnd: number): SubInfo {
  for (const s of STARTS) {
    const sf = snesToFile(s.snes)
    const ef = sf + s.size - 1
    if (subFileStart >= sf && subFileEnd <= ef) {
      return { regionId: s.region, name: s.name, start: s, full: true }
    }
  }
  for (const s of STARTS) {
    const sf = snesToFile(s.snes)
    const ef = sf + s.size - 1
    if (subFileStart <= ef && subFileEnd >= sf) {
      return { regionId: s.region, name: s.name + ' (edge)', start: s, full: false }
    }
  }
  return { regionId: cell.regionId, name: REGIONS[cell.regionId].label, start: null, full: false }
}

// Per-start ordinal used to shade sibling sub-regions that share a base color
// (e.g. nine palette entries all colored amber, but each with a distinct shade).
const startOrdinal = new Map<Start, { ord: number; total: number }>()
{
  const byRegion: Record<string, Start[]> = {}
  for (const s of STARTS) {
    (byRegion[s.region] ||= []).push(s)
  }
  for (const region in byRegion) {
    const arr = byRegion[region]
    arr.forEach((s, i) => startOrdinal.set(s, { ord: i, total: arr.length }))
  }
}

function colorForSubRegion(sub: SubInfo): string {
  const base = REGIONS[sub.regionId].color
  if (!sub.start) return base
  const info = startOrdinal.get(sub.start)
  if (!info || info.total <= 1) return base
  const SPREAD = 0.55
  const t = info.ord / (info.total - 1)
  const amount = (t - 0.5) * 2 * SPREAD
  return shadeColor(base, amount)
}

// ── Cell data ──────────────────────────────────────────────────────────────────

const cells: Cell[] = []
for (let i = 0; i < ROWS * COLS; i++) {
  const row = Math.floor(i / COLS)
  const col = i % COLS
  const fileStart = i * CELL_BYTES
  const fileEnd = fileStart + CELL_BYTES - 1
  cells.push({
    index: i, row, col,
    fileStart, fileEnd,
    snesStart: fileToSnes(fileStart),
    snesEnd: fileToSnes(fileEnd),
    regionId: defaultRegionForRow(row),
    starts: [],
  })
}

for (const s of STARTS) {
  const fileStart = snesToFile(s.snes)
  const fileEnd = fileStart + s.size - 1
  const startCell = cellIndex(fileStart)
  const endCell = cellIndex(fileEnd)
  for (let i = startCell; i <= endCell && i < cells.length; i++) {
    const c = cells[i]
    const cellStart = i * CELL_BYTES
    const cellEnd = cellStart + CELL_BYTES - 1
    const overlap = Math.min(fileEnd, cellEnd) - Math.max(fileStart, cellStart) + 1
    if (c.starts.length === 0 || overlap >= CELL_BYTES / 4) {
      c.regionId = s.region
    }
    if (i === startCell) {
      c.starts.push(s)
    }
  }
}

// ── State ──────────────────────────────────────────────────────────────────────

let romBlocks: Block[] = []
let blocksLoaded = false
let currentSubcells: SubcellInfo[] = []

// ── Styling ────────────────────────────────────────────────────────────────────

const STYLE = `
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --surface: var(--vscode-sideBar-background, #252526);
    --surface-2: var(--vscode-editorWidget-background, #2d2d30);
    --border: var(--vscode-panel-border, #3c3c3c);
    --text: var(--vscode-foreground, #d4d4d4);
    --muted: var(--vscode-descriptionForeground, #858585);
    --accent: var(--vscode-textLink-foreground, #569cd6);
    --cell-size: 36px;
    --cell-gap: 2px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--vscode-font-family, "Segoe UI", system-ui, sans-serif); font-size: 13px; }
  body { padding: 20px 24px 48px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 4px; color: var(--text); }
  .subtitle { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .rom-meta { font-size: 11px; color: var(--muted); font-family: Consolas, "Courier New", monospace; }
  .container { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; }
  .grid-wrap { display: inline-grid; grid-template-columns: auto auto; grid-template-rows: auto auto; gap: 4px 6px; }
  .corner { }
  .col-labels { display: grid; grid-template-columns: repeat(16, var(--cell-size)); gap: var(--cell-gap); }
  .col-labels span { text-align: center; color: var(--muted); font-size: 10px; font-family: Consolas, monospace; }
  .row-labels { display: grid; grid-template-rows: repeat(16, var(--cell-size)); gap: var(--cell-gap); align-items: center; }
  .row-labels span { text-align: right; color: var(--muted); font-size: 10px; font-family: Consolas, monospace; padding-right: 4px; }
  .grid { display: grid; grid-template-columns: repeat(16, var(--cell-size)); grid-template-rows: repeat(16, var(--cell-size)); gap: var(--cell-gap); background: var(--surface); padding: 6px; border: 1px solid var(--border); border-radius: 4px; }
  .cell { width: var(--cell-size); height: var(--cell-size); border-radius: 2px; cursor: crosshair; outline: 1px solid transparent; transition: transform 80ms ease, outline-color 80ms ease; }
  .cell:hover { outline-color: #fff; transform: scale(1.12); z-index: 2; }
  .cell.selected { outline: 2px solid #fff !important; outline-offset: 1px; z-index: 3; }
  .cell--free { background: repeating-linear-gradient(45deg, #2a2a30, #2a2a30 3px, #17171b 3px, #17171b 6px) !important; }

  .legend { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 12px 16px; min-width: 460px; max-width: 500px; flex: 0 0 auto; }
  .legend h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--text); text-transform: uppercase; letter-spacing: 0.5px; }
  #legend-items { display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; row-gap: 2px; }
  .legend-item { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; font-size: 12px; line-height: 1.35; }
  .swatch { flex: 0 0 auto; width: 14px; height: 14px; border-radius: 2px; margin-top: 1px; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
  .legend-label { flex: 1; color: var(--text); }
  .legend-sub { color: var(--muted); font-size: 11px; font-family: Consolas, monospace; }
  .stats { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; line-height: 1.5; }
  .stats strong { color: var(--text); font-weight: 500; }

  #tooltip { position: fixed; z-index: 100; max-width: 360px; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; font-size: 12px; line-height: 1.4; box-shadow: 0 4px 16px rgba(0,0,0,0.6); pointer-events: none; opacity: 0; transition: opacity 80ms ease; }
  #tooltip.visible { opacity: 1; }
  .tt-title { font-weight: 600; margin-bottom: 4px; color: var(--accent); }
  .tt-range { font-family: Consolas, monospace; color: var(--muted); font-size: 11px; margin-bottom: 6px; }
  .tt-starts { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .tt-start { font-family: Consolas, monospace; font-size: 11px; margin: 2px 0; }
  .tt-start b { color: var(--accent); font-weight: 500; }

  .detail-panel { margin-top: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 16px 20px 20px; max-width: 1200px; }
  .detail-panel[hidden] { display: none; }
  .detail-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .detail-header h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; color: var(--accent); }
  .detail-range { color: var(--muted); font-family: Consolas, monospace; font-size: 11px; text-align: right; line-height: 1.4; }
  .detail-close { background: transparent; border: 1px solid var(--border); color: var(--muted); width: 24px; height: 24px; border-radius: 3px; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; font-family: inherit; }
  .detail-close:hover { color: var(--text); border-color: var(--muted); }

  .detail-body { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; }
  .detail-left { flex: 0 0 auto; }
  .detail-subgrid { display: grid; grid-template-columns: repeat(16, 24px); grid-template-rows: repeat(8, 24px); gap: 2px; padding: 4px; background: #141416; border: 1px solid var(--border); border-radius: 3px; }
  .subcell { width: 24px; height: 24px; border-radius: 2px; cursor: crosshair; outline: 1px solid transparent; }
  .subcell:hover { outline-color: #fff; z-index: 2; }
  .subcell--free { background: repeating-linear-gradient(45deg, #2a2a30, #2a2a30 2px, #17171b 2px, #17171b 4px); }
  .detail-subgrid-caption { margin-top: 10px; font-size: 11px; color: var(--muted); line-height: 1.5; max-width: 420px; }

  .detail-schema { font-size: 12px; line-height: 1.55; color: var(--text); flex: 1 1 300px; min-width: 280px; max-width: 460px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 12px 16px; }
  .detail-schema h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--text); text-transform: uppercase; letter-spacing: 0.5px; }
  .detail-schema h3 { margin: 12px 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); letter-spacing: 0.6px; }
  .detail-schema h3:first-child { margin-top: 0; }
  .detail-schema p { margin: 6px 0; }
  .detail-schema code { background: var(--surface-2); padding: 1px 5px; border-radius: 2px; font-family: Consolas, monospace; font-size: 11px; color: #d4d4aa; }

  .schema-box { border: 1px solid var(--border); border-radius: 3px; padding: 10px 12px; margin: 8px 0; background: var(--surface-2); }
  .schema-box-title { font-family: Consolas, monospace; font-size: 11px; color: var(--accent); margin-bottom: 6px; font-weight: 500; }
  .schema-bytes { display: flex; gap: 3px; margin: 8px 0; flex-wrap: wrap; }
  .schema-byte { min-width: 28px; height: 28px; padding: 0 4px; border: 1px solid var(--border); border-radius: 2px; display: flex; align-items: center; justify-content: center; font-family: Consolas, monospace; font-size: 10px; color: var(--muted); background: var(--bg); }
  .schema-byte.hl { color: var(--accent); border-color: var(--accent); }
  .palette-strip { display: flex; gap: 1px; margin: 4px 0; }
  .palette-swatch { width: 14px; height: 14px; border: 1px solid rgba(255,255,255,0.08); border-radius: 1px; }

  .detail-empty { flex: 1 1 auto; padding: 40px 24px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.65; }
  .detail-empty strong { display: block; color: var(--text); font-size: 14px; margin-bottom: 10px; }
  .detail-empty em { color: var(--accent); font-style: normal; }
  .detail-body.no-rom .detail-left,
  .detail-body.no-rom .detail-schema { display: none; }
  .detail-body:not(.no-rom) .detail-empty { display: none; }

  .level-list { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
  .level-entry { display: grid; grid-template-columns: auto auto 1fr auto; gap: 8px; padding: 3px 6px; border-left: 3px solid var(--accent); background: var(--surface-2); font-size: 11px; font-family: Consolas, monospace; align-items: baseline; }
  .level-entry .kind { color: var(--accent); font-weight: 600; min-width: 34px; }
  .level-entry .ids { color: var(--text); }
  .level-entry .addr { color: var(--muted); }
  .level-entry .size { color: var(--muted); text-align: right; white-space: nowrap; }
`

// ── HTML template ──────────────────────────────────────────────────────────────

const TEMPLATE = `
  <header>
    <h1>SMW ROM memory map</h1>
    <p class="subtitle">
      16&times;16 grid &mdash; each cell is 2&nbsp;KB. Rows are LoROM banks <code>$00</code>-<code>$0F</code>.
      Striped cells are free/padding. Click a cell for the detailed breakdown.
    </p>
    <div class="rom-meta" id="rom-meta">Loading&hellip;</div>
  </header>
  <div class="container">
    <section class="grid-wrap">
      <div class="corner"></div>
      <div class="col-labels" id="col-labels"></div>
      <div class="row-labels" id="row-labels"></div>
      <div class="grid" id="grid" aria-label="ROM memory map grid"></div>
    </section>
    <aside class="legend">
      <h2>Legend</h2>
      <div id="legend-items"></div>
      <div class="stats">
        <div><strong>Total:</strong> 524,288 B (512 KiB)</div>
        <div><strong>Grid:</strong> 16 &times; 16 cells of 2 KB</div>
        <div id="stat-util"></div>
        <div><strong>Mapping:</strong> LoROM &mdash; bank <code>$XX</code>, row <code>XX</code>; <br>col = (addr - $8000) &raquo; 11</div>
      </div>
    </aside>
  </div>
  <section class="detail-panel" id="detail-panel" hidden>
    <header class="detail-header">
      <h2 id="detail-title">&mdash;</h2>
      <div class="detail-range" id="detail-range">&mdash;</div>
      <button class="detail-close" id="detail-close" aria-label="Close detail">&times;</button>
    </header>
    <div class="detail-body" id="detail-body">
      <div class="detail-left">
        <div class="detail-subgrid" id="detail-subgrid" aria-label="Cell sub-grid, 16 B per sub-cell"></div>
        <div class="detail-subgrid-caption">128 sub-cells &times; 16 B = 2 KB. Colors show which named region covers each 16&nbsp;B chunk. Hover any sub-cell for its exact offset.</div>
      </div>
      <aside class="detail-schema" id="detail-schema">
        <h2>Layout</h2>
        <div id="detail-schema-body"></div>
      </aside>
      <div class="detail-empty" id="detail-empty">
        <strong>Open a cell to explore this region.</strong>
        Click any cell in the grid above. When the cell holds level data, the sub-grid paints each block (L1, L2, sprite) with a distinct shade keyed by the pointer table.
      </div>
    </div>
  </section>
  <div id="tooltip"></div>
`

// ── Schema renderers ───────────────────────────────────────────────────────────

type SchemaRenderer = (cell: Cell) => string
const SCHEMA_RENDERERS: Record<string, SchemaRenderer> = {
  levelPtrs: () => `
    <div class="schema-box">
      <div class="schema-box-title">Pointer entry (3 bytes, 512 per table)</div>
      <div class="schema-bytes"><div class="schema-byte hl">LO</div><div class="schema-byte hl">HI</div><div class="schema-byte hl">BNK</div></div>
      <code>snesAddr = (BNK &lt;&lt; 16) | (HI &lt;&lt; 8) | LO</code>
    </div>
    <p>Three tables packed in <code>$05E000-$05EFFF</code>:</p>
    <ul>
      <li><code>$05E000</code> L1 pointers (512 &times; 3 B)</li>
      <li><code>$05E600</code> L2 pointers (512 &times; 3 B)</li>
      <li><code>$05EC00</code> Sprite pointers (512 &times; 2 B, bank <code>$07</code> implicit)</li>
    </ul>
    <p>L2 entries with <code>BNK = $FF</code> mean &quot;use preset BG subroutine&quot; (not decodable without 65816 emulation).</p>
  `,
  gfxPtr: () => `
    <div class="schema-box">
      <div class="schema-box-title">Three parallel tables of 50 bytes</div>
      <code>$00B992</code> LO bytes &mdash; one per GFX file<br>
      <code>$00B9C4</code> HI bytes<br>
      <code>$00B9F6</code> BANK bytes
    </div>
    <p>Indexes <code>$00</code>-<code>$31</code> map to files GFX00-GFX31. Each points into banks <code>$08</code>-<code>$0B</code> where the LC_LZ2 data lives.</p>
  `,
  palettes: () => {
    const sample = ['#687090','#a8b8d8','#483870','#d8c898','#903838','#489028','#f0d838','#f0f0f0']
    const strip = sample.map(c => `<div class="palette-swatch" style="background:${c}"></div>`).join('')
    return `
      <div class="schema-box">
        <div class="schema-box-title">BGR555 color format (2 bytes, little-endian)</div>
        <div class="schema-bytes"><div class="schema-byte hl">LO</div><div class="schema-byte hl">HI</div></div>
        <code>GGGRRRRR 0BBBBBGG</code> (5 bits per channel)
      </div>
      <p>Multiple palette regions packed here:</p>
      <ul>
        <li><code>$00B0A0</code> Back-area colors</li>
        <li><code>$00B0B0</code> BG pairs, rows 0-1</li>
        <li><code>$00B190</code> FG pairs, rows 2-3</li>
        <li><code>$00B250</code> Shared sprite colors</li>
        <li><code>$00B2C8</code> Player palettes (Mario/Luigi/Fire)</li>
        <li><code>$00B318</code> Sprite palettes E &amp; F</li>
        <li><code>$00B552</code> Sprite secondary colors</li>
        <li><code>$00B674</code> Berry colors</li>
      </ul>
      <div class="palette-strip">${strip}</div>
      <p>Sample swatches are illustrative, not loaded from the ROM.</p>
    `
  },
  map16: () => `
    <div class="schema-box">
      <div class="schema-box-title">Map16 tile entry (8 bytes = 4 subtiles)</div>
      <div class="schema-bytes">
        <div class="schema-byte hl">TL-lo</div><div class="schema-byte hl">TL-hi</div>
        <div class="schema-byte hl">BL-lo</div><div class="schema-byte hl">BL-hi</div>
        <div class="schema-byte hl">TR-lo</div><div class="schema-byte hl">TR-hi</div>
        <div class="schema-byte hl">BR-lo</div><div class="schema-byte hl">BR-hi</div>
      </div>
      <code>YXPCCCTT TTTTTTTT</code> per subtile (word, LE)
    </div>
    <p>Column-major order (TL, BL, TR, BR). Bit layout:</p>
    <ul>
      <li><code>Y</code> y-flip &middot; <code>X</code> x-flip &middot; <code>P</code> priority</li>
      <li><code>CCC</code> palette row (0-7)</li>
      <li><code>TT TTTTTTTT</code> 10-bit character index</li>
    </ul>
    <p>This 2 KB cell holds exactly 256 tiles &mdash; a full Map16 page.</p>
  `,
  levelData: (cell) => {
    const blocks = findBlocksIn(cell.fileStart, cell.fileEnd)
    let blocksSection: string
    if (blocks.length === 0) {
      blocksSection = `<p><em>No level pointer lands inside this cell (likely padding between blocks).</em></p>`
    } else {
      const rows = blocks.map(b => {
        const ids = b.indices.map(i => '$' + toHex(i, 3)).join(', ')
        return `<div class="level-entry">
          <span class="kind">${b.kind}</span>
          <span class="ids">L ${ids}</span>
          <span class="addr">$${toHex(b.snes, 6)} &middot; file $${toHex(b.fileStart, 5)}-$${toHex(b.fileEnd - 1, 5)}</span>
          <span class="size">${b.size}&nbsp;B</span>
        </div>`
      }).join('')
      blocksSection = `<h3>Blocks in this cell (${blocks.length})</h3><div class="level-list">${rows}</div>`
    }
    return `
      ${blocksSection}
      <h3>Per-level layout</h3>
      <div class="schema-box">
        <div class="schema-box-title">Structure (variable length)</div>
        <div class="schema-bytes">
          <div class="schema-byte hl">H0</div><div class="schema-byte hl">H1</div><div class="schema-byte hl">H2</div><div class="schema-byte hl">H3</div><div class="schema-byte hl">H4</div>
          <div class="schema-byte">obj</div><div class="schema-byte">obj</div><div class="schema-byte">...</div>
          <div class="schema-byte hl">$FF</div>
        </div>
        5-byte header + 3-byte object stream + <code>$FF</code> terminator
      </div>
      <p>Header bytes:</p>
      <ul>
        <li><code>H0</code> <code>PPPNNNNN</code> BG palette + screens-1</li>
        <li><code>H1</code> <code>BBBMMMMM</code> back area color + level mode</li>
        <li><code>H2</code> <code>LMMMSSSS</code> L3 priority + music + sprite set</li>
        <li><code>H3</code> <code>TTPPPCCC</code> time limit + sprite palette + FG palette</li>
        <li><code>H4</code> <code>IIVVOOOO</code> item memory + vertical scroll + object tileset</li>
      </ul>
    `
  },
  gfxFiles: () => `
    <div class="schema-box">
      <div class="schema-box-title">LC_LZ2 compressed chunks</div>
      <p>50 files (GFX00-GFX31) packed sequentially across banks <code>$08-$0B</code>. Each decompresses to 4096 B (3bpp, 128 tiles).</p>
    </div>
    <p>LC_LZ2 command byte: <code>CCC DDDDD</code></p>
    <ul>
      <li><code>000</code> Direct copy &middot; <code>001</code> byte fill &middot; <code>010</code> word fill</li>
      <li><code>011</code> increment fill &middot; <code>100</code> back reference</li>
      <li><code>111</code> extended length prefix</li>
    </ul>
    <p>File boundaries come from <code>$00B992/$00B9C4/$00B9F6</code>.</p>
  `,
  secExits: () => `
    <div class="schema-box">
      <div class="schema-box-title">Four parallel 512-entry tables</div>
      <code>$05F800</code> Dest level (low byte)<br>
      <code>$05FA00</code> Y pos / BG / FG info<br>
      <code>$05FC00</code> X pos / screen byte<br>
      <code>$05FE00</code> Flags (action, slippery)
    </div>
    <p>Dest high bit lives in flags <code>bit 3</code>. &quot;Use secondary&quot; flag is <code>bit 5</code> of the X/screen byte &mdash; when set, Dest is an index into this table rather than a direct level ID.</p>
  `,
  secExitPtrs: () => `
    <p>Four 3-byte relocator pointers. Lunar Magic patches these when moving the secondary exit tables.</p>
    <div class="schema-box">
      <code>$0DE191</code> &rarr; dest level lo table<br>
      <code>$0DE198</code> &rarr; Y/BG/FG table<br>
      <code>$0DE19F</code> &rarr; X/screen table<br>
      <code>$05DC81</code> &rarr; flags table pointer
    </div>
  `,
  music: () => `
    <div class="schema-box">
      <div class="schema-box-title">Level music table (512 bytes)</div>
      <code>$0584DB + levelIndex</code> &rarr; music track byte
    </div>
    <p>One byte per level; top bits select sample set, lower bits select the SPC700 music ID.</p>
  `,
  animation: () => `
    <p>Animated-tile control tables consumed by the NMI routine:</p>
    <div class="schema-box">
      <code>$05B93B-$05B940</code> VRAM destination tables<br>
      <code>$05B96B</code> Tile behavior table<br>
      <code>$05B98B</code> Tileset offset table<br>
      <code>$05B999</code> Animated tile data base address
    </div>
    <p>These drive the once-per-frame copies of GFX33 &quot;animated&quot; tiles into VRAM slots AN1/AN2.</p>
  `,
  gfxAssign: () => `
    <div class="schema-box">
      <div class="schema-box-title">Two 64-byte tables</div>
      <code>$00A8C3</code> Sprite GFX &mdash; 16 sets &times; 4 slots (SP1..SP4)<br>
      <code>$00A92B</code> FG/BG GFX &mdash; 16 sets &times; 4 slots (FG1, FG2, FG3, AN1)
    </div>
    <p>Each slot byte is an index into the GFX pointer tables at <code>$00B992</code>.</p>
  `,
  tilesetId: () => `
    <p>16-byte lookup: <code>ROM[$05D760 + spriteSet]</code> &rarr; tileset index used to pick the FG/BG slot row.</p>
  `,
  objDispatch: () => `
    <p>Object-handler dispatch tables used by the level renderer:</p>
    <div class="schema-box">
      <code>$0DA10F</code> Extended object dispatch<br>
      <code>$0DA41E</code> Tileset-specific object dispatch<br>
      <code>$0DA455</code> Tileset 0 handler entry points
    </div>
    <p>Each entry is a 2-byte pointer into bank <code>$0D</code> routines.</p>
  `,
  spriteTables: () => `
    <p>Sprite property and tilemap tables consumed by the sprite renderer:</p>
    <div class="schema-box">
      <code>$0188F0</code> Sprite 0-19 property bits<br>
      <code>$019B83</code> Sprite tilemap base<br>
      <code>$019C7F</code> Per-sprite tilemap offsets (84 entries)<br>
      <code>$019CD3/$019CD7</code> General-sprite X/Y displacement
    </div>
  `,
  header: () => `
    <div class="schema-box">
      <div class="schema-box-title">SNES ROM header at $00FFC0 (64 bytes)</div>
      <code>$FFC0</code> Internal name (21 B ASCII)<br>
      <code>$FFD5</code> Speed/map byte (<code>$20</code> = LoROM slow)<br>
      <code>$FFD6</code> Cartridge type<br>
      <code>$FFD7</code> ROM size (<code>1 &lt;&lt; n</code> KB)<br>
      <code>$FFD8</code> SRAM size<br>
      <code>$FFD9-$FFE3</code> Region, dev ID, version, checksum<br>
      <code>$FFE4-$FFFF</code> Interrupt vectors (native + emulation)
    </div>
  `,
  freeSpace: () => `
    <p>Padding in the vanilla ROM &mdash; bytes are mostly <code>$FF</code>, occasionally <code>$00</code>.</p>
    <p>Lunar Magic reuses these regions for:</p>
    <ul>
      <li>Custom palette table (<code>$0EF600</code>)</li>
      <li>ExGFX slots (bank <code>$0F</code>)</li>
      <li>Expanded sprite / object data</li>
      <li>Patched routines and new pointer tables</li>
    </ul>
  `,
  secCode: () => `
    <p>Bank <code>$0C</code> secondary code and data: overworld Layer 3 tile data, minor lookup tables, and routine continuations from bank <code>$0D</code>.</p>
  `,
  code: () => `
    <p>65816 game code. Disassembly required for byte-level interpretation.</p>
  `,
}

// ── Element handles (filled after main()) ─────────────────────────────────────

let gridEl!: HTMLElement
let tooltipEl!: HTMLElement
let detailPanel!: HTMLElement
let detailTitle!: HTMLElement
let detailRange!: HTMLElement
let detailSubgrid!: HTMLElement
let detailSchemaBody!: HTMLElement
let detailBody!: HTMLElement
let romMeta!: HTMLElement

// ── Rendering ──────────────────────────────────────────────────────────────────

function buildGrid(): void {
  const colLabels = document.getElementById('col-labels')!
  for (let c = 0; c < COLS; c++) {
    const span = document.createElement('span')
    span.textContent = toHex(c, 1)
    colLabels.appendChild(span)
  }

  const rowLabels = document.getElementById('row-labels')!
  for (let r = 0; r < ROWS; r++) {
    const span = document.createElement('span')
    span.textContent = '$' + toHex(r, 2)
    rowLabels.appendChild(span)
  }

  for (const c of cells) {
    const div = document.createElement('div')
    div.className = 'cell'
    if (c.regionId === 'freeSpace') div.classList.add('cell--free')
    else div.style.background = REGIONS[c.regionId].color
    div.dataset.index = String(c.index)
    gridEl.appendChild(div)
  }
}

function buildLegend(): void {
  const legendItems = document.getElementById('legend-items')!
  const legendOrder = [
    'code', 'header', 'gfxAssign', 'palettes', 'gfxPtr',
    'spriteTables', 'music', 'animation', 'tilesetId',
    'levelPtrs', 'secExits', 'levelData', 'gfxFiles',
    'secCode', 'map16', 'objDispatch', 'secExitPtrs',
    'freeSpace',
  ]
  for (const id of legendOrder) {
    const r = REGIONS[id]
    const item = document.createElement('div')
    item.className = 'legend-item'
    const sw = document.createElement('div')
    sw.className = 'swatch'
    sw.style.background = r.color
    const text = document.createElement('div')
    text.className = 'legend-label'
    text.innerHTML = r.label + '<br><span class="legend-sub">' + r.sub + '</span>'
    item.appendChild(sw)
    item.appendChild(text)
    legendItems.appendChild(item)
  }

  const freeCells = cells.filter(c => c.regionId === 'freeSpace').length
  const usedCells = cells.length - freeCells
  const usedPct = (usedCells / cells.length) * 100
  document.getElementById('stat-util')!.innerHTML =
    '<strong>Utilization:</strong> ~' + usedPct.toFixed(0) + '% ' +
    '(' + usedCells + ' used / ' + freeCells + ' free cells)'
}

function renderSubgrid(cell: Cell): void {
  detailSubgrid.innerHTML = ''
  currentSubcells = []
  const useBlocks = blocksLoaded && cell.regionId === 'levelData'
  for (let i = 0; i < 128; i++) {
    const fs = cell.fileStart + i * 16
    const fe = fs + 15
    const snesStart = fileToSnes(fs)
    const sub = findSubRegion(cell, fs, fe)
    const block = useBlocks ? findBlockAt(fs, fe) : null
    const div = document.createElement('div')
    div.className = 'subcell'
    if (sub.regionId === 'freeSpace') {
      div.classList.add('subcell--free')
    } else if (block) {
      div.style.background = colorForBlock(block)
    } else if (useBlocks) {
      div.classList.add('subcell--free')
    } else {
      div.style.background = colorForSubRegion(sub)
    }
    div.dataset.subIndex = String(i)
    detailSubgrid.appendChild(div)
    currentSubcells.push({ index: i, snesStart, fileStart: fs, fileEnd: fe, sub, block })
  }
}

function renderSchema(cell: Cell): void {
  const r = SCHEMA_RENDERERS[cell.regionId] || SCHEMA_RENDERERS.code
  detailSchemaBody.innerHTML = r(cell)
}

function showDetail(cell: Cell): void {
  detailPanel.hidden = false
  if (!blocksLoaded) {
    detailBody.classList.add('no-rom')
    detailTitle.textContent = 'Waiting for ROM data'
    detailRange.innerHTML = ''
    currentSubcells = []
    detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    return
  }
  detailBody.classList.remove('no-rom')
  detailTitle.textContent = REGIONS[cell.regionId].label
  detailRange.innerHTML =
    'row $' + toHex(cell.row, 2) + ' col $' + toHex(cell.col, 1) + '<br>' +
    'SNES $' + toHex(cell.snesStart, 6) + ' &ndash; $' + toHex(cell.snesEnd, 6) + '<br>' +
    'file $' + toHex(cell.fileStart, 5) + ' &ndash; $' + toHex(cell.fileEnd, 5)
  renderSubgrid(cell)
  renderSchema(cell)
  detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function hideDetail(): void {
  detailPanel.hidden = true
  gridEl.querySelectorAll('.cell.selected').forEach(el => el.classList.remove('selected'))
}

function positionTooltip(ev: MouseEvent): void {
  const pad = 14
  const tw = tooltipEl.offsetWidth
  const th = tooltipEl.offsetHeight
  let x = ev.clientX + pad
  let y = ev.clientY + pad
  if (x + tw + pad > window.innerWidth)  x = ev.clientX - tw - pad
  if (y + th + pad > window.innerHeight) y = ev.clientY - th - pad
  tooltipEl.style.left = x + 'px'
  tooltipEl.style.top  = y + 'px'
}

function renderCellTooltip(c: Cell): void {
  const region = REGIONS[c.regionId]
  const rangeFile = '$' + toHex(c.fileStart, 5) + '-$' + toHex(c.fileEnd, 5)
  const rangeSnes = '$' + toHex(c.snesStart, 6) + '-$' + toHex(c.snesEnd, 6)
  let html = '<div class="tt-title">' + region.label + '</div>'
  html += '<div class="tt-range">'
  html += 'row $' + toHex(c.row, 2) + ' col $' + toHex(c.col, 1)
  html += ' &middot; ' + rangeSnes
  html += '<br>file ' + rangeFile + ' (2 KB)'
  html += '</div>'
  if (c.starts.length > 0) {
    html += '<div class="tt-starts">'
    for (const s of c.starts) {
      html += '<div class="tt-start"><b>$' + toHex(s.snes, 6) + '</b> '
      html += (s.size >= 1024 ? (s.size / 1024).toFixed(s.size % 1024 === 0 ? 0 : 1) + ' KB' : s.size + ' B')
      html += ' &middot; ' + s.name + '</div>'
    }
    html += '</div>'
  }
  tooltipEl.innerHTML = html
}

function attachHandlers(): void {
  gridEl.addEventListener('mouseover', (ev) => {
    const t = (ev.target as HTMLElement).closest('.cell') as HTMLElement | null
    if (!t) return
    const idx = Number(t.dataset.index)
    renderCellTooltip(cells[idx])
    tooltipEl.classList.add('visible')
    positionTooltip(ev)
  })
  gridEl.addEventListener('mousemove', (ev) => {
    if (tooltipEl.classList.contains('visible')) positionTooltip(ev)
  })
  gridEl.addEventListener('mouseleave', () => {
    tooltipEl.classList.remove('visible')
  })
  gridEl.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('.cell') as HTMLElement | null
    if (!t) return
    const idx = Number(t.dataset.index)
    gridEl.querySelectorAll('.cell.selected').forEach(el => el.classList.remove('selected'))
    t.classList.add('selected')
    showDetail(cells[idx])
  })

  document.getElementById('detail-close')!.addEventListener('click', hideDetail)

  detailSubgrid.addEventListener('mouseover', (ev) => {
    const t = (ev.target as HTMLElement).closest('.subcell') as HTMLElement | null
    if (!t) return
    const idx = Number(t.dataset.subIndex)
    const info = currentSubcells[idx]
    const snesEnd = fileToSnes(info.fileEnd)
    let html =
      '<div class="tt-title">' + REGIONS[info.sub.regionId].label + '</div>' +
      '<div class="tt-range">$' + toHex(info.snesStart, 6) + ' &ndash; $' + toHex(snesEnd, 6) +
      '<br>file $' + toHex(info.fileStart, 5) + ' &ndash; $' + toHex(info.fileEnd, 5) + ' (16 B)</div>'
    if (info.block) {
      const ids = info.block.indices.map(i => '$' + toHex(i, 3)).join(', ')
      html +=
        '<div class="tt-starts"><div class="tt-start"><b>' + info.block.kind + '</b> Level ' + ids + '<br>' +
        'Block $' + toHex(info.block.snes, 6) + ' &middot; ' + info.block.size + ' B' +
        '</div></div>'
    } else {
      html += '<div class="tt-starts"><div class="tt-start">' + info.sub.name + '</div></div>'
    }
    tooltipEl.innerHTML = html
    tooltipEl.classList.add('visible')
    positionTooltip(ev)
  })
  detailSubgrid.addEventListener('mousemove', (ev) => {
    if (tooltipEl.classList.contains('visible')) positionTooltip(ev)
  })
  detailSubgrid.addEventListener('mouseleave', () => {
    tooltipEl.classList.remove('visible')
  })
}

function rerenderIfOpen(): void {
  const sel = gridEl.querySelector('.cell.selected') as HTMLElement | null
  if (sel && !detailPanel.hidden) {
    showDetail(cells[Number(sel.dataset.index)])
  }
}

// ── Entry ──────────────────────────────────────────────────────────────────────

function main(): void {
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)

  const app = document.getElementById('app')!
  app.innerHTML = TEMPLATE

  gridEl = document.getElementById('grid')!
  tooltipEl = document.getElementById('tooltip')!
  detailPanel = document.getElementById('detail-panel')!
  detailTitle = document.getElementById('detail-title')!
  detailRange = document.getElementById('detail-range')!
  detailSubgrid = document.getElementById('detail-subgrid')!
  detailSchemaBody = document.getElementById('detail-schema-body')!
  detailBody = document.getElementById('detail-body')!
  romMeta = document.getElementById('rom-meta')!

  buildGrid()
  buildLegend()
  attachHandlers()

  vscode.postMessage({ type: 'ready' })
}

window.addEventListener('message', (ev) => {
  const msg = ev.data
  if (msg.type === 'load') {
    romBlocks = msg.blocks as Block[]
    blocksLoaded = true
    const size = msg.romSize as number
    const headerNote = msg.hasHeader ? ' + 512 B copier header' : ''
    const l1 = romBlocks.filter(b => b.kind === 'L1').length
    const l2 = romBlocks.filter(b => b.kind === 'L2').length
    const spr = romBlocks.filter(b => b.kind === 'Sprite').length
    romMeta.textContent =
      `ROM: ${size} B${headerNote} - ${l1} L1 / ${l2} L2 / ${spr} sprite blocks`
    rerenderIfOpen()
  } else if (msg.type === 'error') {
    romMeta.textContent = 'Error: ' + msg.message
  }
})

main()
