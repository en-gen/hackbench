/**
 * ObjectExpander.ts -- Converts level object stream into a 2D Map16 tile grid.
 *
 * Derived from SMWDisX disassembly (bank_0D.asm):
 *   - CODE_0DA100 (line 1051): Extended object dispatch
 *   - CODE_0DA40F (line 1319): Normal object dispatch (by tileset, then by objNo)
 *   - CODE_0DA44B (line 1345): Tileset 0 normal object handler table
 *   - CODE_0DA8C3: Common ground/terrain handler (objects 1-14)
 *   - DATA_0DA548 (line 1449): Extended object tile ID table
 *
 * The game writes tiles by computing a position in the level's Map16 tile arrays
 * (Map16TilesLow/High at $7E:C800/$7F:C800) and storing Map16 tile IDs there.
 *
 * Empty tile: $25 (bank_05.asm line 24: LDA #$25 fills the level map)
 *
 * IMPORTANT: The full object expansion logic comprises thousands of lines of
 * disassembly with tileset-specific handlers. This module implements the
 * structural framework and common handlers; tileset-specific handlers are stubs
 * that place TILE_UNKNOWN.
 */

import { LevelObject, SCREEN_W, SCREEN_H } from './LevelParser'
import { RomFile } from './RomFile'

// Empty tile = $25 (bank_05.asm line 24: CODE_05801E fills with #$25)
export const TILE_EMPTY = 0x25
// Unknown/unimplemented objects render as tile $00
export const TILE_UNKNOWN = 0x00

/** A 2D tile grid: grid[row][col] = Map16 tile ID. */
export type TileGrid = number[][]

/** Create a blank tile grid filled with the empty tile ($25). */
export function createGrid(screens: number): TileGrid {
  const cols = screens * SCREEN_W
  return Array.from({ length: SCREEN_H }, () => new Array(cols).fill(TILE_EMPTY))
}

function set(grid: TileGrid, col: number, row: number, tileId: number): void {
  if (row >= 0 && row < SCREEN_H && col >= 0 && col < grid[0].length) {
    grid[row][col] = tileId
  }
}

/** Fill a rectangular region with a single tile ID. */
function fillRect(
  grid: TileGrid, col: number, row: number,
  w: number, h: number, tileId: number,
): void {
  for (let r = row; r < row + h; r++)
    for (let c = col; c < col + w; c++)
      set(grid, c, r, tileId)
}

// ── Extended object tile table ─────────────────────────────────────────────────
// DATA_0DA548 (bank_0D.asm line 1449): tile IDs for extended objects 0x10-0x32+
// The game indexes this table with (extType - 0x10) for single-tile placements.
const DATA_0DA548 = [
  0x1F, 0x22, 0x24, 0x42, 0x43, 0x27, 0x29, 0x25,
  0x6E, 0x6F, 0x70, 0x71, 0x72, 0x45, 0x46, 0x47,
  0x48, 0x36, 0x37, 0x11, 0x12, 0x14, 0x15, 0x16,
  0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x29, 0x1D,
  0x1F, 0x20, 0x21, 0x22, 0x23, 0x25, 0x26, 0x27,
  0x28, 0x2A, 0xDE, 0xE0, 0xE2, 0xE4, 0xEC, 0xED,
  0x2C, 0x25, 0x2D,
]

/**
 * Expand a single extended object.
 *
 * Extended objects (objectNumber = 0 in LoadLevelData, settings = ext type):
 *   - Types 0x00 (CODE_0DA512): screen exit -- no tiles
 *   - Types 0x01 (CODE_0DA53D): screen number set -- no tiles
 *   - Types 0x10-0x32+ (CODE_0DA57B): single-tile placement from DATA_0DA548
 *   - Other types: various multi-tile objects (stubs)
 *
 * From CODE_0DA100 dispatch table (bank_0D.asm lines 1062-1317).
 */
function expandExtendedObject(grid: TileGrid, obj: LevelObject): void {
  const extType = obj.objectNumber

  // Types 0x00, 0x01: screen exit / screen set -- no visual tiles
  if (extType <= 0x01) return

  // Types 0x10-0x32: single-tile objects from DATA_0DA548
  // CODE_0DA57B (line 1458): TXA / SEC / SBC #$10 → index = extType - 0x10
  if (extType >= 0x10 && extType < 0x10 + DATA_0DA548.length) {
    const tileId = DATA_0DA548[extType - 0x10]
    set(grid, obj.x, obj.y, tileId)
    return
  }

  // Other extended object types (multi-tile objects) -- stub
  set(grid, obj.x, obj.y, TILE_UNKNOWN)
}

/**
 * Expand a single normal object.
 *
 * Normal objects use the 6-bit object number ($5A) and the settings byte ($59).
 * The game dispatches by tileset first (CODE_0DA415), then by object number.
 *
 * For tileset 0 (CODE_0DA44B), objects 1-14 all go to CODE_0DA8C3 which is the
 * common "rectangular fill from tile table" handler.
 *
 * This is a simplified implementation that places tiles based on the size parameter.
 * Full accuracy requires porting each of the ~60+ object handlers.
 */
function expandNormalObject(grid: TileGrid, obj: LevelObject, _rom?: RomFile): void {
  const objNo = obj.objectNumber
  const size = obj.settings

  // Objects 1-14 in tileset 0 (CODE_0DA8C3): these are rectangular terrain fills
  // The exact tile IDs depend on the object number and are looked up from ROM tables.
  // For now, place a simple rectangular fill based on size.
  if (objNo >= 1 && objNo <= 14) {
    // Width = (size & 0x0F) + 1, Height = (size >> 4) + 1 for most rectangular objects
    const w = (size & 0x0F) + 1
    const h = (size >> 4) + 1
    fillRect(grid, obj.x, obj.y, w, h, objNo)  // Use objNo as provisional tile ID
    return
  }

  // Objects 15+ have specialized handlers
  // Place a single tile as a stub
  const w = (size & 0x0F) + 1
  set(grid, obj.x, obj.y, objNo)
  if (w > 1) {
    for (let c = 1; c < w; c++) {
      set(grid, obj.x + c, obj.y, objNo)
    }
  }
}

/**
 * Expand a single level object into the tile grid.
 */
export function expandObject(grid: TileGrid, obj: LevelObject, rom?: RomFile): void {
  if (obj.type === 'extended') {
    expandExtendedObject(grid, obj)
  } else {
    expandNormalObject(grid, obj, rom)
  }
}

/**
 * Expand all level objects into a tile grid.
 * Objects are processed in order; later objects overwrite earlier ones
 * (matching SMW's rendering behaviour).
 */
export function expandLevel(objects: LevelObject[], screens: number, rom?: RomFile): TileGrid {
  const grid = createGrid(screens)
  for (const obj of objects) {
    expandObject(grid, obj, rom)
  }
  return grid
}
