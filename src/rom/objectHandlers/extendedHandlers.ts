/**
 * extendedHandlers.ts -- Ports of SMW bank_0D.asm extended-object handlers.
 *
 * Extended objects appear in the level stream when the 6-bit object number is
 * zero; the settings byte then selects one of 128 extended types via the
 * CODE_0DA106 dispatch table (bank_0D.asm line 1056).
 */

import { RomFile } from '../RomFile'
import { Cursor, writeTile, setPage0, setPage1 } from './cursor'
import {
  ADDR_DATA_0DA548, DATA_0DA548_LEN,
  ADDR_DATA_0DA652, ADDR_DATA_0DA654,
  ADDR_DATA_0DA671,
  ADDR_DATA_0DA6CD, ADDR_DATA_0DA6CF,
  readByteTable,
} from './romData'

function readByte(rom: RomFile, snesAddr: number): number {
  const b = rom.readByte(snesAddr)
  return b ?? 0
}

/**
 * CODE_0DA512 (bank_0D.asm line 1416) -- screen exit marker (ext type 0x00).
 * Records level/entrance routing; emits no visible tiles. No-op for the editor.
 */
export function handle_0DA512(_cur: Cursor): void {
  // No tiles.
}

/**
 * CODE_0DA53D (bank_0D.asm line 1441) -- screen-number set (ext type 0x01).
 * Updates LevelLoadObject/LevelLoadObjectTile; emits no tiles.
 */
export function handle_0DA53D(_cur: Cursor): void {
  // No tiles.
}

/**
 * CODE_0DA57B (bank_0D.asm line 1458) -- single-tile extended object.
 *
 * The ASM does `TXA; SEC; SBC #$10` to index `DATA_0DA548` with `(objSize - 0x10)`.
 * For editor purposes we always emit the tile, skipping the item-memory check at
 * CODE_0DA57F that hides collected bonus tiles (conditional for ext types 0x18-0x1D).
 */
export function handle_0DA57B(cur: Cursor): void {
  const extType = cur.objNo   // extended dispatch uses LvlLoadObjSize as selector,
                              // which parseLevelObjects places in cur.objNo for extended.
  const idx = extType - 0x10
  if (idx < 0 || idx >= DATA_0DA548_LEN) return
  const table = readByteTable(cur.rom, ADDR_DATA_0DA548, DATA_0DA548_LEN)
  // ASM CODE_0DA5B1: StzTo6ePointer, then if _0 >= $13 also Sta1To6ePointer.
  // _0 = extType - $10 = idx. So idx 0-0x12 write page 0, idx 0x13+ write page 1.
  if (idx >= 0x13) setPage1(cur); else setPage0(cur)
  writeTile(cur, table[idx] ?? 0)
}

/**
 * CODE_0DA64D (bank_0D.asm line 1574) -- ext type 0x17 bonus tile.
 *
 * The ASM loads `#$32`, jumps into CODE_0DA57F which reads DATA_0DA548[$32]
 * (the final entry, $2D) and stamps it. We reproduce the effective single-tile
 * write; the item-memory branches in CODE_0DA57F are skipped because X=$17
 * falls outside the CPX #$18..#$1D window the branches test.
 */
export function handle_0DA64D(cur: Cursor): void {
  const table = readByteTable(cur.rom, ADDR_DATA_0DA548, DATA_0DA548_LEN)
  // Same CODE_0DA5B1 page logic: _0 = $32, which is >= $13, so page 1.
  setPage1(cur)
  writeTile(cur, table[0x32] ?? 0)
}

/**
 * ADDR_0DA656 (bank_0D.asm line 1585) -- ext types 0x42 and 0x43: 2-tile
 * horizontal pair. X = extType - 0x42, picks from DATA_0DA652 (left) and
 * DATA_0DA654 (right).
 */
export function handle_0DA656(cur: Cursor): void {
  const X = cur.objNo - 0x42
  if (X < 0 || X > 1) return
  const left  = readByte(cur.rom, ADDR_DATA_0DA652 + X)
  const right = readByte(cur.rom, ADDR_DATA_0DA654 + X)
  setPage1(cur)   // Sta1To6ePointer before both writes
  writeTile(cur, left)
  const col0 = cur.col
  cur.col = col0 + 1
  writeTile(cur, right)
  cur.col = col0
}

/**
 * CODE_0DA673 (bank_0D.asm line 1603) -- ext types 0x44 and 0x45: 2-tile
 * vertical pair. Top from DATA_0DA671[X], bottom is $EB. X = extType - 0x44.
 */
export function handle_0DA673(cur: Cursor): void {
  const X = cur.objNo - 0x44
  if (X < 0 || X > 1) return
  const top = readByte(cur.rom, ADDR_DATA_0DA671 + X)
  // ASM writes first tile directly (inheriting the caller's Map16HighPtr byte),
  // then issues Sta1To6ePointer before the second write. In the flat-cursor
  // model, default to page 0 for the first write to match the common case.
  setPage0(cur)
  writeTile(cur, top)
  cur.row += 1
  setPage1(cur)
  writeTile(cur, 0xEB)
  cur.row -= 1
}

/**
 * CODE_0DA68E (bank_0D.asm line 1618) -- ext type 0x46: midway point.
 *
 * In-game this consults OWLevelTileSettings and MidwayFlag to decide whether
 * to emit the tape ($35) and base ($38). For an editor we always show the
 * midway post.
 */
export function handle_0DA68E(cur: Cursor): void {
  // ASM uses StzTo6ePointer before both writes -- page 0.
  const origCol = cur.col
  setPage0(cur)
  cur.col = origCol - 1
  writeTile(cur, 0x35)
  cur.col = origCol
  writeTile(cur, 0x38)
}

/**
 * CODE_0DA6D1 (bank_0D.asm line 1660) -- ext types 0x47 and 0x48: 2-tile
 * vertical pair. X = extType - 0x47; top = DATA_0DA6CD[X]; bottom = DATA_0DA6CF[X].
 */
/**
 * CODE_0DB2CA (bank_0D.asm line 3322) -- dragon coin (extended type 0x30).
 *
 * In the live game, the handler consults AllDragonCoinsCollected and the item-
 * memory table to decide whether to emit the coin. For editor rendering we
 * always show both tiles: $2D (top) and $2E (bottom).
 */
export function handle_0DB2CA(cur: Cursor): void {
  setPage0(cur)   // StzTo6ePointer both writes
  writeTile(cur, 0x2D)
  cur.row += 1
  writeTile(cur, 0x2E)
  cur.row -= 1
}

export function handle_0DA6D1(cur: Cursor): void {
  // ASM computes X = extType - $47 without bounds-checking. For ext types
  // beyond $48 (when the dispatch table redirects ext 0x49-0xFF back here)
  // the reads land past DATA_0DA6CD / DATA_0DA6CF and hit whatever ROM bytes
  // follow -- typically code, which SMW interprets as arbitrary Map16 IDs.
  // We mirror that behavior: read raw from ROM, no clamping.
  const X = cur.objNo - 0x47
  const top = readByte(cur.rom, ADDR_DATA_0DA6CD + X)
  const bot = readByte(cur.rom, ADDR_DATA_0DA6CF + X)
  setPage0(cur)   // StzTo6ePointer both writes
  writeTile(cur, top)
  cur.row += 1
  writeTile(cur, bot)
  cur.row -= 1
}
