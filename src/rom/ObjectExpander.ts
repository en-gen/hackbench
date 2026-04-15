/**
 * SMW Object Expander — converts the level object stream into a 2D Map16 tile grid.
 *
 * Each level object encodes a TYPE, POSITION, and SIZE PARAMETER. The game's
 * object drawing routines expand these into regions of Map16 tile IDs on screen.
 *
 * This module replicates those drawing rules in TypeScript so the editor can
 * render the level without running the game.
 *
 * ── Coordinate system ──────────────────────────────────────────────────────────
 *   - Level is SCREEN_W (16) tiles wide × SCREEN_H (27) tiles tall per screen
 *   - Grid is [row][col] with row 0 at the TOP, row 26 at the bottom
 *   - Object x/y from LevelParser are already in absolute tile coords
 *
 * ── Standard object byte format (from LevelParser) ────────────────────────────
 *   objectType nibble (0–F from b1 hi nibble)
 *   param nibble (0–F from b1 lo nibble) — usually encodes width/height - 1
 *   x, y — tile position
 *
 * ── Map16 tile IDs used (vanilla SMW page 0, $0D8000) ─────────────────────────
 *   The specific Map16 tile IDs below are based on community documentation and
 *   known SMW tile layouts. IDs flagged with "⚠ verify" need cross-checking
 *   against the actual ROM's Map16 table.
 *
 * IMPORTANT: Many object types are stubs returning UNKNOWN_TILE.
 * The most common terrain objects for Yoshi's Island levels are implemented first.
 */

import { LevelObject, SCREEN_W, SCREEN_H } from './LevelParser'

// 0 = "nothing here" sentinel — never rendered (sky/transparent cells).
// Both uninitialized grid cells and unimplemented objects use 0.
export const TILE_EMPTY   = 0
export const TILE_UNKNOWN = 0

// ── Common terrain Map16 IDs (vanilla SMW, confirmed via Lunar Magic Map16 editor) ──
// Source: SMW Central Map16 tutorial — pages 00 and 01 are vanilla SMW default FG tiles.
//
// Ground / dirt  (3×3 tile set from page 01)
const T_GROUND_TL = 0x145   // top-left corner
const T_GROUND_TM = 0x100   // top-middle (regular ground surface)
const T_GROUND_TR = 0x148   // top-right corner
const T_GROUND_ML = 0x14B   // left wall
const T_GROUND_MM = 0x03F   // dirt interior fill
const T_GROUND_MR = 0x14C   // right wall
const T_GROUND_BL = 0x14D   // bottom-left corner
const T_GROUND_BM = 0x14E   // bottom surface (upside-down ground)
const T_GROUND_BR = 0x14F   // bottom-right corner

// Cement block / brick
const T_CEMENT   = 0x130    // solid cement block (acts as 130)
const T_BRICK    = 0x011    // ⚠ verify — breakable brick

// Pipe tile IDs (page 01, confirmed via Lunar Magic)
// Non-exit vertical pipe top: $133 (left), $134 (right)
// Exit-enabled vertical pipe top: $137 (left), $138 (right)
// Body tiles: ⚠ IDs not yet confirmed — use UNKNOWN until verified
const T_PIPE_TOP_L      = 0x133   // non-exit pipe top-left
const T_PIPE_TOP_R      = 0x134   // non-exit pipe top-right
const T_PIPE_TOP_EXIT_L = 0x137   // exit-enabled pipe top-left
const T_PIPE_TOP_EXIT_R = 0x138   // exit-enabled pipe top-right
const T_PIPE_BODY_L     = TILE_UNKNOWN   // ⚠ body tile IDs not yet confirmed
const T_PIPE_BODY_R     = TILE_UNKNOWN

// Question / coin
const T_QUESTION = 0x010    // ⚠ verify — ? block (note block = $113, turn block = $11E)
const T_COIN     = 0x001    // ⚠ verify — coin

// Muncher / spike
const T_MUNCHER  = 0x12F    // muncher (acts as 12F)

/** A 2D tile grid: grid[row][col] = Map16 tile ID. */
export type TileGrid = number[][]

/** Create a blank tile grid (all empty) for the given level dimensions. */
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

/**
 * Place ground terrain with proper corner/edge tiles.
 *   width  = param + 1 tiles wide
 *   height = fills from row to bottom of screen (row 26)
 */
function placeGround(grid: TileGrid, col: number, row: number, width: number): void {
  const bottom = SCREEN_H - 1
  const w = width

  for (let r = row; r <= bottom; r++) {
    for (let c = col; c < col + w; c++) {
      const isTop   = r === row
      const isBot   = r === bottom
      const isLeft  = c === col
      const isRight = c === col + w - 1

      let tileId: number
      if (isTop) {
        tileId = isLeft ? T_GROUND_TL : isRight ? T_GROUND_TR : T_GROUND_TM
      } else if (isBot) {
        tileId = isLeft ? T_GROUND_BL : isRight ? T_GROUND_BR : T_GROUND_BM
      } else {
        tileId = isLeft ? T_GROUND_ML : isRight ? T_GROUND_MR : T_GROUND_MM
      }
      set(grid, c, r, tileId)
    }
  }
}

/** Place a vertical pipe at (col, row) with given height. isExit selects exit-enabled top tiles. */
function placePipe(grid: TileGrid, col: number, row: number, height: number, isExit = false): void {
  set(grid, col,     row, isExit ? T_PIPE_TOP_EXIT_L : T_PIPE_TOP_L)
  set(grid, col + 1, row, isExit ? T_PIPE_TOP_EXIT_R : T_PIPE_TOP_R)
  for (let r = row + 1; r < row + height; r++) {
    set(grid, col,     r, T_PIPE_BODY_L)
    set(grid, col + 1, r, T_PIPE_BODY_R)
  }
}

/**
 * Expand a single level object into the tile grid.
 *
 * Standard object types (nibble from b1[7:4]):
 *   0x0: Ground — fills column(s) from y to bottom; param = width - 1
 *   0x1: Flat ledge / platform; param = width - 1
 *   0x2: Ground, diagonal right-up slope
 *   0x3: Ground, diagonal left-up slope
 *   0x4: Cement block (solid); param = width - 1
 *   0x5: Brick row; param = width - 1
 *   0x6: ? block row; param = width - 1
 *   0x7: Coin row; param = count - 1
 *   0x8: Pipe (upward); param = height - 1
 *   0x9: Large pipe / water pipe
 *   0xA: Muncher row
 *   0xB: Water surface / lava
 *   0xC: Slope set
 *   0xD: Ledge/cliff
 *   0xE: Background object
 *   0xF: Extended (3-byte, handled by objectType 0x100+)
 *
 * Extended objects (objectType >= 0x100):
 *   Many extended objects are rare; stub as UNKNOWN_TILE.
 */
export function expandObject(grid: TileGrid, obj: LevelObject): void {
  const { x, y, objectType, param } = obj

  if (obj.type === 'standard') {
    const size = param + 1

    switch (objectType) {
      case 0x0: // Ground
        placeGround(grid, x, y, size)
        break

      case 0x1: // Flat ledge / solid platform row
        fillRect(grid, x, y, size, 1, T_GROUND_TM)
        break

      case 0x2: // Right-rising slope (rough approximation)
        for (let i = 0; i < size; i++) {
          set(grid, x + i, y - i, T_GROUND_TM)
          placeGround(grid, x + i, y - i + 1, 1)
        }
        break

      case 0x3: // Left-rising slope
        for (let i = 0; i < size; i++) {
          set(grid, x + i, y + i, T_GROUND_TM)
          placeGround(grid, x + i, y + i + 1, 1)
        }
        break

      case 0x4: // Cement block row
        fillRect(grid, x, y, size, 1, T_CEMENT)
        break

      case 0x5: // Brick row
        fillRect(grid, x, y, size, 1, T_BRICK)
        break

      case 0x6: // ? block row
        fillRect(grid, x, y, size, 1, T_QUESTION)
        break

      case 0x7: // Coin row
        fillRect(grid, x, y, size, 1, T_COIN)
        break

      case 0x8: // Upward pipe
        placePipe(grid, x, y, Math.max(2, size))
        break

      case 0x9: // Large pipe / water variant — treat same as pipe for now
        placePipe(grid, x, y, Math.max(2, size))
        break

      case 0xA: // Muncher row
        fillRect(grid, x, y, size, 1, T_MUNCHER)
        break

      case 0xB: // Water / lava surface — stub
        fillRect(grid, x, y, size, 1, TILE_UNKNOWN)
        break

      case 0xC: // Slope set — stub
        fillRect(grid, x, y, size, 1, TILE_UNKNOWN)
        break

      case 0xD: // Ledge/cliff — treat like ground column
        fillRect(grid, x, y, 1, size, T_GROUND_MM)
        break

      case 0xE: // Background decoration — skip (no FG tile)
        break

      default:
        fillRect(grid, x, y, Math.max(1, size), 1, TILE_UNKNOWN)
        break
    }
  } else {
    // Extended objects (3-byte, objectType = 0x100 + extNum)
    const extNum = objectType - 0x100
    switch (extNum) {
      case 0x00: // Horizontal pipe exit — stub
      case 0x01:
        fillRect(grid, x, y, 2, 2, TILE_UNKNOWN)
        break
      case 0x02: // Coin outline block — stub
        set(grid, x, y, T_COIN)
        break
      default:
        set(grid, x, y, TILE_UNKNOWN)
        break
    }
  }
}

/**
 * Expand all level objects into a tile grid.
 * Objects are processed in order; later objects overwrite earlier ones
 * (matching SMW's rendering behaviour).
 */
export function expandLevel(objects: LevelObject[], screens: number): TileGrid {
  const grid = createGrid(screens)
  for (const obj of objects) {
    expandObject(grid, obj)
  }
  return grid
}
