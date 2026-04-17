/**
 * standardHandlers.ts -- Ports of SMW bank_0D.asm standard-object handlers.
 *
 * Each exported handler mirrors one ASM routine. ROM addresses in the identifier
 * (e.g. `handle_0DA8C3`) correspond to the disassembly label (`CODE_0DA8C3`).
 *
 * Handler contract:
 *   - Input: Cursor already positioned at the object's (col, row) with objNo/size set.
 *   - Side effect: tiles written into cursor.grid.
 *   - No return value. Cursor state after return is not relied upon by the caller.
 *
 * Faithful port notes:
 *   - The ASM uses `[Map16LowPtr],Y` writes with pointer-juggling across screen
 *     boundaries. Our Cursor flattens this to (col, row) grid coordinates; see
 *     cursor.ts for the mapping.
 *   - Layer-2 pointer writes (Sta1To6ePointer / StzTo6ePointer) are no-ops here
 *     because the editor does not render the Layer-2 solidity map.
 *   - Item-memory conditional tiles (used by object 5 and some extended objects)
 *     always render as "not collected" — we are an editor, not a live game session.
 */

import {
  Cursor, writeTileAdvance, writeTile, nextRow,
  saveBookmark, restoreBookmark, advanceCol,
  setPage0, setPage1,
  diagonalDownLeft, diagonalDownRight, stepDiag,
  writeTileSlopeMerge, writeTilePipeMerge,
  writeTileMergeCODE_0DB114, writeTileMergeCODE_0DB198,
} from './cursor'
import { RomFile } from '../RomFile'
import {
  ADDR_DATA_0DA8B4, DATA_0DA8B4_LEN,
  ADDR_DATA_0DAA12, ADDR_DATA_0DAA17, ADDR_DATA_0DAA1C, ADDR_DATA_0DAA21,
  ADDR_DATA_0DAAA4, ADDR_DATA_0DAAAC,
  ADDR_DATA_0DB3BB, ADDR_DATA_0DB3DB, ADDR_DATA_0DB3DF,
  ADDR_DATA_0DB42B,
  ADDR_DATA_0DB569, ADDR_DATA_0DB5A8, ADDR_DATA_0DB5AD, ADDR_DATA_0DB5B2,
  ADDR_DATA_0DB039, ADDR_DATA_0DB048, ADDR_DATA_0DB057, ADDR_DATA_0DB066,
  ADDR_DATA_0DB0F0, DATA_0DB0F0_LEN, ADDR_DATA_0DB102,
  ADDR_DATA_0DB15C, DATA_0DB15C_LEN, ADDR_DATA_0DB17A,
  ADDR_DATA_0DB212, ADDR_DATA_0DB215, ADDR_DATA_0DB218,
  ADDR_DATA_0DB21B, ADDR_DATA_0DB21E, ADDR_DATA_0DB221,
  ADDR_DATA_0DB72F,
  readByteTable,
} from './romData'

/** Read a single byte at a computed SNES address, defaulting to 0 on failure.
 *  Used by handlers that index data tables with out-of-range X values — SMW
 *  relies on the bytes that follow each table in ROM, so bounds-checking on
 *  the TS side would suppress that behavior. */
function readByte(rom: RomFile, snesAddr: number): number {
  const b = rom.readByte(snesAddr)
  return b ?? 0
}

/**
 * CODE_0DA8C3 (bank_0D.asm line 1913) -- rectangular terrain fill.
 *
 * Dispatched for standard objects 1-14 in tileset 0 (and tilesets that share
 * CODE_0DA44B). The handler writes `DATA_0DA8B4[objNo-1]` into a (width+1) ×
 * (height+1) rectangle anchored at the cursor.
 *
 *   Size byte: WWWWHHHH → width-1 (low nibble), height-1 (high nibble).
 *
 * Object 5 (X=4 in the handler) would normally consult the item-memory table
 * (CODE_0DA8D8 line 1926); we skip that and always emit the tile.
 */
export function handle_0DA8C3(cur: Cursor): void {
  const widthM1  = cur.size & 0x0F
  const heightM1 = (cur.size >> 4) & 0x0F
  const x = cur.objNo - 1
  if (x < 0 || x >= DATA_0DA8B4_LEN) return
  const tileTable = readByteTable(cur.rom, ADDR_DATA_0DA8B4, DATA_0DA8B4_LEN)
  const tileId = tileTable[x]

  // ASM (CODE_0DA92E): StzTo6ePointer, then if X>=7 also Sta1To6ePointer.
  // Net: objNo 1-7 write page 0, objNo 8-14 write page 1.
  if (x >= 7) setPage1(cur); else setPage0(cur)

  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, tileId)
    }
    restoreBookmark(cur)
    nextRow(cur)
  }
}

/**
 * CODE_0DAA26 (bank_0D.asm line 2130) -- horizontal ledge (object 15).
 *
 * Size byte: HHHHTTTT
 *   H (high nibble, stored in _0) = height-1 of the middle section (0 = only caps).
 *   T (low nibble, X)             = ledge type, selecting edge tile tables:
 *       X < 3   : DATA_0DAA12/DATA_0DAA17 (left-cap only + middle)
 *       X == 5  : hard-coded $68/$69 middle tiles
 *       else    : $35/$36 middle tiles
 *   Final row also stamps right-cap tiles from DATA_0DAA1C/0DAA21 (for X >= 2 and X != 5).
 *
 * Structure from ASM:
 *   - Write two tiles at cursor.col, cursor.col+1 (top + bottom row) for the left cap.
 *   - Loop H+1 times writing middle-section tiles at (col+0, col+1).
 *   - For X != 5 && X >= 2: write right-cap at the final position.
 */
export function handle_0DAA26(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0F
  const X = cur.size & 0x0F

  const leftTop    = readByteTable(cur.rom, ADDR_DATA_0DAA12, 5)
  const leftBottom = readByteTable(cur.rom, ADDR_DATA_0DAA17, 5)
  const rightTop   = readByteTable(cur.rom, ADDR_DATA_0DAA1C, 5)
  const rightBottom= readByteTable(cur.rom, ADDR_DATA_0DAA21, 5)

  // All writes in CODE_0DAA26 are preceded by Sta1To6ePointer -- page 1.
  setPage1(cur)
  // Top-left cap (if X < 3) -- matches branch BPL CODE_0DAA52 (X >= 3 skips this).
  saveBookmark(cur)
  if (X < 3) {
    // Top row: left cap
    writeTile(cur, leftTop[X] ?? 0)
    // Bottom row: left cap
    const col0 = cur.col
    const row0 = cur.row
    cur.row += 1
    writeTile(cur, leftBottom[X] ?? 0)
    cur.row = row0
    cur.col = col0 + 1
  }

  // Middle section: H+1 iterations (or H for X==5 loop-back path)
  let iter = 0
  while (iter <= H) {
    let topTile: number
    let botTile: number
    if (X === 5) {
      topTile = 0x68
      botTile = 0x69
    } else if (X >= 3) {
      // The ASM falls through CODE_0DAA68 which writes $35/$36; used for ledge types 3,4.
      topTile = 0x35
      botTile = 0x36
    } else {
      topTile = leftTop[X] ?? 0
      botTile = leftBottom[X] ?? 0
    }
    const col0 = cur.col
    const row0 = cur.row
    writeTile(cur, topTile)
    cur.row += 1
    writeTile(cur, botTile)
    cur.row = row0
    cur.col = col0 + 1
    iter++
  }

  // Right cap (for X != 5 && X >= 2) -- CODE_0DAA8C
  if (X !== 5 && X >= 2) {
    const col0 = cur.col
    const row0 = cur.row
    writeTile(cur, rightTop[X] ?? 0)
    cur.row += 1
    writeTile(cur, rightBottom[X] ?? 0)
    cur.row = row0
    cur.col = col0
  }

  restoreBookmark(cur)
}

/**
 * CODE_0DAAB4 (bank_0D.asm line 2200) -- used-block horizontal line (object 16).
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)            = width-1 of the run.
 *   H (high nibble, X = H>>4) = selector into tile tables; controls which row
 *                               of DATA_0DAAA4 / DATA_0DAAAC is used and whether
 *                               the bottom run of the pair is emitted.
 *
 * Pattern: alternating tile pairs from DATA_0DAAA4 (odd) and DATA_0DAAAC (even)
 * depending on position, producing the classic "used-block staircase".
 *
 * Faithful implementation keeps the ASM's X-index cycling: writes a tile, toggles
 * X's low bit, and loops for (width+1) columns; the BPL/BMI branches on X<4 vs X>=4
 * select which table and whether to continue on the second row.
 */
export function handle_0DAAB4(cur: Cursor): void {
  const W = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F
  let X = H  // ASM uses H as X directly (no shift: AND $F0; LSR LSR LSR -> high nibble)

  const tableA = readByteTable(cur.rom, ADDR_DATA_0DAAA4, 8)  // X < 4
  const tableB = readByteTable(cur.rom, ADDR_DATA_0DAAAC, 8)  // X >= 4

  setPage1(cur)   // Sta1To6ePointer throughout
  saveBookmark(cur)
  // Outer loop: ASM rotates X between low and high tables via `INX; AND #$01`
  // which toggles low bit; each iteration writes a run of width+1 tiles.
  // Faithful port: two possible passes (X<4 then X>=4) per size-nibble cycle.
  let guard = 0
  while (guard++ < 32) {
    let widthCounter = W
    while (widthCounter >= 0) {
      if (X < 4) {
        writeTileAdvance(cur, tableA[X] ?? 0)
      } else {
        writeTileAdvance(cur, tableB[X] ?? 0)
      }
      widthCounter--
    }
    restoreBookmark(cur)
    nextRow(cur)
    X++
    if ((X & 0x01) === 0) break  // AND #$01; BNE loops -> exits when low bit clears
  }
}

/**
 * CODE_0DB1D4 (bank_0D.asm line 3179) -- rectangle with distinct top row.
 *
 * Used by object 20 (standard nibble-sized rectangle).
 * Size byte: HHHHWWWW
 *   W (low nibble)  = width-1 of the fill.
 *   H (high nibble) = height-1 of the rectangle.
 *
 * Shares its main body (CODE_0DB1E3) with CODE_0DB1C8 (object 33) — both write
 * tile $00 across the first row, then tile $3F across the remaining rows.
 */
export function handle_0DB1D4(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const heightM1 = (cur.size >> 4) & 0x0F
  fillRectTopBottom(cur, widthM1, heightM1)
}

/**
 * CODE_0DB1C8 (bank_0D.asm line 3171) -- full-byte-width rectangle (object 33).
 *
 * The size byte is used as a raw *width count*: total width = (size & 0xFF) + 1.
 * The height is fixed at 3 rows (`LDA #$02; STA _2` in the ASM).
 *
 * This is how SMW stamps the wide base-ground strips in levels like
 * Yoshi's Island 1 — a single object with size $BF produces a 192-tile run.
 */
export function handle_0DB1C8(cur: Cursor): void {
  const widthM1 = cur.size & 0xFF   // full byte as width-1
  const heightM1 = 2                // fixed 3 rows (height-1 = 2)
  fillRectTopBottom(cur, widthM1, heightM1)
}

/** Shared body for CODE_0DB1D4 / CODE_0DB1C8 (the CODE_0DB1E3 loop).
 *
 *  Row 0 uses Sta1To6ePointer (page 1) -- that's $100 = the grass-capped ground
 *  tile. Rows 1+ use StzTo6ePointer (page 0) -- $03F = plain dirt. Without the
 *  page switch, the top row would render as $000 (empty) and the ground strip
 *  would appear without its characteristic green top. */
function fillRectTopBottom(cur: Cursor, widthM1: number, heightM1: number): void {
  saveBookmark(cur)
  setPage1(cur)               // Sta1To6ePointer
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, 0x00)
  }
  restoreBookmark(cur)
  setPage0(cur)               // StzTo6ePointer
  for (let r = 0; r < heightM1; r++) {
    cur.row += 1
    cur.col = cur.bookmarkCol
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, 0x3F)
    }
  }
}

/**
 * CODE_0DB3BD (bank_0D.asm line 3455) -- coin cloud / simple horizontal run (object 23).
 *
 * Size byte: HHHHWWWW — H selects tile via DATA_0DB3BB[H], W = width-1.
 * A single-row run of (width+1) tiles of DATA_0DB3BB[H].
 */
export function handle_0DB3BD(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F
  const tileId = readByte(cur.rom, ADDR_DATA_0DB3BB + H)

  setPage1(cur)   // Sta1To6ePointer
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, tileId)
  }
}

/**
 * CODE_0DB3E3 (bank_0D.asm line 3480) -- two-row fill with top/bottom variants.
 *
 * Used by many objects (24-26, 34-46). The dispatcher CODE_0DA44B leaves X =
 * objNo - 1, and the handler subtracts another $17 → X = objNo - $18.
 * Row 0 uses DATA_0DB3DB[X]; rows 1+ use DATA_0DB3DF[X].
 *
 * Note: for objNo >= 0x1C (X >= 4) the reads land outside the 4-byte tables,
 * hitting whatever ROM bytes follow. We preserve that quirk by reading raw
 * from ROM at the computed address rather than clamping.
 */
export function handle_0DB3E3(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const heightM1 = (cur.size >> 4) & 0x0F
  const X = cur.objNo - 0x18

  const topTile = readByte(cur.rom, ADDR_DATA_0DB3DB + X)
  const botTile = readByte(cur.rom, ADDR_DATA_0DB3DF + X)

  setPage0(cur)   // StzTo6ePointer
  saveBookmark(cur)
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, topTile)
  }
  for (let r = 1; r <= heightM1; r++) {
    restoreBookmark(cur)
    nextRow(cur)
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, botTile)
    }
  }
}

/**
 * CODE_0DB42D (bank_0D.asm line 3522) -- goal post (object 29).
 *
 * Size byte: low nibble only = width-1. Writes two rows: row 0 of tile $26,
 * row 1 of tile $44, each (width+1) wide. Taken from DATA_0DB42B.
 */
export function handle_0DB42D(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const row0Tile = readByte(cur.rom, ADDR_DATA_0DB42B + 0)
  const row1Tile = readByte(cur.rom, ADDR_DATA_0DB42B + 1)

  // ASM: row 0 does StzTo6ePointer only (page 0); row 1 adds Sta1To6ePointer
  // after StzTo6ePointer (net page 1).
  saveBookmark(cur)
  setPage0(cur)
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, row0Tile)
  }
  restoreBookmark(cur)
  nextRow(cur)
  setPage1(cur)
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, row1Tile)
  }
}

/**
 * CODE_0DB461 (bank_0D.asm line 3548) -- diagonal rope/vine pattern (object 30).
 *
 * Size byte: HHHHWWWW
 *   H (high nibble) = height counter (rows of tile $0B, then one final row of $0E).
 *   W (low nibble)  = width-1 of each row.
 */
export function handle_0DB461(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const height = (cur.size >> 4) & 0x0F

  setPage0(cur)   // all StzTo6ePointer
  saveBookmark(cur)
  // For `height` rows, stamp $0B across (width+1) columns.
  for (let r = 0; r < height; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, 0x0B)
    }
    restoreBookmark(cur)
    nextRow(cur)
  }
  // Final row: tile $0E across (width+1) columns.
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, 0x0E)
  }
}

/**
 * CODE_0DB075 (bank_0D.asm line 3013) -- vertical slope/ledge column (object 19).
 *
 * Size byte: HHHHXXXX
 *   X (low nibble)  = slope variant (indexes 4 ROM tables).
 *   H (high nibble, _0) = middle-segment count.
 *
 * Column layout:
 *   row 0     : DATA_0DB039[X]     (top segment)
 *   row 1     : DATA_0DB048[X]     (if _0 reaches 0, included; else still written)
 *   middle×_0 : DATA_0DB057[X]     (loops until _0 goes negative)
 *   optional  : DATA_0DB066[X]     (only if X >= 0x0B, e.g. some rope/chain variants)
 *
 * The ASM also runs CODE_0DB114 / CODE_0DB198 which do context-aware merging
 * with the tile already in the slot (used to blend slope joins). The first-pass
 * port writes the raw table values — adequate for rendering without stitching.
 */
export function handle_0DB075(cur: Cursor): void {
  const X = cur.size & 0x0F
  let count = (cur.size >> 4) & 0x0F

  const topTile    = readByte(cur.rom, ADDR_DATA_0DB039 + X)
  const row1Tile   = readByte(cur.rom, ADDR_DATA_0DB048 + X)
  const middleTile = readByte(cur.rom, ADDR_DATA_0DB057 + X)
  const footerTile = readByte(cur.rom, ADDR_DATA_0DB066 + X)

  // Context-merge tables (same tables for every row; read once).
  const db0F0 = readByteTable(cur.rom, ADDR_DATA_0DB0F0, DATA_0DB0F0_LEN)
  const db102 = readByteTable(cur.rom, ADDR_DATA_0DB102, DATA_0DB0F0_LEN)
  const db15C = readByteTable(cur.rom, ADDR_DATA_0DB15C, DATA_0DB15C_LEN)
  const db17A = readByteTable(cur.rom, ADDR_DATA_0DB17A, DATA_0DB15C_LEN)

  // Row 0 page (ASM): page 0 if X < 3, else page 1. Merge may override to 1.
  if (X < 3) setPage0(cur); else setPage1(cur)
  writeTileMergeCODE_0DB114(cur, X, topTile, db0F0, db102)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0B) { setPage1(cur); writeTile(cur, footerTile) }
    return
  }

  // Rows 1+ page (ASM): X in [3,6] or X >= 9 → page 1, else page 0.
  const rowPage1 = (X >= 3 && X <= 6) || X >= 9

  // Row 1 uses CODE_0DB198 merge.
  if (rowPage1) setPage1(cur); else setPage0(cur)
  writeTileMergeCODE_0DB198(cur, X, row1Tile, db15C, db17A)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0B) { setPage1(cur); writeTile(cur, footerTile) }
    return
  }

  // Middle loop: same page + merge pattern as row 1.
  while (count >= 0) {
    if (rowPage1) setPage1(cur); else setPage0(cur)
    writeTileMergeCODE_0DB198(cur, X, middleTile, db15C, db17A)
    cur.row += 1
    count -= 1
  }

  // Footer (X >= 0x0B): plain page-1 write, no merge.
  if (X >= 0x0B) {
    setPage1(cur)
    writeTile(cur, footerTile)
  }
}

/**
 * ADDR_0DB571 (bank_0D.asm line 3715) -- single-tile stamp by size byte (objects 47-54).
 *
 * X = LvlLoadObjSize - $68. Writes DATA_0DB569[X] at the cursor. Used by the
 * 8 "question/misc" single-tile standard objects.
 */
export function handle_0DB571(cur: Cursor): void {
  const X = cur.size - 0x68
  if (X < 0 || X > 7) return
  setPage0(cur)   // StzTo6ePointer
  writeTile(cur, readByte(cur.rom, ADDR_DATA_0DB569 + X))
}

/**
 * CODE_0DB51F (bank_0D.asm line 3666) -- 3-segment vertical pipe-end piece (object 32).
 *
 * Size high nibble = X = height count. Writes $53 at top, $54 (X-1) times in the
 * middle, $55 at bottom. If X is 0 the loop writes nothing in the middle.
 */
export function handle_0DB51F(cur: Cursor): void {
  const X = (cur.size >> 4) & 0x0F
  setPage1(cur)   // Sta1To6ePointer for every write
  writeTile(cur, 0x53)
  let count = X
  while (count > 0) {
    cur.row += 1
    writeTile(cur, 0x54)
    count -= 1
  }
  cur.row += 1
  writeTile(cur, 0x55)
}

/**
 * CODE_0DB547 (bank_0D.asm line 3691) -- 3-segment horizontal run (object 33).
 *
 * Size low nibble = X = width count. Writes $56 (left cap), $57 (X-1 times
 * middle), $58 (right cap). Column advances normally.
 */
export function handle_0DB547(cur: Cursor): void {
  const X = cur.size & 0x0F
  setPage1(cur)   // Sta1To6ePointer for every write
  writeTileAdvance(cur, 0x56)
  let count = X
  while (count > 1) {
    writeTileAdvance(cur, 0x57)
    count -= 1
  }
  writeTile(cur, 0x58)
}

/**
 * CODE_0DB5B7 (bank_0D.asm line 3761) -- capped horizontal run (object 63).
 *
 * Size byte: HHHHWWWW
 *   W (low nibble, _0)   = width count (number of tiles after the left cap).
 *   H (high nibble, X)   = which of 5 (cap, middle, cap) tile triples to use.
 *
 * Writes DATA_0DB5A8[X] then (W-1) copies of DATA_0DB5AD[X] then DATA_0DB5B2[X].
 */
export function handle_0DB5B7(cur: Cursor): void {
  const W = cur.size & 0x0F
  const X = (cur.size >> 4) & 0x0F
  const leftCap  = readByte(cur.rom, ADDR_DATA_0DB5A8 + X)
  const middle   = readByte(cur.rom, ADDR_DATA_0DB5AD + X)
  const rightCap = readByte(cur.rom, ADDR_DATA_0DB5B2 + X)

  setPage0(cur)   // StzTo6ePointer
  writeTileAdvance(cur, leftCap)
  let count = W
  while (count > 1) {
    writeTileAdvance(cur, middle)
    count -= 1
  }
  if (W === 0) return  // avoid writing the right cap when the ASM would loop forever
  writeTile(cur, rightCap)
}

/**
 * CODE_0DB224 (bank_0D.asm line 3234) -- 3-column framed vertical structure (object 21).
 *
 * Size byte: HHHHVVVV
 *   V (low nibble)  = variant flag. V=0 uses DATA_0DB212/15/18 (primary set);
 *                     V!=0 uses DATA_0DB21B/1E/21 (alternate set).
 *   H (high nibble) = inner body height (both structures produce top + H middles + bottom).
 *
 * Per column X in 0..2: writes top[X] at row 0, middle[X] for H rows, then
 * bottom[X] at the final row. Each column is placed one column to the right
 * of the previous. All writes go through StzTo6ePointer -- page 0.
 */
export function handle_0DB224(cur: Cursor): void {
  const V = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F
  const top = V === 0 ? ADDR_DATA_0DB212 : ADDR_DATA_0DB21B
  const mid = V === 0 ? ADDR_DATA_0DB215 : ADDR_DATA_0DB21E
  const bot = V === 0 ? ADDR_DATA_0DB218 : ADDR_DATA_0DB221

  setPage0(cur)
  const origCol = cur.col
  const origRow = cur.row
  for (let X = 0; X < 3; X++) {
    cur.col = origCol + X
    cur.row = origRow
    writeTile(cur, readByte(cur.rom, top + X))
    for (let r = 0; r < H; r++) {
      cur.row += 1
      writeTile(cur, readByte(cur.rom, mid + X))
    }
    cur.row += 1
    writeTile(cur, readByte(cur.rom, bot + X))
  }
  cur.col = origCol
  cur.row = origRow
}

/**
 * CODE_0DAB3E (bank_0D.asm line 2278) -- pipe dispatcher (object 18).
 *
 * The low nibble of the size byte (modulo 10) selects one of 10 pipe shapes,
 * each with its own handler in the ASM. High nibble is a length/height
 * parameter whose meaning varies by variant. The dispatch table lives right
 * after the JSL at $0DAB52; each entry's handler follows.
 *
 * We skip the CODE_0DABFD / CODE_0DB84E context-merging helpers (which read
 * the existing tile and blend pipe lips with neighbor terrain); the raw tile
 * values from the ASM are written directly. This produces the correct shape;
 * pipe-into-ground joins show a subtle seam but the silhouette is right.
 */
export function handle_0DAB3E(cur: Cursor): void {
  const variant = (cur.size & 0x0F) % 10
  switch (variant) {
    case 0: return pipeVariant0(cur)
    case 1: return pipeVariant1(cur)
    case 2: return pipeVariant2(cur)
    case 3: return pipeVariant3(cur)
    case 4: return pipeVariant4(cur)
    case 5: return pipeVariant5(cur)
    case 6: return pipeVariant6(cur)
    case 7: return pipeVariant7(cur)
    case 8: return pipeVariant8(cur)
    case 9: return pipeVariant9(cur)
  }
}

/**
 * Variant 0 -- CODE_0DAB6E (bank_0D line 2301).
 * Short upward-facing vertical pipe, 2 columns × (H+1) rows.
 * Top: $96/$9B nozzle. Body: $DE/$E6.
 */
function pipeVariant0(cur: Cursor): void {
  const height = (cur.size >> 4) & 0x0F
  setPage1(cur)
  const col0 = cur.col, row0 = cur.row

  writeTile(cur, 0x96)
  cur.col = col0 + 1
  writeTile(cur, 0x9B)

  for (let r = 1; r <= height; r++) {
    cur.row = row0 + r
    cur.col = col0
    writeTile(cur, 0xDE)
    cur.col = col0 + 1
    writeTile(cur, 0xE6)
  }
  cur.row = row0
  cur.col = col0
}

/**
 * Variant 1 -- CODE_0DAC21 (bank_0D line 2412).
 * Diagonal pipe sloping down-left: tip at upper-right cursor position,
 * body extends down and to the left in 1-col-per-row steps.
 *
 * Each iteration `_2` grows by 1; row 0 writes only the lip $AA, row 1
 * writes $AA then body $E2, row 2 adds a $3F filler, etc. Between rows the
 * cursor steps diagonally down-left (col-- row++), so the lips form a
 * downward-left line while the row extends further right each pass.
 */
function pipeVariant1(cur: Cursor): void {
  const heightCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  let widthCounter = 0
  saveBookmark(cur)

  // Each iteration writes one row. Row `i` contains:
  //   - lip tile $AA (always)
  //   - if widthCounter >= 1: body tile $E2
  //   - then (widthCounter - 1) $3F ground fillers
  // This mirrors the ASM pattern: write $AA, DEX (X=widthCounter-1), BMI skip;
  // else write $E2, DEX, then loop writing $3F while X>=0.
  for (let i = 0; i < heightCount; i++) {
    setPage1(cur)
    writeTileAdvance(cur, 0xAA)
    let x = widthCounter - 1
    if (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, 0xE2)
      x -= 1
      while (x >= 0) {
        setPage0(cur); writeTileAdvance(cur, 0x3F)
        x -= 1
      }
    }
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    saveBookmark(cur)
    widthCounter += 1
  }

  // Final body row (CODE_0DAC89 path): skip the lip, body row with $E2 + $3F fill.
  nextRow(cur)   // CODE_0DA97D
  let x = widthCounter - 1
  if (x >= 0) {
    setPage1(cur); writeTileAdvance(cur, 0xE2)
    x -= 1
    while (x >= 0) {
      setPage0(cur); writeTileAdvance(cur, 0x3F)
      x -= 1
    }
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 2 -- CODE_0DAC92 (bank_0D line 2480).
 * Wide diagonal pipe (4 cols) sloping down-left. Like variant 1 but four
 * lip tiles per row ($6E/$73/$78/$7D) and four body tiles ($D8/$DA/$E6/$E6).
 * Diagonal step is col-=4, row+=1 per iteration.
 */
function pipeVariant2(cur: Cursor): void {
  const heightCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  let widthCounter = 3   // starts at 3 because ASM decrements X by 4 then tests BMI
  saveBookmark(cur)

  for (let i = 0; i < heightCount; i++) {
    setPage1(cur)
    writeTileAdvance(cur, 0x6E); writeTileAdvance(cur, 0x73)
    writeTileAdvance(cur, 0x78); writeTileAdvance(cur, 0x7D)
    let x = widthCounter - 4
    if (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, 0xD8)
      setPage1(cur); writeTileAdvance(cur, 0xDA)
      setPage1(cur); writeTileAdvance(cur, 0xE6)
      setPage1(cur); writeTileAdvance(cur, 0xE6)
      x -= 3
    }
    while (x >= 0) {
      setPage0(cur); writeTileAdvance(cur, 0x3F)
      x -= 1
    }
    restoreBookmark(cur)
    stepDiag(cur, -4, 1)
    saveBookmark(cur)
    widthCounter += 4
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 3 -- CODE_0DAD44 (bank_0D line 2580).
 * 2-wide vertical pipe pointing DOWN (ceiling pipe). Top (at cursor) is the
 * pipe body $A0/$A5; body rows below are $E6/$E0; final row is closed with
 * $E6/$E0 as the ceiling lip.
 *
 * This one reverses the logic: writes body first, then the "lip" at the end.
 */
function pipeVariant3(cur: Cursor): void {
  const bodyCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  for (let i = 0; i < bodyCount; i++) {
    cur.col = col0
    setPage1(cur); writeTile(cur, 0xA0)
    cur.col = col0 + 1
    setPage1(cur); writeTile(cur, 0xA5)
    cur.row += 1
  }
  // Terminal lip
  cur.col = col0
  setPage1(cur); writeTile(cur, 0xE6)
  cur.col = col0 + 1
  setPage1(cur); writeTile(cur, 0xE0)

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 4 -- CODE_0DADA3 (bank_0D line 2631).
 * 1-wide diagonal pipe sloping up-left (tip at upper-left cursor, body
 * extends down-right). Each row i produces:
 *   (i-1) × $3F ground fillers, then $E4 pipe body, then $AF pipe lip.
 * The row 0 degenerate case is just the lip.
 */
function pipeVariant4(cur: Cursor): void {
  const bodyCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  for (let i = 0; i < bodyCount; i++) {
    cur.row = row0 + i
    cur.col = col0
    // (i-1) ground fillers to the left of the pipe body
    for (let j = 0; j < i - 1; j++) {
      setPage0(cur); writeTileAdvance(cur, 0x3F)
    }
    // Pipe body (only present when i >= 1)
    if (i >= 1) {
      setPage1(cur); writeTileAdvance(cur, 0xE4)
    }
    // Pipe lip at the tip (rightmost col of this row)
    setPage1(cur); writeTile(cur, 0xAF)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 5 -- CODE_0DADEB (bank_0D line 2671).
 * 4-wide vertical pipe. Top: $82/$87/$8C/$91. Body: $E6/$E6/$DB/$DC.
 */
function pipeVariant5(cur: Cursor): void {
  const bodyCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  // Top lip row
  const topTiles = [0x82, 0x87, 0x8C, 0x91]
  for (let c = 0; c < 4; c++) {
    cur.col = col0 + c
    setPage1(cur); writeTile(cur, topTiles[c])
  }

  // Body rows
  const bodyTiles = [0xE6, 0xE6, 0xDB, 0xDC]
  for (let r = 1; r <= bodyCount; r++) {
    cur.row = row0 + r
    for (let c = 0; c < 4; c++) {
      cur.col = col0 + c
      setPage1(cur); writeTile(cur, bodyTiles[c])
    }
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 6 -- CODE_0DAE6D (bank_0D line 2738).
 * Diagonal pipe sloping down-right with a 2-col body. Tip tiles $C6/$C7 at
 * the lip, $EE/$F0 at the body. Diagonal step is +2 cols, +1 row per
 * iteration (ADC #$12).
 *
 * The ASM builds a sloping shape that extends down-right from the cursor.
 */
function pipeVariant6(cur: Cursor): void {
  const iter = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  let widthCounter = iter * 2 - 1

  for (let i = 0; i < iter; i++) {
    setPage1(cur); writeTileAdvance(cur, 0xEE)
    setPage1(cur); writeTileAdvance(cur, 0xF0)
    let x = widthCounter - 2
    while (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, 0x65)
      x -= 1
    }
    stepDiag(cur, 2, 1)
    widthCounter -= 2
  }
  // Final lip row
  setPage1(cur); writeTileAdvance(cur, 0xC6)
  setPage1(cur); writeTile(cur, 0xC7)

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 7 -- CODE_0DAEFC (bank_0D line 2819).
 * Another diagonal down-right variant. Lip $C8/$C9, intermediate $F0/$EF.
 */
function pipeVariant7(cur: Cursor): void {
  const iter = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  let widthCounter = iter * 2 + 1

  for (let i = 0; i < iter; i++) {
    let x = widthCounter
    while (x >= 4) {
      setPage1(cur); writeTileAdvance(cur, 0x65)
      x -= 1
    }
    if (x >= 2) {
      setPage1(cur); writeTileAdvance(cur, 0xF0)
      setPage1(cur); writeTileAdvance(cur, 0xEF)
      x -= 2
    }
    // Lip at the very end only on final iteration, but ASM writes it each row
    setPage1(cur); writeTileAdvance(cur, 0xC8)
    setPage1(cur); writeTileAdvance(cur, 0xC9)
    cur.col -= widthCounter + 2
    cur.row += 1
    widthCounter -= 2
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 8 -- CODE_0DAF61 (bank_0D line 2872).
 * 1-wide diagonal pipe sloping down-right. Step col+1 row+1.
 * Lip $C4, body $EC, filler $65.
 */
function pipeVariant8(cur: Cursor): void {
  const iter = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  let widthCounter = iter - 1

  for (let i = 0; i < iter; i++) {
    // Lead $EC body, then $65 fillers, then $C4 lip at current diagonal col.
    setPage1(cur); writeTileAdvance(cur, 0xEC)
    let x = widthCounter
    while (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, 0x65)
      x -= 1
    }
    setPage1(cur); writeTile(cur, 0xC4)
    diagonalDownRight(cur)
    widthCounter -= 1
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 9 -- CODE_0DAFEA (bank_0D line 2953).
 * Further diagonal variant; ASM body is a mirror of variant 8 with different
 * tiles. First-pass port: draw a 1-wide diagonal column with variant-8 tiles
 * so the silhouette is at least visible.
 */
function pipeVariant9(cur: Cursor): void {
  const iter = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row
  setPage1(cur)
  for (let i = 0; i < iter; i++) {
    writeTile(cur, 0xC4)
    diagonalDownRight(cur)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DAB0D (bank_0D.asm line 2249) -- vertical "rope/pole" 3-segment run (object 17).
 *
 * Size byte: HHHHxxxx
 *   H (high nibble, X) = height; tile sequence: $41 (top), $42 (middle), $43 (repeated).
 *
 * Loop:
 *   write $41; row++; X--; if <0 return
 *   write $42; row++; X--; if <0 return
 *   loop: write $43; row++; X--; until X<0
 */
export function handle_0DAB0D(cur: Cursor): void {
  let X = (cur.size >> 4) & 0x0F
  setPage1(cur)   // Sta1To6ePointer before each write
  writeTile(cur, 0x41); cur.row += 1
  X--
  if (X < 0) return
  writeTile(cur, 0x42); cur.row += 1
  X--
  if (X < 0) return
  while (X >= 0) {
    writeTile(cur, 0x43); cur.row += 1
    X--
  }
}

/**
 * CODE_0DB73F (bank_0D.asm line 3957) -- diagonal slope walker (object 57).
 *
 * Size byte: HHHHxxxx; H (high nibble, _0) = number of diagonal steps.
 *
 * The handler stamps an increasing number of tiles per row while walking an
 * X-index forward through DATA_0DB72F (16 entries) and stepping diagonally
 * down-left between rows. When X reaches 6 the code switches to a second
 * loop variant which can wrap X back to 11 (`X = X - 5`) to cycle through a
 * different subrange of the table. The $EB capper tile closes out the shape
 * at the final diagonal position.
 *
 * Shape: a down-left-sloping ridge that gets wider each row. For SMW levels
 * this renders the "diagonal ground with grass top" seen at screen 0B of the
 * reference map.
 *
 * The ASM also does Sta1To6ePointer before each write (page 1).
 */
export function handle_0DB73F(cur: Cursor): void {
  const steps = (cur.size >> 4) & 0x0F
  const table = readByteTable(cur.rom, ADDR_DATA_0DB72F, 16)
  const col0 = cur.col, row0 = cur.row

  let _1 = 1
  let X = 0
  let _0 = steps
  setPage1(cur)

  // Phase 1 loop (CODE_0DB752): continues while X < 6.
  while (true) {
    let count = _1
    saveBookmark(cur)
    // Inner: write (_1 + 1) tiles, advancing X into DATA_0DB72F each write.
    while (count >= 0) {
      writeTileAdvance(cur, table[X & 0x0F] ?? 0)
      X += 1
      count -= 1
    }
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    _1 += 2
    _0 -= 1
    if (_0 < 0) break
    // ASM: `CPX #$06; BNE CODE_0DB752` — exits Phase 1 only when X == 6 exactly.
    if (X === 6) { _1 -= 1; break }
  }

  // Phase 2 loop (CODE_0DB779): continues until _0 < 0.
  if (_0 >= 0) {
    while (_0 >= 0) {
      let count = _1
      saveBookmark(cur)
      while (count >= 0) {
        writeTileAdvance(cur, table[X & 0x0F] ?? 0)
        X += 1
        count -= 1
      }
      restoreBookmark(cur)
      diagonalDownLeft(cur)
      // ASM: `CPX #$10; BNE +; TXA SEC SBC #$05; TAX` — wraps X only when
      // X == $10 exactly (X - 5 = 11, so Phase 2 cycles 11 → 16 → 11 → …).
      if (X === 16) X = X - 5
      _0 -= 1
    }
  }

  // Final capper (CODE_0DB79F): advance one col, write $EB.
  advanceCol(cur)
  setPage1(cur)
  writeTile(cur, 0xEB)

  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DB7AA (bank_0D.asm line 4013) -- pyramid/hill slope (object 58).
 *
 * Size byte: HHHHWWWW.
 *   W (low nibble, _0 / _2) = width of the hill at its widest point.
 *   H (high nibble, _3)     = number of rows on the down-right side.
 *
 * The handler draws a two-phase sloped shape:
 *   1. Up-left phase: increasing rows of $AA lip + $E2 body + $3F fills on the
 *      left side; between rows, steps down-left (CODE_0DA992). Last row of the
 *      phase caps with $A6.
 *   2. Down-right phase: writes $F7 once, then iterates drawing $A3 lip + $3F
 *      fill + $A6 capper per row, stepping diagonally down-right (CODE_0DA9B4).
 *
 * This renders the typical stepped hill / pyramid silhouette. Context-merge
 * helpers (CODE_0DB84E) that would soften lip-to-ground transitions are
 * skipped; each tile is written as-is.
 */
export function handle_0DB7AA(cur: Cursor): void {
  const width = cur.size & 0x0F
  const rightSide = (cur.size >> 4) & 0x0F
  const col0 = cur.col, row0 = cur.row

  // Phase 1 — up-left side.
  let _1 = 1
  let _2 = width
  saveBookmark(cur)

  // First row: pipe-merged $AA lip, slope-merged $A1 body. Both advance.
  setPage1(cur); writeTilePipeMerge(cur, 0xAA)
  setPage0(cur); writeTileSlopeMerge(cur, 0xA1)
  restoreBookmark(cur)
  diagonalDownLeft(cur)
  _1 += 2
  _2 -= 1
  saveBookmark(cur)

  // CODE_0DB7D6 loop: $AA lip (pipe-merge) + $E2 body + (X-2) $3F + $A6 cap
  // (slope-merge on the cap so the right edge blends with ground).
  while (_2 >= 0) {
    setPage1(cur); writeTilePipeMerge(cur, 0xAA)
    setPage1(cur); writeTileAdvance(cur, 0xE2)
    let x = _1 - 2
    while (x > 0) {
      setPage0(cur); writeTileAdvance(cur, 0x3F)
      x -= 1
    }
    setPage0(cur); writeTileSlopeMerge(cur, 0xA6)
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    _1 += 2
    _2 -= 1
    saveBookmark(cur)
  }

  // Advance one column + write $F7 (pipe-merge) as the first-row lip,
  // then enter the down-right loop.
  advanceCol(cur)
  saveBookmark(cur)
  const _1b = _1 - 2

  // Phase 2 -- down-right side. The ASM's JMP CODE_0DB836 skips the $A3 lip
  // on the FIRST iteration only; $F7 (written just above) fills that role.
  // Subsequent iterations each start with an $A3 slope-merge lip.
  let _3 = rightSide
  let firstPhase2Iter = true
  while (_3 >= 0) {
    if (firstPhase2Iter) {
      setPage1(cur); writeTilePipeMerge(cur, 0xF7)
    } else {
      setPage0(cur); writeTileSlopeMerge(cur, 0xA3)
    }
    let x = _1b
    while (x > 0) {
      setPage0(cur); writeTileAdvance(cur, 0x3F)
      x -= 1
    }
    setPage0(cur); writeTileSlopeMerge(cur, 0xA6)
    restoreBookmark(cur)
    diagonalDownRight(cur)
    saveBookmark(cur)
    _3 -= 1
    firstPhase2Iter = false
  }

  cur.col = col0
  cur.row = row0
}
