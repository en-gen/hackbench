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
 *     always render as "not collected" - we are an editor, not a live game session.
 */

import {
  Cursor,
  writeTileAdvance,
  writeTile,
  nextRow,
  saveBookmark,
  restoreBookmark,
  advanceCol,
  advanceRowRaw,
  setPage0,
  setPage1,
  peekExistingLow,
  diagonalDownLeft,
  diagonalDownRight,
  writeTileSlopeMerge,
  writeTilePipeMerge,
  writeTilePipeMergeNoAdvance,
  writeTileMergeCODE_0DB114,
  writeTileMergeCODE_0DB198,
  readLongOperand,
  readGatedLongOperand,
  readImmByte,
  MAP16_BYTES_PER_SCREEN_H,
} from './cursor'
import { isInterpretedHandler, drawInterpreted } from './interpretedDraw'
// No ADDR_DATA_* imports: every handler resolves its table addresses and
// immediate tile IDs dynamically from its own bytecode via cur.handlerAddr.
// No RomFile / readByteTable imports either -- reads go through cur.rom directly.

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
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  const x = cur.objNo - 1
  if (x < 0 || x >= 14) return // 14 tiles in the table (objects 1-14)

  // LDA.L DATA_0DA8B4,X at handler offset +107 (operand at +108). ASM: line 1974.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 108)
  const tileId = cur.rom.readByte(tableAddr + x) ?? 0

  // ASM (CODE_0DA92E): StzTo6ePointer, then if X>=7 also Sta1To6ePointer.
  // Net: objNo 1-7 write page 0, objNo 8-14 write page 1.
  if (x >= 7) setPage1(cur)
  else setPage0(cur)

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
  // CODE_0DAA26 is a 2-wide × (H+1)-tall vertical structure. Each iteration
  // writes a horizontal pair of tiles (left tile via CODE_0DA95B which
  // advances Y, then right tile via STA [Map16LowPtr],Y at the advanced Y),
  // then restores the bookmark column and advances to the next row.
  //
  // Behaviour by row and by X (ledge variant, low nibble of size):
  //   X < 3:   row 0 = left-cap pair (DATA_0DAA12[X] / DATA_0DAA17[X])
  //            rows 1..H = middle pair ($35 / $36)
  //            no right cap
  //   X = 5:   every row = $68 / $69
  //   X in {3, 4}: rows 0..H-1 = middle pair ($35 / $36)
  //                final row (H) = right-cap pair
  //                (DATA_0DAA1C[X] / DATA_0DAA21[X])
  //   X = 2:   row 0 = left-cap ($39/$3A), rows 1..H-1 = middle ($35/$36),
  //            final row (H) = right-cap ($39/$3A)
  //
  // All writes are on page 1 (Sta1To6ePointer precedes every write).
  const H = (cur.size >> 4) & 0x0f
  const X = cur.size & 0x0f

  // LDA.L operands inside the handler body (opcodes $BF at -1):
  //   +26  DATA_0DAA12 (left-cap top)     +36  DATA_0DAA17 (left-cap bottom)
  //   +110 DATA_0DAA1C (right-cap top)    +120 DATA_0DAA21 (right-cap bottom)
  const addrLeftTop = readLongOperand(cur, cur.handlerAddr + 26)
  const addrLeftBottom = readLongOperand(cur, cur.handlerAddr + 36)
  const addrRightTop = readLongOperand(cur, cur.handlerAddr + 110)
  const addrRightBottom = readLongOperand(cur, cur.handlerAddr + 120)
  const leftTop = (i: number) => cur.rom.readByte(addrLeftTop + i) ?? 0
  const leftBottom = (i: number) => cur.rom.readByte(addrLeftBottom + i) ?? 0
  const rightTop = (i: number) => cur.rom.readByte(addrRightTop + i) ?? 0
  const rightBottom = (i: number) => cur.rom.readByte(addrRightBottom + i) ?? 0

  // LDA # immediates (X==5 and X>=3 branches). Operand follows the $A9
  // opcode, so operand offset = opcode offset + 1:
  //   +52 $68 (X==5 top)   +60 $69 (X==5 bottom)
  //   +70 $35 (fallthrough middle top)   +78 $36 (fallthrough middle bottom)
  const x5Top = readImmByte(cur, cur.handlerAddr + 52)
  const x5Bot = readImmByte(cur, cur.handlerAddr + 60)
  const midTop = readImmByte(cur, cur.handlerAddr + 70)
  const midBot = readImmByte(cur, cur.handlerAddr + 78)

  const col0 = cur.col
  const row0 = cur.row
  let row = 0

  const writePair = (top: number, bot: number) => {
    cur.col = col0
    cur.row = row0 + row
    setPage1(cur)
    writeTile(cur, top)
    cur.col = col0 + 1
    setPage1(cur)
    writeTile(cur, bot)
    row++
  }

  // Row 0 (only if X < 3) -- left cap.
  if (X < 3) {
    writePair(leftTop(X), leftBottom(X))
  }

  // Remaining rows. Loop count depends on ASM flow:
  //   X < 2 (and not skipped): DEC _0 counts down _0 from H, writes H+1 middles
  //     after the left cap, producing (H+1) total iterations AFTER row 0.
  //     But ASM wraps: we wrote 1 row already, so middles run while _0 >= 0.
  //   X >= 2 (and X != 5): writes (H) middles, then replaces the final row
  //     with right cap when _0 reaches 0.
  //   X == 5: all rows use $68/$69, loops H+1 times total from the start.

  // ASM loop behaviour after the optional left-cap row:
  //   _0 starts at H. DEC _0 before each subsequent write. BPL (X<2 path via
  //   CODE_0DAA85) continues while _0 >= 0 after DEC. BNE (X>=2 path via
  //   CODE_0DAA8C) continues while _0 != 0 after DEC, then writes the right
  //   cap when _0 reaches 0.
  //
  // Net row counts (all shapes are H+1 rows total, 2 cols wide):
  //   X == 5:     H+1 rows of $68/$69. No left or right cap.
  //   X in {0,1}: row 0 = left cap, rows 1..H = middle pair ($35/$36).
  //   X == 2:     row 0 = left cap, rows 1..H-1 = middle, row H = right cap.
  //   X in {3,4}: rows 0..H-1 = middle, row H = right cap. No left cap.
  if (X === 5) {
    for (let i = 0; i <= H; i++) writePair(x5Top, x5Bot)
  } else if (X === 2) {
    // Left cap (written above) + (H-1) middles + right cap.
    for (let i = 0; i < H - 1; i++) writePair(midTop, midBot)
    writePair(rightTop(X), rightBottom(X))
  } else if (X >= 3) {
    // No left cap. H middles + right cap.
    for (let i = 0; i < H; i++) writePair(midTop, midBot)
    writePair(rightTop(X), rightBottom(X))
  } else {
    // X in {0, 1}: left cap (written above) + H middles. No right cap.
    for (let i = 0; i < H; i++) writePair(midTop, midBot)
  }

  // Leave cursor unchanged from ASM perspective; our bookmark is implicit.
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DAAB4 (bank_0D.asm line 2200) -- used-block / horizontal-pipe pair (object 16).
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = width-1 of the row (column count = W + 1).
 *   H (high nibble) = style selector; X starts at H * 2 (ASM: AND #$F0; LSR x3).
 *
 * Produces a 2-row horizontal pair (always 2 rows because X_start = H*2 is
 * always even, and the outer loop continues while X is odd after increment).
 *
 * Tile tables, indexed by X after each row:
 *   DATA_0DAAA4 = [$3B, $3C, $3B, $3F, $3B, $3C, $3B, $3F]  cap tiles
 *   DATA_0DAAAC = [$3D, $3E, $3D, $3E, $3D, $3E, $3D, $3E]  middle tiles
 *
 * Per-row layout (all page 1):
 *   X<4  (left-cap rows):   AAAA[X] at col 0, then AAAC[X] at cols 1..W.
 *   X>=4 (right-cap rows):  AAAC[X] at cols 0..W-1, then AAAA[X] at col W
 *                           (STA without advance - row ends here anyway).
 *
 * Between rows: CODE_0DA6BA + CODE_0DA97D (restore bookmark, row += 1); INX; loop
 * while (X & 1) != 0.
 *
 * Used by the horizontal goal-area pipe at the end of level $002 (objNum $10,
 * size $15 → H=1 W=5 → rows $13B $13D×5 / $13F $13E×5).
 */
export function handle_0DAAB4(cur: Cursor): void {
  const width = cur.size & 0x0f // _0 = _1 = W
  const heightNibble = (cur.size >> 4) & 0x0f // H
  let X = (heightNibble << 1) & 0xff // ASM: AND #$F0; LSR x3 → H * 2

  // LDA.L DATA_0DAAA4,X operand at handler offset +29 (the $BF opcode at +28).
  // LDA.L DATA_0DAAAC,X operand at handler offset +42 (the $BF opcode at +41).
  const addrA = readLongOperand(cur, cur.handlerAddr + 29)
  const addrB = readLongOperand(cur, cur.handlerAddr + 42)
  const tableA = [0, 1, 2, 3, 4, 5, 6, 7].map(i => cur.rom.readByte(addrA + i) ?? 0)
  const tableB = [0, 1, 2, 3, 4, 5, 6, 7].map(i => cur.rom.readByte(addrB + i) ?? 0)

  saveBookmark(cur) // CODE_0DA6B1

  // Outer loop runs while X (post-increment) is still odd. With X_start always
  // even, this yields exactly 2 iterations - one for the top row, one for the
  // bottom.
  let iter = 0
  while (iter++ < 4) {
    // bounded for safety; expected 2
    const idx = X & 7
    const capTile = tableA[idx] ?? 0
    const midTile = tableB[idx] ?? 0

    if (X < 4) {
      // Left-cap row: cap at col 0, then W middles.
      setPage1(cur)
      writeTileAdvance(cur, capTile)
      for (let w = 0; w < width; w++) {
        setPage1(cur)
        writeTileAdvance(cur, midTile)
      }
    } else {
      // Right-cap row: W middles, then cap at col W (STA-only in ASM, no advance).
      for (let w = 0; w < width; w++) {
        setPage1(cur)
        writeTileAdvance(cur, midTile)
      }
      setPage1(cur)
      writeTile(cur, capTile)
    }

    restoreBookmark(cur) // CODE_0DA6BA
    nextRow(cur) // CODE_0DA97D (row += 1, col = bookmark)
    X = (X + 1) & 0xff
    if ((X & 0x01) === 0) break // AND #$01; BNE - stop when X becomes even
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
 * Shares its main body (CODE_0DB1E3) with CODE_0DB1C8 (object 33) - both write
 * tile $00 across the first row, then tile $3F across the remaining rows.
 */
export function handle_0DB1D4(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  // CODE_0DB1D4 falls through into the shared CODE_0DB1E3 body at handler +15.
  fillRectTopBottom(cur, cur.handlerAddr + 15, widthM1, heightM1)
}

/**
 * CODE_0DB1C8 (bank_0D.asm line 3171) -- full-byte-width rectangle (object 33).
 *
 * The size byte is used as a raw *width count*: total width = (size & 0xFF) + 1.
 * The height is fixed at 3 rows (`LDA #$02; STA _2` in the ASM).
 *
 * This is how SMW stamps the wide base-ground strips in levels like
 * Yoshi's Island 1 - a single object with size $BF produces a 192-tile run.
 */
export function handle_0DB1C8(cur: Cursor): void {
  const widthM1 = cur.size & 0xff // full byte as width-1
  // LDA #$02 at handler +5, STA _2 then JMP CODE_0DB1E3. Height-1 immediate at +6.
  const heightM1 = readImmByte(cur, cur.handlerAddr + 6)
  // JMP CODE_0DB1E3 operand at handler +10 (2-byte same-bank target).
  const sharedBodyAddr =
    (cur.handlerAddr & 0xff0000) |
    ((cur.rom.readByte(cur.handlerAddr + 11) ?? 0) << 8) |
    (cur.rom.readByte(cur.handlerAddr + 10) ?? 0)
  fillRectTopBottom(cur, sharedBodyAddr, widthM1, heightM1)
}

/** Shared body for CODE_0DB1D4 / CODE_0DB1C8 (the CODE_0DB1E3 loop).
 *
 *  Row 0 uses Sta1To6ePointer (page 1) -- that's $100 = the grass-capped ground
 *  tile. Rows 1+ use StzTo6ePointer (page 0) -- $03F = plain dirt. Without the
 *  page switch, the top row would render as $000 (empty) and the ground strip
 *  would appear without its characteristic green top. */
function fillRectTopBottom(cur: Cursor, bodyAddr: number, widthM1: number, heightM1: number): void {
  // CODE_0DB1E3 layout (shared body at bodyAddr):
  //   +8  LDA #$00   ← grass tile (row 0, page 1). Immediate at bodyAddr + 9.
  //   +24 LDA #$3F   ← dirt tile (rows 1+, page 0). Immediate at bodyAddr + 25.
  //
  // (Offsets are relative to CODE_0DB1E3 and independent of whether we arrived
  // via fall-through from CODE_0DB1D4 or JMP from CODE_0DB1C8.)
  const grassTile = readImmByte(cur, bodyAddr + 9)
  const dirtTile = readImmByte(cur, bodyAddr + 25)

  saveBookmark(cur)
  setPage1(cur) // Sta1To6ePointer
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, grassTile)
  }
  restoreBookmark(cur)
  setPage0(cur) // StzTo6ePointer
  for (let r = 0; r < heightM1; r++) {
    cur.row += 1
    cur.col = cur.bookmarkCol
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, dirtTile)
    }
  }
}

/**
 * CODE_0DB3BD (bank_0D.asm line 3455) -- coin cloud / simple horizontal run (object 23).
 *
 * Size byte: HHHHWWWW - H selects tile via DATA_0DB3BB[H], W = width-1.
 * A single-row run of (width+1) tiles of DATA_0DB3BB[H].
 */
export function handle_0DB3BD(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // LDA.L DATA_0DB3BB,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tileId = cur.rom.readByte(tableAddr + H) ?? 0

  setPage1(cur) // Sta1To6ePointer
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
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  const X = cur.objNo - 0x18

  // LDA.L DATA_0DB3DB,X at handler offset +29 (operand at +30)
  // LDA.L DATA_0DB3DF,X at handler offset +46 (operand at +47)
  const addrTop = readLongOperand(cur, cur.handlerAddr + 30)
  const addrBot = readLongOperand(cur, cur.handlerAddr + 47)
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const botTile = cur.rom.readByte(addrBot + X) ?? 0

  setPage0(cur) // StzTo6ePointer
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
  const widthM1 = cur.size & 0x0f

  // LDA.L DATA_0DB42B,X at handler offset +25 (operand at +26).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 26)
  const row0Tile = cur.rom.readByte(tableAddr + 0) ?? 0
  const row1Tile = cur.rom.readByte(tableAddr + 1) ?? 0

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
  const widthM1 = cur.size & 0x0f
  const height = (cur.size >> 4) & 0x0f

  // LDA #$0B immediate at handler +28 (opcode A9 at +27)
  // LDA #$0E immediate at handler +51 (opcode A9 at +50)
  const midTile = readImmByte(cur, cur.handlerAddr + 28)
  const endTile = readImmByte(cur, cur.handlerAddr + 51)

  setPage0(cur)
  saveBookmark(cur)
  for (let r = 0; r < height; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, midTile)
    }
    restoreBookmark(cur)
    nextRow(cur)
  }
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, endTile)
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
 * port writes the raw table values - adequate for rendering without stitching.
 */
export function handle_0DB075(cur: Cursor): void {
  const base = cur.handlerAddr
  const X = cur.size & 0x0f
  let count = (cur.size >> 4) & 0x0f

  // LDA.L operands within CODE_0DB075:
  //   +26  DATA_0DB039 (top)   +60  DATA_0DB048 (row 1)
  //   +94  DATA_0DB057 (mid)   +117 DATA_0DB066 (footer)
  const addrTop = readLongOperand(cur, base + 26)
  const addrRow1 = readLongOperand(cur, base + 60)
  const addrMid = readLongOperand(cur, base + 94)
  const addrFooter = readLongOperand(cur, base + 117)
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const row1Tile = cur.rom.readByte(addrRow1 + X) ?? 0
  const middleTile = cur.rom.readByte(addrMid + X) ?? 0
  const footerTile = cur.rom.readByte(addrFooter + X) ?? 0

  // JSR CODE_0DB114 operand at +30; JSR CODE_0DB198 operand at +64.
  // Bank is same as CODE_0DB075.
  const bank = base & 0xff0000
  const merge114Addr =
    bank | ((cur.rom.readByte(base + 31) ?? 0) << 8) | (cur.rom.readByte(base + 30) ?? 0)
  const merge198Addr =
    bank | ((cur.rom.readByte(base + 65) ?? 0) << 8) | (cur.rom.readByte(base + 64) ?? 0)

  // Row 0 page: page 0 if X < 3, else page 1.
  if (X < 3) setPage0(cur)
  else setPage1(cur)
  writeTileMergeCODE_0DB114(cur, merge114Addr, X, topTile)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0b) {
      setPage1(cur)
      writeTile(cur, footerTile)
    }
    return
  }

  const rowPage1 = (X >= 3 && X <= 6) || X >= 9

  if (rowPage1) setPage1(cur)
  else setPage0(cur)
  writeTileMergeCODE_0DB198(cur, merge198Addr, X, row1Tile)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0b) {
      setPage1(cur)
      writeTile(cur, footerTile)
    }
    return
  }

  while (count >= 0) {
    if (rowPage1) setPage1(cur)
    else setPage0(cur)
    writeTileMergeCODE_0DB198(cur, merge198Addr, X, middleTile)
    cur.row += 1
    count -= 1
  }

  if (X >= 0x0b) {
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

  // LDA.L DATA_0DB569,X at handler offset +11 (operand at +12).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur) // StzTo6ePointer
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

/**
 * CODE_0DB49E (bank_0D.asm line 3585) -- vertical pipe (object 31 = std $1F).
 *
 * 1-wide vertical pipe of (_0+2) tiles: top merged, body, bottom merged. Tile
 * from DATA_0DB49C[X] where X = size low nibble; _0 = size high nibble = body
 * row count. Top via CODE_0DB4D9 and bottom via CODE_0DB4FE are context-merge
 * writes that swap different IDs when the existing cell is $08 or $0E, letting
 * adjacent pipes fuse visually.
 *
 * All addresses/immediates are read from the handler's own bytecode so that
 * LM-patched ROMs (which may relocate data tables by patching LDA.L operands)
 * still resolve correctly.
 *
 * Byte layout at cur.handlerAddr:
 *   +0..14  LDY/LDA/LSR×4/STA/LDA/AND/TAX  (state setup)
 *   +15     $BF opcode (LDA.L abs,X)
 *   +16..18 operand: address of DATA_0DB49C  (pipe tile table)
 *   +19..21 JSR CODE_0DB4D9 (top merge)
 *   +22..24 JMP CODE_0DB4C0
 *   +25..   CODE_0DB4B7 body-write branch
 *   +34..   CODE_0DB4C0 loop
 *   +34+18..20  JMP CODE_0DB4FE opcode at +52, operand at +53..+54
 */
export function handle_0DB49E(cur: Cursor): void {
  const base = cur.handlerAddr
  const dataTableAddr = readLongOperand(cur, base + 16)
  const topMergeAddr = resolveJsrTarget(cur, base + 19)
  const bottomMergeAddr = resolveJmpTarget(cur, base + 34 + 18)

  const middleCount = (cur.size >> 4) & 0x0f
  const X = cur.size & 0x0f
  const pipeTile = cur.rom.readByte(dataTableAddr + X) ?? 0

  // Top row: CODE_0DB4D9 context merge.
  writeVerticalPipeMerge(cur, topMergeAddr, X, pipeTile)

  // Middle rows. ASM flow: row++; DEC _0; BNE body; else fall through to
  // bottom merge. BNE exits when _0 reaches 0, so we break on _0 === 0 AFTER
  // the decrement (before writing a body for that iteration).
  let _0 = middleCount
  for (;;) {
    cur.row += 1
    _0 -= 1
    if (_0 === 0) break
    setPage0(cur)
    writeTile(cur, pipeTile)
  }

  // Bottom row: CODE_0DB4FE context merge.
  writeVerticalPipeMerge(cur, bottomMergeAddr, X, pipeTile)
}

/**
 * Context-merge write for CODE_0DB4D9 / CODE_0DB4FE.
 *
 * Both helpers have identical structure -- only their data tables and trigger
 * bytes differ. We read both from the helper's own bytecode:
 *
 *   +0..3    STA _C; LDA [Map16LowPtr],Y
 *   +4..5    CMP #$XX    (first trigger immediate at +5)
 *   +6..7    BNE branch
 *   +8..11   LDA.L $XXXXXX,X    (first data table operand at +9..11)
 *   +12..14  JMP CODE_0DBxxx
 *   +15..16  CMP #$XX    (second trigger immediate at +16)
 *   +17..18  BNE branch
 *   +19..22  LDA.L $XXXXXX,X    (second data table operand at +20..22)
 */
function writeVerticalPipeMerge(
  cur: Cursor,
  helperAddr: number,
  X: number,
  baseTile: number,
): void {
  const trigger1 = readImmByte(cur, helperAddr + 5)
  const table1 = readLongOperand(cur, helperAddr + 9)
  const trigger2 = readImmByte(cur, helperAddr + 16)
  const table2 = readLongOperand(cur, helperAddr + 20)

  const existing = readExistingLow(cur)
  let out = baseTile
  if (existing === trigger1) {
    out = cur.rom.readByte(table1 + X) ?? baseTile
  } else if (existing === trigger2) {
    out = cur.rom.readByte(table2 + X) ?? baseTile
  }
  setPage0(cur) // ASM StzTo6ePointer before the write
  writeTile(cur, out)
}

function readExistingLow(cur: Cursor): number {
  const row = cur.grid[cur.row]
  if (!row) return 0x25
  const v = row[cur.col]
  if (v === undefined) return 0x25
  return v & 0xff
}

/**
 * Resolve a JSR $XXXX (absolute, same-bank) target.
 * opcodeAddr points at the $20 opcode; the 2-byte operand follows at +1.
 * Bank comes from the calling handler (same bank for JSR).
 */
function resolveJsrTarget(cur: Cursor, opcodeAddr: number): number {
  const lo = cur.rom.readByte(opcodeAddr + 1) ?? 0
  const hi = cur.rom.readByte(opcodeAddr + 2) ?? 0
  const bank = opcodeAddr & 0xff0000
  return bank | (hi << 8) | lo
}

/** Resolve a JMP $XXXX (absolute, same-bank) target. Same layout as JSR. */
function resolveJmpTarget(cur: Cursor, opcodeAddr: number): number {
  return resolveJsrTarget(cur, opcodeAddr)
}

/**
 * CODE_0DBA0A (bank_0D.asm line 4346) -- wide vertical pipe (object 57 = std $39).
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = width-1
 *   H (high nibble) = height-1 (applies to body rows only; top row always drawn)
 *
 * Top row: $0E page 1 across (W+1) tiles.
 * Body rows: $B8 page 0 across (W+1) tiles, repeated (H+1) times.
 *
 * Unlike CODE_0DB49E this has no bottom cap - the body just extends and the
 * pipe meets whatever terrain follows below (ground, etc.).
 */
export function handle_0DBA0A(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  let heightM1 = (cur.size >> 4) & 0x0f

  // LDA #$0E (top-row tile, page 1) immediate at handler +24 (opcode at +23)
  // LDA #$B8 (body-row tile, page 0) immediate at handler +38 (opcode at +37)
  const topTile = readImmByte(cur, cur.handlerAddr + 24)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 38)

  saveBookmark(cur)

  for (let c = 0; c <= widthM1; c++) {
    setPage1(cur)
    writeTileAdvance(cur, topTile)
  }

  while (heightM1 >= 0) {
    restoreBookmark(cur)
    cur.row += 1
    for (let c = 0; c <= widthM1; c++) {
      setPage0(cur)
      writeTileAdvance(cur, bodyTile)
    }
    heightM1 -= 1
  }
}

/**
 * CODE_0DB51F (bank_0D.asm line 3666) -- 3-segment vertical pipe-end piece (object 32).
 *
 * Size high nibble = X = height count. Writes $53 at top, $54 (X-1) times in the
 * middle, $55 at bottom. If X is 0 the loop writes nothing in the middle.
 */
export function handle_0DB51F(cur: Cursor): void {
  // ASM flow: write top $53; row++; DEX; BNE middle-loop; write bottom $55.
  // Middle loop entry re-writes $54 and re-DEXes. Total rows = X+1:
  //   X=1 → top + bot             (2 rows)
  //   X=2 → top + 1 mid + bot     (3 rows)
  //   X=3 → top + 2 mid + bot     (4 rows)
  const X = (cur.size >> 4) & 0x0f
  const topTile = readImmByte(cur, cur.handlerAddr + 15)
  const midTile = readImmByte(cur, cur.handlerAddr + 23)
  const bottomTile = readImmByte(cur, cur.handlerAddr + 36)
  setPage1(cur)
  writeTile(cur, topTile)
  // (X - 1) middle rows - X=2 writes 1 middle, X=1 writes 0 middles, etc.
  for (let i = 1; i < X; i++) {
    cur.row += 1
    writeTile(cur, midTile)
  }
  cur.row += 1
  writeTile(cur, bottomTile)
}

/**
 * CODE_0DB547 (bank_0D.asm line 3691) -- 3-segment horizontal run (object 33).
 *
 * Size low nibble = X = width count. Writes $56 (left cap), $57 (X-1 times
 * middle), $58 (right cap). Column advances normally.
 */
export function handle_0DB547(cur: Cursor): void {
  const X = cur.size & 0x0f
  // LDA #$56/$57/$58 immediates at handler +11/+19/+30 (opcodes at +10/+18/+29)
  const leftTile = readImmByte(cur, cur.handlerAddr + 11)
  const midTile = readImmByte(cur, cur.handlerAddr + 19)
  const rightTile = readImmByte(cur, cur.handlerAddr + 30)
  setPage1(cur)
  writeTileAdvance(cur, leftTile)
  let count = X
  while (count > 1) {
    writeTileAdvance(cur, midTile)
    count -= 1
  }
  writeTile(cur, rightTile)
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
  const W = cur.size & 0x0f
  const X = (cur.size >> 4) & 0x0f
  // LDA.L DATA_0DB5A8,X operand at handler offset +19 (opcode $BF at +18)
  // LDA.L DATA_0DB5AD,X operand at handler offset +29 (opcode at +28)
  // LDA.L DATA_0DB5B2,X operand at handler offset +43 (opcode at +42)
  const addrLeft = readLongOperand(cur, cur.handlerAddr + 19)
  const addrMiddle = readLongOperand(cur, cur.handlerAddr + 29)
  const addrRight = readLongOperand(cur, cur.handlerAddr + 43)
  const leftCap = cur.rom.readByte(addrLeft + X) ?? 0
  const middle = cur.rom.readByte(addrMiddle + X) ?? 0
  const rightCap = cur.rom.readByte(addrRight + X) ?? 0

  setPage0(cur) // StzTo6ePointer
  writeTileAdvance(cur, leftCap)
  let count = W
  while (count > 1) {
    writeTileAdvance(cur, middle)
    count -= 1
  }
  if (W === 0) return // avoid writing the right cap when the ASM would loop forever
  writeTile(cur, rightCap)
}

/**
 * CODE_0DB224 (bank_0D.asm line 3234) -- 3-column framed vertical structure (object 21).
 *
 * Used for the midway-post base, donut-plateau columns, etc.
 *
 * Size byte: HHHHVVVV
 *   V (low nibble)  = variant flag. V=0 uses DATA_0DB212/15/18 (primary set);
 *                     V!=0 uses DATA_0DB21B/1E/21 (alternate set).
 *   H (high nibble) = body-height counter (_1 in ASM). Total rows = H + 1.
 *
 * Per column X in 0..2 the ASM runs:
 *   1. Write top[X]; advance row; DEC _1; BEQ to bot write (skips middle loop).
 *   2. If _1 didn't hit 0: middle loop - write mid[X]; advance row; DEC _1;
 *      BNE to loop head. Runs H-1 times for a total of H-1 middle writes.
 *   3. Write bot[X] at the final row.
 *
 * Net per column: 1 top + (H-1) middles + 1 bot = H+1 rows. For H=1 that is
 * just {top, bot}. An earlier version of this port wrote one extra middle row
 * (H middles instead of H-1), which shifted the midway pole's base tile down
 * by one row vs the real SMW output.
 */
export function handle_0DB224(cur: Cursor): void {
  const V = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // LDA.L operands inside CODE_0DB224 (6 total):
  //   V=0 branch:  +24  DATA_0DB212  (top)
  //                +66  DATA_0DB215  (mid)
  //                +108 DATA_0DB218  (bot)
  //   V!=0 branch: +34  DATA_0DB21B  (top)
  //                +76  DATA_0DB21E  (mid)
  //                +118 DATA_0DB221  (bot)
  const topV0 = readLongOperand(cur, cur.handlerAddr + 24)
  const midV0 = readLongOperand(cur, cur.handlerAddr + 66)
  const botV0 = readLongOperand(cur, cur.handlerAddr + 108)
  const topV1 = readLongOperand(cur, cur.handlerAddr + 34)
  const midV1 = readLongOperand(cur, cur.handlerAddr + 76)
  const botV1 = readLongOperand(cur, cur.handlerAddr + 118)
  const top = V === 0 ? topV0 : topV1
  const mid = V === 0 ? midV0 : midV1
  const bot = V === 0 ? botV0 : botV1

  setPage0(cur)
  const origCol = cur.col
  const origRow = cur.row
  for (let X = 0; X < 3; X++) {
    cur.col = origCol + X
    cur.row = origRow
    // TOP row (always).
    writeTile(cur, cur.rom.readByte(top + X) ?? 0)
    // Middle rows: H-1 of them. The ASM's post-TOP `DEC _1; BEQ CODE_0DB28F`
    // skips the middle loop entirely when H == 1, so there are no middle
    // rows in that case. Middle loop `DEC _1; BNE` runs until _1 hits 0,
    // giving H-1 middle writes.
    for (let r = 0; r < H - 1; r++) {
      cur.row += 1
      writeTile(cur, cur.rom.readByte(mid + X) ?? 0)
    }
    // BOT row.
    cur.row += 1
    writeTile(cur, cur.rom.readByte(bot + X) ?? 0)
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
  // The ASM reduces low nibble modulo 10 (CODE_0DAB42 loop), then does
  // JSL ExecutePtrLong which reads a 3-byte long pointer from the table
  // immediately after the JSL. That table lives at cur.handlerAddr + 18.
  const variant = (cur.size & 0x0f) % 10
  const tableBase = cur.handlerAddr + 18
  const target = readLongOperand(cur, tableBase + variant * 3) & 0xffffff

  // Run each variant handler with its own handlerAddr so that its LDA.L
  // and LDA # operands resolve correctly against its own bytecode.
  // A gated variant is drawn from the interpreter; a refusal falls to the port.
  if (cur.draw && isInterpretedHandler(target) && drawInterpreted(cur, target, cur.draw)) return
  const prevHandler = cur.handlerAddr
  cur.handlerAddr = target
  try {
    PIPE_VARIANT_HANDLERS[target & 0x7fffff]?.(cur)
  } finally {
    cur.handlerAddr = prevHandler
  }
}

/** Registry mapping each pipe-variant's SNES start address to its TS port.
 *  handle_0DAB3E looks up the target from the ROM dispatch table and calls
 *  the function here. */
const PIPE_VARIANT_HANDLERS: Record<number, (cur: Cursor) => void> = {
  0x0dab6e: pipeVariant0,
  0x0dac21: pipeVariant1,
  0x0dac92: pipeVariant2,
  0x0dad44: pipeVariant3,
  0x0dada3: pipeVariant4,
  0x0dadeb: pipeVariant5,
  0x0dae6d: pipeVariant6,
  0x0daefc: pipeVariant7,
  0x0daf61: pipeVariant8,
  0x0dafea: pipeVariant9,
}

/**
 * Variant 0 -- CODE_0DAB6E (bank_0D line 2301).
 *
 * Diagonal down-left slope, 2-wide lip/body pair descending col-2 / row+1
 * per iteration. A final straight-down body row at the bottom flattens the
 * slope into the ground. (Previously mis-classified as "vertical pipe".)
 *
 * Shape for size $HW (H = high nibble; heightCount = H + 1):
 *   iter 0:   lip pair at (col0,         row0)                   -- 2 tiles
 *   iter 1:   lip pair at (col0-2,       row0+1), body pair col0 -- 4 tiles
 *   iter 2:   lip pair at (col0-4,       row0+2), body pair + 2 fills
 *   ...
 *   iter N-1: lip pair at (col0-2(N-1),  row0+N-1), body + 2(N-2) fills
 *   final:    body pair at (col0-2(N-1), row0+N) + 2(N-1) fills
 *
 * ASM control flow: saveBookmark once; between lip iters,
 * `LevelLoadPos += $0E` (col-2 row+1); on _0 hitting 0, BEQ into CODE_0DABEC
 * which calls CODE_0DA97D (row+=1 only, no diagonal) and JMPs into the
 * body/fill phase WITHOUT a lip write.
 *
 * Width counter `_2` starts at 1 and grows by 2 per iter (tracking body+fill
 * length per row).
 */
function pipeVariant0(cur: Cursor): void {
  const heightCount = ((cur.size >> 4) & 0x0f) + 1
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DAB6E inline immediates:
  //   +27 $96, +35 $9B (lip pair, pipe-merged via CODE_0DABFD)
  //   +47 $DE, +55 $E6 (body pair, page 1, plain write)
  //   hardcoded $3F (fill, page 0, plain write inside the `-` label)
  const lipL = readImmByte(cur, cur.handlerAddr + 27)
  const lipR = readImmByte(cur, cur.handlerAddr + 35)
  const bodL = readImmByte(cur, cur.handlerAddr + 47)
  const bodR = readImmByte(cur, cur.handlerAddr + 55)
  const fillTile = 0x3f // inline LDA #$3F in the fill-writer branch

  // Lip phase. Iter i at (col0 - 2i, row0 + i). X at iter entry = _2 = 1 + 2i.
  //   i = 0: X = 1. Write lip pair. DEX DEX -> -1. BMI. No body.
  //   i = 1: X = 3. Lip. DEX DEX -> 1. Body pair. DEX -> 0. JMP body-exit. DEX -> -1. Exit.
  //   i = 2: X = 5. Lip. DEX DEX -> 3. Body. DEX -> 2. JMP body-exit. DEX -> 1. Fill. DEX -> 0. Fill. DEX -> -1.
  // Body+fill count: i=0 -> 0; i>=1 -> body (2 tiles) + 2*(i-1) fills.
  for (let i = 0; i < heightCount; i++) {
    cur.col = col0 - 2 * i
    cur.row = row0 + i
    setPage1(cur)
    writeTilePipeMerge(cur, lipL)
    setPage1(cur)
    writeTilePipeMerge(cur, lipR)
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, bodL)
      setPage1(cur)
      writeTileAdvance(cur, bodR)
      for (let k = 0; k < 2 * (i - 1); k++) {
        setPage0(cur)
        writeTileAdvance(cur, fillTile)
      }
    }
  }

  // Final body row (CODE_0DABEC -> CODE_0DA97D -> CODE_0DAB99).
  // X at CODE_0DABEC entry = _2 = 1 + 2*heightCount. DEX DEX -> 2*heightCount - 1.
  // Write body pair. DEX -> 2*heightCount - 2. JMP body-exit. DEX -> 2*heightCount - 3.
  // Loop fills until X = -1. Total fills = 2*(heightCount - 1).
  cur.col = col0 - 2 * (heightCount - 1)
  cur.row = row0 + heightCount
  setPage1(cur)
  writeTileAdvance(cur, bodL)
  setPage1(cur)
  writeTileAdvance(cur, bodR)
  for (let k = 0; k < 2 * (heightCount - 1); k++) {
    setPage0(cur)
    writeTileAdvance(cur, fillTile)
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 1 -- CODE_0DAC21 (bank_0D line 2412).
 *
 * Diagonal down-left slope: 1-wide lip column descending col-1 / row+1 per
 * iteration, with body ($E2) and dirt fills ($3F) trailing to the right of
 * each new lip row. A final straight-down body row at the bottom flattens
 * the slope into ground.
 *
 * Shape for size $HW (H = high nibble; heightCount = H + 1):
 *   iter 0: lip at (col0,      row0)                          -- 1 tile
 *   iter 1: lip at (col0-1,    row0+1), body at col0          -- 2 tiles
 *   iter 2: lip at (col0-2,    row0+2), body + 1 fill         -- 3 tiles
 *   ...
 *   iter N-1: lip at (col0-N+1, row0+N-1), body + N-2 fills   -- N tiles
 *   final:    body at (col0-N+1, row0+N), plus N-1 fills      -- N tiles (no lip)
 *
 * ASM control-flow: saveBookmark once; accumulate `LevelLoadPos += $0F` (col-1
 * row+1) between lip iters; on _0 hitting 0, BEQ into CODE_0DAC89 which calls
 * CODE_0DA97D (row++ only, no diagonal) and JMPs into the body/fill phase
 * WITHOUT a lip write. Previously mis-ported (bookmark re-saved per iter) so
 * the final straight-down row landed one col and one row off.
 */
function pipeVariant1(cur: Cursor): void {
  const heightCount = ((cur.size >> 4) & 0x0f) + 1
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DAC21 inline immediates:
  //   +25 $AA (lip, pipe-merged via CODE_0DABFD)
  //   +36 $E2 (body, page 1, plain write)
  //   +47 $3F (fill, page 0, plain write)
  const lipTile = readImmByte(cur, cur.handlerAddr + 25)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 36)
  const fillTile = readImmByte(cur, cur.handlerAddr + 47)

  // Lip phase: iter i at (col0 - i, row0 + i). X = _2 = i at entry, so:
  //   i = 0: X = 0. DEX -> -1. BMI. No body/fills.
  //   i >= 1: 1 body + (i - 1) fills.
  for (let i = 0; i < heightCount; i++) {
    cur.col = col0 - i
    cur.row = row0 + i
    setPage1(cur)
    writeTilePipeMerge(cur, lipTile)
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, bodyTile)
      for (let k = 0; k < i - 1; k++) {
        setPage0(cur)
        writeTileAdvance(cur, fillTile)
      }
    }
  }

  // Straight-down body row (CODE_0DAC89 -> CODE_0DAC3E).
  // Position: row0 + heightCount, col shifted by (heightCount - 1) since
  // LevelLoadPos has accumulated (heightCount - 1) diagonal steps before
  // BEQ fires, plus one straight row++.
  // X entering body phase = _2 = heightCount. DEX at CODE_0DAC3E -> heightCount - 1.
  // Write body. DEX at CODE_0DAC54 -> heightCount - 2. Loop writes (heightCount - 1) fills total.
  cur.col = col0 - (heightCount - 1)
  cur.row = row0 + heightCount
  setPage1(cur)
  writeTileAdvance(cur, bodyTile)
  for (let k = 0; k < heightCount - 1; k++) {
    setPage0(cur)
    writeTileAdvance(cur, fillTile)
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 2 -- CODE_0DAC92 (bank_0D line 2480).
 *
 * Wide 4-tile diagonal pipe sloping down-left. Each lip iteration shifts the
 * 4-wide lip group (6E/73/78/7D) left by 4 columns and down by 1 row.
 * Iterations i >= 1 also write a body section (D8/DA/E6/E6 + fills) to the
 * right of the lip group on that same row. After all lip iterations a final
 * straight body row is written one row below the last lip row.
 *
 * ASM control-flow (CODE_0DAC92): _0 = (size>>4)+1, _2 = 3.
 *   - Each CODE_0DACA7 pass: write 4 lips, DEX x4. If X < 0 (iter 0): BMI to
 *     CODE_0DAD00. Otherwise (iter >= 1): fall into CODE_0DACCF body section.
 *   - CODE_0DAD00: restore bookmark, _2 += 4, DEC _0. If _0==0: CODE_0DAD37
 *     (straight row++ + final body). If _0>0: LevelLoadPos += $0C (col-4,row+1)
 *     diagonal step, JMP CODE_0DACA7.
 *   - CODE_0DAD37: LDX _2, DEX x4, CODE_0DA97D (row+1 only), JMP CODE_0DACCF.
 *
 * Shape for N = (size>>4)+1:
 *   iter i (0..N-1): lips at (col0-4i, row0+i)
 *   iter i>=1:       bodies at (col0-4i+4, row0+i); filler x 4*(i-1)
 *   final row:       bodies at (col0-4*(N-1), row0+N); filler x 4*(N-1)
 *
 * Inline immediates from CODE_0DAC92: +27=$6E, +35=$73, +43=$78, +51=$7D
 * (lips); +65=$D8, +73=$DA, +81=$E6, +89=$E6 (bodies); +103=$3F (filler).
 */
function pipeVariant2(cur: Cursor): void {
  const N = ((cur.size >> 4) & 0x0f) + 1
  const col0 = cur.col,
    row0 = cur.row

  const lip1 = readImmByte(cur, cur.handlerAddr + 27)
  const lip2 = readImmByte(cur, cur.handlerAddr + 35)
  const lip3 = readImmByte(cur, cur.handlerAddr + 43)
  const lip4 = readImmByte(cur, cur.handlerAddr + 51)
  const body1 = readImmByte(cur, cur.handlerAddr + 65)
  const body2 = readImmByte(cur, cur.handlerAddr + 73)
  const body3 = readImmByte(cur, cur.handlerAddr + 81)
  const body4 = readImmByte(cur, cur.handlerAddr + 89)
  const fillTile = readImmByte(cur, cur.handlerAddr + 103)

  for (let i = 0; i < N; i++) {
    // Lip group at (col0-4i, row0+i).
    cur.col = col0 - 4 * i
    cur.row = row0 + i
    setPage1(cur)
    writeTilePipeMerge(cur, lip1)
    setPage1(cur)
    writeTilePipeMerge(cur, lip2)
    setPage1(cur)
    writeTilePipeMerge(cur, lip3)
    setPage1(cur)
    writeTilePipeMerge(cur, lip4)
    // Body+filler section only for iterations i >= 1. The cursor is now at
    // col0-4i+4 (right after the lip group). ASM X = _2-4 = 4*i-1 >= 0.
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, body1)
      setPage1(cur)
      writeTileAdvance(cur, body2)
      setPage1(cur)
      writeTileAdvance(cur, body3)
      setPage1(cur)
      writeTileAdvance(cur, body4)
      // Filler: 4*(i-1) tiles. ASM DEX x3 + JMP DACFD loop: net (4*i-1-3) = 4*(i-1) fills.
      for (let k = 0; k < 4 * (i - 1); k++) {
        setPage0(cur)
        writeTileAdvance(cur, fillTile)
      }
    }
  }

  // Final straight body row (CODE_0DAD37): one row below last lip group,
  // same starting column as that lip group. Width = 4*N tiles: 4 body + 4*(N-1) fills.
  cur.col = col0 - 4 * (N - 1)
  cur.row = row0 + N
  setPage1(cur)
  writeTileAdvance(cur, body1)
  setPage1(cur)
  writeTileAdvance(cur, body2)
  setPage1(cur)
  writeTileAdvance(cur, body3)
  setPage1(cur)
  writeTileAdvance(cur, body4)
  for (let k = 0; k < 4 * (N - 1); k++) {
    setPage0(cur)
    writeTileAdvance(cur, fillTile)
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 3 -- CODE_0DAD44 (bank_0D line 2580).
 *
 * Diagonal down-right slope that widens each row. The 2-wide lip pair
 * (`$A0/$A5`, pipe-merged) shifts 2 cols right every row while a 2-wide
 * mid-body pair (`$E6/$E0`) fills in behind the lip. Each subsequent row
 * adds two dirt fills on the left. The final row omits the trailing lip,
 * leaving the slope to flatten into the ground.
 *
 * Shape for size $HW (H = high nibble; rowCount = H + 2):
 *   row 0: A0 A5                                        at cols (col0, col0+1)
 *   row 1: E6 E0 A0 A5                                  at cols (col0..col0+3)
 *   row 2: 3F 3F E6 E0 A0 A5                            at cols (col0..col0+5)
 *   ...
 *   row N-2: 3F... E6 E0 A0 A5                           at cols (col0..col0+2N-3)
 *   row N-1 (final): 3F... E6 E0                         at cols (col0..col0+2N-3), no lip
 *
 * ASM control flow: first row JMPs to `CODE_0DAD7F` which writes just the
 * lip pair; subsequent rows enter `CODE_0DAD65` where `CPX #$03` eats
 * (X - 3) fills before falling through to the mid pair, and then (when
 * `_0 > 0`) falls into `CODE_0DAD7F` again to append the lip pair. The
 * last iteration's `BEQ Return0DAD9F` skips the trailing lip.
 */
function pipeVariant3(cur: Cursor): void {
  const highNibble = (cur.size >> 4) & 0x0f
  const rowCount = highNibble + 2
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DAD44 inline immediates:
  //   +28 $3F (fill, page 0, plain write)
  //   +41 $E6, +49 $E0 (mid pair, page 1, plain write)
  //   +63 $A0, +71 $A5 (lip pair, page 1, pipe-merged via CODE_0DABFD)
  const fillTile = readImmByte(cur, cur.handlerAddr + 28)
  const midL = readImmByte(cur, cur.handlerAddr + 41)
  const midR = readImmByte(cur, cur.handlerAddr + 49)
  const lipL = readImmByte(cur, cur.handlerAddr + 63)
  const lipR = readImmByte(cur, cur.handlerAddr + 71)

  // Row 0: just the pipe-merged lip pair.
  cur.col = col0
  cur.row = row0
  setPage1(cur)
  writeTilePipeMerge(cur, lipL)
  setPage1(cur)
  writeTilePipeMerge(cur, lipR)

  // Rows 1..rowCount-1. Each writes 2*(i-1) dirt fills, then the mid pair,
  // then (if not the last row) the pipe-merged lip pair. All row starts at col0.
  for (let i = 1; i < rowCount; i++) {
    cur.col = col0
    cur.row = row0 + i
    const fillCount = 2 * (i - 1)
    for (let j = 0; j < fillCount; j++) {
      setPage0(cur)
      writeTileAdvance(cur, fillTile)
    }
    setPage1(cur)
    writeTileAdvance(cur, midL)
    setPage1(cur)
    writeTileAdvance(cur, midR)
    if (i < rowCount - 1) {
      setPage1(cur)
      writeTilePipeMerge(cur, lipL)
      setPage1(cur)
      writeTilePipeMerge(cur, lipR)
    }
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 4 -- CODE_0DADA3 (bank_0D line 2631).
 *
 * Diagonal pipe sloping up-left: tip at upper-left cursor, shape extends
 * down-right forming a right triangle with the diagonal lip on the right
 * edge. The ASM's loop structure draws one lip per `CODE_0DADD0` visit,
 * with `CODE_0DADC4` writing the pre-lip tiles (dirts + body) for each new
 * row. After the final lip, one more `CODE_0DADC4` runs without a trailing
 * lip -- producing an extra row of dirts+body at the bottom that flattens
 * the slope into the ground.
 *
 * For size `0xHW` (W ignored here; height count = H+1):
 *   row 0: lip
 *   row i (1 ≤ i ≤ H): (i-1) dirts, body, lip
 *   row H+1: H dirts, body (no lip)  ← ground-merge row
 */
function pipeVariant4(cur: Cursor): void {
  const bodyCount = ((cur.size >> 4) & 0x0f) + 1
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DADA3 inline immediates: +28 $3F (filler), +41 $E4 (body),
  // +53 $AF (lip via CODE_0DABFD merge).
  const fillTile = readImmByte(cur, cur.handlerAddr + 28)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 41)
  const lipTile = readImmByte(cur, cur.handlerAddr + 53)

  // Rows 0..bodyCount-1: each ends in a lip.
  for (let i = 0; i < bodyCount; i++) {
    cur.row = row0 + i
    cur.col = col0
    for (let j = 0; j < i - 1; j++) {
      setPage0(cur)
      writeTileAdvance(cur, fillTile)
    }
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, bodyTile)
    }
    setPage1(cur)
    writeTilePipeMergeNoAdvance(cur, lipTile)
  }

  // Final `CODE_0DADC4` pass after the last lip: writes bodyCount-1 dirts
  // then the body, no lip. This row overwrites any grass/terrain beneath
  // the slope's base, flattening it into the adjacent ground plane.
  cur.row = row0 + bodyCount
  cur.col = col0
  for (let j = 0; j < bodyCount - 1; j++) {
    setPage0(cur)
    writeTileAdvance(cur, fillTile)
  }
  setPage1(cur)
  writeTileAdvance(cur, bodyTile)

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 5 -- CODE_0DADEB (bank_0D line 2671).
 * 4-wide vertical pipe. Top: $82/$87/$8C/$91. Body: $E6/$E6/$DB/$DC.
 */
function pipeVariant5(cur: Cursor): void {
  const bodyCount = ((cur.size >> 4) & 0x0f) + 1
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DADEB inline immediates: +79 $82, +87 $87, +95 $8C, +103 $91 (top
  // lip tiles through CODE_0DABFD); +39 $E6, +47 $E6, +55 $DB, +63 $DC (body).
  const topTiles = [
    readImmByte(cur, cur.handlerAddr + 79),
    readImmByte(cur, cur.handlerAddr + 87),
    readImmByte(cur, cur.handlerAddr + 95),
    readImmByte(cur, cur.handlerAddr + 103),
  ]
  const bodyTiles = [
    readImmByte(cur, cur.handlerAddr + 39),
    readImmByte(cur, cur.handlerAddr + 47),
    readImmByte(cur, cur.handlerAddr + 55),
    readImmByte(cur, cur.handlerAddr + 63),
  ]

  for (let c = 0; c < 4; c++) {
    cur.col = col0 + c
    setPage1(cur)
    writeTilePipeMergeNoAdvance(cur, topTiles[c])
  }

  for (let r = 1; r <= bodyCount; r++) {
    cur.row = row0 + r
    for (let c = 0; c < 4; c++) {
      cur.col = col0 + c
      setPage1(cur)
      writeTile(cur, bodyTiles[c])
    }
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 6 -- CODE_0DAE6D (bank_0D line 2738).
 * Diagonal pipe sloping down-right. Builds a staircase shape stepping +2 cols
 * per row. _0 = size >> 4 (high nibble). _2 = 2*_0 - 1.
 *
 * Row 0 (body only, first pass jumps to CODE_0DAE9E):
 *   body($EE/$F0) at col0, then (_2-1) fill($65) tiles = 2*(_0-1) fills.
 * Rows 1.._0 (lip+body passes at CODE_0DAE88):
 *   lip($C6/$C7) at col0+2*(r-1); if _2-2>=0: body+fills; _2 -= 2 each row.
 *
 * ASM: CODE_0DA6BA (restoreBookmark) resets col0 each pass, but the diagonal
 * step (ADC #$12) also calls CODE_0DA9EF which updates _4/_5 to track the
 * shifted column. So in the flat model each lip row starts at col0+2*(r-1).
 */
function pipeVariant6(cur: Cursor): void {
  const _0 = (cur.size >> 4) & 0x0f // number of lip rows
  const col0 = cur.col,
    row0 = cur.row

  // CODE_0DAE6D inline immediates (verified against ROM bytes at $0DAE6D):
  //   +33 $C6  +41 $C7  (lip pair, page 1)
  //   +53 $EE  +61 $F0  (body pair, page 1)
  //   +73 $65  (filler, page 1)
  const lipL = readImmByte(cur, cur.handlerAddr + 33)
  const lipR = readImmByte(cur, cur.handlerAddr + 41)
  const bodyL = readImmByte(cur, cur.handlerAddr + 53)
  const bodyR = readImmByte(cur, cur.handlerAddr + 61)
  const fillTile = readImmByte(cur, cur.handlerAddr + 73)

  // Row 0: body pair + 2*(_0-1) fills. (_2=2*_0-1; row-0 fill count = _2-1.)
  cur.col = col0
  cur.row = row0
  setPage1(cur)
  writeTileAdvance(cur, bodyL)
  setPage1(cur)
  writeTileAdvance(cur, bodyR)
  for (let f = 0; f < 2 * (_0 - 1); f++) {
    setPage1(cur)
    writeTileAdvance(cur, fillTile)
  }

  // Rows 1.._0: lip at (col0+2*(r-1), row0+r), body+fills as _2 shrinks.
  let _2 = 2 * _0 - 1
  for (let r = 1; r <= _0; r++) {
    cur.col = col0 + 2 * (r - 1)
    cur.row = row0 + r
    setPage1(cur)
    writeTileAdvance(cur, lipL)
    setPage1(cur)
    writeTileAdvance(cur, lipR)
    // After lip DEX DEX: x = _2 - 2. BMI if < 0 → no body/fill.
    let x = _2 - 2
    if (x >= 0) {
      setPage1(cur)
      writeTileAdvance(cur, bodyL)
      setPage1(cur)
      writeTileAdvance(cur, bodyR)
      x -= 1 // DEX after body
      x -= 1 // DEX at CODE_0DAEBA before fill-loop BPL
      while (x >= 0) {
        setPage1(cur)
        writeTileAdvance(cur, fillTile)
        x -= 1
      }
    }
    _2 -= 2
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 7 -- CODE_0DAEFC (bank_0D line 2819).
 * Another diagonal down-right variant. Lip $C8/$C9, intermediate $F0/$EF.
 */
function pipeVariant7(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const col0 = cur.col,
    row0 = cur.row
  let widthCounter = H * 2 + 1

  // CODE_0DAEFC inline immediates (per-row writes):
  //   +31 $65  (filler)
  //   +48 $F0  +56 $EF  (body pair)
  //   +68 $C8  +76 $C9  (lip pair)
  const fillTile = readImmByte(cur, cur.handlerAddr + 31)
  const bodyL = readImmByte(cur, cur.handlerAddr + 48)
  const bodyR = readImmByte(cur, cur.handlerAddr + 56)
  const lipL = readImmByte(cur, cur.handlerAddr + 68)
  const lipR = readImmByte(cur, cur.handlerAddr + 76)

  for (let i = 0; i <= H; i++) {
    let x = widthCounter
    while (x >= 4) {
      setPage1(cur)
      writeTileAdvance(cur, fillTile)
      x -= 1
    }
    if (x >= 2) {
      setPage1(cur)
      writeTileAdvance(cur, bodyL)
      setPage1(cur)
      writeTileAdvance(cur, bodyR)
      // Row 0 (first pass, _1==0 in ASM) has no lip.
      if (i > 0) {
        setPage1(cur)
        writeTileAdvance(cur, lipL)
        setPage1(cur)
        writeTileAdvance(cur, lipR)
      }
    } else {
      // x < 2 (BMI path): final row, only lip.
      setPage1(cur)
      writeTileAdvance(cur, lipL)
      setPage1(cur)
      writeTileAdvance(cur, lipR)
    }
    cur.col = col0
    cur.row += 1
    widthCounter -= 2
  }
  cur.col = col0
  cur.row = row0
}

/**
 * Variant 8 -- CODE_0DAF61 (bank_0D line 2872).
 *
 * Diagonal slope descending to the right: a right-angled triangle with a
 * vertical right edge and a diagonal left edge. The right column is always
 * at col0+H-1 where H = (size>>4) & 0xF. The left edge starts at col0 for
 * rows 0-1, then steps one column right per row from row 2 onward.
 *
 * ASM state: _0 = H, _2 = H-1, _1 = 0, X = H-1.
 *   - Iter 0 (JMP CODE_0DAF88, first pass): writes EC at col0, then H-1 fill
 *     tiles ($65) at col0+1..col0+H-1. After: row-only advance.
 *   - Iter 1 (CODE_0DAF7B): LDX _2 = H-1. Writes C4 (lip) at col0, EC at
 *     col0+1, H-2 fills. After: _2-=1, diagonal (col+1 row+1 via +=11).
 *   - Iter k >= 2 at (col0+k-1, row0+k): LDX _2 = H-k. Writes C4, EC,
 *     then H-k-1 fills. After: _2-=1, diagonal step.
 *
 * All rows end at col0+H-1 (vertical right wall). Total iterations = H+1.
 *
 * Inline immediates (CODE_0DAF61): +32 $C4 (lip), +43 $EC (body), +54 $65 (fill).
 */
function pipeVariant8(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const col0 = cur.col,
    row0 = cur.row

  const lipTile = readImmByte(cur, cur.handlerAddr + 32)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 43)
  const fillTile = readImmByte(cur, cur.handlerAddr + 54)

  for (let i = 0; i <= H; i++) {
    // Set starting col/row per iteration formula.
    // Iter 0 and 1 share the same left column (col0); iter k>=2 steps right.
    cur.col = i <= 1 ? col0 : col0 + i - 1
    cur.row = row0 + i

    if (i === 0) {
      // First pass (JMP CODE_0DAF88): EC body then H-1 fill tiles.
      setPage1(cur)
      writeTileAdvance(cur, bodyTile)
      for (let f = 0; f < H - 1; f++) {
        setPage1(cur)
        writeTileAdvance(cur, fillTile)
      }
    } else {
      // CODE_0DAF7B: write C4 lip, DEX. BMI if _2==0 (i==H) -> skip EC+fills.
      setPage1(cur)
      writeTileAdvance(cur, lipTile)
      if (i < H) {
        // _2 = H-i >= 1 -> fall to CODE_0DAF88: EC body + (H-i-1) fills.
        setPage1(cur)
        writeTileAdvance(cur, bodyTile)
        const fillCount = H - i - 1
        for (let f = 0; f < fillCount; f++) {
          setPage1(cur)
          writeTileAdvance(cur, fillTile)
        }
      }
      // i == H (_2 == 0): only C4 was written; EC+fills skipped by BMI.
    }
  }

  cur.col = col0
  cur.row = row0
}

/**
 * Variant 9 -- CODE_0DAFEA (bank_0D line 2953).
 *
 * Diagonal slope with a vertical left edge and a diagonal right edge,
 * mirroring variant 8's orientation. All rows start at col0; the right edge
 * shrinks by one column per row starting from row 2. Tiles: fill $65 on the
 * left, body $ED in the next-to-last position, lip $C5 at the rightmost.
 *
 * ASM state: _0 = H, _2 = H (NOT H-1 like variant 8), _1 = 0, X = H.
 *   Loop: fill while X>=2 (H-k-1 fills for iter k), ED if X==1, C5 unless
 *   _1==0 (skip on iter 0 only). After each row: _2-=1, row-only advance.
 *
 *   Iter 0: (H-1) fills + ED. No C5. Ends at col0+H-1.
 *   Iter 1: (H-2) fills + ED + C5. Ends at col0+H-1.
 *   Iter k (1<=k<=H-1): (H-k-1) fills + ED + C5. Ends at col0+H-k.
 *   Iter H: C5 only (X=0, skip fills and ED). 1 tile at col0.
 *
 * Inline immediates (CODE_0DAFEA): +28 $65 (fill), +45 $ED (body), +57 $C5 (lip).
 */
function pipeVariant9(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const col0 = cur.col,
    row0 = cur.row

  const fillTile = readImmByte(cur, cur.handlerAddr + 28)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 45)
  const lipTile = readImmByte(cur, cur.handlerAddr + 57)

  for (let i = 0; i <= H; i++) {
    cur.col = col0
    cur.row = row0 + i

    const X = H - i // _2 at start of iteration i

    if (X === 0) {
      // Only C5 lip; ED is skipped when X < 1.
      setPage1(cur)
      writeTileAdvance(cur, lipTile)
    } else {
      // Fill loop: writes while X >= 2, count = X-1 = H-i-1 fills.
      for (let f = 0; f < X - 1; f++) {
        setPage1(cur)
        writeTileAdvance(cur, fillTile)
      }
      // ED body (X == 1 after fill loop).
      setPage1(cur)
      writeTileAdvance(cur, bodyTile)
      // C5 lip on all iterations except iter 0 (_1 == 0 skip).
      if (i > 0) {
        setPage1(cur)
        writeTileAdvance(cur, lipTile)
      }
    }
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
  let X = (cur.size >> 4) & 0x0f
  // LDA #$41/$42/$43 immediates at handler +13/+26/+39 (opcodes at +12/+25/+38).
  const topTile = readImmByte(cur, cur.handlerAddr + 13)
  const midTile = readImmByte(cur, cur.handlerAddr + 26)
  const botTile = readImmByte(cur, cur.handlerAddr + 39)
  setPage1(cur)
  writeTile(cur, topTile)
  cur.row += 1
  X--
  if (X < 0) return
  writeTile(cur, midTile)
  cur.row += 1
  X--
  if (X < 0) return
  while (X >= 0) {
    writeTile(cur, botTile)
    cur.row += 1
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
  const steps = (cur.size >> 4) & 0x0f
  // LDA.L DATA_0DB72F,X operand at handler +27 (opcode $BF at +26).
  // Final capper $EB is LDA # immediate at handler +103 (opcode at +102).
  // Initial _1 value is LDA #$01 immediate at +11 (opcode at +10).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 27)
  const cappingTile = readImmByte(cur, cur.handlerAddr + 103)
  const initialOne = readImmByte(cur, cur.handlerAddr + 11)
  const table = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(
    i => cur.rom.readByte(tableAddr + i) ?? 0,
  )
  const col0 = cur.col,
    row0 = cur.row

  let _1 = initialOne
  let X = 0
  let _0 = steps
  setPage1(cur)

  // Phase 1 loop (CODE_0DB752): continues while X < 6.
  for (;;) {
    let count = _1
    saveBookmark(cur)
    // Inner: write (_1 + 1) tiles, advancing X into DATA_0DB72F each write.
    while (count >= 0) {
      writeTileAdvance(cur, table[X & 0x0f] ?? 0)
      X += 1
      count -= 1
    }
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    _1 += 2
    _0 -= 1
    if (_0 < 0) break
    // ASM: `CPX #$06; BNE CODE_0DB752` - exits Phase 1 only when X == 6 exactly.
    if (X === 6) {
      _1 -= 1
      break
    }
  }

  // Phase 2 loop (CODE_0DB779): continues until _0 < 0.
  if (_0 >= 0) {
    while (_0 >= 0) {
      let count = _1
      saveBookmark(cur)
      while (count >= 0) {
        writeTileAdvance(cur, table[X & 0x0f] ?? 0)
        X += 1
        count -= 1
      }
      restoreBookmark(cur)
      diagonalDownLeft(cur)
      // ASM: `CPX #$10; BNE +; TXA SEC SBC #$05; TAX` - wraps X only when
      // X == $10 exactly (X - 5 = 11, so Phase 2 cycles 11 → 16 → 11 → …).
      if (X === 16) X = X - 5
      _0 -= 1
    }
  }

  // Final capper (CODE_0DB79F): advance one col, write $EB.
  advanceCol(cur)
  setPage1(cur)
  writeTile(cur, cappingTile)

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
  const width = cur.size & 0x0f
  const rightSide = (cur.size >> 4) & 0x0f
  const col0 = cur.col,
    row0 = cur.row

  // Inline LDA #$XX immediates inside CODE_0DB7AA. Opcode $A9 is at each
  // offset listed by the disasm; the 1-byte immediate follows at +1.
  //   opcode +28  imm +29  $AA  first-row pipe-lip
  //   opcode +36  imm +37  $A1  first-row slope body
  //   opcode +47  imm +48  $AA  CODE_0DB7D6 loop lip
  //   opcode +56  imm +57  $E2  CODE_0DB7D6 body
  //   opcode +67  imm +68  $3F  CODE_0DB7D6 filler
  //   opcode +78  imm +79  $A6  CODE_0DB7D6 cap
  //   opcode +113 imm +114 $F7  phase-2 first-row lip
  //   opcode +124 imm +125 $A3  phase-2 per-row lip
  //   opcode +135 imm +136 $3F  phase-2 filler
  //   opcode +146 imm +147 $A6  phase-2 cap
  const tAA1 = readImmByte(cur, cur.handlerAddr + 29)
  const tA1 = readImmByte(cur, cur.handlerAddr + 37)
  const tAA2 = readImmByte(cur, cur.handlerAddr + 48)
  const tE2 = readImmByte(cur, cur.handlerAddr + 57)
  const t3Fa = readImmByte(cur, cur.handlerAddr + 68)
  const tA6a = readImmByte(cur, cur.handlerAddr + 79)
  const tF7 = readImmByte(cur, cur.handlerAddr + 114)
  const tA3 = readImmByte(cur, cur.handlerAddr + 125)
  const t3Fb = readImmByte(cur, cur.handlerAddr + 136)
  const tA6b = readImmByte(cur, cur.handlerAddr + 147)

  let _1 = 1
  let _2 = width
  saveBookmark(cur)

  setPage1(cur)
  writeTilePipeMerge(cur, tAA1)
  setPage0(cur)
  writeTileSlopeMerge(cur, tA1)
  restoreBookmark(cur)
  diagonalDownLeft(cur)
  _1 += 2
  _2 -= 1
  saveBookmark(cur)

  while (_2 >= 0) {
    setPage1(cur)
    writeTilePipeMerge(cur, tAA2)
    setPage1(cur)
    writeTileAdvance(cur, tE2)
    let x = _1 - 2
    while (x > 0) {
      setPage0(cur)
      writeTileAdvance(cur, t3Fa)
      x -= 1
    }
    setPage0(cur)
    writeTileSlopeMerge(cur, tA6a)
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    _1 += 2
    _2 -= 1
    saveBookmark(cur)
  }

  advanceCol(cur)
  saveBookmark(cur)
  const _1b = _1 - 2

  let _3 = rightSide
  let firstPhase2Iter = true
  while (_3 >= 0) {
    if (firstPhase2Iter) {
      setPage1(cur)
      writeTilePipeMerge(cur, tF7)
    } else {
      setPage0(cur)
      writeTileSlopeMerge(cur, tA3)
    }
    let x = _1b
    while (x > 0) {
      setPage0(cur)
      writeTileAdvance(cur, t3Fb)
      x -= 1
    }
    setPage0(cur)
    writeTileSlopeMerge(cur, tA6b)
    restoreBookmark(cur)
    diagonalDownRight(cur)
    saveBookmark(cur)
    _3 -= 1
    firstPhase2Iter = false
  }

  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DD103 (bank_0D.asm line 5917) -- horizontal ground ledge, page 1.
 *
 * Dispatched for standard object $3C on tileset-8 family dispatchers
 * ($0DCD90 - tilesets 2/6/8). Writes a single row of ledge tiles with
 * context-sensitive end caps that fuse into adjacent grass-top terrain.
 *
 *   Size byte: ????WWWW - only low nibble matters (width counter = _0).
 *   Total columns = _0 + 1 (1 left cap + _0-1 middles + 1 right cap).
 *
 * Every column is set page-1 via Sta1To6ePointer before the low-byte write,
 * so stored IDs are $107-$10B (page << 8 | low).
 *
 * Cap selection at each end:
 *   - Existing tile in [$73..$75]  →  fusion cap ($0A left / $0B right)
 *   - Otherwise                     →  plain cap ($07 left / $09 right)
 * Middle columns are always $08.
 */
export function handle_0DD103(cur: Cursor): void {
  const width = cur.size & 0x0f // _0 (line 5920)

  // Left cap (lines 5922-5931).
  setPage1(cur)
  const existingLeft = peekExistingLow(cur)
  const leftCap = existingLeft >= 0x73 && existingLeft <= 0x75 ? 0x0a : 0x07
  writeTileAdvance(cur, leftCap)

  // Middle tiles: _0 - 1 of them. The ASM's JMP CODE_0DD12B after the left
  // cap write folds the first DEC into the left-cap iteration, so the loop
  // body runs width-1 times before _0 hits zero (lines 5933-5939).
  for (let i = 0; i < width - 1; i++) {
    setPage1(cur)
    writeTileAdvance(cur, 0x08)
  }

  // Right cap (lines 5940-5949).
  setPage1(cur)
  const existingRight = peekExistingLow(cur)
  const rightCap = existingRight >= 0x73 && existingRight <= 0x75 ? 0x0b : 0x09
  writeTileAdvance(cur, rightCap)
}

/**
 * CODE_0DD145 (bank_0D.asm line 5952) -- grass-top row, page 0.
 *
 * Dispatched for standard object $3D on tileset-8 family dispatchers. This is
 * the ubiquitous grass-top row used for ground runs in grassland / Donut-style
 * levels. Vanilla level data typically pairs this with a matching dirt-fill
 * rectangle underneath (via CODE_0DA8C3).
 *
 *   Size byte: HHHHWWWW - H = height (_1), W = width (_0).
 *   Total columns per row = _0 + 1, total rows = _1 + 1.
 *
 * Each row: $73 left cap, $74 × (_0-1) middles, $75 right cap. All writes are
 * page-0 via StzTo6ePointer, so stored IDs are $073-$075.
 *
 * Between rows the ASM calls CODE_0DA6BA (restore Map16LowPtr bookmark) +
 * CODE_0DA97D (LevelLoadPos += $10). In our flat-grid cursor that's nextRow:
 * col resets to the saved bookmark, row advances by one.
 */
export function handle_0DD145(cur: Cursor): void {
  const width = cur.size & 0x0f // _0 (line 5955)
  const height = (cur.size >> 4) & 0x0f // _1 (lines 5957-5961)

  saveBookmark(cur) // CODE_0DA6B1 (line 5963)

  // Row loop: DEC _1 then BPL while _1 >= 0 → total rows = height + 1
  // (lines 5964-5983).
  for (let r = 0; r <= height; r++) {
    // Left cap $73 (lines 5965-5968, written at the JMP-skip target).
    setPage0(cur)
    writeTileAdvance(cur, 0x73)

    // Middle $74 tiles: width - 1 of them. First X-loop iteration is folded
    // into the left-cap write via the JMP pattern (lines 5970-5975).
    for (let i = 0; i < width - 1; i++) {
      setPage0(cur)
      writeTileAdvance(cur, 0x74)
    }

    // Right cap $75 (lines 5976-5978).
    setPage0(cur)
    writeTileAdvance(cur, 0x75)

    // Next row: CODE_0DA6BA + CODE_0DA97D (lines 5979-5981).
    if (r < height) nextRow(cur)
  }
}

/**
 * CODE_0DB916 (bank_0D.asm line 4199) -- blue switch-palace block (rectangular).
 *
 * Counterpart to the extended green/yellow handlers (CODE_0DB58B/0DB583) but
 * as a rectangular *standard* object. Size byte: HHHHWWWW. Iterates (W+1) by
 * (H+1) tiles. The shared body branches on SwitchBlockFlags+2,X (X=0 blue,
 * X=1 red at $7E1F29/$7E1F2A):
 *   DATA_0DB91A[0] = $6C page 0 -> Map16 $06C, uncleared (bank_0D.asm:4227)
 *   DATA_0DB91C[0] = $6C page 1 -> Map16 $16C, cleared   (bank_0D.asm:4232,
 *   taken when :4229 `LDA.W SwitchBlockFlags+2,X` / :4230 `BEQ +` branches)
 *
 * Reads whichever table `cur.switchFlags.blue` (#567) says the ROM would
 * have read, gated on the `$BF` opcode - see `writeSwitchBlockRect`.
 */
export function handle_0DB916(cur: Cursor): void {
  writeSwitchBlockRect(cur, 37, 51, cur.switchFlags.blue)
}

/**
 * CODE_0DB91E (bank_0D.asm line 4209) -- red switch-palace block (rectangular).
 * Sibling of CODE_0DB916 entered 8 bytes later - see its comment; gates on
 * `cur.switchFlags.red`. Operand offsets are 8 less: 29 (uncleared), 43 (cleared).
 */
export function handle_0DB91E(cur: Cursor): void {
  writeSwitchBlockRect(cur, 29, 43, cur.switchFlags.red)
}

function writeSwitchBlockRect(
  cur: Cursor,
  unclearedOffset: number,
  clearedOffset: number,
  cleared: boolean,
): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const tableAddr = readGatedLongOperand(cur, cleared ? clearedOffset : unclearedOffset)
  if (tableAddr === null) return
  const tile = cur.rom.readByte(tableAddr + X) ?? 0
  if (cleared) setPage1(cur)
  else setPage0(cur)
  const origCol = cur.col
  const origRow = cur.row
  for (let r = 0; r <= H; r++) {
    cur.row = origRow + r
    for (let c = 0; c <= W; c++) {
      cur.col = origCol + c
      writeTile(cur, tile)
    }
  }
  cur.col = origCol
  cur.row = origRow
}

// ── Tileset-1 (castle/dungeon) standard-object handlers ───────────────────
// These serve CODE_0DC190's slots 46-63 (object numbers 52-63 in 1-based
// tiling). The layout + byte counts for LDA.L operand offsets were verified
// by re-reading bank_0D.asm branch-by-branch.

/**
 * ADDR_0DB336 (bank_0D.asm line 3376) -- used-block rectangle (object 22 on
 * CODE_0DC190). A per-tile item-memory lookup decides whether the slot gets
 * its "not yet collected" tile ($2C on page 0) or is left blank. Our editor
 * always renders the uncollected state -- see the header comment block at
 * the top of this file for the rationale.
 *
 *   Size byte: HHHHWWWW -- W width-1, H height-1. Result is a (W+1)x(H+1)
 *   rectangle of tile $2C (read from the LDA #$2C immediate at handler+95 so
 *   that relocated LM-patched handlers still resolve).
 */
export function handle_0DB336(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  // LDA #$2C at handler offset +95 (opcode $A9 at +95; immediate at +96).
  const tile = readImmByte(cur, cur.handlerAddr + 96)

  setPage0(cur)
  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, tile)
    }
    restoreBookmark(cur)
    if (r < heightM1) nextRow(cur)
  }
}

/**
 * CODE_0DCF12 (bank_0D.asm line 5611) -- horizontal row, page 0. Used by
 * CODE_0DC190 (tileset 1) for object 55 and by CODE_0DCD90 (tilesets 2/6/8)
 * for the same slot.
 *
 *   Size byte: HHHHWWWW -- W width-1, H selects DATA_0DCF10[H] (2-entry
 *   table of tiles, [$92, $93] in vanilla).
 *   Result: (W+1) tiles in a row, all tile[H], page 0.
 */
export function handle_0DCF12(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f
  // LDA.L DATA_0DCF10,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(tableAddr + H) ?? 0

  setPage0(cur) // StzTo6ePointer
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, tile)
  }
}

/**
 * CODE_0DCF33 (bank_0D.asm line 5633) -- vertical column, page 0. Used by
 * CODE_0DC190 (tileset 1) for object 56 and by CODE_0DCD90 for the same slot.
 *
 *   Size byte: HHHHXXXX -- X selects DATA_0DCF30[X] (3-entry table of tiles,
 *   [$90, $91, $A2] in vanilla), H = height-1 of the column.
 *   Result: (H+1) tiles stacked vertically, all tile[X], page 0.
 */
export function handle_0DCF33(cur: Cursor): void {
  const X = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  // LDA.L DATA_0DCF30,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(tableAddr + X) ?? 0

  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    setPage0(cur) // StzTo6ePointer before every write
    writeTile(cur, tile) // STA [Map16LowPtr],Y -- no advance
    if (r < heightM1) nextRow(cur) // CODE_0DA97D
  }
}

/**
 * CODE_0DC42E (bank_0D.asm line 4981) -- horizontal row from DATA_0DC42C,
 * page 1. Object 62 on CODE_0DC190. DATA_0DC42C = [$5A, $59].
 *
 *   Size byte: HHHHWWWW -- W width-1 (row length), H selects DATA_0DC42C[H].
 *   Result: (W+1) tiles in a row, page 1.
 */
export function handle_0DC42E(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f
  // LDA.L DATA_0DC42C,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(tableAddr + H) ?? 0

  for (let c = 0; c <= widthM1; c++) {
    setPage1(cur) // Sta1To6ePointer before every write
    writeTileAdvance(cur, tile)
  }
}

/**
 * CODE_0DC44F (bank_0D.asm line 5003) -- vertical column from DATA_0DC44C,
 * page 1. Object 63 on CODE_0DC190. DATA_0DC44C = [$5B, $5C, $53].
 *
 *   Size byte: HHHHXXXX -- X selects DATA_0DC44C[X], H = height-1.
 *   Result: (H+1) tiles stacked vertically, page 1.
 */
export function handle_0DC44F(cur: Cursor): void {
  const heightM1 = (cur.size >> 4) & 0x0f
  const X = cur.size & 0x0f
  // LDA.L DATA_0DC44C,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(tableAddr + X) ?? 0

  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    setPage1(cur) // Sta1To6ePointer
    writeTile(cur, tile) // STA [Map16LowPtr],Y (no advance)
    if (r < heightM1) nextRow(cur) // CODE_0DA97D
  }
}

/**
 * CODE_0DC478 (bank_0D.asm line 5032) -- vertical stack of 3-row-tall pole
 * segments. Object 60 on CODE_0DC190.
 *
 *   DATA_0DC46F = [$5D, $60, $63]  -- left cap for each of the 3 row-types
 *   DATA_0DC472 = [$5E, $61, $64]  -- middle fill for each
 *   DATA_0DC475 = [$5F, $62, $65]  -- right cap for each
 *
 *   Size byte: HHHHWWWW -- W = (total row width) - 1, H = total rows - 1.
 *   Per row the ASM writes: 1 left cap + (W-1) middles + 1 right cap = W+1 tiles.
 *   The loop seeds _2 = W, writes the left cap, then DECs _2 before each middle,
 *   so W=1 emits 0 middles (cap-cap), W=2 emits 1 middle, W=6 emits 5 middles.
 *
 *   Row 0 uses X=0 (top segment: $5D / $5E / $5F).
 *   Middle rows (if any) use X=1 ($60 / $61 / $62).
 *   Final row uses X=2 ($63 / $64 / $65).
 *
 *   The ASM picks "final row" via X=2 when _1 reaches 0 AFTER decrement;
 *   otherwise X stays at 1. So H=0 → 1 row (top only). H=1 → top + bottom.
 *   H>=2 → top + (H-1) middles + bottom.
 */
export function handle_0DC478(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  let rowsLeft = (cur.size >> 4) & 0x0f
  const base = cur.handlerAddr
  // LDA.L DATA_0DC46F,X at +28 (operand at +29).
  // LDA.L DATA_0DC472,X at +41 (operand at +42).
  // LDA.L DATA_0DC475,X at +55 (operand at +56).
  const addrLeft = readLongOperand(cur, base + 29)
  const addrMid = readLongOperand(cur, base + 42)
  const addrRight = readLongOperand(cur, base + 56)

  saveBookmark(cur)
  // First row uses X=0 (top cap variant).
  // Inside the loop we pick X=1 for middles, X=2 for the final row.
  let X = 0
  while (true) {
    const leftTile = cur.rom.readByte(addrLeft + X) ?? 0
    const midTile = cur.rom.readByte(addrMid + X) ?? 0
    const rightTile = cur.rom.readByte(addrRight + X) ?? 0

    setPage1(cur)
    writeTileAdvance(cur, leftTile)
    for (let c = 0; c < widthM1 - 1; c++) {
      setPage1(cur)
      writeTileAdvance(cur, midTile)
    }
    setPage1(cur)
    writeTile(cur, rightTile) // STA [Map16LowPtr],Y no advance
    // Restore + row++.
    restoreBookmark(cur)
    advanceRowRaw(cur)

    // DEC _1 → BMI exit; BNE keep X=1 (middle); else (_1 exactly 0) X=2 (final row).
    rowsLeft -= 1
    if (rowsLeft < 0) break
    if (rowsLeft === 0) X = 2
    else X = 1
  }
}

/**
 * CODE_0DC4C9 (bank_0D.asm line 5074) -- two-row horizontal strip
 * (castle-window / similar). Object 59 on CODE_0DC190.
 *
 *   Size byte: WWWW (low nibble only) -- W = width-1.
 *   Row 0: tile $09 (page 1) repeated W+1 times.
 *   Row 1: tile $86 (page 0) repeated W+1 times.
 */
export function handle_0DC4C9(cur: Cursor): void {
  const W = cur.size & 0x0f
  // Byte layout in vanilla (non-hires build, so the `ver_is_hires` JSR
  // CODE_0DA6B1/BA save/restore hooks are NOT emitted):
  //   +0..+7  LDY/LDA/AND/STA/LDX  state setup
  //   +8      loop -
  //   +10..+12 JSR Sta1To6ePointer
  //   +13     A9 09   (LDA #$09 → immediate at +14)
  //   +15..+17 JSR CODE_0DA95B
  //   +18     CA     DEX
  //   +19..+20 10 XX BPL -
  //   +21..+23 JSR CODE_0DA97D
  //   +24..+25 LDX _0
  //   +26..+28 JSR StzTo6ePointer
  //   +29     A9 86  (LDA #$86 → immediate at +30)
  const row0Tile = readImmByte(cur, cur.handlerAddr + 14)
  const row1Tile = readImmByte(cur, cur.handlerAddr + 30)

  saveBookmark(cur)
  for (let c = 0; c <= W; c++) {
    setPage1(cur)
    writeTileAdvance(cur, row0Tile)
  }
  restoreBookmark(cur)
  advanceRowRaw(cur)
  for (let c = 0; c <= W; c++) {
    setPage0(cur)
    writeTileAdvance(cur, row1Tile)
  }
}

/**
 * CODE_0DC4EF (bank_0D.asm line 5100) -- castle spike trap (crusher) frame
 * with optional top and bottom caps. Object 54 on CODE_0DC190.
 *
 *   Size byte: HHHHXXXX -- X selects top/bottom cap presence (0 = caps on
 *   both ends, non-zero = caps on top only -- see trace below), H = body
 *   row count - 1 (the alternating $89/$66/$67/$8A vs $8B/$68/$69/$8C pairs).
 *
 *   Col layout is always 4 wide: (col0, col0+1, col0+2, col0+3).
 *
 *   If X != 0: top cap half-row at (col0+1, col0+2) with $87/$88 (page 0);
 *   the outer columns stay blank. Then row++.
 *
 *   Main body alternating rows (row types A/B):
 *     Row A:  $89,  $66,  $67,  $8A   (page pattern 0/1/1/0)
 *     Row B:  $8B,  $68,  $69,  $8C   (page pattern 0/1/1/0)
 *   Alternation: A, (B, A), (B, A), ... repeated.
 *   The ASM's DEC _0 + BPL loop produces (_0_init + 1) total rows (A, B, A, B, ...).
 *
 *   If X == 0 at the end: trailing half-row $8D/$8E at (col0+1, col0+2) (page 0).
 */
export function handle_0DC4EF(cur: Cursor): void {
  const X = cur.size & 0x0f
  const _0init = (cur.size >> 4) & 0x0f
  // LDA # immediates inside the handler (offset of the $A9 opcode; the
  // immediate byte lives at opcode offset + 1). Verified byte-by-byte via
  // direct ROM dump at 0DC4EF.
  //   +28  $87   top-cap L     (imm at +29)
  //   +36  $88   top-cap R     (imm at +37)
  //   +50  $89   A-row col 0   (imm at +51)
  //   +58  $66   A-row col 1   (imm at +59)
  //   +66  $67   A-row col 2   (imm at +67)
  //   +74  $8A   A-row col 3   (imm at +75)
  //   +92  $8B   B-row col 0   (imm at +93)
  //   +100 $68   B-row col 1   (imm at +101)
  //   +108 $69   B-row col 2   (imm at +109)
  //   +116 $8C   B-row col 3   (imm at +117)
  //   +141 $8D   bot-cap L     (imm at +142)
  //   +149 $8E   bot-cap R     (imm at +150)
  const base = cur.handlerAddr
  const t87 = readImmByte(cur, base + 29)
  const t88 = readImmByte(cur, base + 37)
  const t89 = readImmByte(cur, base + 51)
  const t66 = readImmByte(cur, base + 59)
  const t67 = readImmByte(cur, base + 67)
  const t8A = readImmByte(cur, base + 75)
  const t8B = readImmByte(cur, base + 93)
  const t68 = readImmByte(cur, base + 101)
  const t69 = readImmByte(cur, base + 109)
  const t8C = readImmByte(cur, base + 117)
  const t8D = readImmByte(cur, base + 142)
  const t8E = readImmByte(cur, base + 150)

  saveBookmark(cur)
  const col0 = cur.col

  // Top cap (only when X != 0). ASM does CODE_0DA95D (INY = advance col)
  // before writing, which puts $87/$88 at col+1, col+2. col+0 and col+3 stay
  // empty.
  if (X !== 0) {
    cur.col = col0 + 1
    setPage0(cur)
    writeTile(cur, t87)
    cur.col = col0 + 2
    setPage0(cur)
    writeTile(cur, t88)
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }

  // Alternating A/B body rows. Run (_0init + 1) total rows.
  //   DEC _0 after row A: BMI exits if _0 was 0 (one A row only).
  //   DEC _0 after row B: BPL loops back to A if _0 was positive.
  let _0 = _0init
  // Safety cap: the vanilla ASM would loop 256 times if _0 starts at 0 and
  // the B row runs (_0 wraps through 0xFF). Our editor caps at 32 which is
  // well above any reasonable level geometry.
  let safetyCap = 64
  for (;;) {
    // Row A
    setPage0(cur)
    writeTileAdvance(cur, t89)
    setPage1(cur)
    writeTileAdvance(cur, t66)
    setPage1(cur)
    writeTileAdvance(cur, t67)
    setPage0(cur)
    writeTileAdvance(cur, t8A)
    restoreBookmark(cur)
    advanceRowRaw(cur)
    _0 = (_0 - 1) & 0xff
    if (_0 === 0xff) break // BMI: _0 was 0 before DEC
    if (--safetyCap < 0) break
    // Row B
    setPage0(cur)
    writeTileAdvance(cur, t8B)
    setPage1(cur)
    writeTileAdvance(cur, t68)
    setPage1(cur)
    writeTileAdvance(cur, t69)
    setPage0(cur)
    writeTileAdvance(cur, t8C)
    restoreBookmark(cur)
    advanceRowRaw(cur)
    _0 = (_0 - 1) & 0xff
    if (_0 === 0xff) break // BPL not taken: _0 wrapped to 0xFF
    if (--safetyCap < 0) break
  }

  // Bottom cap (only when X == 0). Same offset pattern as top cap.
  if (X === 0) {
    cur.col = col0 + 1
    setPage0(cur)
    writeTile(cur, t8D)
    cur.col = col0 + 2
    setPage0(cur)
    writeTile(cur, t8E)
  }
}

/**
 * CODE_0DC58A (bank_0D.asm line 5168) -- checkerboard / 2-wide decorative
 * wall. Object 53 on CODE_0DC190.
 *
 *   Size byte: HHHHWWWW -- W = pair-count - 1 (so 2*(W+1) tiles per row),
 *   H = row-pair-count - 1 (so 2*(H+1) total rows).
 *   Row A:  $94, $95, $94, $95, ...   (page 0)
 *   Row B:  $96, $97, $96, $97, ...   (page 0)
 *
 *   Pattern: (A, B) repeated (H+1) times top-to-bottom, each row being 2*(W+1)
 *   tiles wide.
 */
export function handle_0DC58A(cur: Cursor): void {
  const pairCountM1 = cur.size & 0x0f
  const rowPairM1 = (cur.size >> 4) & 0x0f
  // LDA # immediate offsets (verified via ROM byte dump):
  //   +24 $94 (imm at +25),  +32 $95 (imm at +33)   -- row A pair
  //   +51 $96 (imm at +52),  +59 $97 (imm at +60)   -- row B pair
  const base = cur.handlerAddr
  const t94 = readImmByte(cur, base + 25)
  const t95 = readImmByte(cur, base + 33)
  const t96 = readImmByte(cur, base + 52)
  const t97 = readImmByte(cur, base + 60)

  saveBookmark(cur)
  for (let rp = 0; rp <= rowPairM1; rp++) {
    for (let c = 0; c <= pairCountM1; c++) {
      setPage0(cur)
      writeTileAdvance(cur, t94)
      setPage0(cur)
      writeTileAdvance(cur, t95)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
    for (let c = 0; c <= pairCountM1; c++) {
      setPage0(cur)
      writeTileAdvance(cur, t96)
      setPage0(cur)
      writeTileAdvance(cur, t97)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DC5D8 (bank_0D.asm line 5207) -- 2-wide vertical chain/pole with
 * top+bottom cap ($33/$34) and middle segments ($9D/$9E). Object 52 on
 * CODE_0DC190.
 *
 *   Size byte: HHHH???? -- H = middle-row count (the body length counter _0
 *   that the ASM decrements with BNE). Low nibble ignored.
 *
 *   ASM flow: write top ($33/$34 page 1), row++, DEC _0. Loop: if _0 != 0,
 *   write middle ($9D/$9E page 0), row++, DEC _0 again. Loop until _0 == 0.
 *   Write bottom cap ($33/$34 page 1).
 *
 *   For H==0 the ASM hits an infinite loop (DEC _0 wraps to 0xFF and BNE keeps
 *   firing). We cap iterations at 64 for safety; vanilla level data never
 *   trips this.
 */
export function handle_0DC5D8(cur: Cursor): void {
  let _0 = (cur.size >> 4) & 0x0f
  // LDA # immediate offsets (verified via ROM byte dump):
  //   +16 $33 (imm at +17),  +24 $34 (imm at +25)   -- top/bottom cap pair
  //   +34 $9D (imm at +35),  +42 $9E (imm at +43)   -- middle pair
  const base = cur.handlerAddr
  const t33 = readImmByte(cur, base + 17)
  const t34 = readImmByte(cur, base + 25)
  const t9D = readImmByte(cur, base + 35)
  const t9E = readImmByte(cur, base + 43)

  saveBookmark(cur)
  // Top cap.
  setPage1(cur)
  writeTileAdvance(cur, t33)
  setPage1(cur)
  writeTile(cur, t34) // STA no advance
  restoreBookmark(cur)
  advanceRowRaw(cur)

  // Middle rows. DEC _0; BNE loops.
  let safety = 64
  _0 = (_0 - 1) & 0xff
  while (_0 !== 0 && safety-- > 0) {
    setPage0(cur)
    writeTileAdvance(cur, t9D)
    setPage0(cur)
    writeTile(cur, t9E)
    restoreBookmark(cur)
    advanceRowRaw(cur)
    _0 = (_0 - 1) & 0xff
  }

  // Bottom cap.
  setPage1(cur)
  writeTileAdvance(cur, t33)
  setPage1(cur)
  writeTile(cur, t34)
}

/**
 * CODE_0DC341 (bank_0D.asm line 4845) -- castle staircase dispatcher.
 * Object 61 on CODE_0DC190. Dispatches by size bit 1:
 *   bit 1 = 0 → CODE_0DC358 (staircase up-left)
 *   bit 1 = 1 → CODE_0DC3D8 (staircase up-right)
 *
 * Both variants share tile tables DATA_0DC350 ($CE,$D1,$CF,$D0 step caps)
 * and DATA_0DC354 ($F3,$F6,$F4,$F5 step edges); the low 2 bits of size
 * select the style (X), the high nibble sets step count.
 */
export function handle_0DC341(cur: Cursor): void {
  // dl CODE_0DC358, dl CODE_0DC3D8 table starts at handler +9 (after
  // SEP/LDA/AND/LSR/JSL = 9 bytes).
  const variantIdx = (cur.size >> 1) & 1
  const target = readLongOperand(cur, cur.handlerAddr + 9 + variantIdx * 3) & 0xffffff

  const prevHandler = cur.handlerAddr
  cur.handlerAddr = target
  try {
    STAIRCASE_VARIANT_HANDLERS[target]?.(cur)
  } finally {
    cur.handlerAddr = prevHandler
  }
}

const STAIRCASE_VARIANT_HANDLERS: Record<number, (cur: Cursor) => void> = {
  0x0dc358: staircaseVariantA,
  0x0dc3d8: staircaseVariantB,
}

/**
 * CODE_0DC358 (bank_0D.asm line 4860) -- staircase variant A (up-left).
 *
 *   Size byte: HHHHSSXX -- X (bits 0-1) selects tile style into DATA_0DC350
 *     and DATA_0DC354 (0-3); bits 2-3 ignored here (they were consumed by
 *     the CODE_0DC341 dispatcher). H = step-count (_0 initialized to H+1).
 *
 *   For each step i in 0..H (total H+1 steps, moving up-left):
 *     (col0 - i, row0 + i):              step cap (DATA_0DC350[X], page 1)
 *     (col0 - i + 1, row0 + i):          step edge (DATA_0DC354[X], page 1)  if i >= 1
 *     (col0 - i + 2 .. col0, row0 + i):  $3F fill (page 0)                    if i >= 2
 *
 *   Final ground row at (row0 + H + 1):
 *     (col0 - H, ...): step edge (DATA_0DC354[X], page 1)
 *     (col0 - H + 1 .. col0, ...): $3F fill (page 0)   -- (H) tiles
 */
function staircaseVariantA(cur: Cursor): void {
  const X = cur.size & 0x03
  const H = (cur.size >> 4) & 0x0f
  const base = cur.handlerAddr
  // Verified via ROM byte dump:
  //   LDA.L DATA_0DC350,X  opcode at +31, operand at +32  (step cap)
  //   LDA.L DATA_0DC354,X  opcode at +45, operand at +46  (step edge)
  //   LDA #$3F             opcode at +58, imm at +59      (page-0 fill)
  const addrCap = readLongOperand(cur, base + 32)
  const addrEdge = readLongOperand(cur, base + 46)
  const capTile = cur.rom.readByte(addrCap + X) ?? 0
  const edgeTile = cur.rom.readByte(addrEdge + X) ?? 0
  const fillTile = readImmByte(cur, base + 59)

  const col0 = cur.col,
    row0 = cur.row

  // Step rows.
  for (let i = 0; i <= H; i++) {
    cur.row = row0 + i
    cur.col = col0 - i
    setPage1(cur)
    writeTileAdvance(cur, capTile)
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, edgeTile)
    }
    for (let k = 2; k <= i; k++) {
      setPage0(cur)
      writeTileAdvance(cur, fillTile)
    }
  }

  // Ground row at row0 + H + 1: one edge tile at col0 - H, then H $3F fills.
  cur.row = row0 + H + 1
  cur.col = col0 - H
  setPage1(cur)
  writeTileAdvance(cur, edgeTile)
  for (let k = 0; k < H; k++) {
    setPage0(cur)
    writeTileAdvance(cur, fillTile)
  }

  // Restore cursor (bookkeeping; handler caller does not depend on this).
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DC3D8 (bank_0D.asm line 4933) -- staircase variant B (up-right).
 *
 *   Same table layout as variant A, but the staircase descends to the right
 *   instead of the left: step i at (col0 + i, row0 + i), with preceding
 *   tiles on the row filled with $3F (page 0) and an $F3 edge next to the
 *   step cap.
 *
 *   For each step i in 0..H (total H+1 steps):
 *     (col0 + 0 .. col0 + i - 2, row0 + i): $3F fill (page 0)   -- (i-1) tiles
 *     (col0 + i - 1, row0 + i):             step edge ($F3, page 1)  if i >= 1
 *     (col0 + i, row0 + i):                 step cap ($CE, page 1)
 *
 *   No separate ground row (unlike variant A) -- the bottom step IS the
 *   terminating row.
 */
function staircaseVariantB(cur: Cursor): void {
  const X = cur.size & 0x03
  const H = (cur.size >> 4) & 0x0f
  const base = cur.handlerAddr
  // Verified via ROM byte dump:
  //   LDA #$3F             opcode at +30, imm at +31      (page-0 fill)
  //   LDA.L DATA_0DC354,X  opcode at +46, operand at +47  (step edge)
  //   LDA.L DATA_0DC350,X  opcode at +60, operand at +61  (step cap)
  const fillTile = readImmByte(cur, base + 31)
  const addrEdge = readLongOperand(cur, base + 47)
  const addrCap = readLongOperand(cur, base + 61)
  const capTile = cur.rom.readByte(addrCap + X) ?? 0
  const edgeTile = cur.rom.readByte(addrEdge + X) ?? 0

  const col0 = cur.col,
    row0 = cur.row

  for (let i = 0; i <= H; i++) {
    cur.row = row0 + i
    cur.col = col0
    // (i - 1) fills on page 0.
    for (let k = 0; k < i - 1; k++) {
      setPage0(cur)
      writeTileAdvance(cur, fillTile)
    }
    // Edge tile (only if i >= 1).
    if (i >= 1) {
      setPage1(cur)
      writeTileAdvance(cur, edgeTile)
    }
    // Step cap.
    setPage1(cur)
    writeTileAdvance(cur, capTile)
  }

  cur.col = col0
  cur.row = row0
}

// ── Tileset-8 (ghost-house) novel handlers ───────────────────────────────────
// Ported from CODE_0DCD90's dispatch table in bank_0D.asm. Most ghost-house
// levels only use shared handlers (CODE_0DA8C3, CODE_0DD103, CODE_0DD145, …)
// but a handful use these tileset-8-specific routines for doors, wall edges,
// picture frames, and staircases. Handlers that duplicate tileset-1 entries
// (handle_0DB336, handle_0DCF12, handle_0DCF33, handle_0DC341) are reused
// from the tileset-1 port above.

/**
 * ADDR_0DCEF2 (bank_0D.asm line 5589) -- tileset-8 object $36 (horizontal run
 * of $0C/$0D on page 1). Low nibble = width-1, high nibble = which of two
 * tiles (DATA_0DCEF0 = $0C, $0D). Only 2 valid X values.
 *
 * Single row, (W+1) tiles wide. Writes via CODE_0DA95B which is
 * advance-after-write, so the cursor walks right by (W+1) steps.
 */
export function handle_0DCEF2(cur: Cursor): void {
  const W = cur.size & 0x0f
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DCEF2 from ROM:
  //   +18 BF F0 CE 0D   LDA.L DATA_0DCEF0,X   (operand at +19..+21)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(tableAddr + (X & 0x01)) ?? 0 // only 2 entries
  const col0 = cur.col
  for (let c = 0; c <= W; c++) {
    cur.col = col0 + c
    setPage1(cur)
    writeTile(cur, tile)
  }
  cur.col = col0
}

/**
 * CODE_0DCF53 (bank_0D.asm line 5652) -- tileset-8 object $3A sub-dispatcher.
 * Low nibble = variant (0-5):
 *   0: CODE_0DCF6E  -- 2-wide staircase going down-left with $8C/$8D.
 *   1: CODE_0DCFB1  -- 1-wide diagonal going down-left with $86.
 *   2: ADDR_0DCFF0  -- 2-wide staircase going down-right with $8E/$8F.
 *   3: CODE_0DD034  -- 1-wide diagonal going down-right with $87.
 *   4: CODE_0DCFB1  -- 1-wide diagonal going down-left with $94 (X=4 selects).
 *   5: CODE_0DD034  -- 1-wide diagonal going down-right with $95 (X=5 selects).
 * High nibble = step count (X+1 steps total).
 */
export function handle_0DCF53(cur: Cursor): void {
  const X = cur.size & 0x0f
  if (X >= 6) return
  // Byte layout verified by dumping $0DCF53:
  //   +0 A5 59 29 0F AA 22 FA 86 00   LDA size; AND #$0F; TAX; JSL ExecutePtrLong
  //   +9..+26   dl $0DCF6E, $0DCFB1, $0DCFF0, $0DD034, $0DCFB1, $0DD034
  const target = readLongOperand(cur, cur.handlerAddr + 9 + X * 3) & 0xffffff
  const prevHandler = cur.handlerAddr
  cur.handlerAddr = target
  try {
    STAIR_VARIANT_HANDLERS[target]?.(cur, X)
  } finally {
    cur.handlerAddr = prevHandler
  }
}

const STAIR_VARIANT_HANDLERS: Record<number, (cur: Cursor, X: number) => void> = {
  0x0dcf6e: stairVariantDownLeft2Wide,
  0x0dcfb1: stairVariantDownLeft1Wide,
  0x0dcff0: stairVariantDownRight2Wide,
  0x0dd034: stairVariantDownRight1Wide,
}

/**
 * CODE_0DCF6E (bank_0D.asm line 5665) -- 2-wide staircase descending to left.
 * Each step writes a horizontal pair ($8C/$8D) then shifts (col-=2, row+=1).
 * X = (size >> 4) & 0x0F = count, produces X+1 steps total.
 */
function stairVariantDownLeft2Wide(cur: Cursor, _subX: number): void {
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DCF6E:
  //   +15 A9 8C   LDA #$8C  (imm at +16)
  //   +23 A9 8D   LDA #$8D  (imm at +24)
  const tileA = readImmByte(cur, cur.handlerAddr + 16)
  const tileB = readImmByte(cur, cur.handlerAddr + 24)
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= X; i++) {
    cur.col = col0 - i * 2
    cur.row = row0 + i
    setPage0(cur)
    writeTile(cur, tileA)
    cur.col += 1
    setPage0(cur)
    writeTile(cur, tileB)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * ADDR_0DCFF0 (bank_0D.asm line 5745) -- 2-wide staircase descending to right.
 * Each step writes a horizontal pair ($8E/$8F) then shifts (col+=2, row+=1).
 */
function stairVariantDownRight2Wide(cur: Cursor, _subX: number): void {
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DCFF0:
  //   +15 A9 8E   LDA #$8E  (imm at +16)
  //   +23 A9 8F   LDA #$8F  (imm at +24)
  const tileA = readImmByte(cur, cur.handlerAddr + 16)
  const tileB = readImmByte(cur, cur.handlerAddr + 24)
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= X; i++) {
    cur.col = col0 + i * 2
    cur.row = row0 + i
    setPage0(cur)
    writeTile(cur, tileA)
    cur.col += 1
    setPage0(cur)
    writeTile(cur, tileB)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DCFB1 (bank_0D.asm line 5705) -- 1-wide diagonal staircase going
 * down-left. Tile = $86 (variant 1) or $94 (variant 4, sub-dispatcher X=4).
 * Each step shifts (col-=1, row+=1). Total X+1 steps.
 */
function stairVariantDownLeft1Wide(cur: Cursor, subX: number): void {
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DCFB1:
  //   +0 A9 86   LDA #$86        (imm at +1)
  //   +2 E0 04   CPX #$04
  //   +4 D0 02   BNE +2
  //   +6 A9 94   LDA #$94        (imm at +7) - overrides when X==4
  const tile86 = readImmByte(cur, cur.handlerAddr + 1)
  const tile94 = readImmByte(cur, cur.handlerAddr + 7)
  const tile = subX === 4 ? tile94 : tile86
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= X; i++) {
    cur.col = col0 - i
    cur.row = row0 + i
    setPage0(cur)
    writeTile(cur, tile)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DD034 (bank_0D.asm line 5786) -- 1-wide diagonal staircase going
 * down-right. Tile = $87 (variant 3) or $95 (variant 5). Each step shifts
 * (col+=1, row+=1). Total X+1 steps.
 */
function stairVariantDownRight1Wide(cur: Cursor, subX: number): void {
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DD034:
  //   +0 A9 87   LDA #$87        (imm at +1)
  //   +6 A9 95   LDA #$95        (imm at +7) - overrides when X==5
  const tile87 = readImmByte(cur, cur.handlerAddr + 1)
  const tile95 = readImmByte(cur, cur.handlerAddr + 7)
  const tile = subX === 5 ? tile95 : tile87
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= X; i++) {
    cur.col = col0 + i
    cur.row = row0 + i
    setPage0(cur)
    writeTile(cur, tile)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * ADDR_0DD070 (bank_0D.asm line 5825) -- tileset-8 object $3B sub-dispatcher.
 * Bit 4 of size selects variant. High nibble >> 4 → 0 or 1.
 *   0: ADDR_0DD080 -- descends to left with $88/$8A (top/bottom of each step).
 *   1: ADDR_0DD0C3 -- descends to right with $89/$8B.
 * Low nibble = W = iteration count (W+1 steps). Each step is 2 tiles tall.
 */
export function handle_0DD070(cur: Cursor): void {
  const sel = (cur.size >> 4) & 0x0f
  if (sel >= 2) return
  // Byte layout verified by dumping $0DD070:
  //   +0 A5 59 4A 4A 4A 4A 22 FA 86 00   LDA size; LSR×4; JSL ExecutePtrLong
  //   +10..+15   dl $0DD080, $0DD0C3
  const target = readLongOperand(cur, cur.handlerAddr + 10 + sel * 3) & 0xffffff
  const prevHandler = cur.handlerAddr
  cur.handlerAddr = target
  try {
    if (target === 0x0dd080) twoTallStairDownLeft(cur)
    else if (target === 0x0dd0c3) twoTallStairDownRight(cur)
  } finally {
    cur.handlerAddr = prevHandler
  }
}

/** ADDR_0DD080: 2-tall staircase down-left, tiles $88 (top) / $8A (bottom). */
function twoTallStairDownLeft(cur: Cursor): void {
  const W = cur.size & 0x0f
  // Byte layout verified by dumping $0DD080:
  //   +10 A9 88   LDA #$88 (imm at +11)
  //   +27 A9 8A   LDA #$8A (imm at +28)
  const tileTop = readImmByte(cur, cur.handlerAddr + 11)
  const tileBot = readImmByte(cur, cur.handlerAddr + 28)
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= W; i++) {
    cur.col = col0 - i
    cur.row = row0 + i * 2
    setPage0(cur)
    writeTile(cur, tileTop)
    cur.row += 1
    setPage0(cur)
    writeTile(cur, tileBot)
  }
  cur.col = col0
  cur.row = row0
}

/** ADDR_0DD0C3: 2-tall staircase down-right, tiles $89 (top) / $8B (bottom). */
function twoTallStairDownRight(cur: Cursor): void {
  const W = cur.size & 0x0f
  // Byte layout verified by dumping $0DD0C3:
  //   +10 A9 89   LDA #$89 (imm at +11)
  //   +27 A9 8B   LDA #$8B (imm at +28)
  const tileTop = readImmByte(cur, cur.handlerAddr + 11)
  const tileBot = readImmByte(cur, cur.handlerAddr + 28)
  const col0 = cur.col,
    row0 = cur.row
  for (let i = 0; i <= W; i++) {
    cur.col = col0 + i
    cur.row = row0 + i * 2
    setPage0(cur)
    writeTile(cur, tileTop)
    cur.row += 1
    setPage0(cur)
    writeTile(cur, tileBot)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * ADDR_0DD182 (bank_0D.asm line 5986) -- tileset-8 object $3E (horizontal
 * window/door with 3-segment pattern). Low nibble = width counter X (total
 * X+1 tiles). Writes $59 (left cap) + $5A * (X-1 middles) + $5B (right cap),
 * all page 1.
 */
export function handle_0DD182(cur: Cursor): void {
  const X = cur.size & 0x0f
  // Byte layout verified by dumping $0DD182:
  //   +10 A9 59   LDA #$59   (imm at +11) - left cap
  //   +18 A9 5A   LDA #$5A   (imm at +19) - middle
  //   +29 A9 5B   LDA #$5B   (imm at +30) - right cap
  const leftTile = readImmByte(cur, cur.handlerAddr + 11)
  const midTile = readImmByte(cur, cur.handlerAddr + 19)
  const rightTile = readImmByte(cur, cur.handlerAddr + 30)
  if (X === 0) {
    // Degenerate: ASM writes left cap + right cap only (the BNE loop runs 0
    // iterations because DEX from 0 gives $FF which is not zero, so the
    // loop actually runs forever in the real game - a level-author bug).
    // For safety emit just the left cap.
    setPage1(cur)
    writeTile(cur, leftTile)
    return
  }
  const col0 = cur.col
  setPage1(cur)
  writeTileAdvance(cur, leftTile)
  for (let i = 0; i < X - 1; i++) {
    setPage1(cur)
    writeTileAdvance(cur, midTile)
  }
  setPage1(cur)
  writeTile(cur, rightTile)
  cur.col = col0
}

/**
 * ADDR_0DD1A5 (bank_0D.asm line 6006) -- tileset-8 object $3F (vertical
 * pillar/support). High nibble = X = height count (total X+1 tiles).
 * Writes $5C (top) + $5D * (X-1 middles) + $5E (bottom), all page 1, one
 * column wide.
 */
export function handle_0DD1A5(cur: Cursor): void {
  const X = (cur.size >> 4) & 0x0f
  // Byte layout verified by dumping $0DD1A5:
  //   +12 A9 5C   LDA #$5C   (imm at +13) - top
  //   +20 A9 5D   LDA #$5D   (imm at +21) - middle
  //   +33 A9 5E   LDA #$5E   (imm at +34) - bottom
  const topTile = readImmByte(cur, cur.handlerAddr + 13)
  const midTile = readImmByte(cur, cur.handlerAddr + 21)
  const botTile = readImmByte(cur, cur.handlerAddr + 34)
  const row0 = cur.row
  if (X === 0) {
    setPage1(cur)
    writeTile(cur, topTile)
    return
  }
  cur.row = row0
  setPage1(cur)
  writeTile(cur, topTile)
  for (let i = 0; i < X - 1; i++) {
    cur.row += 1
    setPage1(cur)
    writeTile(cur, midTile)
  }
  cur.row += 1
  setPage1(cur)
  writeTile(cur, botTile)
  cur.row = row0
}

/**
 * CODE_0DD24E (bank_0D.asm line 6098) -- tileset-8 object $32 (2-row wide
 * fill of $A3 top + $0E bottom). Low nibble = W = width count; total (W+1)
 * tiles wide, 2 rows tall. Row 0 is page 0 ($A3), row 1 is page 1 ($0E).
 *
 *   DATA_0DD24C: db $A3, $0E
 *
 * Inner loop visits X=0 (top) and X=1 (bot). On X=0 the code runs only
 * StzTo6ePointer (page 0); on X=1 both StzTo6ePointer and Sta1To6ePointer
 * run, so the net page is 1.
 */
export function handle_0DD24E(cur: Cursor): void {
  const W = cur.size & 0x0f
  // Byte layout verified by dumping $0DD24E:
  //   +25 BF 4C D2 0D   LDA.L DATA_0DD24C,X   (operand at +26..+28)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 26)
  const row0Tile = cur.rom.readByte(tableAddr + 0) ?? 0
  const row1Tile = cur.rom.readByte(tableAddr + 1) ?? 0
  const col0 = cur.col,
    row0 = cur.row

  for (let x = 0; x < 2; x++) {
    cur.row = row0 + x
    const tile = x === 0 ? row0Tile : row1Tile
    for (let c = 0; c <= W; c++) {
      cur.col = col0 + c
      if (x === 0) setPage0(cur)
      else setPage1(cur)
      writeTile(cur, tile)
    }
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DD1D9 (bank_0D.asm line 6040) -- tileset-8 object $35 (vertical
 * picture-frame / stacked bordered structure). Low nibble = X (frame style,
 * 0-3). High nibble = H = body-segment count.
 *
 *   DATA_0DD1CB = $9A, $9C, $9E, $A0    (top-left capstone per style)
 *   DATA_0DD1CF = $9B, $9D, $9F, $A1    (top-right capstone per style)
 *   middle connector pair: $5F (left) / $60 (right)
 *   body cycle DATA_0DD1D3 = $61, $62, $63, $64, $65, $66 (reads 2 at a time,
 *     wraps after 6 entries)
 *
 * Structure: 2 columns wide. Row 0 = DATA_0DD1CB[X]/DATA_0DD1CF[X] pair
 * (page 0). If H >= 0, row 1 = $5F/$60 pair (page 1). Then H more rows each
 * drawing 2 tiles from DATA_0DD1D3 cycling [0,1], [2,3], [4,5], [0,1], …
 */
export function handle_0DD1D9(cur: Cursor): void {
  const X = cur.size & 0x0f
  let _0 = (cur.size >> 4) & 0x0f // body segment count

  // Byte layout verified by dumping $0DD1D9 from ROM:
  //   +21 BF CB D1 0D   LDA.L DATA_0DD1CB,X   (operand at +22..+24)
  //   +31 BF CF D1 0D   LDA.L DATA_0DD1CF,X   (operand at +32..+34)
  //   +53 A9 5F         LDA #$5F               (imm at +54)
  //   +61 A9 60         LDA #$60               (imm at +62)
  //   +80 BF D3 D1 0D   LDA.L DATA_0DD1D3,X   (operand at +81..+83)
  const addrCB = readLongOperand(cur, cur.handlerAddr + 22)
  const addrCF = readLongOperand(cur, cur.handlerAddr + 32)
  const addrD3 = readLongOperand(cur, cur.handlerAddr + 81)
  const t5F = readImmByte(cur, cur.handlerAddr + 54)
  const t60 = readImmByte(cur, cur.handlerAddr + 62)

  const col0 = cur.col,
    row0 = cur.row

  // Row 0: capstone pair at (col, row), (col+1, row), page 0.
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addrCB + (X & 0x03)) ?? 0)
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addrCF + (X & 0x03)) ?? 0)
  _0 -= 1
  if (_0 < 0) {
    cur.col = col0
    cur.row = row0
    return
  }

  // Row 1: middle-connector pair $5F/$60, page 1.
  cur.col = col0
  cur.row = row0 + 1
  setPage1(cur)
  writeTile(cur, t5F)
  cur.col = col0 + 1
  setPage1(cur)
  writeTile(cur, t60)
  _0 -= 1
  if (_0 < 0) {
    cur.col = col0
    cur.row = row0
    return
  }

  // Body cycle: pairs from DATA_0DD1D3, each iteration writes 2 tiles and
  // advances to next row. X_cycle cycles [0,2,4] mod 6.
  let cycX = 0
  let bodyRow = row0 + 2
  while (_0 >= 0) {
    cur.col = col0
    cur.row = bodyRow
    setPage1(cur)
    writeTile(cur, cur.rom.readByte(addrD3 + cycX) ?? 0)
    cur.col = col0 + 1
    setPage1(cur)
    writeTile(cur, cur.rom.readByte(addrD3 + cycX + 1) ?? 0)
    cycX += 2
    if (cycX >= 6) cycX = 0
    bodyRow += 1
    _0 -= 1
  }

  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DDCA9 (bank_0D.asm line 6724) -- tileset 9-14 two-tile-type floor/ceil.
 *
 * Used by objects $3A and $3B in tilesets 3/9/10/11/14 (dispatcher CODE_0DD990).
 * The handler is shared by two consecutive dispatch entries; it uses the 0-based
 * object index (passed in the X register by the dispatcher) to decide which tile
 * to use on the FIRST row:
 *
 *   objNo == $3A (index $39): first row = tile $59 (page 1), then $FF rows.
 *   objNo == $3B (index $3A): all rows = tile $FF (page 1).
 *
 * Size byte: HHHHWWWW
 *   H (high nibble) = number of additional $FF rows after the first row (BPL loop).
 *   W (low nibble)  = width - 1 (tiles per row).
 *
 * Total rows:
 *   obj $3A: 1 ($59 row) + H ($FF rows) = H + 1 rows
 *   obj $3B: H + 1 ($FF rows only)
 *
 * Inline immediates: +31 = $59 (first-row tile for obj $3A); +45 = $FF (all-row
 * tile for obj $3B / subsequent rows for obj $3A).
 */
export function handle_0DDCA9(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  const tile59 = readImmByte(cur, cur.handlerAddr + 31) // $59
  const tileFF = readImmByte(cur, cur.handlerAddr + 45) // $FF

  saveBookmark(cur)

  if (cur.objNo === 0x3a) {
    // First row: tile $59 (the "ceiling" / distinct top tile).
    for (let x = 0; x <= W; x++) {
      setPage1(cur)
      writeTileAdvance(cur, tile59)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }

  // H rows of tile $FF (page 1). For obj $3A: H rows below the $59 row.
  // For obj $3B: H+1 rows total (the BPL is inclusive so H+1 iterations).
  const ffRows = H + (cur.objNo === 0x3a ? 0 : 1)
  for (let r = 0; r < ffRows; r++) {
    for (let x = 0; x <= W; x++) {
      setPage1(cur)
      writeTileAdvance(cur, tileFF)
    }
    if (r < ffRows - 1) {
      restoreBookmark(cur)
      advanceRowRaw(cur)
    }
  }
}

/**
 * CODE_0DDCEA (bank_0D.asm line 6762) -- tileset 9-14 "filled rectangle with
 * distinct bottom row".
 *
 * Size byte: HHHHWWWW
 *   H (high nibble) = number of rows of body tile (tile $65).
 *   W (low nibble)  = width-1 of the object (both body rows and bottom row).
 *
 * Structure:
 *   - If H > 0: draw H rows of tile $65, W+1 tiles wide, on page 1.
 *   - Always: draw 1 row of tile $4E, W+1 tiles wide, on page 1, at the bottom.
 *
 * The ASM writes via CODE_0DA95B (write + advance col), then restores bookmark
 * via CODE_0DA6BA and advances row via CODE_0DA97D between body rows. The final
 * row is written but cursor advance after is irrelevant (handler returns).
 */
export function handle_0DDCEA(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const W = cur.size & 0x0f

  // LDA # immediates inside the handler body. The opcode is $A9, operand follows.
  //   +28 $A9 $65 → body tile (operand at +29, body loop's LDA #$65)
  //   +51 $A9 $4E → bottom tile (operand at +52, bottom-row loop's LDA #$4E)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 29)
  const bottomTile = readImmByte(cur, cur.handlerAddr + 52)

  saveBookmark(cur)
  for (let r = 0; r < H; r++) {
    for (let x = 0; x <= W; x++) {
      setPage1(cur)
      writeTileAdvance(cur, bodyTile)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
  for (let x = 0; x <= W; x++) {
    setPage1(cur)
    writeTileAdvance(cur, bottomTile)
  }
}

/**
 * CODE_0DDD2E (bank_0D.asm line 6803) -- tileset 9-14 "vertical pillar with
 * variant-selected body / bottom tiles".
 *
 * Size byte: HHHHVVVV
 *   H (high nibble) = number of body tiles (always stacked downward).
 *   V (low nibble)  = variant selector (0-3), indexes DATA_0DDD26 / DATA_0DDD2A.
 *
 * Tables (ROM addresses resolved from LDA.L operands):
 *   DATA_0DDD26[V] = body tile (written H times, each on its own row)
 *   DATA_0DDD2A[V] = bottom tile (written once at the final row)
 *
 * All writes on page 1. Body writes use STA [Map16LowPtr],Y (no col advance)
 * followed by CODE_0DA97D (row advance). Final tile uses CODE_0DA95B.
 */
export function handle_0DDD2E(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const V = cur.size & 0x0f

  // LDA.L DATA_0DDD26,X - opcode $BF at +22, 3-byte operand at +23.
  // LDA.L DATA_0DDD2A,X - opcode $BF at +38, 3-byte operand at +39.
  const addrBody = readLongOperand(cur, cur.handlerAddr + 23)
  const addrBottom = readLongOperand(cur, cur.handlerAddr + 39)
  const bodyTile = cur.rom.readByte(addrBody + V) ?? 0
  const bottomTile = cur.rom.readByte(addrBottom + V) ?? 0

  for (let r = 0; r < H; r++) {
    setPage1(cur)
    writeTile(cur, bodyTile)
    advanceRowRaw(cur)
  }
  setPage1(cur)
  writeTile(cur, bottomTile)
}

/**
 * CODE_0DDD5C (bank_0D.asm line 6828) -- tileset 9-14 solid rectangular fill.
 *
 * Size byte: HHHHWWWW
 *   H (high nibble) = rect height, actual rows = H + 1 (BPL loop is inclusive).
 *   W (low nibble)  = rect width,  actual cols = W + 1 (BPL loop is inclusive).
 *
 * Writes the immediate tile $65 on page 1 across the full (H+1) x (W+1) rect.
 * Structure mirrors the body-row loop of CODE_0DDCEA but with no final "bottom"
 * row and with BPL (inclusive) replacing BNE (exclusive) on the outer DEC.
 */
export function handle_0DDD5C(cur: Cursor): void {
  const H = (cur.size >> 4) & 0x0f
  const W = cur.size & 0x0f

  // LDA #$65 - opcode $A9 at +24, operand at +25.
  const tile = readImmByte(cur, cur.handlerAddr + 25)

  saveBookmark(cur)
  for (let r = 0; r <= H; r++) {
    for (let x = 0; x <= W; x++) {
      setPage1(cur)
      writeTileAdvance(cur, tile)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DDD87 (bank_0D.asm line 6853) -- tileset 9-14 diagonal staircase.
 *
 * Size byte: BBBBWWWW
 *   W (low nibble) = width: staircase has W+1 columns.
 *   B (bit 4 of high nibble) = branch selector:
 *     0 → CODE_0DDD99: header tiles $CA/$CB/$F1, staircase goes UP-LEFT
 *         (each successive column is one col to the left and two rows higher)
 *     1 → CODE_0DDE3C: header tiles $CC/$CD/$F2, staircase goes UP-RIGHT
 *         (each successive column is one col to the right and two rows higher)
 *
 * Each column writes the 3-tile header (page 1) then (height-2) fill tiles of
 * $3F (page 0) vertically downward. The first (rightmost/leftmost depending on
 * branch) column has height = W*2+2; each successive column's height shrinks
 * by 2.
 *
 * ASM structure (CODE_0DDD99):
 *   _0 = size & 0x0F  (W)
 *   _1 = _0*2 + 2     (height)
 *   Outer loop (runs _0+1 times, DEC _0; BMI exit):
 *     saveBookmark; write $CA/$CB/$F1 at Y, Y+$10, Y+$20; DEX DEX (_1-=2);
 *     inner fill loop (DEX; BPL write $3F at Y; Y+=10): writes _1-2 tiles;
 *     restoreBookmark; LevelLoadPos += $1F (col-1, row+2); _1-=2; _0-=1
 *
 * Branch 1 (CODE_0DDE3C) is identical except tiles $CC/$CD/$F2 and
 * LevelLoadPos += $21 (col+1, row+2).
 */
export function handle_0DDD87(cur: Cursor): void {
  const W = cur.size & 0x0f // low nibble: W+1 columns
  const branch = (cur.size >> 4) & 0x01 // bit 4: 0=left($CA/$CB/$F1) / 1=right($CC/$CD/$F2)

  const [tileA, tileB, tileC] = branch === 0 ? [0xca, 0xcb, 0xf1] : [0xcc, 0xcd, 0xf2]
  const dCol = branch === 0 ? -1 : +1

  let height = W * 2 + 2 // _1
  let rem = W // _0 countdown

  while (rem >= 0) {
    const startCol = cur.col
    const startRow = cur.row

    // Header: three page-1 tiles written straight down this column.
    setPage1(cur)
    writeTile(cur, tileA)
    cur.row++
    setPage1(cur)
    writeTile(cur, tileB)
    cur.row++
    setPage1(cur)
    writeTile(cur, tileC)
    cur.row++

    // Fill: (height - 2) page-0 $3F tiles continuing downward.
    // DEX DEX gives X = height-2; CODE_0DDE09 does DEX first (→ height-3),
    // then BPL; so fill count = max(0, height-2).
    const fillCount = Math.max(0, height - 2)
    for (let i = 0; i < fillCount; i++) {
      setPage0(cur)
      writeTile(cur, 0x3f)
      cur.row++
    }

    // Advance to next column: col ± 1, row + 2 from this iteration's start.
    // (LevelLoadPos += $1F for branch 0 → abs col-1, abs row+2;
    //  LevelLoadPos += $21 for branch 1 → abs col+1, abs row+2)
    cur.col = startCol + dCol
    cur.row = startRow + 2

    height -= 2
    rem -= 1
  }
}

/**
 * CODE_0DE135 (bank_0D.asm line 7327) -- three-part rectangle (top / middle /
 * bottom rows), each row having distinct left / middle-fill / right tiles.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble) = width-related; row width = W + 1 tiles.
 *                    (ASM's DEC _2 BNE loop requires W >= 1.)
 *   H (high nibble) = height-related; total rows = H + 1.
 *
 * Each row picks an X index into three parallel 3-byte tables:
 *   X = 0 for the first (top) row
 *   X = 1 for intermediate middle rows
 *   X = 2 for the final (bottom) row (if H >= 1)
 *
 * Tables (resolved from LDA.L operands):
 *   DATA_0DE12C[X] = left-cap tile
 *   DATA_0DE12F[X] = middle tile (repeated to fill)
 *   DATA_0DE132[X] = right-cap tile
 *
 * All writes on page 1.
 */
export function handle_0DE135(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // LDA.L DATA_0DE12C,X - opcode $BF at +28, 3-byte operand at +29.
  // LDA.L DATA_0DE12F,X - opcode $BF at +41, 3-byte operand at +42.
  // LDA.L DATA_0DE132,X - opcode $BF at +55, 3-byte operand at +56.
  const addrLeft = readLongOperand(cur, cur.handlerAddr + 29)
  const addrMiddle = readLongOperand(cur, cur.handlerAddr + 42)
  const addrRight = readLongOperand(cur, cur.handlerAddr + 56)

  // Trace for W=W (>=1): write LEFT (advance), then DEC _2 from W. Loop middle
  // writes while _2 != 0; falls through after _2 reaches 0, writing RIGHT
  // without advance. Net row width = 1 + (W - 1) + 1 = W + 1 tiles.
  const emitRow = (x: number): void => {
    setPage1(cur)
    writeTileAdvance(cur, cur.rom.readByte(addrLeft + x) ?? 0)
    for (let m = 0; m < W - 1; m++) {
      setPage1(cur)
      writeTileAdvance(cur, cur.rom.readByte(addrMiddle + x) ?? 0)
    }
    setPage1(cur)
    writeTile(cur, cur.rom.readByte(addrRight + x) ?? 0)
  }

  saveBookmark(cur)
  // First row always uses X = 0.
  emitRow(0)
  restoreBookmark(cur)
  advanceRowRaw(cur)

  // Remaining rows: X = 1 for middle, X = 2 for the final row (when H >= 1).
  for (let r = 0; r < H; r++) {
    const isLast = r === H - 1
    emitRow(isLast ? 2 : 1)
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DECC9 (bank_0D.asm line 7939) -- single-tile rectangular fill for
 * tileset-5 (ghost house / castle) standard objects $35 and $36.
 *
 * Size byte: WWWWHHHH → width-1 (low nibble), height-1 (high nibble).
 *
 * Tile selection (DATA_0DECC6 = $92, $5E, $82):
 *   - Dispatcher preamble leaves X = objNo - 1 on entry. Handler immediately
 *     does TXA; SEC; SBC #$34; TAX, so in the body:
 *       obj $35 → X = 0 → low byte $92, page 0 (CPX #$01 not equal → skip
 *                                               Sta1To6ePointer)
 *       obj $36 → X = 1 → low byte $5E, page 1 (Sta1To6ePointer runs)
 *   - DATA_0DECC6[2] = $82 is unused from the $35/$36 dispatch path; reachable
 *     only if another routine jumps directly into CODE_0DECCE with X pre-set
 *     (no such caller in vanilla SMW).
 *
 * ASM control flow: saveBookmark once; per row, inner loop writes (W+1) tiles
 * advancing col, then restoreBookmark + nextRow; outer repeats for (H+1) rows.
 * The StzTo6ePointer / Sta1To6ePointer pair runs inside the inner loop in the
 * ASM, but the page is invariant for the whole call, so we set it once up front.
 */
export function handle_0DECC9(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f

  // Dispatcher preamble: X = objNo - 1 on entry. Handler then subtracts $34.
  const X = (cur.objNo - 1 - 0x34) & 0xff

  // LDA.L DATA_0DECC6,X - opcode $BF at handler+36, 3-byte operand at +37.
  // Byte layout: TXA(1) SEC(1) SBC#(2) TAX(1) LDY_dp(2) LDA_dp(2) AND#(2)
  //   STA_dp(2) STA_dp(2) LDA_dp(2) LSR×4(4) STA_dp(2) JSR(3) JSR(3) CPX#(2)
  //   BNE(2) JSR(3) = 36 bytes before the BF.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 37)
  const tileLow = cur.rom.readByte(tableAddr + X) ?? 0

  if (X === 1) setPage1(cur)
  else setPage0(cur)

  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, tileLow)
    }
    restoreBookmark(cur)
    nextRow(cur)
  }
}

/**
 * CODE_0DED99 (bank_0D.asm line 8067) -- vertical tile strip for tileset-5
 * standard object $3A (ghost-house pillar pieces).
 *
 * Size byte: HHHHVVVV
 *   V (low nibble)  = variant, indexes DATA_0DED95 = $5F, $60, $5A, $5B
 *   H (high nibble) = strip length - 1
 *
 * Tile ID is always page 1 (Sta1To6ePointer runs per iteration), so the final
 * stored tiles are $015F / $0160 / $015A / $015B. Writes (H+1) tiles straight
 * down from the cursor; no column advance between rows.
 */
export function handle_0DED99(cur: Cursor): void {
  const variant = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f

  // LDA.L DATA_0DED95,X - opcode $BF at handler+18, 3-byte operand at +19.
  // Byte layout: LDA_dp(2) AND#(2) TAX(1) LDY_dp(2) LDA_dp(2) LSR×4(4)
  //   STA_dp(2) JSR(3) = 18 bytes before the BF.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tileLow = cur.rom.readByte(tableAddr + variant) ?? 0

  setPage1(cur)
  for (let r = 0; r <= heightM1; r++) {
    writeTile(cur, tileLow)
    advanceRowRaw(cur)
  }
}

/**
 * Shared body of CODE_0DED43 / CODE_0DED4A -- draws a horizontal catwalk
 * strip starting at the cursor's current column. Writes 1 left-cap ($010A),
 * (initialX - 1) middles ($010B), and 1 right-cap ($010C) -- total `initialX
 * + 1` tiles -- all on page 1. The cursor is left one column past the final
 * middle ($010B) write; the right-cap write does NOT advance.
 *
 * ASM (CODE_0DED4A, bank_0D.asm line 8016):
 *   JSR Sta1To6ePointer; LDA #$0A; JMP into loop       ; first iter
 *   loop: JSR Sta1To6ePointer; LDA #$0B; CODE_0DA95B (write + advanceCol);
 *         DEX; BNE loop
 *   post: JSR Sta1To6ePointer; LDA #$0C; STA [Map16LowPtr],Y (no advance)
 */
function drawCatwalkStrip_0DED4A(cur: Cursor, initialX: number): void {
  if (initialX < 1) return
  setPage1(cur)
  writeTileAdvance(cur, 0x0a)
  for (let k = 0; k < initialX - 1; k++) {
    setPage1(cur)
    writeTileAdvance(cur, 0x0b)
  }
  setPage1(cur)
  writeTile(cur, 0x0c)
}

/**
 * CODE_0DED43 (bank_0D.asm line 8011) -- horizontal catwalk for tileset-5
 * standard object $38 (bare catwalk walkway, no support poles).
 *
 * Size byte: HHHHWWWW → W (low nibble) = strip length - 1. High nibble unused
 * by this handler. Emits (W + 1) tiles: $010A, $010B × (W - 1), $010C.
 *
 * Body is CODE_0DED4A which CODE_0DEEC0 also inlines; factored here as
 * drawCatwalkStrip_0DED4A(cur, X) with X = W.
 */
export function handle_0DED43(cur: Cursor): void {
  const W = cur.size & 0x0f
  drawCatwalkStrip_0DED4A(cur, W)
}

/**
 * CODE_0DEDB9 (bank_0D.asm line 8086) -- tileset-4 standard object $3B:
 * horizontal rail / fence strip (cap-body-cap, width W+1).
 *
 * Size byte: HHHHWWWW → W (low nibble) = strip length - 1. High nibble unused
 * by this handler. Emits (W+1) tiles, all on page 1:
 *   col 0        : $107 (left cap)
 *   cols 1..W-1  : $108 (body repeat)
 *   col W        : $109 (right cap)
 *
 * W=1 degenerates to $107,$109 (no body) because the `DEX / BNE -` loop hits
 * zero after the first CODE_0DEDCD entry. Cursor is left one column past the
 * final $108 write; the $109 store does not advance.
 */
export function handle_0DEDB9(cur: Cursor): void {
  const W = cur.size & 0x0f
  if (W < 1) return
  // Immediate operands:
  //   +11  A9 07    LDA #$07   (entry tile, left cap)
  //   +19  A9 08    LDA #$08   (loop body tile)
  //   +30  A9 09    LDA #$09   (right cap, no advance)
  const leftCap = readImmByte(cur, cur.handlerAddr + 11)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 19)
  const rightCap = readImmByte(cur, cur.handlerAddr + 30)

  setPage1(cur)
  writeTileAdvance(cur, leftCap)
  for (let k = 0; k < W - 1; k++) {
    setPage1(cur)
    writeTileAdvance(cur, bodyTile)
  }
  setPage1(cur)
  writeTile(cur, rightCap)
}

/**
 * CODE_0DEDDB (bank_0D.asm line 8106) -- tileset-4/5 standard object $3C:
 * cave/underground ceiling + BG fill block.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = width - 1.
 *   H (high nibble) = row count of $53 BG-fill ABOVE the $54 ceiling row.
 *
 * Emits an (H+1) x (W+1) rectangle:
 *   rows 0..H-1: $153 fill (page 1, Sta1To6ePointer)
 *   row H:       $154 ceiling (page 1)
 *
 * Loop structure in ASM: outer loop runs H times, each inner loop writes W+1
 * tiles of $53; after H iterations falls through to the $54 writer that runs
 * once with X still = W.
 */
export function handle_0DEDDB(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // Immediate operands verified by ROM dump (see disassembly byte layout):
  //   +29  A9 53    LDA #$53   (BG fill)
  //   +52  A9 54    LDA #$54   (ceiling)
  const fillTile = readImmByte(cur, cur.handlerAddr + 29)
  const ceilingTile = readImmByte(cur, cur.handlerAddr + 52)

  setPage1(cur)
  saveBookmark(cur)
  for (let r = 0; r < H; r++) {
    for (let c = 0; c <= W; c++) writeTileAdvance(cur, fillTile)
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
  for (let c = 0; c <= W; c++) writeTileAdvance(cur, ceilingTile)
}

/**
 * CODE_0DEE17 (bank_0D.asm line 8139) -- tileset-4/5 standard object $3D:
 * cave/underground floor + BG fill block.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = width - 1.
 *   H (high nibble) = row count of $53 BG-fill BELOW the $5D floor row.
 *
 * Emits an (H+2) x (W+1) rectangle:
 *   row 0:       $15D floor top (page 1)
 *   rows 1..H+1: $153 BG fill (page 1)
 *
 * Loop structure: first writes one $5D row (W+1 tiles); then jumps into the
 * shared end block (restore/advance/LDX/DEC/BPL) which then loops back into
 * the $53 writer. The outer BPL runs while _1 >= 0, so (H+1) iterations of
 * the $53 writer execute -- plus the initial $5D row = H+2 rows total.
 */
export function handle_0DEE17(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // Immediate operands:
  //   +25  A9 5D    LDA #$5D   (floor top)
  //   +39  A9 53    LDA #$53   (BG fill)
  const floorTile = readImmByte(cur, cur.handlerAddr + 25)
  const fillTile = readImmByte(cur, cur.handlerAddr + 39)

  setPage1(cur)
  saveBookmark(cur)
  for (let c = 0; c <= W; c++) writeTileAdvance(cur, floorTile)
  for (let r = 0; r <= H; r++) {
    restoreBookmark(cur)
    advanceRowRaw(cur)
    for (let c = 0; c <= W; c++) writeTileAdvance(cur, fillTile)
  }
}

/**
 * CODE_0DEE52 (bank_0D.asm line 8172) -- tileset-4/5 standard object $3E:
 * left-wall column with optional BG fill to its right.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = count of $53 BG-fill tiles to the LEFT of each $55 wall.
 *                     (ASM: BNE loop, so exactly W tiles are written; W=0 skips.)
 *   H (high nibble) = row count - 1 for the whole structure.
 *
 * For each row 0..H: writes W tiles of $53 (page 1), then 1 tile of $55 (page 1).
 * Used in level 014 with W=0: produces a pure vertical wall of $155 tiles.
 */
export function handle_0DEE52(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // Immediate operands:
  //   +27  A9 53    LDA #$53   (BG fill, repeated W times per row)
  //   +38  A9 55    LDA #$55   (left wall, once per row)
  const fillTile = readImmByte(cur, cur.handlerAddr + 27)
  const wallTile = readImmByte(cur, cur.handlerAddr + 38)

  setPage1(cur)
  saveBookmark(cur)
  for (let r = 0; r <= H; r++) {
    for (let c = 0; c < W; c++) writeTileAdvance(cur, fillTile)
    writeTileAdvance(cur, wallTile)
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DEE89 (bank_0D.asm line 8203) -- tileset-4/5 standard object $3F:
 * right-wall column with optional BG fill to its left.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = count of $53 BG-fill tiles to the RIGHT of each $5C wall.
 *                     (ASM: BPL loop, so W+1 tiles are written; W=0 via BEQ
 *                     skip → zero tiles.)
 *   H (high nibble) = row count - 1 for the whole structure.
 *
 * For each row 0..H: writes 1 tile of $5C (page 1), then (W+1 when W>0, else 0)
 * tiles of $53 (page 1). Used in level 014 with W=0: produces a pure vertical
 * right-wall of $15C tiles.
 */
export function handle_0DEE89(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // Immediate operands:
  //   +23  A9 5C    LDA #$5C   (right wall, once per row)
  //   +35  A9 53    LDA #$53   (BG fill, W+1 times per row when W>0)
  const wallTile = readImmByte(cur, cur.handlerAddr + 23)
  const fillTile = readImmByte(cur, cur.handlerAddr + 35)

  setPage1(cur)
  saveBookmark(cur)
  for (let r = 0; r <= H; r++) {
    writeTileAdvance(cur, wallTile)
    if (W !== 0) {
      for (let c = 0; c <= W; c++) writeTileAdvance(cur, fillTile)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DEEC0 (bank_0D.asm line 8234) -- tileset-5 standard object $34:
 * horizontal catwalk + periodic vertical support poles.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = controls BOTH the catwalk width and the pole count:
 *                     catwalk is (W*4 + 3) tiles, poles are drawn W+1 times
 *                     (spaced 4 columns apart).
 *   H (high nibble) = pole height: writes H tiles per pole ($0078 then
 *                     $0079 × (H - 1)). All four vanilla instances use H=2.
 *
 * ASM control flow:
 *   1. saveBookmark (Map16LowPtr).
 *   2. JSR CODE_0DED4A with X = W*4 + 2 → catwalk of W*4 + 3 tiles on page 1.
 *   3. restoreBookmark; advance cursor to (startCol + 1, startRow + 1).
 *   4. Loop (W+1) times: draw one pole at current column going down H tiles
 *      on page 0 ($78, $79, $79, ...); then advance LevelLoadPos by 4 cols
 *      (with screen-wrap rollback that effectively keeps absolute col = prev
 *      pole's col + 4).
 *
 * The screen-wrap branch at the end of each pole loop (SBC #$10 + CODE_0DA9EF)
 * unwinds the automatic row++ that happens when the byte-encoded LevelLoadPos
 * overflows its low nibble past $F. In the flat (col, row) model we compute
 * absolute columns directly, so no rollback is needed -- each pole lives at
 * startCol + 1 + 4 * p for p in [0, W].
 */
export function handle_0DEEC0(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f
  const startCol = cur.col
  const startRow = cur.row

  saveBookmark(cur)

  // Catwalk: X = W*4 + 2 produces W*4 + 3 tiles at row = startRow.
  drawCatwalkStrip_0DED4A(cur, W * 4 + 2)

  // Poles: W + 1 of them, spaced 4 cols, each H tiles tall starting one
  // row below the catwalk. First pole is at startCol + 1 (the catwalk's
  // second tile).
  for (let p = 0; p <= W; p++) {
    cur.col = startCol + 1 + p * 4
    cur.row = startRow + 1
    setPage0(cur)
    writeTile(cur, 0x78)
    for (let k = 1; k < H; k++) {
      cur.row += 1
      setPage0(cur)
      writeTile(cur, 0x79)
    }
  }
}

/**
 * CODE_0DED6B (bank_0D.asm line 8039) -- standalone vertical pole/column for
 * tileset-5 standard object $39. Same shape as CODE_0DED99 but with a
 * two-table top-cap / body split (and page 0 instead of page 1).
 *
 * Size byte: HHHHVVVV → V (low nibble) = variant, H (high nibble) = length - 1.
 *
 * Tile selection:
 *   First row:      DATA_0DED65[V] → $83, $78, $79
 *   Remaining rows: DATA_0DED68[V] → $83, $79, $79
 *
 *   V=0: uniform $0083 pole (no cap).
 *   V=1: $0078 cap + $0079 body - identical to CODE_0DEEC0's catwalk poles
 *        (obj $34), used for poles detached from a catwalk.
 *   V=2: uniform $0079 body (no cap).
 */
export function handle_0DED6B(cur: Cursor): void {
  const variant = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f

  // First-row LDA.L operand at +19, subsequent-row LDA.L operand at +29.
  const addrFirst = readLongOperand(cur, cur.handlerAddr + 19)
  const addrBody = readLongOperand(cur, cur.handlerAddr + 29)
  const firstTile = cur.rom.readByte(addrFirst + variant) ?? 0
  const bodyTile = cur.rom.readByte(addrBody + variant) ?? 0

  setPage0(cur)
  writeTile(cur, firstTile)
  for (let r = 1; r <= heightM1; r++) {
    advanceRowRaw(cur)
    setPage0(cur)
    writeTile(cur, bodyTile)
  }
}

/**
 * CODE_0DEF67 (bank_0D.asm line 8334) -- tileset-5 standard object $32:
 * floor/ground strip with a top row of page-1 cap tiles and a solid body
 * of page-0 fill tiles below.
 *
 * Size byte: HHHHWWWW
 *   W (low nibble)  = strip width - 1.
 *   H (high nibble) = body row count (rows of fill beneath the top cap).
 *
 * Layout:
 *   row 0:        (W+1) tiles of $010E (page 1, floor cap)
 *   rows 1..H+1:  (W+1) tiles of $00A3 (page 0, body fill) each
 *
 * ASM control flow: JSR CODE_0DA6B1 saves the starting column, the first
 * inner loop runs LDX _0 / DEX / BPL for (W+1) writes, then CODE_0DEF87
 * decrements _1 and loops with JSR CODE_0DA6BA (restore column) + JSR
 * CODE_0DA97D (advance row) before the next row's (W+1) fill writes.
 */
export function handle_0DEF67(cur: Cursor): void {
  const W = cur.size & 0x0f
  const H = (cur.size >> 4) & 0x0f

  // Immediate operands (bytecode layout at CODE_0DEF67):
  //   +24  A9 0E    LDA #$0E   (page-1 floor cap)   - operand at +25
  //   +47  A9 A3    LDA #$A3   (page-0 body fill)   - operand at +48
  const capTile = readImmByte(cur, cur.handlerAddr + 25)
  const fillTile = readImmByte(cur, cur.handlerAddr + 48)

  saveBookmark(cur)
  setPage1(cur)
  for (let c = 0; c <= W; c++) writeTileAdvance(cur, capTile)
  for (let r = 0; r <= H; r++) {
    restoreBookmark(cur)
    advanceRowRaw(cur)
    saveBookmark(cur)
    setPage0(cur)
    for (let c = 0; c <= W; c++) writeTileAdvance(cur, fillTile)
  }
}

/**
 * CODE_0DB966 (bank_0D.asm line 4251) -- vertical tree-trunk stripe, single column
 * (object 55 in tilesets 0/7/12). Draws a 1-column-wide vertical stripe where the
 * tile alternates between a "top" tile (DATA_0DB962[X]) and a "bottom" tile
 * (DATA_0DB964[X]) every row. X comes from the low nibble of the size byte and
 * selects between two trunk variants ($BD/$BE vs $BF/$C0).
 *
 * Size byte: HHHHVVVV
 *   V (low nibble, X)  = variant (0 or 1).
 *   H (high nibble)    = length counter; total rows = H + 1 if H is even, else H.
 *
 * The ASM double-decrements `_0` per iteration (once between the two rows of a
 * pair, once at the bottom of the loop). Net row count = H + 1.
 *
 * CODE_0DB997 context-merge (only for X == 1):
 *   - existing tile is $B1 or $B6 → write existing+1 (B1→B2, B6→B7)
 * CODE_0DB997 context-merge (otherwise, X != 1):
 *   - existing tile is $0E (slope) → set page 1 and write $0D
 *
 * The bottom tile is written via raw STA (no merge, no advance).
 */
export function handle_0DB966(cur: Cursor): void {
  const X = cur.size & 0x0f
  // LDA.L DATA_0DB962 operand at handler +19, DATA_0DB964 operand at handler +36.
  const addrTop = readLongOperand(cur, cur.handlerAddr + 19)
  const addrBottom = readLongOperand(cur, cur.handlerAddr + 36)
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const bottomTile = cur.rom.readByte(addrBottom + X) ?? 0

  let count = (cur.size >> 4) & 0x0f
  while (true) {
    // Top tile with context merge.
    const existingTop = peekExistingLow(cur)
    setPage0(cur)
    let out = topTile
    if (X === 1) {
      if (existingTop === 0xb1 || existingTop === 0xb6) out = (existingTop + 1) & 0xff
    } else {
      if (existingTop === 0x0e) {
        setPage1(cur)
        out = 0x0d
      }
    }
    writeTile(cur, out)
    advanceRowRaw(cur)
    count -= 1
    if (count < 0) return

    // Bottom tile -- raw write, no merge.
    setPage0(cur)
    writeTile(cur, bottomTile)
    advanceRowRaw(cur)
    count -= 1
    if (count < 0) return
  }
}

/**
 * CODE_0DB9C0 (bank_0D.asm line 4304) -- vertical 2-wide tree-trunk stripe
 * (object 54 in tilesets 0/7/12). Each iteration writes two tiles horizontally
 * across two rows:
 *   Row R:   $B9 (left, context-merged), $BA (right)
 *   Row R+1: $BB (left),                 $BC (right)
 *
 * CODE_0DB9F6 context-merge (left tile of top row): if existing tile is $0E
 * (slope), set page 1 and replace X ($B9) with $0B ($0C for the neighbour).
 *
 * Size byte: HHHH----
 *   H (high nibble) = length counter; loops H+1 times producing 2×(H+1) rows.
 */
export function handle_0DB9C0(cur: Cursor): void {
  const topLeftTile = readImmByte(cur, cur.handlerAddr + 14) // LDX.B #$B9 at +13, imm at +14
  const botLeftTile = readImmByte(cur, cur.handlerAddr + 32) // LDA.B #$BB at +31, imm at +32
  const botRightTile = readImmByte(cur, cur.handlerAddr + 40) // LDA.B #$BC at +39, imm at +40

  let count = (cur.size >> 4) & 0x0f
  const startCol = cur.col
  while (true) {
    // Top row: CODE_0DB9F6 context merge on left tile. Right tile = X+1.
    const existing = peekExistingLow(cur)
    if (existing === 0x0e) {
      setPage1(cur)
      writeTile(cur, 0x0b) // replace slope with $0B
      cur.col += 1
      writeTile(cur, 0x0c) // neighbour = $0B + 1
    } else {
      writeTile(cur, topLeftTile) // $B9
      cur.col += 1
      writeTile(cur, (topLeftTile + 1) & 0xff) // $BA
    }
    cur.col = startCol
    advanceRowRaw(cur)
    count -= 1
    if (count < 0) return

    // Bottom row: raw $BB, $BC (no merge).
    setPage0(cur)
    writeTile(cur, botLeftTile)
    cur.col += 1
    writeTile(cur, botRightTile)
    cur.col = startCol
    advanceRowRaw(cur)
    count -= 1
    if (count < 0) return
  }
}

/**
 * CODE_0DBA4C (bank_0D.asm line 4386) -- vertical slope-shoulder stripe
 * (object 52 in tilesets 0/7/12). Single-column vertical line; the top row uses
 * DATA_0DBA44[X] (page 1), and all following rows use DATA_0DBA48[X] with a
 * page-1 prefix that only applies when X < 2.
 *
 * Size byte: HHHHVVVV
 *   V (low nibble, X)  = variant index (0-3) selecting both tables.
 *   H (high nibble)    = count (H + 1 rows written below the top).
 *
 * ASM path: JSR Sta1To6ePointer once up-front, then STA top tile, JMP to loop
 * body. Each iteration in the body: CPX #$02 / BPL skip / JSR Sta1To6ePointer;
 * then STA body tile, advance row, DEC _0, BPL.
 */
export function handle_0DBA4C(cur: Cursor): void {
  const X = cur.size & 0x0f
  const addrTop = readLongOperand(cur, cur.handlerAddr + 19) // DATA_0DBA44
  const addrBody = readLongOperand(cur, cur.handlerAddr + 35) // DATA_0DBA48
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const bodyTile = cur.rom.readByte(addrBody + X) ?? 0

  // Top row: page 1 unconditionally.
  setPage1(cur)
  writeTile(cur, topTile)

  let count = (cur.size >> 4) & 0x0f
  while (count >= 0) {
    advanceRowRaw(cur)
    // Body tile: page 1 only when X < 2 (CPX #$02 / BPL skip-page1).
    if (X < 2) setPage1(cur)
    else setPage0(cur)
    writeTile(cur, bodyTile)
    count -= 1
  }
}

/**
 * CODE_0DBADC (bank_0D.asm line 4429) -- large 16×6 canopy rectangle, repeated
 * horizontally (object 51 in tilesets 0/7/12). Used to tile the Forest of
 * Illusion canopy and similar wide foliage blocks.
 *
 * Size byte: raw count of additional 16-col repeats (count + 1 total). So
 * settings=$0F draws 16 blocks × 16 cols = 256 cols wide.
 *
 * Each block is a 16 cols × 6 rows slab drawn from DATA_0DBA7C (96 bytes). The
 * table is indexed sequentially by X which is reset to 0 at the start of each
 * block, so every block emits the identical 6×16 pattern.
 *
 * Row advance uses CODE_0DA97D (the "+$10 to LevelLoadPos" pattern); we model
 * that with advanceRowRaw. Block advance in the ASM is Map16LowPtr += $B0 after
 * the 6th row has already bumped Map16LowPtr+1 by $01 (via CODE_0DA987 on the
 * row-5 → row-6 carry). Net effect: next block starts 16 cols to the right at
 * the same starting row. In the flat-grid model this is simply col = startCol +
 * blockIndex × 16, row = startRow for each block.
 */
export function handle_0DBADC(cur: Cursor): void {
  const blockCount = cur.size & 0xff // raw size byte (count + 1 blocks)
  const innerRows = readImmByte(cur, cur.handlerAddr + 12) + 1 // #$05 + 1 = 6
  const innerCols = readImmByte(cur, cur.handlerAddr + 16) + 1 // #$0F + 1 = 16
  const dataAddr = readLongOperand(cur, cur.handlerAddr + 27) // DATA_0DBA7C

  const startCol = cur.col
  const startRow = cur.row

  setPage0(cur) // ASM does not Stz/Sta here, but CODE_0DA95B preserves page
  // state via the caller; the default at object entry is page 0.

  for (let block = 0; block <= blockCount; block++) {
    const blockStartCol = startCol + block * innerCols
    let x = 0
    for (let r = 0; r < innerRows; r++) {
      cur.row = startRow + r
      for (let c = 0; c < innerCols; c++) {
        cur.col = blockStartCol + c
        const tile = cur.rom.readByte(dataAddr + x) ?? 0
        writeTile(cur, tile)
        x += 1
      }
    }
  }
}

/**
 * CODE_0DB604 (bank_0D.asm line 3800) -- 2:1 slope block (object $3C).
 *
 * Draws a 4-row × (3·n+1)-column slope shape from DATA_0DB5E8 (28-byte stream).
 * Row 0 uses page 1 (Sta1To6ePointer); rows 1-3 use page 0 (StzTo6ePointer).
 *
 * Size byte: ----NNNN
 *   N (low nibble, _0) = width divisor (must be ≥ 1).
 *   Tiles per row = 3·N + 1; total data consumed = 4 × (3·N + 1) = 28 for N=2.
 *
 * Within each row the tile stream is:
 *   - 3 tiles from the "first" group (DATA_0DB5E8 base table, indices X..X+2)
 *   - (N-1) × 3 tiles from the "middle" groups (DATA[X..X+2] repeated N-1 times,
 *     with the SAME X as above, so middle uses DATA[X], DATA[X+1], DATA[X+2])
 *   - X += 3 (skip to cap group), 1 cap tile
 *   - X++ (position for next row)
 *
 * DATA_0DB5E8 base address is read from the LDA.L operand at handler offset +$1D.
 */
export function handle_0DB604(cur: Cursor): void {
  const _0 = cur.size & 0x0f // width parameter (N)
  // LDA.L DATA_0DB5E8,X opcode=$BF at handler+$1C, operand at handler+$1D.
  const dataBase = readLongOperand(cur, cur.handlerAddr + 0x1d)

  const startCol = cur.col
  const startRow = cur.row

  let X = 0
  for (let rowIdx = 0; rowIdx < 4; rowIdx++) {
    cur.col = startCol
    cur.row = startRow + rowIdx

    // Row 0 uses page 1 (CODE_0DB604 path: Sta1To6ePointer).
    // Rows 1-3 use page 0 (CODE_0DB664 path: StzTo6ePointer).
    const page = rowIdx === 0 ? 1 : 0

    // First group: 3 tiles at DATA[X], DATA[X+1], DATA[X+2] (always 3 tiles).
    for (let i = 0; i < 3; i++) {
      cur.page = page
      writeTileAdvance(cur, cur.rom.readByte(dataBase + X + i) ?? 0)
    }
    X += 3

    // Middle groups: (_0 - 1) iterations, each reading DATA[X], DATA[X+1], DATA[X+2].
    // Note: X does NOT advance inside the middle loop body (same 3 entries re-read).
    let _2 = _0
    _2 -= 1 // mirrors DEC _2 before the BEQ check
    if (_2 > 0) {
      // Middle loop: run _2 more times (DEC _2; BNE -)
      let mid = _2
      while (mid > 0) {
        cur.page = page
        writeTileAdvance(cur, cur.rom.readByte(dataBase + X + 0) ?? 0)
        cur.page = page
        writeTileAdvance(cur, cur.rom.readByte(dataBase + X + 1) ?? 0)
        cur.page = page
        writeTileAdvance(cur, cur.rom.readByte(dataBase + X + 2) ?? 0)
        mid -= 1
      }
    }
    // CODE_0DB652/0DB6A3: X += 3, then write cap tile.
    X += 3
    cur.page = page
    writeTileAdvance(cur, cur.rom.readByte(dataBase + X) ?? 0)
    // CODE_0DB6B2: INX (position for next row).
    X += 1
  }
}

/**
 * CODE_0DBB2C (bank_0D.asm line 4473) -- 2-wide vertical slope pillar (object $30).
 *
 * Draws a 2-column-wide vertical stripe downward. The top row writes tile-pair
 * ($161, $162). Each subsequent row writes ($163, $164). Total rows = 1 + X+1
 * where X = LvlLoadObjSize >> 4 (high nibble of size byte).
 *
 * Size byte: NNNN----
 *   N (high nibble) = body row count - 1 (BPL loop runs N+1 times after header).
 *
 * All tiles are written page 1 (Sta1To6ePointer before each write).
 *
 * ASM flow:
 *   - Header: write $61 (page 1, advance), $62 (page 1, no advance) → JMP CODE_0DBB59
 *   - Body (label -): write $63 (page 1, advance), $64 (page 1, no advance)
 *   CODE_0DBB59: restoreBookmark, nextRow, DEX, BPL -
 */
export function handle_0DBB2C(cur: Cursor): void {
  const startCol = cur.col
  const startRow = cur.row
  const X = (cur.size >> 4) & 0x0f // high nibble

  // Header row: write $61 (advance) and $62 (no advance), both page 1.
  cur.row = startRow
  cur.col = startCol
  cur.page = 1
  writeTileAdvance(cur, 0x61) // → tile $161
  cur.page = 1
  writeTile(cur, 0x62) // → tile $162 at col+1, no advance

  // JMP CODE_0DBB59: restore col, next row, DEX, BPL.
  // Body loop: runs while X >= 0 after DEX, but first DEX is at CODE_0DBB59
  // which is reached via JMP from the header. So DEX happens before first body.
  // Total body rows = X (initial value, since DEX runs before re-entering '-').
  for (let row = 1; row <= X; row++) {
    cur.row = startRow + row
    cur.col = startCol
    cur.page = 1
    writeTileAdvance(cur, 0x63) // → tile $163
    cur.page = 1
    writeTile(cur, 0x64) // → tile $164 at col+1, no advance
  }
}

/**
 * CODE_0DBB63 (bank_0D.asm line 4503) -- rectangular fill using tile slot 14.
 *
 *   LDX.B #$0E
 *   JMP CODE_0DA8C3
 *
 * Identical to handle_0DA8C3 but forces X=14, which reads DATA_0DA8B4[14]=$65
 * (the 15th entry) and uses page 1 (X >= 7 → Sta1To6ePointer). Effectively
 * stamps tile $165 in a (width+1) × (height+1) rectangle.
 *
 * Size byte: WWWWHHHH (same as CODE_0DA8C3).
 *
 * We read DATA_0DA8B4 from CODE_0DA8C3's LDA.L operand (at $0DA8C3 + $6C)
 * and use index 14 directly, bypassing handle_0DA8C3's x<14 bounds check
 * (the table has 15 entries; handle_0DA8C3 only covers objects 1-14 = x 0-13).
 */
export function handle_0DBB63(cur: Cursor): void {
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f

  // CODE_0DA8C3 is at $0DA8C3; its LDA.L DATA_0DA8B4,X opcode (CODE_0DA92E)
  // is at offset +$6B; 3-byte operand at +$6C = absolute $0DA92F.
  const tableAddr = readLongOperand(cur, 0x0da8c3 + 0x6c)
  const tileId = cur.rom.readByte(tableAddr + 14) ?? 0 // index 14 = $65

  // X=14 >= 7 → Sta1To6ePointer → page 1.
  setPage1(cur)
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
 * CODE_0DED12 (bank_0D.asm line 7985) -- ghost-house horizontal strip
 * (object $37 in tileset-5 family dispatcher $0DE890 - tilesets 4/5/13).
 *
 * Writes a single horizontal row of W+1 tiles: one start tile, W-1 body tiles,
 * and one end tile. The three tile IDs are selected from three parallel 3-entry
 * tables (DATA_0DED09, DATA_0DED0C, DATA_0DED0F) indexed by the high nibble of
 * the size byte (X = size >> 4).
 *
 * Size byte: XXXWWWWW (only low nibble W used as repeat counter; high nibble X
 * selects the variant row from each 3-entry table).
 *
 * ASM layout:
 *   _0 = size & $0F  (W, width counter)
 *   X  = size >> 4   (variant index for table lookup)
 *   StzTo6ePointer; LDA.L DATA_0DED09,X; JMP CODE_0DED32
 *     (→ writeTileAdvance; DEC _0; BNE to body)
 *   body: StzTo6ePointer; LDA.L DATA_0DED0C,X
 *   CODE_0DED32: writeTileAdvance; DEC _0; BNE body
 *   end: StzTo6ePointer; LDA.L DATA_0DED0F,X; STA (no advance)
 *
 * Total = W+1 tiles (1 start + W-1 bodies + 1 end).
 * LDA.L DATA_0DED09,X operand at handler offset +19 (opcode $BF at +18)
 * LDA.L DATA_0DED0C,X operand at handler offset +29 (opcode at +28)
 * LDA.L DATA_0DED0F,X operand at handler offset +43 (opcode at +42)
 */
export function handle_0DED12(cur: Cursor): void {
  const W = cur.size & 0x0f
  const X = (cur.size >> 4) & 0x0f
  const addrStart = readLongOperand(cur, cur.handlerAddr + 19) // DATA_0DED09
  const addrBody = readLongOperand(cur, cur.handlerAddr + 29) // DATA_0DED0C
  const addrEnd = readLongOperand(cur, cur.handlerAddr + 43) // DATA_0DED0F
  const startTile = cur.rom.readByte(addrStart + X) ?? 0
  const bodyTile = cur.rom.readByte(addrBody + X) ?? 0
  const endTile = cur.rom.readByte(addrEnd + X) ?? 0

  setPage0(cur)
  writeTileAdvance(cur, startTile)
  for (let i = 1; i < W; i++) {
    setPage0(cur)
    writeTileAdvance(cur, bodyTile)
  }
  setPage0(cur)
  writeTile(cur, endTile)
}

/**
 * CODE_0DB863 (bank_0D.asm line 4108) -- diagonal staircase, left-descending
 * (object $3B in tileset-5 family dispatcher $0DE890 - tilesets 4/5/13).
 *
 * Draws a staircase that descends diagonally down-left. Each diagonal step uses
 * CODE_0DA992 (diagonalDownLeft: col--, row++). The staircase has two phases:
 *
 *   Phase 1 - expanding triangle of width-height rows:
 *     First row: slopeMerge($AF) + pipeMerge($1AF) [1-tile row]
 *     Main loop (width rows): slopeMerge($A9) + (_1-2) fills($3F) + advance($1E4) + pipeMerge($1AF)
 *       where _1 grows by 2 each diagonal step (starts at 1, first loop at 3).
 *     End row: slopeMerge($A9) + (_1-2) fills($3F) + slopeMerge($1F9) [no E4/AF]
 *       Note: at the end row, _1 is decremented by 1 (DEX; STX _1), so fills = _1-1.
 *
 *   Phase 2 - extending tail of height+1 rows:
 *     Each row: slopeMerge($A9) + (_1-1) fills($3F) + slopeMerge($0AC)
 *     _1 stays fixed at the phase1-end value. Runs height+1 times.
 *
 * Size byte: HHHHWWWW  (H = high nibble = height, W = low nibble = width).
 *
 * Immediate tile offsets from CODE_0DB863 base address:
 *   +29  $AF  first row slope (page 0)
 *   +37  $AF  first row pipe (page 1)
 *   +48  $A9  main-loop slope (page 0)
 *   +59  $3F  main-loop fill (page 0)
 *   +72  $E4  main-loop E4 (page 1)
 *   +80  $AF  main-loop pipe (page 1)
 *   +107 $A9  phase1-end slope (page 0)
 *   +118 $3F  phase1-end fill (page 0)
 *   +129 $F9  phase1-end cap (page 1)
 *   +140 $A9  phase2 slope (page 0)
 *   +151 $3F  phase2 fill (page 0)
 *   +162 $AC  phase2 cap (page 0)
 */
export function handle_0DB863(cur: Cursor): void {
  const width = cur.size & 0x0f
  const height = (cur.size >> 4) & 0x0f

  const tAF1 = readImmByte(cur, cur.handlerAddr + 29) // $AF  first-row slope
  const tAF2 = readImmByte(cur, cur.handlerAddr + 37) // $AF  first-row pipe
  const tA9a = readImmByte(cur, cur.handlerAddr + 48) // $A9  main-loop slope
  const t3Fa = readImmByte(cur, cur.handlerAddr + 59) // $3F  main-loop fill
  const tE4 = readImmByte(cur, cur.handlerAddr + 72) // $E4  main-loop E4
  const tAFb = readImmByte(cur, cur.handlerAddr + 80) // $AF  main-loop pipe
  const tA9b = readImmByte(cur, cur.handlerAddr + 107) // $A9  phase1-end slope
  const t3Fb = readImmByte(cur, cur.handlerAddr + 118) // $3F  phase1-end fill
  const tF9 = readImmByte(cur, cur.handlerAddr + 129) // $F9  phase1-end cap
  const tA9c = readImmByte(cur, cur.handlerAddr + 140) // $A9  phase2 slope
  const t3Fc = readImmByte(cur, cur.handlerAddr + 151) // $3F  phase2 fill
  const tAC = readImmByte(cur, cur.handlerAddr + 162) // $AC  phase2 cap

  let _1 = 1
  let _2 = width
  let _3 = height

  // First diagonal row (jumps directly to CODE_0DB8B7 via JMP).
  saveBookmark(cur)
  setPage0(cur)
  writeTileSlopeMerge(cur, tAF1)
  setPage1(cur)
  writeTilePipeMerge(cur, tAF2)
  // CODE_0DB8B7: restoreBookmark, diagonalDownLeft, then update counters and loop.
  restoreBookmark(cur)
  diagonalDownLeft(cur)
  _1 += 2
  _2--
  saveBookmark(cur)

  // Main loop (CODE_0DB88F): runs while _2 >= 0.
  // X = _1 on each entry (set by LDX _1 at the top of CODE_0DB8B7).
  // Fill loop (CODE_0DB8A2): DEX first, then BNE while X != 1 → fills = _1 - 2.
  while (_2 >= 0) {
    setPage0(cur)
    writeTileSlopeMerge(cur, tA9a)
    let x = _1 - 1 // first DEX inside CODE_0DB8A2
    while (x !== 1) {
      setPage0(cur)
      writeTileAdvance(cur, t3Fa)
      x--
    }
    setPage1(cur)
    writeTileAdvance(cur, tE4)
    setPage1(cur)
    writeTilePipeMerge(cur, tAFb)
    // CODE_0DB8B7
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    _1 += 2
    _2--
    saveBookmark(cur)
  }

  // Phase 1 end: DEX; STX _1 → _1 decremented by 1.
  // Fill loop (CODE_0DB8DD): DEX first, then BNE while X != 0 → fills = _1 - 1.
  _1 -= 1
  setPage0(cur)
  writeTileSlopeMerge(cur, tA9b)
  let x2 = _1 - 1 // first DEX inside CODE_0DB8DD
  while (x2 !== 0) {
    setPage0(cur)
    writeTileAdvance(cur, t3Fb)
    x2--
  }
  setPage1(cur)
  writeTileSlopeMerge(cur, tF9)
  // JMP CODE_0DB909
  restoreBookmark(cur)
  diagonalDownLeft(cur)
  saveBookmark(cur)

  // Phase 2 loop (CODE_0DB8EB): runs while _3 >= 0.
  // X = _1 on each entry (LDX _1 at CODE_0DB909).
  // Fill loop (CODE_0DB8FE): DEX first, then BNE while X != 0 → fills = _1 - 1.
  // CODE_0DB909 does DEC _3 BEFORE the BPL check, so decrement once before entering.
  _3--
  while (_3 >= 0) {
    setPage0(cur)
    writeTileSlopeMerge(cur, tA9c)
    let x3 = _1 - 1 // first DEX inside CODE_0DB8FE
    while (x3 !== 0) {
      setPage0(cur)
      writeTileAdvance(cur, t3Fc)
      x3--
    }
    setPage0(cur)
    writeTileSlopeMerge(cur, tAC)
    // CODE_0DB909
    restoreBookmark(cur)
    diagonalDownLeft(cur)
    saveBookmark(cur)
    _3--
  }
}

/**
 * CODE_0DDAC8 (bank_0D.asm line 6450) -- vertical column of cliff tiles
 * (object $38 in tileset-3/9/10/11/14 dispatcher $0DD990).
 *
 * Writes a vertical strip: one top tile from DATA_0DDAC4[X] (page 1), then
 * _0 body tiles from DATA_0DDAC6[X] (page 1), each advancing one row down.
 * Uses raw row-advance (CODE_0DA97D), not restoreBookmark.
 *
 * Size byte HHHHWWWW:
 *   W = low nibble  → tile-variant selector X (DATA table index)
 *   H = high nibble → body row count after the first tile
 *
 * DATA_0DDAC4 = [$5A, $5B]  (top tile variants)
 * DATA_0DDAC6 = [$5B, $5B]  (body tile variants, both $5B)
 */
export function handle_0DDAC8(cur: Cursor): void {
  const DATA_0DDAC4 = [0x5a, 0x5b]
  const DATA_0DDAC6 = [0x5b, 0x5b]
  const X = cur.size & 0x0f
  let _0 = (cur.size >> 4) & 0x0f

  setPage1(cur)
  writeTile(cur, DATA_0DDAC4[X] ?? 0x5b)
  advanceRowRaw(cur)
  _0--
  while (_0 >= 0) {
    setPage1(cur)
    writeTile(cur, DATA_0DDAC6[X] ?? 0x5b)
    advanceRowRaw(cur)
    _0--
  }
}

/**
 * CODE_0DDAF2 (bank_0D.asm line 6474) -- diagonal cliff staircase dispatcher
 * (object $39 in tileset-3/9/10/11/14 dispatcher $0DD990).
 *
 * Dispatches on the low 2 bits of size to one of four sub-handlers, each
 * building a different staircase/cliff shape using page-1 terrain tiles.
 *
 * Sub-handlers:
 *   bits 00 → CODE_0DDB06: 2-wide diagonal staircase ($D2/$D3 header, $FB/$FF fill)
 *   bits 01 → CODE_0DDB8F: 1-wide diagonal staircase ($D6 header, $FD/$FF fill)
 *   bits 10 → ADDR_0DDC02: 2-wide right-growing staircase ($D4/$D5 header, $FC/$FF fill)
 *   bits 11 → CODE_0DDC61: 1-wide right-growing staircase ($D7 header, $FE/$FF fill)
 *
 * Size byte: HHHHWWWW -- high nibble encodes the step count (_0 = H+1); low 2 bits
 * select the sub-handler variant.
 *
 * All tile writes use page 1 (Sta1To6ePointer before each CODE_0DA95B call).
 *
 * ASM: bank_0D.asm lines 6474–6722.
 */
export function handle_0DDAF2(cur: Cursor): void {
  const variant = cur.size & 0x03
  switch (variant) {
    case 0:
      return _0DDB06(cur)
    case 1:
      return _0DDB8F(cur)
    case 2:
      return _0DDC02(cur)
    case 3:
      return _0DDC61(cur)
  }
}

/**
 * CODE_0DDB06 (bank_0D.asm line 6484) -- 2-wide left-descending cliff staircase.
 *
 * Draws a staircase that descends diagonally down-left by 2 columns per row.
 * Row 0 (at the object origin) writes the 2-tile header $D2/$D3.
 * Each subsequent row steps 2 columns left and 1 row down, then writes a growing
 * run: $D2/$D3 header + $FB/$FF fill + $FF inner fill (width grows by 2/row).
 * When _0 hits zero (BEQ CODE_0DDB84), one extra row is written one row below the
 * last diagonal position, using only the $FB/$FF fill pattern (no D2/D3 header).
 *
 * Initial _2=1. _0=(size>>4)+1.
 *
 * SNES invariant: `LevelLoadPos` RAM holds the diagonal-position accumulator.
 * `CODE_0DA6BA` (restoreBookmark) restores Map16LowPtr (screen pointer) but does
 * NOT touch LevelLoadPos. The diagonal step `LDA LevelLoadPos; ADC #$0E; STY
 * LevelLoadPos` therefore accumulates from the PREVIOUS step's position, not from
 * the bookmark. In the flat cursor model, we track `diagCol`/`diagRow` separately.
 */
function _0DDB06(cur: Cursor): void {
  let _2 = 1
  let _0 = ((cur.size >> 4) & 0x0f) + 1
  // diagCol/diagRow mirror LevelLoadPos RAM: starts at origin, accumulates +0x0E steps.
  let diagCol = cur.col
  let diagRow = cur.row

  // Main loop (CODE_0DDB1B).
  while (true) {
    cur.col = diagCol
    cur.row = diagRow
    const X0 = _2 // LDX _2 at top of CODE_0DDB1B

    // Write D2/D3 header (always 2 tiles).
    setPage1(cur)
    writeTileAdvance(cur, 0xd2)
    setPage1(cur)
    writeTileAdvance(cur, 0xd3)

    let x = X0 - 2 // DEX; DEX

    if (x >= 0) {
      // CODE_0DDB31: FB/FF pair + inner FF fills.
      setPage1(cur)
      writeTileAdvance(cur, 0xfb)
      setPage1(cur)
      writeTileAdvance(cur, 0xff)
      x-- // DEX before JMP CODE_0DDB4D
      // CODE_0DDB4D: DEX; BPL -
      x--
      while (x >= 0) {
        setPage1(cur)
        writeTileAdvance(cur, 0xff)
        x--
      }
    }

    // CODE_0DDB50: (restoreBookmark = no-op in flat model), update counters.
    _2 += 2
    _0--

    if (_0 === 0) {
      // CODE_0DDB84: one final row at (diagCol, diagRow+1), no diagonal step.
      // advanceRowRaw = LevelLoadPos += $10 (row++ keeping same col).
      let xFinal = _2 - 2 // X = _2; DEX; DEX
      cur.col = diagCol
      cur.row = diagRow + 1
      // JMP CODE_0DDB31
      setPage1(cur)
      writeTileAdvance(cur, 0xfb)
      setPage1(cur)
      writeTileAdvance(cur, 0xff)
      xFinal-- // DEX before JMP CODE_0DDB4D
      xFinal--
      while (xFinal >= 0) {
        setPage1(cur)
        writeTileAdvance(cur, 0xff)
        xFinal--
      }
      return
    }

    if (_0 < 0) return

    // Diagonal step: LevelLoadPos += 0x0E → diagCol -= 2, diagRow += 1.
    // (screen-boundary wrap omitted for flat-grid model)
    diagCol -= 2
    diagRow += 1
    // loop back to CODE_0DDB1B
  }
}

/**
 * CODE_0DDB8F (bank_0D.asm line 6564) -- 1-wide left-descending cliff staircase.
 *
 * Similar to _0DDB06 but steps 1 column left per row (LevelLoadPos += 0x0F).
 * Row 0 writes $D6 header. Fill tiles: $FD (right edge) + $FF (inner).
 * Width grows by 1 per row. Initial _2=0; _2 increments by 1 each iteration.
 *
 * Final-row path (CODE_0DDBF9, BEQ): advanceRowRaw from diagPos, then write
 * the $FD/$FF fill with X = _2 (entering CODE_0DDBAE: DEX first → _2-1 tiles).
 *
 * Same LevelLoadPos-accumulator semantics as _0DDB06: restoreBookmark (CODE_0DA6BA)
 * does not touch LevelLoadPos, so the diagonal step always accumulates.
 */
function _0DDB8F(cur: Cursor): void {
  let _2 = 0
  let _0 = ((cur.size >> 4) & 0x0f) + 1
  // diagCol/diagRow mirror LevelLoadPos RAM.
  let diagCol = cur.col
  let diagRow = cur.row

  // Main loop (CODE_0DDBA4).
  while (true) {
    cur.col = diagCol
    cur.row = diagRow
    const X0 = _2 // LDX _2

    // Write D6 header.
    setPage1(cur)
    writeTileAdvance(cur, 0xd6)

    // CODE_0DDBAE: DEX; BMI cleanup if X < 0.
    let x = X0 - 1
    if (x >= 0) {
      // Write FD right-edge + FF inner fills.
      setPage1(cur)
      writeTileAdvance(cur, 0xfd)
      // JMP CODE_0DDBC4: DEX; BPL -
      x--
      while (x >= 0) {
        setPage1(cur)
        writeTileAdvance(cur, 0xff)
        x--
      }
    }

    // CODE_0DDBC7: (restoreBookmark = no-op in flat model), update counters.
    _2++
    _0--

    if (_0 === 0) {
      // CODE_0DDBF9: final row at (diagCol, diagRow+1).
      // LDX _2; advanceRowRaw; JMP CODE_0DDBAE
      let xFinal = _2 - 1 // LDX _2; CODE_0DDBAE starts with DEX
      cur.col = diagCol
      cur.row = diagRow + 1
      if (xFinal >= 0) {
        setPage1(cur)
        writeTileAdvance(cur, 0xfd)
        xFinal--
        while (xFinal >= 0) {
          setPage1(cur)
          writeTileAdvance(cur, 0xff)
          xFinal--
        }
      }
      return
    }

    if (_0 < 0) return

    // Diagonal step: LevelLoadPos += 0x0F → diagCol -= 1, diagRow += 1.
    diagCol -= 1
    diagRow += 1
    // loop back to CODE_0DDBA4
  }
}

/**
 * ADDR_0DDC02 (bank_0D.asm line 6633) -- 2-wide right-growing cliff staircase.
 *
 * Draws a staircase where each row extends 2 tiles to the right. The structure
 * alternates between a "step cap" phase ($D4/$D5 written at the current cursor)
 * and a "fill" phase ($FF...$FF/$FC written from the bookmark column).
 *
 * Phase sequence each outer step:
 *   ADDR_0DDC3D: write $D4 + $D5 at current col (expanding rightward each row),
 *                then restoreBookmark + advanceRowRaw + _2 += 2 + DEC _0.
 *   ADDR_0DDC23: write ($FF × (X-3)) + $FF + $FC starting at bookmarkCol,
 *                then check _0 and fall through to ADDR_0DDC3D for next cap pair.
 *
 * Initial _2=1. _0=(size>>4)+1. First action is JMP ADDR_0DDC3D.
 */
function _0DDC02(cur: Cursor): void {
  let _2 = 1
  saveBookmark(cur)
  let _0 = ((cur.size >> 4) & 0x0f) + 1

  // JMP ADDR_0DDC3D on entry.
  // Interleaved loop: each outer cycle = cap (D4/D5) then fill (FF.../FC).

  while (true) {
    // ADDR_0DDC3D: write D4/D5 cap at current position.
    setPage1(cur)
    writeTileAdvance(cur, 0xd4)
    setPage1(cur)
    writeTileAdvance(cur, 0xd5)
    restoreBookmark(cur)
    advanceRowRaw(cur)
    _2 += 2
    let x = _2
    _0--
    if (_0 < 0) return // BPL failed

    // ADDR_0DDC23: fill from bookmark col. Write (x-3) loop $FF + terminal $FF + $FC.
    // minus label: write $FF, DEX; ADDR_0DDC23: CPX #3; BNE -
    // i.e., loop while x != 3.
    while (x !== 3) {
      setPage1(cur)
      writeTileAdvance(cur, 0xff)
      x--
    }
    // x == 3: write terminal $FF + $FC.
    setPage1(cur)
    writeTileAdvance(cur, 0xff)
    setPage1(cur)
    writeTileAdvance(cur, 0xfc)
    // DEX; DEX → x = 1 (not used further in this path)

    // LDA _0; BEQ return
    if (_0 === 0) return

    // Fall through to ADDR_0DDC3D: loop back.
  }
}

/**
 * CODE_0DDC61 (bank_0D.asm line 6684) -- 1-wide right-growing cliff staircase.
 *
 * Each row: (n-1) $FF fill tiles + $FE right-edge tile + $D7 corner tile,
 * where n grows by 1 per row. The cursor always resets to bookmarkCol after
 * the $D7 write via restoreBookmark.
 *
 * Initial _2=0. _0=(size>>4)+1. First action is JMP CODE_0DDC8E.
 *
 * CODE_0DDC8E: if _0==0 return; write $D7, restoreBookmark, advanceRowRaw, _2++, DEC _0; BPL CODE_0DDC82.
 * CODE_0DDC82: write ($FF × (X-1)) + $FE, fall through to CODE_0DDC8E.
 */
function _0DDC61(cur: Cursor): void {
  let _2 = 0
  saveBookmark(cur)
  let _0 = ((cur.size >> 4) & 0x0f) + 1

  // JMP CODE_0DDC8E on entry.
  while (true) {
    // CODE_0DDC8E.
    if (_0 === 0) return
    setPage1(cur)
    writeTileAdvance(cur, 0xd7)
    restoreBookmark(cur)
    advanceRowRaw(cur)
    _2++
    let x = _2
    _0--
    if (_0 < 0) return // BPL failed

    // CODE_0DDC82: write $FF while x != 1, then write $FE.
    // minus label: write $FF, DEX; CODE_0DDC82: CPX #1; BNE -
    while (x !== 1) {
      setPage1(cur)
      writeTileAdvance(cur, 0xff)
      x--
    }
    // x == 1: write $FE.
    setPage1(cur)
    writeTileAdvance(cur, 0xfe)

    // Fall through to CODE_0DDC8E (loop back).
  }
}

/**
 * CODE_0DF02B (bank_0D.asm line 8441) -- staircase floor cap + body fill
 * (object $30 in tileset-4/5/13 dispatcher $0DE890).
 *
 * Writes a multi-row rectangle: one cap row of page-1 $0F tiles, then _1 rows
 * of page-0 $EA tiles, all (_0+1) wide.
 *
 * Size byte: HHHHWWWW
 *   W = low nibble  → width: writes W+1 tiles per row
 *   H = high nibble → body row count: writes H rows of $EA after the cap row
 *
 * ASM flow:
 *   saveBookmark
 *   LDX _0; loop: Sta1To6ePointer; LDA #$0F; writeTileAdvance; DEX; BPL
 *   JMP CODE_0DF05B:
 *     restoreBookmark; row++; DEC _1; BPL CODE_0DF04E; RTS
 *   CODE_0DF04E:
 *     LDX _0; loop: StzTo6ePointer; LDA #$EA; writeTileAdvance; DEX; BPL
 *     (fall through to CODE_0DF05B)
 */
export function handle_0DF02B(cur: Cursor): void {
  const _0 = cur.size & 0x0f
  let _1 = (cur.size >> 4) & 0x0f

  saveBookmark(cur)
  for (let x = _0; x >= 0; x--) {
    setPage1(cur)
    writeTileAdvance(cur, 0x0f)
  }
  nextRow(cur)
  _1--
  while (_1 >= 0) {
    for (let x = _0; x >= 0; x--) {
      setPage0(cur)
      writeTileAdvance(cur, 0xea)
    }
    nextRow(cur)
    _1--
  }
}

/**
 * CODE_0DB6C3 (bank_0D.asm line 3889) -- horizontal tile strip, page 0.
 *
 * Size byte XXXXXWWWW: high nibble selects tile from DATA_0DB6C1 = {$93,$9C};
 * low nibble + 1 = count.  Writes count writeTileAdvance calls.
 *
 * DATA_0DB6C1 operand at handler+19.
 */
export function handle_0DB6C3(cur: Cursor): void {
  const X = cur.size >> 4
  const count = (cur.size & 0x0f) + 1
  const addr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(addr + X) ?? 0
  setPage0(cur)
  for (let i = 0; i < count; i++) {
    writeTileAdvance(cur, tile)
  }
}

/**
 * ADDR_0DB705 (bank_0D.asm line 3928) -- vertical tile strip, page 0.
 *
 * Size byte HHHHTTTT: high nibble + 1 = height; low nibble selects tile type.
 * Top tile from DATA_0DB6F5[low]; subsequent tiles from DATA_0DB6FD[low].
 *
 * DATA_0DB6F5 operand at handler+19; DATA_0DB6FD operand at handler+29.
 */
export function handle_0DB705(cur: Cursor): void {
  const X = cur.size & 0x0f
  const height = (cur.size >> 4) + 1
  const addrTop = readLongOperand(cur, cur.handlerAddr + 19)
  const addrMid = readLongOperand(cur, cur.handlerAddr + 29)
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const midTile = cur.rom.readByte(addrMid + X) ?? 0
  setPage0(cur)
  writeTile(cur, topTile)
  for (let r = 1; r < height; r++) {
    advanceRowRaw(cur)
    setPage0(cur)
    writeTile(cur, midTile)
  }
}

/**
 * CODE_0DEF45 (bank_0D.asm line 8314) -- horizontal rope/chain strip, page 0.
 *
 * Size low nibble = X (DEX-BNE loop count).  Pattern: $A0 + ($A1 × X−1) + $A2.
 * Total tiles = X + 1.
 */
export function handle_0DEF45(cur: Cursor): void {
  const count = cur.size & 0x0f
  setPage0(cur)
  writeTileAdvance(cur, 0xa0)
  for (let i = 1; i < count; i++) {
    setPage0(cur)
    writeTileAdvance(cur, 0xa1)
  }
  setPage0(cur)
  writeTile(cur, 0xa2)
}

/**
 * CODE_0DEFA8 (bank_0D.asm line 8378) -- bordered rectangular box, page 1.
 *
 * Size: HHHHWWWW. width = low nibble; height = high nibble.
 * Total rows = height + 1 (top + (height−1) middle + bottom).
 * Top row:    page-1 tiles $61 + ($0D × width−1) + $62.
 * Middle rows: page-1 left (DATA_0DEFA2[X]) + page-0 middle (DATA_0DEFA4[X])
 *              × width−1 + page-1 right (DATA_0DEFA6[X]); X alternates 0/1.
 * Bottom row: page-1 tiles $6B + ($6C × width−1) + $6D.
 *
 * DATA_0DEFA2 operand at handler+58; DATA_0DEFA4 at +67; DATA_0DEFA6 at +81.
 */
export function handle_0DEFA8(cur: Cursor): void {
  const width = cur.size & 0x0f
  const height = (cur.size >> 4) & 0x0f
  const addrSide = readLongOperand(cur, cur.handlerAddr + 58)
  const addrMid = readLongOperand(cur, cur.handlerAddr + 67)
  const addrRight = readLongOperand(cur, cur.handlerAddr + 81)
  saveBookmark(cur)
  // Top row (page 1)
  setPage1(cur)
  writeTileAdvance(cur, 0x61)
  for (let c = 1; c < width; c++) {
    setPage1(cur)
    writeTileAdvance(cur, 0x0d)
  }
  setPage1(cur)
  writeTile(cur, 0x62)
  // Middle rows: height−1 rows (none for height≤1)
  let X = 0
  for (let r = 0; r < height - 1; r++) {
    restoreBookmark(cur)
    advanceRowRaw(cur)
    const left = cur.rom.readByte(addrSide + X) ?? 0
    const mid = cur.rom.readByte(addrMid + X) ?? 0
    const right = cur.rom.readByte(addrRight + X) ?? 0
    setPage1(cur)
    writeTileAdvance(cur, left)
    setPage0(cur)
    for (let c = 1; c < width; c++) {
      writeTileAdvance(cur, mid)
    }
    setPage1(cur)
    writeTile(cur, right)
    X ^= 1
  }
  // Bottom row (page 1)
  restoreBookmark(cur)
  advanceRowRaw(cur)
  setPage1(cur)
  writeTileAdvance(cur, 0x6b)
  for (let c = 1; c < width; c++) {
    setPage1(cur)
    writeTileAdvance(cur, 0x6c)
  }
  setPage1(cur)
  writeTile(cur, 0x6d)
}

/**
 * ADDR_0DF066 (bank_0D.asm line 8475) -- rectangular fill via CODE_0DECCE.
 *
 * LDX #imm; JMP CODE_0DECCE - enters the core of handle_0DECC9 with X set
 * from bytecode rather than from the dispatched object number. Tile and page
 * are determined by DATA_0DECC6[X]; rectangle size from cur.size.
 *
 * X immediate at handler+1; JMP lo/hi at handler+2/3; DATA_0DECC6 operand at
 * CODE_0DECCE+32 (= JMP target + 32).
 */
export function handle_0DF066(cur: Cursor): void {
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const jmpLo = cur.rom.readByte(cur.handlerAddr + 2) ?? 0
  const jmpHi = cur.rom.readByte(cur.handlerAddr + 3) ?? 0
  const target = 0x0d0000 | (jmpHi << 8) | jmpLo // CODE_0DECCE
  const tableAddr = readLongOperand(cur, target + 32) // DATA_0DECC6
  const tile = cur.rom.readByte(tableAddr + X) ?? 0
  if (X === 1) setPage1(cur)
  else setPage0(cur)
  const widthM1 = cur.size & 0x0f
  const heightM1 = (cur.size >> 4) & 0x0f
  saveBookmark(cur)
  for (let r = 0; r <= heightM1; r++) {
    for (let c = 0; c <= widthM1; c++) {
      writeTileAdvance(cur, tile)
    }
    restoreBookmark(cur)
    nextRow(cur)
  }
}

/**
 * CODE_0DF06C (bank_0D.asm line 8483) -- horizontal page-1 tile strip.
 *
 * Size byte TTTTCCCC: high nibble = type index into DATA_0DF06B = {$59};
 * low nibble + 1 = count.  Writes count writeTileAdvance calls, page 1.
 *
 * DATA_0DF06B operand at handler+19.
 */
export function handle_0DF06C(cur: Cursor): void {
  const X = cur.size >> 4
  const count = (cur.size & 0x0f) + 1
  const addr = readLongOperand(cur, cur.handlerAddr + 19)
  const tile = cur.rom.readByte(addr + X) ?? 0
  setPage1(cur)
  for (let i = 0; i < count; i++) {
    writeTileAdvance(cur, tile)
  }
}

// ── CODE_0DDF3A: castle wall stamped on screen 0, then block-copied ──────────

/** Map16TilesLow / Map16TilesHigh sit at $7EC800 / $7FC800 (rammap.asm). */
const MAP16_BASE = 0xc800
/** LDA #imm for the cap width; the INX run before it must end here. */
const CAP_W_AT = 159

type WallSite = readonly [name: string, off: number, opcode: number, width: number, expect?: number]

/**
 * Every operand CODE_0DDF3A reads, by offset from the handler start. The
 * opcode is checked before reading; `expect` pins operands the port cannot
 * follow elsewhere (another bank would be RAM this grid does not model).
 */
const WALL_SITES = [
  ['mask', 2, 0x29, 1], // AND #$0F on LvlLoadObjSize
  ['rowStart', 9, 0xa0, 1], // LDY #$50
  ['cols', 13, 0xa9, 1],
  ['rows', 17, 0xa9, 1],
  ['fill', 26, 0xa9, 1],
  ['stride', 40, 0x69, 1], // ADC #$40
  ['ptrLow', 54, 0xa9, 1], // LDA #$00 -> Map16LowPtr, _4
  ['stampStart', 62, 0xa9, 1], // LDA #$00 -> _0
  ['stamps', 66, 0xa9, 1],
  ['midRows', 70, 0xa9, 1],
  ['posTbl', 76, 0xbf, 3], // DATA_0DDEEA
  ['posHi', 83, 0xbf, 3], // DATA_0DDEF2
  ['topW', 93, 0xa9, 1],
  ['xStart', 97, 0xa2, 1], // LDX #$00
  ['top', 102, 0xbf, 3], // DATA_0DDEDC
  ['midA', 123, 0xbf, 3], // DATA_0DDEDC
  ['midB', 133, 0xbf, 3], // DATA_0DDEDD
  ['midC', 143, 0xbf, 3], // DATA_0DDEDE
  ['capW', CAP_W_AT, 0xa9, 1],
  ['cap', 166, 0xbf, 3],
  ['baseW', 181, 0xa9, 1],
  ['base', 191, 0xbf, 3],
  ['copyStart', 212, 0xa9, 1], // LDA #$01 -> _8
  ['copyStartHi', 216, 0xa9, 1], // LDA #$00 -> _9
  ['dstLo', 226, 0xbf, 3], // DATA_0DDEFA
  ['dstHi', 232, 0xbf, 3], // DATA_0DDF1A
  ['lenLo', 238, 0xa9, 2], // LDA.W #$01B0
  ['srcLo', 243, 0xa9, 2], // LDA.W #$C800
  ['banksLo', 255, 0x54, 2, 0x7e7e], // MVN $7E,$7E
  ['lenHi', 259, 0xa9, 2],
  ['srcHi', 264, 0xa9, 2],
  ['banksHi', 276, 0x54, 2, 0x7f7f], // MVN $7F,$7F
] as const satisfies readonly WallSite[]

/**
 * Every JSR, with the stock subroutine it must reach. Their semantics are
 * ported in cursor.ts rather than read, so a hijacked call must refuse.
 */
const WALL_CALLS = [
  [6, 0xa6b1], [23, 0xaa08], [28, 0xa95b], [34, 0xa6ba], [47, 0xa987], [99, 0xaa08],
  [106, 0xa95b], [114, 0xa6ba], [117, 0xa97d], [120, 0xaa0d], [127, 0xa95b], [130, 0xaa0d],
  [137, 0xa95b], [140, 0xaa0d], [149, 0xa97d], [163, 0xaa08], [170, 0xa95b], [178, 0xa6ba],
  [185, 0xa97d], [188, 0xaa0d], [195, 0xa95b],
] as const // prettier-ignore
/** STA [Map16LowPtr],Y: the mid rows' third write, with no INY after it. */
const WALL_RAW_STA_AT = 147
/** The INX run that skips X past the mid-row index. */
const WALL_INX_AT = 156

type WallKey = (typeof WALL_SITES)[number][0] | 'skip'

function readWallSites(cur: Cursor): Record<WallKey, number> | null {
  /** The `width`-byte operand after `opcode` at `off`, or null if the opcode differs. */
  const operand = (off: number, opcode: number, width: number): number | null => {
    const addr = cur.handlerAddr + off
    if (cur.rom.readByte(addr) !== opcode) return null
    let v = 0
    for (let i = width; i >= 1; i--) v = (v << 8) | readImmByte(cur, addr + i)
    return v
  }
  for (const [off, target] of WALL_CALLS) if (operand(off, 0x20, 2) !== target) return null
  if (operand(WALL_RAW_STA_AT, 0x97, 0) === null) return null
  let skip = 0
  // Capped one past the expected end, so a gate fault refuses rather than hangs.
  while (skip <= CAP_W_AT - WALL_INX_AT && operand(WALL_INX_AT + skip, 0xe8, 0) !== null) skip++
  if (WALL_INX_AT + skip !== CAP_W_AT) return null
  const out = { skip } as Record<WallKey, number>
  for (const [name, off, opcode, width, expect] of WALL_SITES as readonly WallSite[]) {
    const v = operand(off, opcode, width)
    if (v === null || (expect !== undefined && v !== expect)) return null
    out[name as WallKey] = v
  }
  return out
}

/** Body runs of a `DEC; BPL` loop entered with `n` (8-bit). */
function bplCount(n: number): number {
  let count = 1
  for (let v = (n - 1) & 0xff; !(v & 0x80); v = (v - 1) & 0xff) count++
  return count
}

/** Point the cursor at the cell holding a Map16 RAM address; false below the buffer. */
function seekMap16(cur: Cursor, addr: number): boolean {
  const o = addr - MAP16_BASE
  if (o < 0) return false
  const rem = o % MAP16_BYTES_PER_SCREEN_H
  cur.row = rem >> 4
  cur.col = Math.floor(o / MAP16_BYTES_PER_SCREEN_H) * 16 + (rem & 0x0f)
  return true
}

function peekMap16(cur: Cursor, addr: number): number {
  return seekMap16(cur, addr) ? (cur.grid[cur.row][cur.col] ?? 0x25) : 0x25
}

function pokeMap16(cur: Cursor, addr: number, page: number, low: number): void {
  if (!seekMap16(cur, addr)) return
  cur.page = page
  writeTile(cur, low)
}

/**
 * CODE_0DDF3A (bank_0D.asm:7107-7242; lower half per bank_05.asm:778-782) --
 * castle wall, standard object $37 in tilesets 3/9/10/11/14. What each phase
 * draws: SMWDisX/bank_0D/MEMO.md, "Castle wall object".
 *
 * Tracks the game's own registers (Map16LowPtr, its _4/_5 bookmark,
 * LevelLoadPos, Y) as 16-bit RAM addresses, because two of its three phases
 * ignore the object's position.
 *
 * Declines (draws nothing) on a vertical level, whose Map16 layout this does
 * not model, when any opcode it reads through is not the expected one, or
 * when a JSR does not reach the stock subroutine the port models.
 */
export function handle_0DDF3A(cur: Cursor): void {
  if (cur.grid.length !== 27) return
  const k = readWallSites(cur)
  if (!k) return
  const word = (addr: number): number => (readImmByte(cur, addr + 1) << 8) | readImmByte(cur, addr)
  const screenPtr =
    MAP16_BASE + Math.floor(cur.col / 16) * MAP16_BYTES_PER_SCREEN_H + (cur.row >= 16 ? 0x100 : 0)
  let ptr = screenPtr
  let mark = screenPtr // CODE_0DA6B1
  let pos = k.rowStart
  let y = pos

  const sta = (page: number, low: number): void => pokeMap16(cur, ptr + y, page, low)
  // CODE_0DA95D
  const iny = (): void => {
    y = (y + 1) & 0xff
    if (y & 0x0f) return
    ptr += MAP16_BYTES_PER_SCREEN_H
    y = pos & 0xf0
  }
  const restore = (): void => void (ptr = mark) // CODE_0DA6BA
  // CODE_0DA97D / CODE_0DA987: carry bumps the pointer's high byte into _5.
  const down = (step: number): void => {
    const sum = pos + step
    pos = y = sum & 0xff
    if (sum < 0x100) return
    ptr += 0x100
    mark = (mark & 0x00ff) | (ptr & 0xff00)
  }

  for (let r = bplCount(k.rows); r > 0; r--) {
    for (let c = bplCount(k.cols); c > 0; c--) {
      sta(1, k.fill)
      iny()
    }
    restore()
    down(k.stride)
  }

  ptr = (ptr & 0xff00) | k.ptrLow
  mark = (mark & 0xff00) | k.ptrLow
  for (let n = bplCount(k.stamps), i = k.stampStart; n > 0; n--, i = (i + 1) & 0xff) {
    pos = y = readImmByte(cur, k.posTbl + i)
    const hi = readImmByte(cur, k.posHi + i) << 8
    ptr = hi | (ptr & 0xff)
    mark = hi | (mark & 0xff)
    let x = k.xStart
    for (let c = bplCount(k.topW); c > 0; c--, x++) {
      sta(1, readImmByte(cur, k.top + x))
      iny()
    }
    restore()
    down(0x10)
    for (let r = bplCount(k.midRows); r > 0; r--) {
      sta(0, readImmByte(cur, k.midA + x))
      iny()
      sta(0, readImmByte(cur, k.midB + x))
      iny()
      sta(0, readImmByte(cur, k.midC + x))
      down(0x10)
    }
    x += k.skip
    for (let c = bplCount(k.capW); c > 0; c--, x++) {
      sta(1, readImmByte(cur, k.cap + x))
      iny()
    }
    restore()
    down(0x10)
    for (let c = bplCount(k.baseW); c > 0; c--, x++) {
      sta(0, readImmByte(cur, k.base + x))
      iny()
    }
  }

  let left = cur.size & k.mask
  for (let s = k.copyStart; ; s = (s + 1) & 0xff) {
    const xi = (((k.copyStartHi << 8) | s) * 2) & 0xffff // REP #$30; LDA _8; ASL
    const dLo = word(k.dstLo + xi)
    const dHi = word(k.dstHi + xi)
    for (let i = 0; i <= k.lenLo; i++) {
      const d = peekMap16(cur, dLo + i)
      pokeMap16(cur, dLo + i, d >> 8, peekMap16(cur, k.srcLo + i))
    }
    for (let i = 0; i <= k.lenHi; i++) {
      pokeMap16(cur, dHi + i, peekMap16(cur, k.srcHi + i) >> 8, peekMap16(cur, dHi + i))
    }
    left = (left - 1) & 0xff
    if (left === 0) break
  }
}
