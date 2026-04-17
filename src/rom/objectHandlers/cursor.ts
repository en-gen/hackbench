/**
 * cursor.ts -- LevelLoadPos / Map16LowPtr cursor model for faithful object-handler ports.
 *
 * Mirrors the in-game state used by every object handler in bank_0D.asm:
 *   - LevelLoadPos ($7E:0057, rammap.asm line 454) holds Y-register position within the
 *     current screen. Low nibble = column (0-15), high nibble = row (0-15). Rows 16-26
 *     extend via bank-carry (TYA wraps past 256).
 *   - Map16LowPtr ($7E:0065, rammap.asm line 553) is a 3-byte pointer into Map16TilesLow
 *     which backs the Layer-1 tile grid. Each screen occupies $1B0 bytes (432 = 16×27).
 *   - Map16HighPtr ($7E:0068) backs a parallel byte array that acts as the *page
 *     selector* for each tile slot: 0 = page 0 (tiles $000-$0FF), 1 = page 1
 *     (tiles $100-$1FF). Handlers set it via Sta1To6ePointer (page 1) / StzTo6ePointer
 *     (page 0) immediately before each low-byte write.
 *
 * We flatten pointer arithmetic to (col, row) grid coordinates and fold the page
 * selector into the tile ID: stored grid value = (page << 8) | low. That way a
 * single integer in grid[row][col] carries the same meaning as the two parallel
 * byte arrays the game maintains.
 *
 * Routines ported here:
 *   CODE_0DA95B  (line 1996)  STA [Map16LowPtr],Y + fall-through to CODE_0DA95D
 *   CODE_0DA95D  (line 1998)  INY + screen-boundary handling
 *   CODE_0DA97D  (line 2018)  row advance (LevelLoadPos += $10)
 *   CODE_0DA987  (line 2025)  bank-carry helper (no-op in flat grid model)
 *   CODE_0DA6B1  (line 1635)  save Map16LowPtr (bookmark for per-row restart)
 *   CODE_0DA6BA  (line 1642)  restore Map16LowPtr + reset LevelLoadObjectTile
 *   Sta1To6ePointer (line 2107) setPage(1) — next write is on page 1
 *   StzTo6ePointer  (line 2112) setPage(0) — next write is on page 0
 */

import { RomFile } from '../RomFile'
import { SCREEN_H } from '../LevelParser'

/** A 2D tile grid; grid[row][col] = 9-bit Map16 tile ID (page << 8 | low). */
export type TileGrid = number[][]

/** Mirrors the game's object-handler execution state. */
export interface Cursor {
  grid: TileGrid
  rom: RomFile
  /** Object tileset (0-14) — for tileset-specific dispatch. */
  tileset: number
  /** Current absolute column across all screens. */
  col: number
  /** Current row within the level. */
  row: number
  /** Bookmarked column for per-row restart (CODE_0DA6B1/BA). */
  bookmarkCol: number
  /** Bookmarked row (tracked for symmetry; some handlers need it). */
  bookmarkRow: number
  /** Object number ($5A = LvlLoadObjNo). */
  objNo: number
  /** Object size/settings byte ($59 = LvlLoadObjSize). */
  size: number
  /**
   * Current Map16 page (0 or 1). Handlers set it via setPage1/setPage0 before
   * each low-byte write; writeTile combines it with the low byte: stored tile
   * ID = (page << 8) | lowByte. This reflects Sta1To6ePointer / StzTo6ePointer
   * semantics — those routines are *page selectors*, not layer/collision flags.
   */
  page: number
}

export function makeCursor(
  grid: TileGrid, rom: RomFile, tileset: number,
  col: number, row: number, objNo: number, size: number,
): Cursor {
  return {
    grid, rom, tileset,
    col, row,
    bookmarkCol: col, bookmarkRow: row,
    objNo, size,
    page: 0,
  }
}

/**
 * Write a tile ID at the current cursor and advance one column.
 * Ports CODE_0DA95B (STA [Map16LowPtr],Y) + CODE_0DA95D (INY + screen handling).
 */
export function writeTileAdvance(cur: Cursor, lowByte: number): void {
  writeTile(cur, lowByte)
  advanceCol(cur)
}

/**
 * Write the low byte at the cursor, combined with the current page.
 * Mirrors raw STA [Map16LowPtr],Y — the page byte was set by a prior call to
 * Sta1To6ePointer / StzTo6ePointer (setPage1 / setPage0 here).
 */
export function writeTile(cur: Cursor, lowByte: number): void {
  if (cur.row >= 0 && cur.row < SCREEN_H && cur.col >= 0 && cur.col < cur.grid[0].length) {
    cur.grid[cur.row][cur.col] = ((cur.page & 0x01) << 8) | (lowByte & 0xFF)
  }
}

/** Sta1To6ePointer (bank_0D line 2107) -- next tile is on page 1 ($100-$1FF). */
export function setPage1(cur: Cursor): void {
  cur.page = 1
}

/** StzTo6ePointer (bank_0D line 2112) -- next tile is on page 0 ($000-$0FF). */
export function setPage0(cur: Cursor): void {
  cur.page = 0
}

/** INY + screen-boundary handling (CODE_0DA95D). */
export function advanceCol(cur: Cursor): void {
  cur.col += 1
}

/**
 * Advance cursor to next row, resetting column to the bookmark.
 * Mirrors the pattern: JSR CODE_0DA6BA (restore saved ptr) + JSR CODE_0DA97D (row++).
 */
export function nextRow(cur: Cursor): void {
  cur.row += 1
  cur.col = cur.bookmarkCol
}

/** Advance row without resetting col (raw CODE_0DA97D). */
export function advanceRowRaw(cur: Cursor): void {
  cur.row += 1
}

/**
 * CODE_0DA992 (bank_0D line 2033) -- diagonal step NW↘SE: `LevelLoadPos += $0F`.
 *
 * In the flat-grid model that's col-- + row++. SMW uses this for diagonal pipes
 * sloping up-right (tip at upper-right, pipe extends down-left to the ground)
 * and for NW-SE-facing slopes.
 */
export function diagonalDownLeft(cur: Cursor): void {
  cur.col -= 1
  cur.row += 1
}

/**
 * CODE_0DA9B4 (bank_0D line 2055) -- diagonal step NE↙SW: `LevelLoadPos += $11`.
 *
 * In flat coords: col++ + row++. Used for diagonal pipes sloping up-left
 * (tip at upper-left, pipe extends down-right) and NE-SW slopes.
 */
export function diagonalDownRight(cur: Cursor): void {
  cur.col += 1
  cur.row += 1
}

/**
 * Step by an arbitrary (dcol, drow) diagonal. Wider pipes step by e.g. (-2, +1)
 * or (-4, +1) to form wider diagonals; variant 2 uses col-=4 row+=1 via ADC #$0C.
 */
export function stepDiag(cur: Cursor, dcol: number, drow: number): void {
  cur.col += dcol
  cur.row += drow
}

/** Save current column as bookmark (CODE_0DA6B1). */
export function saveBookmark(cur: Cursor): void {
  cur.bookmarkCol = cur.col
  cur.bookmarkRow = cur.row
}

/** Restore column from bookmark (CODE_0DA6BA). */
export function restoreBookmark(cur: Cursor): void {
  cur.col = cur.bookmarkCol
}
