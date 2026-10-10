/**
 * cursor.ts -- LevelLoadPos / Map16LowPtr cursor model for faithful object-handler ports.
 *
 * Mirrors the in-game state used by every object handler in bank_0D.asm:
 *   - LevelLoadPos ($7E:0057, rammap.asm line 454) holds Y-register position within the
 *     current screen. Low nibble = column (0-15), high nibble = row (0-15). Rows 16-26
 *     extend via bank-carry (TYA wraps past 256).
 *   - Map16LowPtr ($7E:006B, SMW_E0.sym; rammap.asm line 553) is a 3-byte pointer into Map16TilesLow
 *     which backs the Layer-1 tile grid. Each screen occupies $1B0 bytes (432 = 16×27).
 *   - Map16HighPtr ($7E:006E) backs a parallel byte array that acts as the *page
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
 *   Sta1To6ePointer (line 2107) setPage(1) - next write is on page 1
 *   StzTo6ePointer  (line 2112) setPage(0) - next write is on page 0
 */

import type { InterpretedDraw } from './interpretedDraw'
import { RomFile } from '../RomFile'

/** Map16 RAM bytes per horizontal-level screen: 27 rows x 16 cols. */
export const MAP16_BYTES_PER_SCREEN_H = 0x1b0

/** A 2D tile grid; grid[row][col] = 9-bit Map16 tile ID (page << 8 | low). */
export type TileGrid = number[][]

/**
 * Which object drew each cell, parallel to TileGrid.
 *
 * The editor needs this to turn a click into a selection. A tile ID cannot
 * answer that on its own, because the same ID is written by dozens of objects.
 *
 * Ownership is LAST WRITER WINS, which is the rule the tile itself already
 * follows: whatever a handler writes last is what renders, so the recorded
 * owner always names the object that drew what is on screen.
 *
 * Cells the object stream never touched keep OWNER_NONE. Boss-arena pre-fills
 * and the Layer 3 overflow region come from game-mode init routines rather
 * than object handlers, so they stay unowned and are not selectable.
 */
export type OwnerGrid = number[][]

/** No object drew this cell. */
export const OWNER_NONE = -1

/**
 * Which of the four switch palaces have been pressed (cleared), in the ROM's
 * own SwitchBlockFlags index order: green=0, yellow=1, blue=2, red=3
 * ($7E1F27-$7E1F2A; bank_0D.asm:3739 reads `SwitchBlockFlags,X` for
 * green/yellow, :4229 reads `SwitchBlockFlags+2,X` for blue/red). A pressed
 * flag selects the Map16 page-1 (cleared) tile; unpressed selects page 0.
 */
export interface SwitchFlags {
  green: boolean
  yellow: boolean
  blue: boolean
  red: boolean
}

/** The palaces in SwitchBlockFlags order ($1F27-$1F2A): one list for the interpreter and the collision probe. */
export const SWITCH_BLOCK_ORDER = ['green', 'yellow', 'blue', 'red'] as const

/**
 * Default switch state: all four uncleared, matching a fresh save and the
 * `layers_v5` Mesen captures (#567).
 */
export const SWITCH_FLAGS_UNCLEARED: SwitchFlags = Object.freeze({
  green: false,
  yellow: false,
  blue: false,
  red: false,
})

/** All four palaces pressed - the pre-#567 behavior, pinned where callers need it unchanged. */
export const SWITCH_FLAGS_CLEARED: SwitchFlags = Object.freeze({
  green: true,
  yellow: true,
  blue: true,
  red: true,
})

/** Mirrors the game's object-handler execution state. */
export interface Cursor {
  grid: TileGrid
  rom: RomFile
  /** Object tileset (0-14) - for tileset-specific dispatch. */
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
   * semantics - those routines are *page selectors*, not layer/collision flags.
   */
  page: number
  /**
   * SNES address of the handler being invoked. Resolved by the dispatcher from
   * ROM pointer tables (tileset → per-tileset dispatcher → handler pointer).
   *
   * Handlers use this to read their own data-table addresses and immediate
   * operands from the ROM bytecode rather than hardcoded vanilla-ROM
   * addresses -- so Lunar Magic patches that relocate tables (by patching
   * LDA.L operands inside the handler body) still resolve correctly.
   */
  handlerAddr: number
  /**
   * Parallel grid recording which object drew each cell, or null when the
   * caller does not want ownership tracked. Every write goes through
   * writeTile, so that one function is the entire mechanism.
   */
  owners: OwnerGrid | null
  /** Index into the level's object stream of the object being expanded. */
  owner: number
  /** Switch-palace state the switch-block handlers gate on (#567). */
  switchFlags: SwitchFlags
  /** Set by a caller that takes the interpreter's word for gated handlers (#342). */
  draw?: InterpretedDraw | null
  /**
   * True when the grid is a vertical level's (32 wide, 16 rows per screen).
   * Only handlers that address raw Map16 buffer offsets need it (ext $5F, #362).
   */
  vertical: boolean
  /**
   * Game-state RAM a gated handler reads, by WRAM address; unset reads are 0.
   * Same key space and default as InterpretEnv.ram, so the port and the #351
   * interpreter see one editor state (fresh save: no midway taken, no tile
   * cleared). Production callers leave it unset (#635).
   */
  ram?: ReadonlyMap<number, number>
}

export function makeCursor(
  grid: TileGrid,
  rom: RomFile,
  tileset: number,
  col: number,
  row: number,
  objNo: number,
  size: number,
  owners: OwnerGrid | null = null,
  owner: number = OWNER_NONE,
  switchFlags: SwitchFlags = SWITCH_FLAGS_UNCLEARED,
  vertical = false,
): Cursor {
  return {
    grid,
    rom,
    tileset,
    col,
    row,
    bookmarkCol: col,
    bookmarkRow: row,
    objNo,
    size,
    page: 0,
    handlerAddr: 0, // filled in by dispatcher right before calling handler
    owners,
    owner,
    switchFlags,
    vertical,
  }
}

/**
 * Read a 24-bit long address operand from the ROM at the given SNES address.
 * Used to resolve data-table addresses from LDA.L instruction operands.
 * The 3-byte operand is stored little-endian (lo, mid, hi).
 */
export function readLongOperand(cur: Cursor, snesAddr: number): number {
  const lo = cur.rom.readByte(snesAddr) ?? 0
  const mi = cur.rom.readByte(snesAddr + 1) ?? 0
  const hi = cur.rom.readByte(snesAddr + 2) ?? 0
  return (hi << 16) | (mi << 8) | lo
}

/**
 * Read a single-byte immediate operand at the given SNES address. Used to
 * resolve LDA #$XX / CMP #$XX operand values from the handler bytecode.
 */
export function readImmByte(cur: Cursor, snesAddr: number): number {
  return cur.rom.readByte(snesAddr) ?? 0
}

/**
 * Read an `LDA.L addr,X` operand at `cur.handlerAddr + offset`, gated on the
 * `$BF` opcode still sitting one byte earlier. Returns null instead of a
 * table address when a hack has relocated or replaced the instruction there,
 * so a caller with two candidate tables (e.g. the switch-palace blocks) can
 * decline rather than silently decode a wrong operand (CLAUDE.md: gate on
 * the opcode before trusting what it points to).
 */
export function readGatedLongOperand(cur: Cursor, offset: number): number | null {
  const opcodeAddr = cur.handlerAddr + offset - 1
  if (cur.rom.readByte(opcodeAddr) !== 0xbf) return null
  return readLongOperand(cur, opcodeAddr + 1)
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
 * Mirrors raw STA [Map16LowPtr],Y - the page byte was set by a prior call to
 * Sta1To6ePointer / StzTo6ePointer (setPage1 / setPage0 here).
 *
 * Writes past the current row length auto-grow the row (padded with TILE_EMPTY)
 * up to a 512-col cap - matches the SNES behaviour where the Map16 RAM buffer
 * has far more headroom than the level's declared screen count. Narrow castle
 * rooms (e.g. level $0FD) stamp right-wall fill tiles one column past the
 * declared levelLength; the engine happily writes there and Mesen captures it.
 */
export function writeTile(cur: Cursor, lowByte: number): void {
  if (cur.row < 0 || cur.row >= cur.grid.length) return
  if (cur.col < 0 || cur.col >= 0x200) return
  const tile = ((cur.page & 0x01) << 8) | (lowByte & 0xff)
  const row = cur.grid[cur.row]
  // Pad with TILE_EMPTY ($25) up to the target column so downstream readers
  // that iterate by row length see a contiguous tile stream.
  while (row.length < cur.col) row.push(0x25)
  row[cur.col] = tile
  claimCell(cur)
}

/**
 * Record the current object as the owner of the cell just written.
 *
 * Grows the owner row in step with the tile row so the two stay the same
 * shape; a shorter owner row would read as OWNER_NONE for a cell that an
 * object really did draw, and the click on it would select nothing.
 */
function claimCell(cur: Cursor): void {
  const owners = cur.owners
  if (!owners) return
  const orow = owners[cur.row]
  if (!orow) return
  while (orow.length < cur.col) orow.push(OWNER_NONE)
  orow[cur.col] = cur.owner
}

/**
 * The high-byte half of a skipped tile store: the ROM zeroes the cell's page
 * even when a $25 table entry skips the low byte, so a blank cell reads $25
 * (SMWDisX bank_0D.asm:2112-2114 StzTo6ePointer; skips at 1736-1740 and
 * 4804-4808; see SMWDisX bank_0D/MEMO.md, "Hillside tables and
 * StzTo6ePointer"). No owner is claimed: no tile is drawn, unlike
 * `applyWrites` in interpret.ts, which claims every buffer write.
 */
export function clearPageKeepLow(cur: Cursor): void {
  if (cur.row < 0 || cur.row >= cur.grid.length) return
  if (cur.col < 0 || cur.col >= 0x200) return
  const low = peekExistingLow(cur)
  const row = cur.grid[cur.row]
  while (row.length < cur.col) row.push(0x25)
  row[cur.col] = low
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
 * Flat-grid equivalent: col-- + row++. Used both for pipes sloping up-right
 * (variant 1/2 of CODE_0DAB3E) and for NW-SE-facing slopes.
 */
export function diagonalDownLeft(cur: Cursor): void {
  cur.col -= 1
  cur.row += 1
}

/**
 * CODE_0DA9B4 (bank_0D line 2055) -- diagonal step NE↙SW: `LevelLoadPos += $11`.
 * Flat-grid equivalent: col++ + row++. Used for diagonal pipes sloping up-left
 * (variants 6-8 of CODE_0DAB3E) and NE-SW-facing slopes.
 */
export function diagonalDownRight(cur: Cursor): void {
  cur.col += 1
  cur.row += 1
}

/**
 * Step by an arbitrary (dcol, drow) diagonal. Wider pipes step by e.g. (-2, +1)
 * or (-4, +1) to form wider diagonals; CODE_0DAC92 (pipe variant 2) uses
 * col-=4 row+=1 via ADC #$0C.
 */
export function stepDiag(cur: Cursor, dcol: number, drow: number): void {
  cur.col += dcol
  cur.row += drow
}

/**
 * Read the low byte of whatever tile is currently at the cursor. Used by the
 * context-merge helpers below (and by ground-ledge handlers that pick their
 * left/right cap tile based on what was already drawn at the cursor).
 * Returns the empty-tile sentinel ($25) if the cursor is outside the grid.
 */
export function peekExistingLow(cur: Cursor): number {
  const row = cur.grid[cur.row]
  if (!row) return 0x25
  const v = row[cur.col]
  if (v === undefined) return 0x25
  return v & 0xff
}

/**
 * CODE_0DB84E (bank_0D line 4095) -- slope-lip context-merge write.
 *
 * Exactly the ASM's branch structure:
 *   - existing $25 (empty): BEQ takes us past both INCs → return base unchanged
 *   - existing $3F (ground fill): CMP matches, BEQ jumps past the first INC
 *     but falls into the second → base + 1
 *   - anything else: both INCs execute → base + 2
 *
 * So $Ax is the "over empty" variant, $Ax+1 is the "over ground" blend, and
 * $Ax+2 is the "over other terrain" (e.g. over another slope) variant.
 * Writes + advances column.
 */
export function writeTileSlopeMerge(cur: Cursor, baseTile: number): void {
  writeTile(cur, slopeMergeTile(cur, baseTile))
  advanceCol(cur)
}

/** Non-advancing variant of writeTileSlopeMerge (CODE_0DB84E). */
export function writeTileSlopeMergeNoAdvance(cur: Cursor, baseTile: number): void {
  writeTile(cur, slopeMergeTile(cur, baseTile))
}

function slopeMergeTile(cur: Cursor, baseTile: number): number {
  const existing = peekExistingLow(cur)
  if (existing === 0x25) return baseTile
  if (existing === 0x3f) return (baseTile + 1) & 0xff
  return (baseTile + 2) & 0xff
}

/**
 * CODE_0DB114 (bank_0D line 3084) -- slope-column context-merge, variant A.
 *
 * Skip rules (return base tile unchanged):
 *   - X in [9, 10]: skip
 *   - X == 2:       skip
 * Otherwise:
 *   - Scan DATA_0DB0F0 (18 entries) backwards for a match with the existing
 *     tile. If match at index k, return DATA_0DB102[k] with page forced to 1.
 *   - Else if existing is $25 (empty): return base unchanged.
 *   - Else if base is one of $01/$03/$45/$48: return base + 1.
 *   - Else: return base unchanged.
 *
 * Called by CODE_0DB075 (object 19 slope column) to blend row-0 tiles with
 * whatever terrain was drawn underneath by an earlier object.
 */
export function writeTileMergeCODE_0DB114(
  cur: Cursor,
  helperAddr: number,
  X: number,
  baseTile: number,
): void {
  if ((X >= 9 && X < 0x0b) || X === 2) {
    writeTile(cur, baseTile)
    return
  }
  // Inside CODE_0DB114:
  //   +25  CMP.L DATA_0DB0F0,X  operand (3 bytes = table A address)
  //   +66  LDA.L DATA_0DB102,X  operand (3 bytes = table B address)
  //   +34  CMP #$25   (skip-tile trigger)
  //   +40/+44/+48/+52  CMP #$01/$03/$45/$48  (bump-by-1 triggers)
  const addrDB0F0 = readLongOperand(cur, helperAddr + 25)
  const addrDB102 = readLongOperand(cur, helperAddr + 66)
  const skipTile = readImmByte(cur, helperAddr + 34)
  const bump1 = readImmByte(cur, helperAddr + 40)
  const bump2 = readImmByte(cur, helperAddr + 44)
  const bump3 = readImmByte(cur, helperAddr + 48)
  const bump4 = readImmByte(cur, helperAddr + 52)

  const existing = peekExistingLow(cur)
  for (let k = 17; k >= 0; k--) {
    const entry = cur.rom.readByte(addrDB0F0 + k) ?? 0
    if (entry === existing) {
      setPage1(cur)
      writeTile(cur, cur.rom.readByte(addrDB102 + k) ?? baseTile)
      return
    }
  }
  if (existing === skipTile) {
    writeTile(cur, baseTile)
    return
  }
  if (baseTile === bump1 || baseTile === bump2 || baseTile === bump3 || baseTile === bump4) {
    writeTile(cur, (baseTile + 1) & 0xff)
  } else {
    writeTile(cur, baseTile)
  }
}

/**
 * CODE_0DB198 (bank_0D line 3141) -- slope-column context-merge, variant B.
 *
 * Skip rules:
 *   - X in [3, 6]:  skip
 *   - X >= 9:       skip
 *   - X == 2:       skip
 * Otherwise:
 *   - Scan DATA_0DB15C (30 entries) backwards. If match at k, return
 *     DATA_0DB17A[k] with page forced to 1.
 *   - Else: return base unchanged (no +1 path here unlike CODE_0DB114).
 *
 * Called by CODE_0DB075 for row-1 and middle tiles.
 */
export function writeTileMergeCODE_0DB198(
  cur: Cursor,
  helperAddr: number,
  X: number,
  baseTile: number,
): void {
  if ((X >= 3 && X < 7) || X >= 9 || X === 2) {
    writeTile(cur, baseTile)
    return
  }
  // Inside CODE_0DB198:
  //   +25  CMP.L DATA_0DB15C,X  operand (3 bytes = trigger table address)
  //   +42  LDA.L DATA_0DB17A,X  operand (3 bytes = substitution table address)
  const addrDB15C = readLongOperand(cur, helperAddr + 25)
  const addrDB17A = readLongOperand(cur, helperAddr + 42)

  const existing = peekExistingLow(cur)
  for (let k = 29; k >= 0; k--) {
    const entry = cur.rom.readByte(addrDB15C + k) ?? 0
    if (entry === existing) {
      setPage1(cur)
      writeTile(cur, cur.rom.readByte(addrDB17A + k) ?? baseTile)
      return
    }
  }
  writeTile(cur, baseTile)
}

/**
 * CODE_0DABFD (bank_0D line 2388) -- pipe-lip context-merge write.
 *
 * Reads the existing tile; if it matches any entry in DATA_0DABF7 ($3F, $01,
 * $03) then adds the parallel DATA_0DABFA offset ($01, $03, $04 respectively)
 * to the new tile. Otherwise writes the base tile unchanged. Writes + advances.
 *
 * This handles pipe-lip-into-ground and pipe-lip-onto-other-pipe blending.
 */
export function writeTilePipeMerge(cur: Cursor, baseTile: number): void {
  writeTile(cur, pipeMergeTile(cur, baseTile))
  advanceCol(cur)
}

/** Same merge logic as writeTilePipeMerge but without advancing the cursor.
 *  Used by variants that manage column positioning manually. */
export function writeTilePipeMergeNoAdvance(cur: Cursor, baseTile: number): void {
  writeTile(cur, pipeMergeTile(cur, baseTile))
}

/** Computes the CODE_0DABFD merged tile ID from (existing tile, base tile). */
function pipeMergeTile(cur: Cursor, baseTile: number): number {
  const existing = peekExistingLow(cur)
  const matches = [0x3f, 0x01, 0x03] // DATA_0DABF7
  const deltas = [0x01, 0x03, 0x04] // DATA_0DABFA
  for (let x = 0; x < 3; x++) {
    if (existing === matches[x]) return (baseTile + deltas[x]) & 0xff
  }
  return baseTile
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
