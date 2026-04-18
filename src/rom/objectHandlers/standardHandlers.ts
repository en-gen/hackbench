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
  setPage0, setPage1, peekExistingLow,
  diagonalDownLeft, diagonalDownRight, stepDiag,
  writeTileSlopeMerge, writeTilePipeMerge, writeTilePipeMergeNoAdvance,
  writeTileMergeCODE_0DB114, writeTileMergeCODE_0DB198,
  readLongOperand, readImmByte,
} from './cursor'
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
  const widthM1  = cur.size & 0x0F
  const heightM1 = (cur.size >> 4) & 0x0F
  const x = cur.objNo - 1
  if (x < 0 || x >= 14) return  // 14 tiles in the table (objects 1-14)

  // LDA.L DATA_0DA8B4,X at handler offset +107 (operand at +108). ASM: line 1974.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 108)
  const tileId = cur.rom.readByte(tableAddr + x) ?? 0

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
  const H = (cur.size >> 4) & 0x0F
  const X = cur.size & 0x0F

  // LDA.L operands inside the handler body (opcodes $BF at -1):
  //   +26  DATA_0DAA12 (left-cap top)     +36  DATA_0DAA17 (left-cap bottom)
  //   +110 DATA_0DAA1C (right-cap top)    +120 DATA_0DAA21 (right-cap bottom)
  const addrLeftTop     = readLongOperand(cur, cur.handlerAddr + 26)
  const addrLeftBottom  = readLongOperand(cur, cur.handlerAddr + 36)
  const addrRightTop    = readLongOperand(cur, cur.handlerAddr + 110)
  const addrRightBottom = readLongOperand(cur, cur.handlerAddr + 120)
  const leftTop     = (i: number) => cur.rom.readByte(addrLeftTop + i) ?? 0
  const leftBottom  = (i: number) => cur.rom.readByte(addrLeftBottom + i) ?? 0
  const rightTop    = (i: number) => cur.rom.readByte(addrRightTop + i) ?? 0
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
    setPage1(cur); writeTile(cur, top)
    cur.col = col0 + 1
    setPage1(cur); writeTile(cur, bot)
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
 *                           (STA without advance — row ends here anyway).
 *
 * Between rows: CODE_0DA6BA + CODE_0DA97D (restore bookmark, row += 1); INX; loop
 * while (X & 1) != 0.
 *
 * Used by the horizontal goal-area pipe at the end of level $002 (objNum $10,
 * size $15 → H=1 W=5 → rows $13B $13D×5 / $13F $13E×5).
 */
export function handle_0DAAB4(cur: Cursor): void {
  const width = cur.size & 0x0F                      // _0 = _1 = W
  const heightNibble = (cur.size >> 4) & 0x0F        // H
  let X = (heightNibble << 1) & 0xFF                 // ASM: AND #$F0; LSR x3 → H * 2

  // LDA.L DATA_0DAAA4,X operand at handler offset +29 (the $BF opcode at +28).
  // LDA.L DATA_0DAAAC,X operand at handler offset +42 (the $BF opcode at +41).
  const addrA = readLongOperand(cur, cur.handlerAddr + 29)
  const addrB = readLongOperand(cur, cur.handlerAddr + 42)
  const tableA = [0, 1, 2, 3, 4, 5, 6, 7].map(i => cur.rom.readByte(addrA + i) ?? 0)
  const tableB = [0, 1, 2, 3, 4, 5, 6, 7].map(i => cur.rom.readByte(addrB + i) ?? 0)

  saveBookmark(cur)    // CODE_0DA6B1

  // Outer loop runs while X (post-increment) is still odd. With X_start always
  // even, this yields exactly 2 iterations — one for the top row, one for the
  // bottom.
  let iter = 0
  while (iter++ < 4) {   // bounded for safety; expected 2
    const idx = X & 7
    const capTile = tableA[idx] ?? 0
    const midTile = tableB[idx] ?? 0

    if (X < 4) {
      // Left-cap row: cap at col 0, then W middles.
      setPage1(cur); writeTileAdvance(cur, capTile)
      for (let w = 0; w < width; w++) {
        setPage1(cur); writeTileAdvance(cur, midTile)
      }
    } else {
      // Right-cap row: W middles, then cap at col W (STA-only in ASM, no advance).
      for (let w = 0; w < width; w++) {
        setPage1(cur); writeTileAdvance(cur, midTile)
      }
      setPage1(cur); writeTile(cur, capTile)
    }

    restoreBookmark(cur)   // CODE_0DA6BA
    nextRow(cur)           // CODE_0DA97D (row += 1, col = bookmark)
    X = (X + 1) & 0xFF
    if ((X & 0x01) === 0) break   // AND #$01; BNE — stop when X becomes even
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
 * Yoshi's Island 1 — a single object with size $BF produces a 192-tile run.
 */
export function handle_0DB1C8(cur: Cursor): void {
  const widthM1 = cur.size & 0xFF   // full byte as width-1
  // LDA #$02 at handler +5, STA _2 then JMP CODE_0DB1E3. Height-1 immediate at +6.
  const heightM1 = readImmByte(cur, cur.handlerAddr + 6)
  // JMP CODE_0DB1E3 operand at handler +10 (2-byte same-bank target).
  const sharedBodyAddr =
    (cur.handlerAddr & 0xFF0000)
    | ((cur.rom.readByte(cur.handlerAddr + 11) ?? 0) << 8)
    | (cur.rom.readByte(cur.handlerAddr + 10) ?? 0)
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
  const dirtTile  = readImmByte(cur, bodyAddr + 25)

  saveBookmark(cur)
  setPage1(cur)               // Sta1To6ePointer
  for (let c = 0; c <= widthM1; c++) {
    writeTileAdvance(cur, grassTile)
  }
  restoreBookmark(cur)
  setPage0(cur)               // StzTo6ePointer
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
 * Size byte: HHHHWWWW — H selects tile via DATA_0DB3BB[H], W = width-1.
 * A single-row run of (width+1) tiles of DATA_0DB3BB[H].
 */
export function handle_0DB3BD(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F

  // LDA.L DATA_0DB3BB,X at handler offset +18 (operand at +19).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 19)
  const tileId = cur.rom.readByte(tableAddr + H) ?? 0

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

  // LDA.L DATA_0DB3DB,X at handler offset +29 (operand at +30)
  // LDA.L DATA_0DB3DF,X at handler offset +46 (operand at +47)
  const addrTop = readLongOperand(cur, cur.handlerAddr + 30)
  const addrBot = readLongOperand(cur, cur.handlerAddr + 47)
  const topTile = cur.rom.readByte(addrTop + X) ?? 0
  const botTile = cur.rom.readByte(addrBot + X) ?? 0

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
  const widthM1 = cur.size & 0x0F
  const height = (cur.size >> 4) & 0x0F

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
 * port writes the raw table values — adequate for rendering without stitching.
 */
export function handle_0DB075(cur: Cursor): void {
  const base = cur.handlerAddr
  const X = cur.size & 0x0F
  let count = (cur.size >> 4) & 0x0F

  // LDA.L operands within CODE_0DB075:
  //   +26  DATA_0DB039 (top)   +60  DATA_0DB048 (row 1)
  //   +94  DATA_0DB057 (mid)   +117 DATA_0DB066 (footer)
  const addrTop = readLongOperand(cur, base + 26)
  const addrRow1 = readLongOperand(cur, base + 60)
  const addrMid = readLongOperand(cur, base + 94)
  const addrFooter = readLongOperand(cur, base + 117)
  const topTile    = cur.rom.readByte(addrTop + X) ?? 0
  const row1Tile   = cur.rom.readByte(addrRow1 + X) ?? 0
  const middleTile = cur.rom.readByte(addrMid + X) ?? 0
  const footerTile = cur.rom.readByte(addrFooter + X) ?? 0

  // JSR CODE_0DB114 operand at +30; JSR CODE_0DB198 operand at +64.
  // Bank is same as CODE_0DB075.
  const bank = base & 0xFF0000
  const merge114Addr = bank
    | ((cur.rom.readByte(base + 31) ?? 0) << 8)
    | (cur.rom.readByte(base + 30) ?? 0)
  const merge198Addr = bank
    | ((cur.rom.readByte(base + 65) ?? 0) << 8)
    | (cur.rom.readByte(base + 64) ?? 0)

  // Row 0 page: page 0 if X < 3, else page 1.
  if (X < 3) setPage0(cur); else setPage1(cur)
  writeTileMergeCODE_0DB114(cur, merge114Addr, X, topTile)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0B) { setPage1(cur); writeTile(cur, footerTile) }
    return
  }

  const rowPage1 = (X >= 3 && X <= 6) || X >= 9

  if (rowPage1) setPage1(cur); else setPage0(cur)
  writeTileMergeCODE_0DB198(cur, merge198Addr, X, row1Tile)
  cur.row += 1
  count -= 1
  if (count < 0) {
    if (X >= 0x0B) { setPage1(cur); writeTile(cur, footerTile) }
    return
  }

  while (count >= 0) {
    if (rowPage1) setPage1(cur); else setPage0(cur)
    writeTileMergeCODE_0DB198(cur, merge198Addr, X, middleTile)
    cur.row += 1
    count -= 1
  }

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

  // LDA.L DATA_0DB569,X at handler offset +11 (operand at +12).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)   // StzTo6ePointer
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
 *   +34+18..20  JMP CODE_0DB4FE operand
 */
export function handle_0DB49E(cur: Cursor): void {
  const base = cur.handlerAddr
  const dataTableAddr  = readLongOperand(cur, base + 16)
  const topMergeAddr   = resolveJsrTarget(cur, base + 19)
  const bottomMergeAddr = resolveJmpTarget(cur, base + 34 + 19)

  const middleCount = (cur.size >> 4) & 0x0F
  const X = cur.size & 0x0F
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
    setPage0(cur); writeTile(cur, pipeTile)
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
  cur: Cursor, helperAddr: number, X: number, baseTile: number,
): void {
  const trigger1 = readImmByte(cur, helperAddr + 5)
  const table1   = readLongOperand(cur, helperAddr + 9)
  const trigger2 = readImmByte(cur, helperAddr + 16)
  const table2   = readLongOperand(cur, helperAddr + 20)

  const existing = readExistingLow(cur)
  let out = baseTile
  if (existing === trigger1) {
    out = cur.rom.readByte(table1 + X) ?? baseTile
  } else if (existing === trigger2) {
    out = cur.rom.readByte(table2 + X) ?? baseTile
  }
  setPage0(cur)   // ASM StzTo6ePointer before the write
  writeTile(cur, out)
}

function readExistingLow(cur: Cursor): number {
  const row = cur.grid[cur.row]
  if (!row) return 0x25
  const v = row[cur.col]
  if (v === undefined) return 0x25
  return v & 0xFF
}

/**
 * Resolve a JSR $XXXX (absolute, same-bank) target.
 * opcodeAddr points at the $20 opcode; the 2-byte operand follows at +1.
 * Bank comes from the calling handler (same bank for JSR).
 */
function resolveJsrTarget(cur: Cursor, opcodeAddr: number): number {
  const lo = cur.rom.readByte(opcodeAddr + 1) ?? 0
  const hi = cur.rom.readByte(opcodeAddr + 2) ?? 0
  const bank = opcodeAddr & 0xFF0000
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
 * Unlike CODE_0DB49E this has no bottom cap — the body just extends and the
 * pipe meets whatever terrain follows below (ground, etc.).
 */
export function handle_0DBA0A(cur: Cursor): void {
  const widthM1 = cur.size & 0x0F
  let heightM1 = (cur.size >> 4) & 0x0F

  // LDA #$0E (top-row tile, page 1) immediate at handler +24 (opcode at +23)
  // LDA #$B8 (body-row tile, page 0) immediate at handler +38 (opcode at +37)
  const topTile  = readImmByte(cur, cur.handlerAddr + 24)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 38)

  saveBookmark(cur)

  for (let c = 0; c <= widthM1; c++) {
    setPage1(cur); writeTileAdvance(cur, topTile)
  }

  while (heightM1 >= 0) {
    restoreBookmark(cur)
    cur.row += 1
    for (let c = 0; c <= widthM1; c++) {
      setPage0(cur); writeTileAdvance(cur, bodyTile)
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
  const X = (cur.size >> 4) & 0x0F
  const topTile    = readImmByte(cur, cur.handlerAddr + 15)
  const midTile    = readImmByte(cur, cur.handlerAddr + 23)
  const bottomTile = readImmByte(cur, cur.handlerAddr + 36)
  setPage1(cur)
  writeTile(cur, topTile)
  // (X - 1) middle rows — X=2 writes 1 middle, X=1 writes 0 middles, etc.
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
  const X = cur.size & 0x0F
  // LDA #$56/$57/$58 immediates at handler +11/+19/+30 (opcodes at +10/+18/+29)
  const leftTile  = readImmByte(cur, cur.handlerAddr + 11)
  const midTile   = readImmByte(cur, cur.handlerAddr + 19)
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
  const W = cur.size & 0x0F
  const X = (cur.size >> 4) & 0x0F
  // LDA.L DATA_0DB5A8,X operand at handler offset +19 (opcode $BF at +18)
  // LDA.L DATA_0DB5AD,X operand at handler offset +29 (opcode at +28)
  // LDA.L DATA_0DB5B2,X operand at handler offset +43 (opcode at +42)
  const addrLeft   = readLongOperand(cur, cur.handlerAddr + 19)
  const addrMiddle = readLongOperand(cur, cur.handlerAddr + 29)
  const addrRight  = readLongOperand(cur, cur.handlerAddr + 43)
  const leftCap  = cur.rom.readByte(addrLeft + X) ?? 0
  const middle   = cur.rom.readByte(addrMiddle + X) ?? 0
  const rightCap = cur.rom.readByte(addrRight + X) ?? 0

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
 * Used for the midway-post base, donut-plateau columns, etc.
 *
 * Size byte: HHHHVVVV
 *   V (low nibble)  = variant flag. V=0 uses DATA_0DB212/15/18 (primary set);
 *                     V!=0 uses DATA_0DB21B/1E/21 (alternate set).
 *   H (high nibble) = body-height counter (_1 in ASM). Total rows = H + 1.
 *
 * Per column X in 0..2 the ASM runs:
 *   1. Write top[X]; advance row; DEC _1; BEQ to bot write (skips middle loop).
 *   2. If _1 didn't hit 0: middle loop — write mid[X]; advance row; DEC _1;
 *      BNE to loop head. Runs H-1 times for a total of H-1 middle writes.
 *   3. Write bot[X] at the final row.
 *
 * Net per column: 1 top + (H-1) middles + 1 bot = H+1 rows. For H=1 that is
 * just {top, bot}. An earlier version of this port wrote one extra middle row
 * (H middles instead of H-1), which shifted the midway pole's base tile down
 * by one row vs the real SMW output.
 */
export function handle_0DB224(cur: Cursor): void {
  const V = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F

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
  const variant = (cur.size & 0x0F) % 10
  const tableBase = cur.handlerAddr + 18
  const target = readLongOperand(cur, tableBase + variant * 3) & 0xFFFFFF

  // Run each variant handler with its own handlerAddr so that its LDA.L
  // and LDA # operands resolve correctly against its own bytecode.
  const prevHandler = cur.handlerAddr
  cur.handlerAddr = target
  try {
    PIPE_VARIANT_HANDLERS[target]?.(cur)
  } finally {
    cur.handlerAddr = prevHandler
  }
}

/** Registry mapping each pipe-variant's SNES start address to its TS port.
 *  handle_0DAB3E looks up the target from the ROM dispatch table and calls
 *  the function here. */
const PIPE_VARIANT_HANDLERS: Record<number, (cur: Cursor) => void> = {
  0x0DAB6E: pipeVariant0,
  0x0DAC21: pipeVariant1,
  0x0DAC92: pipeVariant2,
  0x0DAD44: pipeVariant3,
  0x0DADA3: pipeVariant4,
  0x0DADEB: pipeVariant5,
  0x0DAE6D: pipeVariant6,
  0x0DAEFC: pipeVariant7,
  0x0DAF61: pipeVariant8,
  0x0DAFEA: pipeVariant9,
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
  const heightCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  // CODE_0DAB6E inline immediates:
  //   +27 $96, +35 $9B (lip pair, pipe-merged via CODE_0DABFD)
  //   +47 $DE, +55 $E6 (body pair, page 1, plain write)
  //   hardcoded $3F (fill, page 0, plain write inside the `-` label)
  const lipL = readImmByte(cur, cur.handlerAddr + 27)
  const lipR = readImmByte(cur, cur.handlerAddr + 35)
  const bodL = readImmByte(cur, cur.handlerAddr + 47)
  const bodR = readImmByte(cur, cur.handlerAddr + 55)
  const fillTile = 0x3F  // inline LDA #$3F in the fill-writer branch

  // Lip phase. Iter i at (col0 - 2i, row0 + i). X at iter entry = _2 = 1 + 2i.
  //   i = 0: X = 1. Write lip pair. DEX DEX -> -1. BMI. No body.
  //   i = 1: X = 3. Lip. DEX DEX -> 1. Body pair. DEX -> 0. JMP body-exit. DEX -> -1. Exit.
  //   i = 2: X = 5. Lip. DEX DEX -> 3. Body. DEX -> 2. JMP body-exit. DEX -> 1. Fill. DEX -> 0. Fill. DEX -> -1.
  // Body+fill count: i=0 -> 0; i>=1 -> body (2 tiles) + 2*(i-1) fills.
  for (let i = 0; i < heightCount; i++) {
    cur.col = col0 - 2 * i
    cur.row = row0 + i
    setPage1(cur); writeTilePipeMerge(cur, lipL)
    setPage1(cur); writeTilePipeMerge(cur, lipR)
    if (i >= 1) {
      setPage1(cur); writeTileAdvance(cur, bodL)
      setPage1(cur); writeTileAdvance(cur, bodR)
      for (let k = 0; k < 2 * (i - 1); k++) {
        setPage0(cur); writeTileAdvance(cur, fillTile)
      }
    }
  }

  // Final body row (CODE_0DABEC -> CODE_0DA97D -> CODE_0DAB99).
  // X at CODE_0DABEC entry = _2 = 1 + 2*heightCount. DEX DEX -> 2*heightCount - 1.
  // Write body pair. DEX -> 2*heightCount - 2. JMP body-exit. DEX -> 2*heightCount - 3.
  // Loop fills until X = -1. Total fills = 2*(heightCount - 1).
  cur.col = col0 - 2 * (heightCount - 1)
  cur.row = row0 + heightCount
  setPage1(cur); writeTileAdvance(cur, bodL)
  setPage1(cur); writeTileAdvance(cur, bodR)
  for (let k = 0; k < 2 * (heightCount - 1); k++) {
    setPage0(cur); writeTileAdvance(cur, fillTile)
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
  const heightCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  // CODE_0DAC21 inline immediates:
  //   +25 $AA (lip, pipe-merged via CODE_0DABFD)
  //   +36 $E2 (body, page 1, plain write)
  //   +47 $3F (fill, page 0, plain write)
  const lipTile  = readImmByte(cur, cur.handlerAddr + 25)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 36)
  const fillTile = readImmByte(cur, cur.handlerAddr + 47)

  // Lip phase: iter i at (col0 - i, row0 + i). X = _2 = i at entry, so:
  //   i = 0: X = 0. DEX -> -1. BMI. No body/fills.
  //   i >= 1: 1 body + (i - 1) fills.
  for (let i = 0; i < heightCount; i++) {
    cur.col = col0 - i
    cur.row = row0 + i
    setPage1(cur); writeTilePipeMerge(cur, lipTile)
    if (i >= 1) {
      setPage1(cur); writeTileAdvance(cur, bodyTile)
      for (let k = 0; k < i - 1; k++) {
        setPage0(cur); writeTileAdvance(cur, fillTile)
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
  setPage1(cur); writeTileAdvance(cur, bodyTile)
  for (let k = 0; k < heightCount - 1; k++) {
    setPage0(cur); writeTileAdvance(cur, fillTile)
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

  // CODE_0DAC92 inline immediates: +27 $6E, +35 $73, +43 $78, +51 $7D (lips);
  // +65 $D8, +73 $DA, +81 $E6, +89 $E6 (bodies); +103 $3F (filler).
  const lip1 = readImmByte(cur, cur.handlerAddr + 27)
  const lip2 = readImmByte(cur, cur.handlerAddr + 35)
  const lip3 = readImmByte(cur, cur.handlerAddr + 43)
  const lip4 = readImmByte(cur, cur.handlerAddr + 51)
  const body1 = readImmByte(cur, cur.handlerAddr + 65)
  const body2 = readImmByte(cur, cur.handlerAddr + 73)
  const body3 = readImmByte(cur, cur.handlerAddr + 81)
  const body4 = readImmByte(cur, cur.handlerAddr + 89)
  const fillTile = readImmByte(cur, cur.handlerAddr + 103)

  for (let i = 0; i < heightCount; i++) {
    setPage1(cur); writeTilePipeMerge(cur, lip1)
    setPage1(cur); writeTilePipeMerge(cur, lip2)
    setPage1(cur); writeTilePipeMerge(cur, lip3)
    setPage1(cur); writeTilePipeMerge(cur, lip4)
    let x = widthCounter - 4
    if (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, body1)
      setPage1(cur); writeTileAdvance(cur, body2)
      setPage1(cur); writeTileAdvance(cur, body3)
      setPage1(cur); writeTileAdvance(cur, body4)
      x -= 3
    }
    while (x >= 0) {
      setPage0(cur); writeTileAdvance(cur, fillTile)
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
  const highNibble = (cur.size >> 4) & 0x0F
  const rowCount = highNibble + 2
  const col0 = cur.col, row0 = cur.row

  // CODE_0DAD44 inline immediates:
  //   +28 $3F (fill, page 0, plain write)
  //   +41 $E6, +49 $E0 (mid pair, page 1, plain write)
  //   +63 $A0, +71 $A5 (lip pair, page 1, pipe-merged via CODE_0DABFD)
  const fillTile = readImmByte(cur, cur.handlerAddr + 28)
  const midL     = readImmByte(cur, cur.handlerAddr + 41)
  const midR     = readImmByte(cur, cur.handlerAddr + 49)
  const lipL     = readImmByte(cur, cur.handlerAddr + 63)
  const lipR     = readImmByte(cur, cur.handlerAddr + 71)

  // Row 0: just the pipe-merged lip pair.
  cur.col = col0
  cur.row = row0
  setPage1(cur); writeTilePipeMerge(cur, lipL)
  setPage1(cur); writeTilePipeMerge(cur, lipR)

  // Rows 1..rowCount-1. Each writes 2*(i-1) dirt fills, then the mid pair,
  // then (if not the last row) the pipe-merged lip pair. All row starts at col0.
  for (let i = 1; i < rowCount; i++) {
    cur.col = col0
    cur.row = row0 + i
    const fillCount = 2 * (i - 1)
    for (let j = 0; j < fillCount; j++) {
      setPage0(cur); writeTileAdvance(cur, fillTile)
    }
    setPage1(cur); writeTileAdvance(cur, midL)
    setPage1(cur); writeTileAdvance(cur, midR)
    if (i < rowCount - 1) {
      setPage1(cur); writeTilePipeMerge(cur, lipL)
      setPage1(cur); writeTilePipeMerge(cur, lipR)
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
  const bodyCount = ((cur.size >> 4) & 0x0F) + 1
  const col0 = cur.col, row0 = cur.row

  // CODE_0DADA3 inline immediates: +28 $3F (filler), +41 $E4 (body),
  // +53 $AF (lip via CODE_0DABFD merge).
  const fillTile = readImmByte(cur, cur.handlerAddr + 28)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 41)
  const lipTile  = readImmByte(cur, cur.handlerAddr + 53)

  // Rows 0..bodyCount-1: each ends in a lip.
  for (let i = 0; i < bodyCount; i++) {
    cur.row = row0 + i
    cur.col = col0
    for (let j = 0; j < i - 1; j++) {
      setPage0(cur); writeTileAdvance(cur, fillTile)
    }
    if (i >= 1) {
      setPage1(cur); writeTileAdvance(cur, bodyTile)
    }
    setPage1(cur); writeTilePipeMergeNoAdvance(cur, lipTile)
  }

  // Final `CODE_0DADC4` pass after the last lip: writes bodyCount-1 dirts
  // then the body, no lip. This row overwrites any grass/terrain beneath
  // the slope's base, flattening it into the adjacent ground plane.
  cur.row = row0 + bodyCount
  cur.col = col0
  for (let j = 0; j < bodyCount - 1; j++) {
    setPage0(cur); writeTileAdvance(cur, fillTile)
  }
  setPage1(cur); writeTileAdvance(cur, bodyTile)

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
    setPage1(cur); writeTilePipeMergeNoAdvance(cur, topTiles[c])
  }

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

  // CODE_0DAE6D inline immediates:
  //   +33 $C6  +41 $C7  (lip pair)
  //   +53 $EE  +61 $F0  (body pair)
  //   +73 $65  (filler)
  const lipL  = readImmByte(cur, cur.handlerAddr + 33)
  const lipR  = readImmByte(cur, cur.handlerAddr + 41)
  const bodyL = readImmByte(cur, cur.handlerAddr + 53)
  const bodyR = readImmByte(cur, cur.handlerAddr + 61)
  const fillTile = readImmByte(cur, cur.handlerAddr + 73)

  for (let i = 0; i < iter; i++) {
    setPage1(cur); writeTileAdvance(cur, bodyL)
    setPage1(cur); writeTileAdvance(cur, bodyR)
    let x = widthCounter - 2
    while (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, fillTile)
      x -= 1
    }
    stepDiag(cur, 2, 1)
    widthCounter -= 2
  }
  setPage1(cur); writeTileAdvance(cur, lipL)
  setPage1(cur); writeTile(cur, lipR)

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

  // CODE_0DAEFC inline immediates (per-row writes):
  //   +31 $65  (filler)
  //   +48 $F0  +56 $EF  (body pair)
  //   +68 $C8  +76 $C9  (lip pair)
  const fillTile = readImmByte(cur, cur.handlerAddr + 31)
  const bodyL = readImmByte(cur, cur.handlerAddr + 48)
  const bodyR = readImmByte(cur, cur.handlerAddr + 56)
  const lipL  = readImmByte(cur, cur.handlerAddr + 68)
  const lipR  = readImmByte(cur, cur.handlerAddr + 76)

  for (let i = 0; i < iter; i++) {
    let x = widthCounter
    while (x >= 4) {
      setPage1(cur); writeTileAdvance(cur, fillTile)
      x -= 1
    }
    if (x >= 2) {
      setPage1(cur); writeTileAdvance(cur, bodyL)
      setPage1(cur); writeTileAdvance(cur, bodyR)
      x -= 2
    }
    setPage1(cur); writeTileAdvance(cur, lipL)
    setPage1(cur); writeTileAdvance(cur, lipR)
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

  // CODE_0DAF61 inline immediates: +32 $C4 (lip), +43 $EC (body), +54 $65 (fill).
  const lipTile  = readImmByte(cur, cur.handlerAddr + 32)
  const bodyTile = readImmByte(cur, cur.handlerAddr + 43)
  const fillTile = readImmByte(cur, cur.handlerAddr + 54)

  for (let i = 0; i < iter; i++) {
    setPage1(cur); writeTileAdvance(cur, bodyTile)
    let x = widthCounter
    while (x >= 0) {
      setPage1(cur); writeTileAdvance(cur, fillTile)
      x -= 1
    }
    setPage1(cur); writeTile(cur, lipTile)
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
  // CODE_0DAFEA inline tile at +57 ($C5, mirror of variant 8's $C4).
  const lipTile = readImmByte(cur, cur.handlerAddr + 57)
  setPage1(cur)
  for (let i = 0; i < iter; i++) {
    writeTile(cur, lipTile)
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
  // LDA #$41/$42/$43 immediates at handler +13/+26/+39 (opcodes at +12/+25/+38).
  const topTile = readImmByte(cur, cur.handlerAddr + 13)
  const midTile = readImmByte(cur, cur.handlerAddr + 26)
  const botTile = readImmByte(cur, cur.handlerAddr + 39)
  setPage1(cur)
  writeTile(cur, topTile); cur.row += 1
  X--
  if (X < 0) return
  writeTile(cur, midTile); cur.row += 1
  X--
  if (X < 0) return
  while (X >= 0) {
    writeTile(cur, botTile); cur.row += 1
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
  // LDA.L DATA_0DB72F,X operand at handler +27 (opcode $BF at +26).
  // Final capper $EB is LDA # immediate at handler +103 (opcode at +102).
  // Initial _1 value is LDA #$01 immediate at +11 (opcode at +10).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 27)
  const cappingTile = readImmByte(cur, cur.handlerAddr + 103)
  const initialOne  = readImmByte(cur, cur.handlerAddr + 11)
  const table = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map(i => cur.rom.readByte(tableAddr + i) ?? 0)
  const col0 = cur.col, row0 = cur.row

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
  const width = cur.size & 0x0F
  const rightSide = (cur.size >> 4) & 0x0F
  const col0 = cur.col, row0 = cur.row

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
  const tA1  = readImmByte(cur, cur.handlerAddr + 37)
  const tAA2 = readImmByte(cur, cur.handlerAddr + 48)
  const tE2  = readImmByte(cur, cur.handlerAddr + 57)
  const t3Fa = readImmByte(cur, cur.handlerAddr + 68)
  const tA6a = readImmByte(cur, cur.handlerAddr + 79)
  const tF7  = readImmByte(cur, cur.handlerAddr + 114)
  const tA3  = readImmByte(cur, cur.handlerAddr + 125)
  const t3Fb = readImmByte(cur, cur.handlerAddr + 136)
  const tA6b = readImmByte(cur, cur.handlerAddr + 147)

  let _1 = 1
  let _2 = width
  saveBookmark(cur)

  setPage1(cur); writeTilePipeMerge(cur, tAA1)
  setPage0(cur); writeTileSlopeMerge(cur, tA1)
  restoreBookmark(cur)
  diagonalDownLeft(cur)
  _1 += 2
  _2 -= 1
  saveBookmark(cur)

  while (_2 >= 0) {
    setPage1(cur); writeTilePipeMerge(cur, tAA2)
    setPage1(cur); writeTileAdvance(cur, tE2)
    let x = _1 - 2
    while (x > 0) {
      setPage0(cur); writeTileAdvance(cur, t3Fa)
      x -= 1
    }
    setPage0(cur); writeTileSlopeMerge(cur, tA6a)
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
      setPage1(cur); writeTilePipeMerge(cur, tF7)
    } else {
      setPage0(cur); writeTileSlopeMerge(cur, tA3)
    }
    let x = _1b
    while (x > 0) {
      setPage0(cur); writeTileAdvance(cur, t3Fb)
      x -= 1
    }
    setPage0(cur); writeTileSlopeMerge(cur, tA6b)
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
 * ($0DCD90 — tilesets 2/6/8). Writes a single row of ledge tiles with
 * context-sensitive end caps that fuse into adjacent grass-top terrain.
 *
 *   Size byte: ????WWWW — only low nibble matters (width counter = _0).
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
  const width = cur.size & 0x0F    // _0 (line 5920)

  // Left cap (lines 5922-5931).
  setPage1(cur)
  const existingLeft = peekExistingLow(cur)
  const leftCap = (existingLeft >= 0x73 && existingLeft <= 0x75) ? 0x0A : 0x07
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
  const rightCap = (existingRight >= 0x73 && existingRight <= 0x75) ? 0x0B : 0x09
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
 *   Size byte: HHHHWWWW — H = height (_1), W = width (_0).
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
  const width  = cur.size & 0x0F          // _0 (line 5955)
  const height = (cur.size >> 4) & 0x0F   // _1 (lines 5957-5961)

  saveBookmark(cur)   // CODE_0DA6B1 (line 5963)

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
 * (H+1) tiles, writing DATA_0DB91A[X] at each. The shared body (entered via
 * BEQ +) branches on SwitchBlockFlags+2,X (X=0 blue, X=1 red at $7E1F29/$7E1F2A):
 *   DATA_0DB91A[0] = $6C page 0 -> Map16 $06C (blue uncleared, dotted outline)
 *   DATA_0DB91C[0] = $6C page 1 -> Map16 $16C (blue cleared, solid)
 * Editor always emits the dormant ($06C) state.
 */
export function handle_0DB916(cur: Cursor): void {
  writeSwitchBlockRect(cur, 37)
}

/**
 * CODE_0DB91E (bank_0D.asm line 4209) -- red switch-palace block (rectangular).
 *
 * Sibling of CODE_0DB916 entered 8 bytes later (after the two shared data
 * tables); LDX #$01 selects index 1 -> DATA_0DB91A[1] = $6D page 0 = Map16 $06D.
 * LDA.L operand offset relative to this entry point is 37 - 8 = 29.
 */
export function handle_0DB91E(cur: Cursor): void {
  writeSwitchBlockRect(cur, 29)
}

function writeSwitchBlockRect(cur: Cursor, ldaOperandOffset: number): void {
  const W = cur.size & 0x0F
  const H = (cur.size >> 4) & 0x0F
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + ldaOperandOffset)
  const tile = cur.rom.readByte(tableAddr + X) ?? 0
  setPage0(cur)
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
