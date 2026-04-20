/**
 * extendedHandlers.ts -- Ports of SMW bank_0D.asm extended-object handlers.
 *
 * Extended objects appear in the level stream when the 6-bit object number is
 * zero; the settings byte then selects one of 128 extended types via the
 * CODE_0DA106 dispatch table (bank_0D.asm line 1056).
 */

import {
  Cursor, writeTile, setPage0, setPage1,
  advanceCol, saveBookmark, nextRow,
  peekExistingLow,
  readLongOperand, readImmByte,
} from './cursor'

/**
 * CODE_0DA512 (bank_0D.asm line 1416) -- screen exit marker (ext type 0x00).
 * Records level/entrance routing; emits no visible tiles. No-op for the editor.
 */
export function handle_0DA512(_cur: Cursor): void {
  // No tiles.
}

/**
 * CODE_0DA53D (bank_0D.asm line 1441) -- screen-number set (ext type 0x01).
 * `LDA _A; AND #$1F; STA LevelLoadObject` -- overwrites the screen counter.
 * The side effect is applied in LevelParser (the counter is parser-time state,
 * not expansion-time). This handler emits no tiles.
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
  const extType = cur.objNo
  const idx = extType - 0x10
  if (idx < 0 || idx >= 0x33) return
  // LDA.L DATA_0DA548,X lives inside CODE_0DA5B1 (offset +54 from CODE_0DA57B).
  // Within CODE_0DA5B1, the LDA.L opcode is at +14 so its operand is at +15.
  // Net: operand byte at cur.handlerAddr + 69.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 69)
  if (idx >= 0x13) setPage1(cur); else setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + idx) ?? 0)
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
  // CODE_0DA64D: LDA #$32 at cur.handlerAddr + 0 (operand at +1), then JMP
  // CODE_0DA57F which reads DATA_0DA548[X]. The DATA_0DA548 address is
  // embedded in CODE_0DA5B1's LDA.L, not in CODE_0DA64D itself. To get it
  // dynamically we'd need to follow the JMP target -- for now the index is
  // the only immediate of interest here, and the table comes from the same
  // source as handle_0DA57B. Derive it from CODE_0DA57B's JMP path by
  // reading it from its known vanilla-ROM position, relative to the
  // CODE_0DA64D handler: the JMP CODE_0DA57F operand is at +4, and from
  // there CODE_0DA5B1's LDA.L operand is at +69 relative to CODE_0DA57B.
  // (CODE_0DA5B1 = CODE_0DA57B + 54; LDA.L opcode at +14; operand at +15.)
  const idx = readImmByte(cur, cur.handlerAddr + 1)   // $32 by default
  // CODE_0DA64D does JMP CODE_0DA57F which is inside CODE_0DA57B at offset +4.
  // Read the JMP operand at +4 (after LDA #$32 + JMP opcode).
  const jmpLo = cur.rom.readByte(cur.handlerAddr + 3) ?? 0
  const jmpHi = cur.rom.readByte(cur.handlerAddr + 4) ?? 0
  const bank = cur.handlerAddr & 0xFF0000
  const code0DA57F = bank | (jmpHi << 8) | jmpLo
  // CODE_0DA57F is 4 bytes into CODE_0DA57B (the SBC #$10 ends at CODE_0DA57F).
  // CODE_0DA57B = code0DA57F - 4. The LDA.L operand is at CODE_0DA57B + 69.
  const code0DA57B = code0DA57F - 4
  const tableAddr = readLongOperand(cur, code0DA57B + 69)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + idx) ?? 0)
}

/**
 * ADDR_0DA656 (bank_0D.asm line 1585) -- ext types 0x42 and 0x43: 2-tile
 * horizontal pair. X = extType - 0x42, picks from DATA_0DA652 (left) and
 * DATA_0DA654 (right).
 */
export function handle_0DA656(cur: Cursor): void {
  const X = cur.objNo - 0x42
  if (X < 0 || X > 1) return
  // CODE_0DA656: LDA.L DATA_0DA652,X operand at +11; LDA.L DATA_0DA654,X at +18.
  const addrLeft  = readLongOperand(cur, cur.handlerAddr + 11)
  const addrRight = readLongOperand(cur, cur.handlerAddr + 18)
  const left  = cur.rom.readByte(addrLeft + X) ?? 0
  const right = cur.rom.readByte(addrRight + X) ?? 0
  setPage1(cur)
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
  // CODE_0DA673: LDA.L DATA_0DA671,X operand at +8; LDA #$EB immediate at +20.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 8)
  const top = cur.rom.readByte(tableAddr + X) ?? 0
  const bot = readImmByte(cur, cur.handlerAddr + 20)
  setPage0(cur)
  writeTile(cur, top)
  cur.row += 1
  setPage1(cur)
  writeTile(cur, bot)
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
  // CODE_0DA68E inline tile immediates: +23 $35 (tape), +31 $38 (base).
  const tapeTile = readImmByte(cur, cur.handlerAddr + 23)
  const baseTile = readImmByte(cur, cur.handlerAddr + 31)
  const origCol = cur.col
  setPage0(cur)
  cur.col = origCol - 1
  writeTile(cur, tapeTile)
  cur.col = origCol
  writeTile(cur, baseTile)
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
  // CODE_0DB2CA inline tile immediates. Opcodes at +93 ($A9 LDA #) and +103;
  // the 1-byte immediates follow at +94 ($2D top) and +104 ($2E bottom).
  const topTile = readImmByte(cur, cur.handlerAddr + 94)
  const botTile = readImmByte(cur, cur.handlerAddr + 104)
  setPage0(cur)
  writeTile(cur, topTile)
  cur.row += 1
  writeTile(cur, botTile)
  cur.row -= 1
}

/**
 * CODE_0DA7E7 (bank_0D.asm line 1784) -- 2×2 tile block from DATA_0DA7E3.
 * Writes [$66, $67] on row 0 then [$68, $69] on row 1, all page 0.
 * Dispatched for extended types $86 (and others that redirect here via the
 * table at bank_0D line 1196).
 */
export function handle_0DA7E7(cur: Cursor): void {
  // CODE_0DA7E7: LDA.L DATA_0DA7E3,X operand at +11. Table has 4 entries
  // stamped by the inner loop at positions [0..3]; the ASM's cursor layout
  // gives us (col0, row0) -> (col0+1, row0) on first pair, then nextRow to
  // (col0, row0+1) -> (col0+1, row0+1).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 11)
  const tiles = [
    cur.rom.readByte(tableAddr + 0) ?? 0,
    cur.rom.readByte(tableAddr + 1) ?? 0,
    cur.rom.readByte(tableAddr + 2) ?? 0,
    cur.rom.readByte(tableAddr + 3) ?? 0,
  ]
  const col0 = cur.col, row0 = cur.row
  setPage0(cur)
  writeTile(cur, tiles[0])
  cur.col = col0 + 1
  writeTile(cur, tiles[1])
  cur.col = col0
  cur.row = row0 + 1
  setPage0(cur)
  writeTile(cur, tiles[2])
  cur.col = col0 + 1
  writeTile(cur, tiles[3])
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DC31E (bank_0D.asm line 4826) -- 2×3 tile block from DATA_0DC318.
 * Extended object $90. Writes (all page 0):
 *   Row 0: $98, $99
 *   Row 1: $9A, $9B
 *   Row 2: $9C, $9C
 *
 * ASM loops with X stepping 0..5 through the table; _0=1 gives 2 writes per
 * inner loop, CPX #$06 then terminates the outer loop after 3 rows.
 */
export function handle_0DC31E(cur: Cursor): void {
  // Byte layout from opcode sequence:
  //   +0   LDY LevelLoadPos        (A4 xx)
  //   +2   LDX #$00                (A2 00)
  //   +4   LDA #$01                (A9 01)
  //   +6   STA _0                  (85 xx)
  //   +8   LDA _0                  (A5 xx)   ← CODE_0DC326
  //   +10  STA _1                  (85 xx)
  //   +12  JSR StzTo6ePointer      (20 xx xx)
  //   +15  LDA.L DATA_0DC318,X     (BF ...) operand at +16
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 16)
  const tiles = [
    cur.rom.readByte(tableAddr + 0) ?? 0,
    cur.rom.readByte(tableAddr + 1) ?? 0,
    cur.rom.readByte(tableAddr + 2) ?? 0,
    cur.rom.readByte(tableAddr + 3) ?? 0,
    cur.rom.readByte(tableAddr + 4) ?? 0,
    cur.rom.readByte(tableAddr + 5) ?? 0,
  ]
  const col0 = cur.col, row0 = cur.row
  for (let r = 0; r < 3; r++) {
    cur.row = row0 + r
    cur.col = col0
    setPage0(cur)
    writeTile(cur, tiles[r * 2])
    cur.col = col0 + 1
    writeTile(cur, tiles[r * 2 + 1])
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DDAA2 (bank_0D.asm line 6426) -- 2x2 accent block on page 1.
 *
 * Fixed layout, no size-byte parameters: writes DATA_0DDA9E[0..3] = $66/$67/
 * $68/$69 into a 2x2 grid at (col0, row0). The ASM's `AND #$01 BNE -` pattern
 * toggles row advancement on every odd X, yielding:
 *   (col0, row0)   = $66    (col0+1, row0)   = $67
 *   (col0, row0+1) = $68    (col0+1, row0+1) = $69
 */
export function handle_0DDAA2(cur: Cursor): void {
  // LDA.L DATA_0DDA9E,X — opcode $BF at +10, operand at +11.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 11)
  const tiles = [
    cur.rom.readByte(tableAddr + 0) ?? 0,
    cur.rom.readByte(tableAddr + 1) ?? 0,
    cur.rom.readByte(tableAddr + 2) ?? 0,
    cur.rom.readByte(tableAddr + 3) ?? 0,
  ]
  const col0 = cur.col, row0 = cur.row
  setPage1(cur)
  writeTile(cur, tiles[0])
  cur.col = col0 + 1
  writeTile(cur, tiles[1])
  cur.col = col0
  cur.row = row0 + 1
  setPage1(cur)
  writeTile(cur, tiles[2])
  cur.col = col0 + 1
  writeTile(cur, tiles[3])
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DB583 (bank_0D.asm line 3726) -- yellow switch-palace block (single tile).
 *
 * X=1 (LDX #$01) selects index 1 in the shared data tables. Falls through to
 * the common body at CODE_0DB58B+2. SMW picks between:
 *   DATA_0DB589[1] = $6B on page 0 when SwitchBlockFlags[1] is zero (uncleared)
 *   DATA_0DB587[1] = $6B on page 1 when the yellow switch has been pressed
 * For editor rendering we always show the dormant (uncleared, page-0) tile so
 * the level layout is visible regardless of the save-state flag.
 */
export function handle_0DB583(cur: Cursor): void {
  // LDX #$01 at +0 → X at +1. LDA.L DATA_0DB589 operand at +21 inside the
  // shared body (entered via the intentional BNE +; fall-through to CODE_0DB58B).
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 21)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

/**
 * CODE_0DB58B (bank_0D.asm line 3736) -- green switch-palace block (single tile).
 *
 * Sibling of CODE_0DB583; enters the shared body directly with X=0 via LDX #$00.
 * DATA_0DB589[0] = $6A (green uncleared) → Map16 $06A.
 * DATA_0DB587[0] = $6A (green cleared)   → Map16 $16A.
 * Editor always renders the dormant ($06A) state.
 */
export function handle_0DB58B(cur: Cursor): void {
  // LDX #$00 at +0 → X at +1. CODE_0DB58B enters the shared body 8 bytes
  // before CODE_0DB583's equivalent offset, so LDA.L DATA_0DB589 operand
  // lands at +13 (= 21 - 8).
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 13)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

export function handle_0DA6D1(cur: Cursor): void {
  // CODE_0DA6D1: LDA.L DATA_0DA6CD,X operand at +11; LDA.L DATA_0DA6CF,X at +23.
  const addrTop = readLongOperand(cur, cur.handlerAddr + 11)
  const addrBot = readLongOperand(cur, cur.handlerAddr + 23)
  const X = cur.objNo - 0x47
  const top = cur.rom.readByte(addrTop + X) ?? 0
  const bot = cur.rom.readByte(addrBot + X) ?? 0
  setPage0(cur)
  writeTile(cur, top)
  cur.row += 1
  writeTile(cur, bot)
  cur.row -= 1
}

/**
 * CODE_0DA78D (bank_0D.asm line 1736) -- hillside tile-merge write.
 *
 * Shared by the tall-hillside (ext $82, CODE_0DA71B) and short-hillside
 * (ext $83, CODE_0DA760) handlers. Each caller hands us one table entry `A`;
 * we decide what low byte to stamp at the cursor and then advance one column.
 *
 * ASM decision tree:
 *   A == $25  → JMP CODE_0DA95D       (skip write; just advance cursor)
 *   A <  $49  → JMP CODE_0DA95B at +2 (write A as-is, advance)
 *   A <  $54  → JMP CODE_0DA95B at +2 (write A as-is, advance)
 *   else      → read existing low byte at cursor and blend:
 *                 existing == $25   → write A
 *                 existing == $49   → write A + 1
 *                 existing other    → write A + 2
 *               then advance one column.
 *
 * The $25-in check at the top matters because the data tables are padded with
 * $25 (empty) to preserve grid shape; stamping $25 on top would clobber
 * whatever terrain was drawn underneath. The $54-range blend is how the
 * hillside's outer cap/slope tiles merge with pre-existing ground or other
 * hill tiles.
 *
 * Caller is responsible for setting the page (the hillside handlers call
 * StzTo6ePointer == setPage0 before each call).
 */
function hillsideMergeWriteAdvance(cur: Cursor, A: number): void {
  if (A === 0x25) {
    advanceCol(cur)
    return
  }
  if (A < 0x49 || A < 0x54) {
    writeTile(cur, A)
    advanceCol(cur)
    return
  }
  // A >= $54 → merge with existing.
  const existing = peekExistingLow(cur)
  let tile = A
  if (existing !== 0x25) {
    // BEQ skip both INCs when existing == $25 (no bump). BEQ skip one INC
    // when existing == $49 (bump by 1). Else fall through both INCs (bump by 2).
    tile = (tile + 1) & 0xFF
    if (existing !== 0x49) tile = (tile + 1) & 0xFF
  }
  writeTile(cur, tile)
  advanceCol(cur)
}

/**
 * CODE_0DA71B (bank_0D.asm line 1684) -- extended type $82: tall hillside.
 *
 * Stamps a 9-wide × 5-tall grid of tiles from DATA_0DA6EE into the level
 * tilemap. The data is read row-major (X increments linearly through 45
 * entries). Each tile passes through the CODE_0DA78D hillside-merge helper
 * so $25 entries act as "leave cell alone" padding and out-of-range tiles
 * blend with whatever terrain is already at the destination.
 *
 * Used on the overworld and in grass/hill-themed levels for the large
 * hillside silhouette behind foreground terrain.
 */
export function handle_0DA71B(cur: Cursor): void {
  // LDA.L DATA_0DA6EE operand lives at handler +19 (opcode $BF at +18).
  // Layout:
  //   +0  LDY  LevelLoadPos           (2 bytes)
  //   +2  LDA #$08 / STA _0           (4 bytes)
  //   +6  LDA #$04 / STA _1           (4 bytes)
  //   +10 LDX #$00                    (2 bytes)
  //   +12 JSR CODE_0DA6B1             (3 bytes)
  //   +15 LDA _0 / STA _2             (4 bytes)   ← CODE_0DA72A
  //   +19 JSR StzTo6ePointer          (3 bytes)
  //   +22 LDA.L DATA_0DA6EE,X         (4 bytes)   operand at +23
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 23)

  const cols = 9    // _0 = 8, loop `DEC _2; BPL -` runs while _2 >= 0 → 9 iters
  const rows = 5    // _1 = 4, same pattern → 5 iters

  saveBookmark(cur)   // CODE_0DA6B1
  let x = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      setPage0(cur)   // StzTo6ePointer before each tile
      const tile = cur.rom.readByte(tableAddr + x) ?? 0
      hillsideMergeWriteAdvance(cur, tile)
      x++
    }
    // CODE_0DA6BA + CODE_0DA97D → nextRow (col = bookmark, row += 1).
    // Skip on the last row; the ASM's `BPL` exits naturally here too.
    if (r < rows - 1) nextRow(cur)
  }
}

/**
 * CODE_0DA760 (bank_0D.asm line 1713) -- extended type $83: short hillside.
 *
 * Same machinery as CODE_0DA71B but with a 6-wide × 4-tall grid from
 * DATA_0DA748 (24 bytes). Used for smaller rolling-hill silhouettes on the
 * overworld and in grass-themed levels.
 */
export function handle_0DA760(cur: Cursor): void {
  // LDA.L DATA_0DA748 operand at handler +23 (same layout as CODE_0DA71B —
  // the only differences are the LDA #$05 / #$03 immediates at +3/+7 and
  // the table address).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 23)

  const cols = 6    // _0 = 5 → 6 iters
  const rows = 4    // _1 = 3 → 4 iters

  saveBookmark(cur)
  let x = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      setPage0(cur)
      const tile = cur.rom.readByte(tableAddr + x) ?? 0
      hillsideMergeWriteAdvance(cur, tile)
      x++
    }
    if (r < rows - 1) nextRow(cur)
  }
}

/**
 * CODE_0DA7C1 (bank_0D.asm line 1762) -- extended type $4A.
 *
 * Stamps a 4-wide × 4-tall grid from DATA_0DA7B1 (16 bytes). Unlike the
 * hillside handlers this one writes tiles directly via CODE_0DA95B -- no
 * merge, no $25 skip, no StzTo6ePointer. The page byte at each destination
 * is whatever was there before (typically page 0 for a fresh level because
 * the Map16High array is zero-initialised).
 *
 * Loop terminates when X reaches $10 (= 16 entries consumed).
 */
export function handle_0DA7C1(cur: Cursor): void {
  // Layout:
  //   +0  LDY  LevelLoadPos           (2 bytes)
  //   +2  LDX #$00                    (2 bytes)
  //   +4  JSR CODE_0DA6B1             (3 bytes)
  //   +7  LDA #$03 / STA _2           (4 bytes)  ← CODE_0DA7C8
  //   +11 LDA.L DATA_0DA7B1,X         (4 bytes)  operand at +12
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)

  saveBookmark(cur)
  let x = 0
  // Outer loop mimics `CPX #$10; BNE CODE_0DA7C8` → 4 iterations of 4 cols.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      // No page setter in the ASM -- inherit cursor.page. For a freshly
      // expanded level that's 0 (default), which matches what the game
      // sees via the zero-initialised Map16High array.
      const tile = cur.rom.readByte(tableAddr + x) ?? 0
      writeTile(cur, tile)
      advanceCol(cur)
      x++
    }
    if (r < 3) nextRow(cur)
  }
}

// ── Tileset-8 (ghost-house) extended-object handlers ─────────────────────────
// Bank_0D's extended-object dispatch table ($0DA106 + 3*type) points these
// at ext types $4D-$56 for ghost-house wall art and doors. They weren't
// ported earlier because no fixture level used them directly; ghost-house
// fixtures like $00F / $12A use them heavily.

/**
 * CODE_0DCE67 (bank_0D.asm line 5500) -- ext types $4D-$50 (ghost-house
 * window / picture-frame 2x2 pattern). Reads 4 tiles from DATA_0DCE57 at
 * offset (objNo-$4D)*4 and stamps them in a 2x2 grid.
 *
 *   DATA_0DCE57 =
 *     $7A, $7B, $7C, $25,   ; ext $4D
 *     $7E, $7F, $25, $7D,   ; ext $4E
 *     $82, $25, $80, $81,   ; ext $4F
 *     $25, $83, $84, $85    ; ext $50
 *
 * Layout: [0][1] on top row, restoreBookmark + nextRow, [2][3] on bottom.
 * All writes page 0.
 */
export function handle_0DCE67(cur: Cursor): void {
  const X = (cur.objNo - 0x4D) * 4
  if (X < 0 || X >= 16) return
  // Byte layout verified by dumping $0DCE67:
  //   +16 BF 57 CE 0D   LDA.L DATA_0DCE57,X   (operand at +17..+19)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 17)
  const tiles = [0, 1, 2, 3].map(i => cur.rom.readByte(tableAddr + X + i) ?? 0)
  const col0 = cur.col, row0 = cur.row
  setPage0(cur)
  writeTile(cur, tiles[0])
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, tiles[1])
  cur.col = col0
  cur.row = row0 + 1
  setPage0(cur)
  writeTile(cur, tiles[2])
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, tiles[3])
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DCE94 (bank_0D.asm line 5527) -- ext types $51-$54 single-tile
 * stamps. Reads DATA_0DCE90 = [$76, $77, $78, $79] indexed by objNo-$51.
 * Writes one tile at the cursor, page 0, no advance.
 */
export function handle_0DCE94(cur: Cursor): void {
  const X = cur.objNo - 0x51
  if (X < 0 || X >= 4) return
  // Byte layout verified by dumping $0DCE94:
  //   +11 BF 90 CE 0D   LDA.L DATA_0DCE90,X   (operand at +12..+14)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

/**
 * ADDR_0DCEA6 (bank_0D.asm line 5538) -- ext type $70 (ghost-house double
 * tile). Writes $84 at Y (advance), $85 at Y (no advance). Page 0.
 * Dispatched for ext $70 per line 1174.
 */
export function handle_0DCEA6(cur: Cursor): void {
  // Byte layout verified by dumping $0DCEA6:
  //   +11 A9 84   LDA #$84 (imm at +12)
  //   +19 A9 85   LDA #$85 (imm at +20)
  const tA = readImmByte(cur, cur.handlerAddr + 12)
  const tB = readImmByte(cur, cur.handlerAddr + 20)
  const col0 = cur.col
  setPage0(cur)
  writeTile(cur, tA)
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, tB)
  cur.col = col0
}

/**
 * CODE_0DCEC0 (bank_0D.asm line 5556) -- ext type $55 (vertical 2-tile stack
 * $96 / $97, page 0). Writes $96 at (col, row), then $97 at (col, row+1).
 *
 * The ASM uses `STA [Map16LowPtr],Y` (no advance) followed by CODE_0DA97D
 * (row += 1), so each write stays in the same column.
 */
export function handle_0DCEC0(cur: Cursor): void {
  // Byte layout verified by dumping $0DCEC0:
  //   +9 BF BE CE 0D   LDA.L DATA_0DCEBE,X   (operand at +10..+12)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 10)
  const t0 = cur.rom.readByte(tableAddr + 0) ?? 0
  const t1 = cur.rom.readByte(tableAddr + 1) ?? 0
  const row0 = cur.row
  setPage0(cur)
  writeTile(cur, t0)
  cur.row = row0 + 1
  setPage0(cur)
  writeTile(cur, t1)
  cur.row = row0
}

/**
 * CODE_0DCEDA (bank_0D.asm line 5573) -- ext type $56 (horizontal 2-tile
 * pair $98 / $99, page 0). Writes $98 at (col, row), $99 at (col+1, row).
 *
 * The ASM uses CODE_0DA95B (advance) between writes, so cursor walks right.
 */
export function handle_0DCEDA(cur: Cursor): void {
  // Byte layout verified by dumping $0DCEDA:
  //   +9 BF D8 CE 0D   LDA.L DATA_0DCED8,X   (operand at +10..+12)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 10)
  const t0 = cur.rom.readByte(tableAddr + 0) ?? 0
  const t1 = cur.rom.readByte(tableAddr + 1) ?? 0
  const col0 = cur.col
  setPage0(cur)
  writeTile(cur, t0)
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, t1)
}

/**
 * CODE_0DEC33 (bank_0D.asm line 7854) -- extended type $85: Yoshi's House tree.
 *
 * Stamps a fixed 16-column × 10-row blob of Map16 tile IDs from DATA_0DEB93
 * (0xA0 bytes of raw tile data, line 7832) into the level grid, anchored at
 * the object's cursor position. All tiles are page 0 (StzTo6ePointer per cell).
 *
 * ASM structure:
 *   LDY LevelLoadPos ; LDX #$00
 * outer:
 *   LDA #$0F ; STA _0            ; inner counter = 15
 *   -loop 15x:  StzTo6ePointer + LDA DATA_0DEB93,X + JSR CODE_0DA95B (write+INY) + INX + DEC _0 + BNE -
 *   StzTo6ePointer + LDA DATA_0DEB93,X + STA [Map16LowPtr],Y + INX   ; 16th tile, no INY
 *   JSR CODE_0DA97D                                                   ; LevelLoadPos += $10 (row+1, col reset to col0)
 *   CPX #$A0 ; BNE outer                                              ; 10 rows total
 *
 * Used at sublevel $104 (Yoshi's House) to stamp the big tree/house graphic.
 */
export function handle_0DEC33(cur: Cursor): void {
  // LDA.L DATA_0DEB93,X opcode at +11; operand (3 bytes) at +12.
  // (LDY LevelLoadPos=2 + LDX #$00=2 + LDA #$0F=2 + STA _0=2 + JSR StzTo6ePointer=3 = 11.)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)
  const col0 = cur.col
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 16; c++) {
      const tile = cur.rom.readByte(tableAddr + r * 16 + c) ?? 0
      cur.col = col0 + c
      writeTile(cur, tile)
    }
    cur.row += 1
  }
  cur.col = col0
}

/**
 * CODE_0DB6E3 (bank_0D.asm line 3911) -- single-tile extended object for types
 * 0x88 ($C1) and 0x89 ($C2). Used for one-off decorative tiles (e.g. the Forest
 * of Illusion spore dots). Reads DATA_0DB6E1[type - 0x88] and stamps it at the
 * anchor position.
 */
export function handle_0DB6E3(cur: Cursor): void {
  const X = (cur.objNo - 0x88) & 0xFF
  // LDA.L DATA_0DB6E1,X — $BF opcode at +11, operand at +12..+14.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}
