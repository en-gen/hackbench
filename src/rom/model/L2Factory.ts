import type { RomFile } from '../RomFile'
import {
  L2_BG_PLANE_ROWS,
  L2_EMPTY_TILE,
  L2_TILEMAP_COLS,
  L2_TILEMAP_ROWS,
  isPresetPtr,
  loadL2Objects,
  loadL2Preset,
  readL2Pointer,
} from '../L2Loader'
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
import { StaticQuad } from './tiles/behaviors/StaticQuad'
import { makeTransparentPlaceholderChar, quadFromMap16 } from './tiles/TileFactory'
import { Tile } from './tiles/Tile'

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
    const grid: (number | null)[][] = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => {
        const rr = r % L2_BG_PLANE_ROWS
        if (rr >= L2_TILEMAP_ROWS) return null
        const tileId = preset.grid[rr][c % L2_TILEMAP_COLS]
        const baseId = tileId & 0xFF
        if (baseId === L2_EMPTY_TILE) return null
        return tileId
      }),
    )
    return new L2Preset(preset.page, grid, bgTiles)
  }

  // Object-stream L2 reuses L1's Map16 table + orientation.
  const isVerticalL2 = isLevelModeVerticalL2(header.levelMode)
  const objL2 = loadL2Objects(rom, ptr, screens, header.objectTileset, isVerticalL2)
  if (!objL2) return null

  // Grid of L1 Map16 ids. L2ObjectStream resolves them against the same
  // `l1Tiles` table the L1 grid uses.
  const grid: (number | null)[][] = objL2.grid.map(row =>
    row.map(id => (id === L2_EMPTY_TILE ? null : id)),
  )
  return new L2ObjectStream(grid, l1Tiles)
}

/**
 * Build the full BG Map16 tile table (all 512 entries) from the ROM.
 * Callers get every tile regardless of whether the current level
 * references it — tile-viewer panels show the whole palette, so
 * anything less would leave blank pages 0x80 / 0x81 in the Map16
 * viewer for levels that only use a handful.
 */
export function buildBgTiles(rom: RomFile, chars: Map<number, Char>): Map<number, Tile> {
  const placeholder = makeTransparentPlaceholderChar()
  const bgMap16 = loadAllMap16BG(rom)
  const tiles = new Map<number, Tile>()
  for (const m16 of bgMap16) {
    tiles.set(m16.id, new Tile(m16.id, new StaticQuad(quadFromMap16(m16, chars, placeholder))))
  }
  return tiles
}
