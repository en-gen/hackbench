/**
 * SMW Tile Cursor — replicates the level loading cursor system from bank $0D.
 *
 * Ported from SMWDisX (IsoFrieze/SMWDisX) subroutines:
 *   CODE_0DA6B1 — save column pointer
 *   CODE_0DA6BA — restore column pointer
 *   CODE_0DA95B — write tile + advance column
 *   CODE_0DA95D — advance column (no write)
 *   CODE_0DA97D — advance row
 *   Sta1To6ePointer — set Map16 high byte = 1
 *   StzTo6ePointer — set Map16 high byte = 0
 *
 * Instead of writing to WRAM at [$6B]+Y, we write to a 2D tile grid.
 * The cursor tracks row/col within the grid and handles screen boundaries.
 */

import { SCREEN_W, SCREEN_H } from './LevelParser'

export const TILE_EMPTY = 0x25

export type TileGrid = number[][]

export function createGrid(screens: number): TileGrid {
  const cols = screens * SCREEN_W
  return Array.from({ length: SCREEN_H }, () => new Array(cols).fill(TILE_EMPTY))
}

/**
 * Tile cursor that replicates the game's Map16LowPtr/LevelLoadPos system.
 *
 * In the game:
 *   - LevelLoadPos ($57) = (row << 4) | col  (position within current screen)
 *   - Map16LowPtr ($6B) points to base of current screen in WRAM
 *   - screen advances when col wraps past 15 (via $1B0 offset)
 *
 * In our model:
 *   - row/col track the absolute grid position
 *   - screen tracks which screen we're on
 *   - savedCol remembers the column start for row reset
 */
export class TileCursor {
  grid: TileGrid
  row: number = 0
  col: number = 0
  screen: number = 0
  page: number = 0        // Map16 high byte (0 or 1)
  private savedCol: number = 0
  private savedScreen: number = 0

  constructor(grid: TileGrid) {
    this.grid = grid
  }

  /** Set position from parsed object data. */
  setPosition(screen: number, row: number, col: number): void {
    this.screen = screen
    this.row = row
    this.col = screen * SCREEN_W + col
    this.savedCol = this.col
    this.savedScreen = screen
  }

  /** Write a tile at the current position. Does NOT advance. */
  writeTile(tileId: number): void {
    const finalTile = tileId + (this.page * 0x100)
    if (this.row >= 0 && this.row < SCREEN_H &&
        this.col >= 0 && this.col < this.grid[0].length) {
      this.grid[this.row][this.col] = finalTile
    }
  }

  /**
   * Write tile + advance column.
   * Replicates CODE_0DA95B: STA [Map16LowPtr],Y + CODE_0DA95D.
   * When column wraps past screen boundary (col % 16 == 0),
   * advances to next screen.
   */
  writeTileAdvanceCol(tileId: number): void {
    this.writeTile(tileId)
    this.advanceCol()
  }

  /**
   * Advance column by 1.
   * Replicates CODE_0DA95D: INY; check screen boundary.
   */
  advanceCol(): void {
    this.col++
    // Check screen boundary (every 16 columns)
    if (this.col % SCREEN_W === 0) {
      // Wrapped to next screen — in the game this advances Map16LowPtr by $1B0
      // and resets Y to the row start
      this.screen++
      // Column stays at the new screen start
    }
  }

  /**
   * Advance to next row, reset column to saved position.
   * Replicates CODE_0DA97D: LevelLoadPos += $10.
   */
  advanceRow(): void {
    this.row++
    this.col = this.savedCol
    this.screen = this.savedScreen
  }

  /**
   * Save current column position.
   * Replicates CODE_0DA6B1.
   */
  saveCol(): void {
    this.savedCol = this.col
    this.savedScreen = this.screen
  }

  /**
   * Restore saved column position.
   * Replicates CODE_0DA6BA.
   */
  restoreCol(): void {
    this.col = this.savedCol
    this.screen = this.savedScreen
  }

  /** Set Map16 high byte to 0 (page 0 tiles). Replicates StzTo6ePointer. */
  setPage0(): void { this.page = 0 }

  /** Set Map16 high byte to 1 (page 1 tiles). Replicates Sta1To6ePointer. */
  setPage1(): void { this.page = 1 }
}
