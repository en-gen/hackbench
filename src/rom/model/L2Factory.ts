import type { RomFile } from '../RomFile'
import {
  L2_BG_PLANE_ROWS,
  L2_EMPTY_TILE,
  L2_TILEMAP_COLS,
  L2_TILEMAP_ROWS,
  computeL2ScrollRange,
  isPresetPtr,
  loadL2Objects,
  loadL2Preset,
  readInitialLayer2YPos,
  readL2Pointer,
} from '../L2Loader'
import { type ColumnDyRange } from '../scrollSim'
import {
  SCREEN_H,
  SCREEN_H_VERT,
  SCREEN_W,
  SCREEN_W_VERT,
  isLevelModeVerticalL2,
  type LevelHeader,
} from '../LevelParser'
import { loadAllMap16BG } from '../Map16'
import type { Char } from './chars/Char'
import { L2ObjectStream, L2Preset, type L2Layer } from './L2Layer'
import { PaletteOrBehavior } from './tiles/behaviors/PaletteOrBehavior'
import { StaticQuadBehavior } from './tiles/behaviors/StaticQuadBehavior'
import { makeTransparentPlaceholderChar, quadFromMap16 } from './tiles/TileFactory'
import { Tile } from './tiles/Tile'

/**
 * Tileset(s) where SMW's L2 strip uploader OR's `$1000` (= palette bit 2)
 * into every L2 subtile attribute. The check sits inline in the routine -
 * `LDA.W ObjectTileset / CMP.B #$03` at bank_05.asm:1387-1391 + 1503-1507 -
 * with no pointer table, so this is the entire set: tileset 3 only.
 *
 * The OR mask itself in tilemap-entry coords is `$1000` = bit 12 = palette
 * index += 4 (the 3-bit palette field lives at bits 10-12 of a tilemap word).
 * Expressed against our 0..7 `SubTile.palette` field, the mask is simply `4`.
 */
const L2_TILESET3_PALETTE_OR = 4

/** Returns the value OR'd with each L2 subtile's palette for this tileset. */
export function l2PaletteOrForTileset(objectTileset: number): number {
  return objectTileset === 3 ? L2_TILESET3_PALETTE_OR : 0
}

/**
 * Wrap each L1 tile's behavior in `PaletteOrBehavior` when L2 needs the
 * tileset-3 OR mask. When `mask === 0` the L1 atlas is reused as-is so
 * tilesets 0/1/2/4/5+ pay no overhead and L2 cells render with whatever
 * palette indices their atlas tiles encode.
 */
export function buildL2Tiles(l1Tiles: Map<number, Tile>, paletteOrMask: number): Map<number, Tile> {
  if (paletteOrMask === 0) return l1Tiles
  const out = new Map<number, Tile>()
  for (const [id, tile] of l1Tiles) {
    out.set(
      id,
      new Tile(
        tile.id,
        new PaletteOrBehavior(tile.behavior, paletteOrMask),
        tile.actsLike,
        tile.collision,
      ),
    )
  }
  return out
}

/**
 * Build the L2 layer for a level (or null if the level has no L2 data).
 *
 * Preset L2 reads compressed BG tilemap from bank $0C, then tiles it across
 * the level footprint. Preset tiles index into the separate Map16 BG table
 * (Map16BGTiles @ $0D9100), built fresh here from the same VRAM chars as L1.
 *
 * Object-stream L2 shares L1's Map16 table, so we reuse the already-built
 * L1 tile map.
 */
export function buildL2(
  rom: RomFile,
  levelId: number,
  header: LevelHeader,
  screens: number,
  isVertical: boolean,
  chars: Map<number, Char>,
  l1Tiles: Map<number, Tile>,
  bgTiles: Map<number, Tile>,
  /**
   * `Layer1ScrollCmd` from `findLevelScrollSprite` (or null when no scroll
   * sprite). Recorded on the scroll-range descriptor for diagnostic / label
   * purposes. Note: this is L1's cmd, not L2's - gameplay never sets
   * `Layer2ScrollCmd`. See `findLevelScrollSprite` JSDoc.
   */
  layer1ScrollCmd: number | null,
  /** Initial Layer1YPos at level start - needed for scroll-range pixel math. */
  initialCameraYPx: number,
  /** VerticalTable's 32 bytes, from LevelTableGate.readVerticalTable. */
  verticalTable: readonly number[],
): L2Layer | null {
  const ptr = readL2Pointer(rom, levelId) ?? 0
  if (ptr === 0) return null

  if (isPresetPtr(ptr)) {
    const preset = loadL2Preset(rom, ptr)
    if (!preset) return null

    const cols = isVertical ? SCREEN_W_VERT : screens * SCREEN_W
    const rows = isVertical ? screens * SCREEN_H_VERT : SCREEN_H
    // Grid of BG Map16 ids. The L2Preset resolves ids against the shared
    // `bgTiles` map at render time rather than holding Tile references.
    //
    // We render every byte - including the $25 pre-init filler CODE_05801E
    // writes before decompression - because SMW's upload loop (CODE_058D7A,
    // bank_05.asm:1680-1705) indexes Map16BGTiles with that byte unconditionally.
    // Map16BGTiles[$025] is a real visible tile (char $13D), not empty.
    const grid: (number | null)[][] = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => {
        const rr = r % L2_BG_PLANE_ROWS
        if (rr >= L2_TILEMAP_ROWS) return null
        return preset.grid[rr][c % L2_TILEMAP_COLS]
      }),
    )
    return new L2Preset(preset.page, grid, bgTiles)
  }

  // Object-stream L2 reuses L1's Map16 table + orientation.
  const isVerticalL2 = isLevelModeVerticalL2(header.levelMode, verticalTable)
  const objL2 = loadL2Objects(rom, ptr, screens, header.objectTileset, isVerticalL2)
  if (!objL2) return null

  // Grid of L1 Map16 ids. L2ObjectStream resolves them against an L2
  // tile collection - usually the same `l1Tiles`, but for tileset-3
  // levels each tile's behavior is wrapped in `PaletteOrBehavior(mask=4)`
  // to mirror the runtime ORA at bank_05.asm:1463-1480 / 1597-1615.
  const grid: (number | null)[][] = objL2.grid.map(row =>
    row.map(id => (id === L2_EMPTY_TILE ? null : id)),
  )
  const paletteOrMask = l2PaletteOrForTileset(header.objectTileset)
  const l2Tiles = buildL2Tiles(l1Tiles, paletteOrMask)
  // Per-level initial Layer2YPos (BG2VOFS). Only applied to object-stream
  // L2; preset BG is positioned by the page-byte / parallax registers and
  // CODE_05801E never writes Layer2YPos for the $FF branch.
  const initialLayer2YPx = readInitialLayer2YPos(rom, levelId, isVerticalL2)

  // Bounding rect for the editor's L2 scroll-range overlay. Always
  // 'fixed'-kind for object-stream L2 today; per-frame Y animation
  // (sink-rise, screen-shake) is undecoded - see issue #246.
  const cols = isVerticalL2 ? SCREEN_W_VERT : screens * SCREEN_W
  const levelPixelW = cols * 16
  const scrollRange = computeL2ScrollRange({
    grid,
    initialLayer2YPx,
    initialCameraYPx,
    levelPixelW,
    layer1ScrollCmd,
  })

  // layer2YRange and tileDyRanges are derived in the webview's
  // rehydrate.buildL2 from the scrollSimulator, not on the host.
  return new L2ObjectStream(grid, l2Tiles, initialLayer2YPx, scrollRange, paletteOrMask, null, null)
}

/**
 * Build per-tile dy ranges by grouping L2 tiles into 2D connected
 * components (BFS, 4-connectivity). Each component's `(min, max)` is
 * the union of the raw per-column ranges for every column the
 * component spans.
 *
 * This correctly handles levels (like $009) where a single column
 * contains tiles from two vertically separate L2 regions - the regions
 * are distinct components and each gets its own, narrower range rather
 * than the union of the whole column run.
 */
export function buildTileDyRanges(
  rawRanges: (ColumnDyRange | null)[],
  grid: readonly (readonly (number | null)[])[],
  cols: number,
  fallbackDy: number,
): ({ min: number; max: number } | null)[][] {
  const rows = grid.length

  // Component id per cell. -1 = empty tile.
  const compId: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1))
  let nextId = 0
  const compCols = new Map<number, Set<number>>()

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((grid[r]?.[c] ?? null) === null || compId[r][c] !== -1) continue
      const id = nextId++
      compCols.set(id, new Set<number>())
      // BFS - 4-connected (up/down/left/right)
      const q: number[] = [r * cols + c]
      compId[r][c] = id
      for (let qi = 0; qi < q.length; qi++) {
        const idx = q[qi]
        const row = (idx / cols) | 0,
          col = idx % cols
        compCols.get(id)!.add(col)
        for (const [dr, dc] of [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ] as const) {
          const nr = row + dr,
            nc = col + dc
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
          if ((grid[nr]?.[nc] ?? null) === null || compId[nr][nc] !== -1) continue
          compId[nr][nc] = id
          q.push(nr * cols + nc)
        }
      }
    }
  }

  // Union of raw per-column ranges for each component's column set.
  const compRange = new Map<number, { min: number; max: number }>()
  for (const [id, colSet] of compCols) {
    let m = Number.POSITIVE_INFINITY,
      M = Number.NEGATIVE_INFINITY
    for (const c of colSet) {
      const r = rawRanges[c]
      if (!r) continue // camera never reached this column
      if (r.min < m) m = r.min
      if (r.max > M) M = r.max
    }
    // Camera reached no column in this component (unported scroll cmd, or
    // camera stopped before this region): fall back to the static initial
    // offset so tiles render at their natural position rather than vanishing.
    compRange.set(
      id,
      m === Number.POSITIVE_INFINITY ? { min: fallbackDy, max: fallbackDy } : { min: m, max: M },
    )
  }

  // Build 2D output - null for empty cells only.
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      const id = compId[r][c]
      return id === -1 ? null : (compRange.get(id) ?? null)
    }),
  )
}

/**
 * Build the full BG Map16 tile table (all 512 entries) from the ROM.
 * Callers get every tile regardless of whether the current level
 * references it - tile-viewer panels show the whole palette, so
 * anything less would leave blank pages 0x80 / 0x81 in the Map16
 * viewer for levels that only use a handful.
 */
export function buildBgTiles(rom: RomFile, chars: Map<number, Char>): Map<number, Tile> {
  const placeholder = makeTransparentPlaceholderChar()
  const bgMap16 = loadAllMap16BG(rom)
  const tiles = new Map<number, Tile>()
  for (const m16 of bgMap16) {
    tiles.set(
      m16.id,
      new Tile(m16.id, new StaticQuadBehavior(quadFromMap16(m16, chars, placeholder))),
    )
  }
  return tiles
}
