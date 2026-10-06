/**
 * extendedHandlers.ts -- Ports of SMW bank_0D.asm extended-object handlers.
 *
 * Extended objects appear in the level stream when the 6-bit object number is
 * zero; the settings byte then selects one of 128 extended types via the
 * CODE_0DA106 dispatch table (bank_0D.asm line 1056).
 */

import {
  Cursor,
  writeTile,
  writeTileAdvance,
  setPage0,
  setPage1,
  advanceCol,
  advanceRowRaw,
  saveBookmark,
  restoreBookmark,
  nextRow,
  peekExistingLow,
  readLongOperand,
  readGatedLongOperand,
  readImmByte,
  MAP16_BYTES_PER_SCREEN_H,
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
 * For editor purposes we emit the tile, skipping the item-memory checks at
 * CODE_0DA57F (the editor always shows the "not collected" state).
 */
export function handle_0DA57B(cur: Cursor): void {
  const extType = cur.objNo
  const idx = extType - 0x10
  if (idx < 0 || idx >= 0x33) return
  // LDA.L DATA_0DA548,X lives inside CODE_0DA5B1 (offset +54 from CODE_0DA57B).
  // Within CODE_0DA5B1, the LDA.L opcode is at +14 so its operand is at +15.
  // Net: operand byte at cur.handlerAddr + 69.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 69)
  if (idx >= 0x13) setPage1(cur)
  else setPage0(cur)
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
  const idx = readImmByte(cur, cur.handlerAddr + 1) // $32 by default
  // CODE_0DA64D does JMP CODE_0DA57F which is inside CODE_0DA57B at offset +4.
  // Read the JMP operand at +4 (after LDA #$32 + JMP opcode).
  const jmpLo = cur.rom.readByte(cur.handlerAddr + 3) ?? 0
  const jmpHi = cur.rom.readByte(cur.handlerAddr + 4) ?? 0
  const bank = cur.handlerAddr & 0xff0000
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
  const addrLeft = readLongOperand(cur, cur.handlerAddr + 11)
  const addrRight = readLongOperand(cur, cur.handlerAddr + 18)
  const left = cur.rom.readByte(addrLeft + X) ?? 0
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
 *
 * Both writes run the low-byte store BEFORE `Sta1To6ePointer`, so the high
 * byte ends up $01 on both rows - the whole pair lives on page 1 ($1B4/$1B5
 * on top, $1EB on bottom).
 */
export function handle_0DA673(cur: Cursor): void {
  const X = cur.objNo - 0x44
  if (X < 0 || X > 1) return
  // CODE_0DA673: LDA.L DATA_0DA671,X operand at +8; LDA #$EB immediate at +20.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 8)
  const top = cur.rom.readByte(tableAddr + X) ?? 0
  const bot = readImmByte(cur, cur.handlerAddr + 20)
  setPage1(cur)
  writeTile(cur, top)
  cur.row += 1
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
  const col0 = cur.col,
    row0 = cur.row
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
  const col0 = cur.col,
    row0 = cur.row
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
  // LDA.L DATA_0DDA9E,X - opcode $BF at +10, operand at +11.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 11)
  const tiles = [
    cur.rom.readByte(tableAddr + 0) ?? 0,
    cur.rom.readByte(tableAddr + 1) ?? 0,
    cur.rom.readByte(tableAddr + 2) ?? 0,
    cur.rom.readByte(tableAddr + 3) ?? 0,
  ]
  const col0 = cur.col,
    row0 = cur.row
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
 *     (bank_0D.asm:3739 `LDA.W SwitchBlockFlags,X`, :3740 `BNE +`, :3742 `LDA.L DATA_0DB589,X`)
 *   DATA_0DB587[1] = $6B on page 1 when the yellow switch has been pressed
 *     (:3747 `LDA.L DATA_0DB587,X`, taken branch)
 *
 * Reads whichever table `cur.switchFlags.yellow` (#567) says the ROM would
 * have read, gated on the `$BF` opcode still being there at each offset -
 * a single-table read that assumed the two tables agree would silently pick
 * the wrong tile the day they don't.
 */
export function handle_0DB583(cur: Cursor): void {
  // LDX #$01 at +0 → X at +1. DATA_0DB589 (uncleared) operand at +21;
  // DATA_0DB587 (cleared) operand at +31 (the shared body's taken-branch LDA.L).
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const cleared = cur.switchFlags.yellow
  const tableAddr = readGatedLongOperand(cur, cleared ? 31 : 21)
  if (tableAddr === null) return
  if (cleared) setPage1(cur)
  else setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

/**
 * CODE_0DB58B (bank_0D.asm line 3736) -- green switch-palace block (single tile).
 * Sibling of CODE_0DB583, entered 8 bytes earlier with X=0 - see its comment;
 * gates on `cur.switchFlags.green`.
 */
export function handle_0DB58B(cur: Cursor): void {
  // CODE_0DB58B enters the shared body 8 bytes before CODE_0DB583's
  // equivalent offsets: DATA_0DB589 operand at +13 (21-8), DATA_0DB587 at
  // +23 (31-8).
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const cleared = cur.switchFlags.green
  const tableAddr = readGatedLongOperand(cur, cleared ? 23 : 13)
  if (tableAddr === null) return
  if (cleared) setPage1(cur)
  else setPage0(cur)
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
 * CODE_0DEABF (bank_0D.asm line 7772) -- tileset-5 extended object $49:
 * ghost-house facade stamped from DATA_0DEA71, a fixed 6-column ×
 * 13-row tile image (78 bytes total).
 *
 * The ASM iterates with a single running index X from 0 to $4E (=78),
 * emitting 6 page-0 tiles per row before CODE_0DA97D advances the row
 * and LevelLoadPos resets the column back to the object's start col.
 *
 * Used by sublevels of Donut Ghost House (e.g. $0C4) to paint the
 * visible wall + staircase that sits behind the catwalks. Called a
 * "facade" because it's a pre-baked image in ROM rather than
 * procedurally generated.
 */
export function handle_0DEABF(cur: Cursor): void {
  // LDA.L DATA_0DEA71,X - opcode $BF at handler+11, 3-byte operand at +12.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  const TILES_PER_ROW = 6
  const TOTAL_TILES = 0x4e // 78

  const origCol = cur.col
  setPage0(cur)
  for (let x = 0; x < TOTAL_TILES; x++) {
    const tile = cur.rom.readByte(tableAddr + x) ?? 0
    writeTile(cur, tile)
    cur.col += 1
    if ((x + 1) % TILES_PER_ROW === 0) {
      cur.col = origCol
      cur.row += 1
    }
  }
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
    tile = (tile + 1) & 0xff
    if (existing !== 0x49) tile = (tile + 1) & 0xff
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

  const cols = 9 // _0 = 8, loop `DEC _2; BPL -` runs while _2 >= 0 → 9 iters
  const rows = 5 // _1 = 4, same pattern → 5 iters

  saveBookmark(cur) // CODE_0DA6B1
  let x = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      setPage0(cur) // StzTo6ePointer before each tile
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
  // LDA.L DATA_0DA748 operand at handler +23 (same layout as CODE_0DA71B -
  // the only differences are the LDA #$05 / #$03 immediates at +3/+7 and
  // the table address).
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 23)

  const cols = 6 // _0 = 5 → 6 iters
  const rows = 4 // _1 = 3 → 4 iters

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
  const X = (cur.objNo - 0x4d) * 4
  if (X < 0 || X >= 16) return
  // Byte layout verified by dumping $0DCE67:
  //   +16 BF 57 CE 0D   LDA.L DATA_0DCE57,X   (operand at +17..+19)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 17)
  const tiles = [0, 1, 2, 3].map(i => cur.rom.readByte(tableAddr + X + i) ?? 0)
  const col0 = cur.col,
    row0 = cur.row
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
  const X = (cur.objNo - 0x88) & 0xff
  // LDA.L DATA_0DB6E1,X - $BF opcode at +11, operand at +12..+14.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(tableAddr + X) ?? 0)
}

/**
 * CODE_0DEC5C (bank_0D.asm line 7875) -- extended type $97: single-tile write
 * of $110 (page 1) at the cursor. Dispatched from the extended table at line
 * 1213. Used in level $0CA among others for the small light/detail block.
 *
 * ASM:
 *   LDY LevelLoadPos
 *   JSR Sta1To6ePointer   ; page 1
 *   LDA #$10              ; tile immediate at handler+6
 *   STA [Map16LowPtr],Y   ; write, no advance
 */
export function handle_0DEC5C(cur: Cursor): void {
  const tile = readImmByte(cur, cur.handlerAddr + 6)
  setPage1(cur)
  writeTile(cur, tile)
}

/**
 * CODE_0DEC8E (bank_0D.asm line 7901) -- extended types $8A..$8D: 2x2 switch-
 * block sprite (four consecutive tiles from DATA_0DEC7E indexed by
 * (extType - $8A) * 4). Tiles laid out (tl, tr, bl, br), all on page 0.
 *
 * DATA_0DEC7E = EC ED EE EF  F0 F1 F2 F3  F4 F5 F6 F7  F8 F9 FA FB
 *                (ext $8A)    (ext $8B)    (ext $8C)    (ext $8D)
 *
 * The ASM first consults `SwitchBlockFlags` ($1F27,X) and returns without
 * emitting anything if the flag is set (block has been triggered). For the
 * editor we always render the pre-trigger state.
 */
export function handle_0DEC8E(cur: Cursor): void {
  const extType = cur.objNo
  const baseType = readImmByte(cur, cur.handlerAddr + 6)
  const idx = extType - baseType
  if (idx < 0 || idx >= 4) return
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 32)
  const base = idx * 4
  const tl = cur.rom.readByte(tableAddr + base + 0) ?? 0
  const tr = cur.rom.readByte(tableAddr + base + 1) ?? 0
  const bl = cur.rom.readByte(tableAddr + base + 2) ?? 0
  const br = cur.rom.readByte(tableAddr + base + 3) ?? 0
  const col0 = cur.col,
    row0 = cur.row
  setPage0(cur)
  writeTile(cur, tl)
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, tr)
  cur.col = col0
  cur.row = row0 + 1
  setPage0(cur)
  writeTile(cur, bl)
  cur.col = col0 + 1
  setPage0(cur)
  writeTile(cur, br)
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DC259 (bank_0D.asm line 4767) -- ext types $4B and $4C: coin block
 * variants. DATA_0DC257 = [$07, $08]; index X = extType - $4B (0 or 1).
 * Writes DATA_0DC257[X] on page 1 at the cursor position (no advance).
 *
 * ASM:
 *   LDY.B LevelLoadPos
 *   LDA.B LvlLoadObjSize   ; = ext type byte
 *   SEC
 *   SBC.B #$4B             ; X = extType - $4B
 *   TAX
 *   JSR Sta1To6ePointer    ; page 1
 *   LDA.L DATA_0DC257,X    ; operand at handler+12
 *   STA.B [Map16LowPtr],Y  ; write, no advance
 */
export function handle_0DC259(cur: Cursor): void {
  const X = cur.objNo - 0x4b
  if (X < 0 || X >= 2) return
  // LDA.L DATA_0DC257,X opcode ($BF) at +11; 3-byte operand at +12..+14.
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  const tile = cur.rom.readByte(tableAddr + X) ?? 0
  setPage1(cur)
  writeTile(cur, tile)
}

/**
 * CODE_0DE95F (bank_0D.asm line 7626) -- single-tile extended handler for the
 * eight cave-trim corner/edge types $57..$5E. Dispatched from the extended
 * table at lines 1149..1156 (eight consecutive entries, one per type).
 *
 * ASM:
 *   LDY LevelLoadPos ; LDA LvlLoadObjSize ; SEC ; SBC #$57 ; TAX
 *   JSR StzTo6ePointer                            ; page 0
 *   LDA.L DATA_0DE957,X ; STA [Map16LowPtr],Y    ; single tile write
 *
 * DATA_0DE957 = $73, $74, $75, $76, $93, $94, $95, $96  (cave corners / cap row)
 *
 * Index = (extType - $57). We resolve both the base ($57 immediate at +6) and
 * the table address (LDA.L operand at +12) from handler bytecode so Lunar Magic
 * relocations still work.
 */
export function handle_0DE95F(cur: Cursor): void {
  const extType = cur.objNo
  const baseType = readImmByte(cur, cur.handlerAddr + 6)
  const idx = extType - baseType
  if (idx < 0 || idx >= 8) return
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 12)
  const tile = cur.rom.readByte(tableAddr + idx) ?? 0
  setPage0(cur)
  writeTile(cur, tile)
}

/**
 * CODE_0DE9ED (bank_0D.asm line 7697) -- 2×2 tile block from DATA_0DE9E1,
 * dispatched for extended types $64 and $65 (cave-exit opening / capped arch).
 *
 * DATA_0DE9E1 = $8C,$8D,$25,$8E,$90,$91,$8F,$25,$FC,$FD,$FE,$FF
 *
 * Entry table index:  X = (extType - $64) * 4
 *   ext=$64: X=0  → tiles [$8C,$8D] row 0, [$25,$8E] row 1
 *   ext=$65: X=4  → tiles [$90,$91] row 0, [$8F,$25] row 1
 *
 * ASM structure (CODE_0DE9F5):
 *   _1 = _0 = 1; save bookmark.
 *   Inner loop (BPL, 2 iters): page-0 write + advance col; INX; DEC _0; BPL.
 *   After inner: restore bookmark; row++; reset _0=1; DEC _1; BPL (back to inner).
 *   Outer runs 2 times (_1=1→0→-1), so 2 rows × 2 cols = 4 writes total.
 *
 * Bytecode offsets (verified against ROM at $0DE9ED):
 *   +4   LDA.B #$64  SBC immediate (base ext type)
 *   +23  LDA.L DATA_0DE9E1,X operand (3-byte table address)
 */
export function handle_0DE9ED(cur: Cursor): void {
  const extType = cur.objNo
  const base = readImmByte(cur, cur.handlerAddr + 4)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 23)
  const X = (extType - base) * 4
  if (X < 0 || X + 3 >= 256) return // safety: only ext=$64,$65 are valid

  const col0 = cur.col,
    row0 = cur.row
  for (let row = 0; row < 2; row++) {
    cur.col = col0
    cur.row = row0 + row
    setPage0(cur)
    writeTile(cur, cur.rom.readByte(tableAddr + X + row * 2 + 0) ?? 0)
    advanceCol(cur)
    setPage0(cur)
    writeTile(cur, cur.rom.readByte(tableAddr + X + row * 2 + 1) ?? 0)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DDA57 (bank_0D.asm line 6378) -- single coin/reveal tile (ext $60).
 * Writes one page-1 tile $FE at the current position. Used as a standalone
 * one-tile marker; no column or row advance.
 */
export function handle_0DDA57(cur: Cursor): void {
  setPage1(cur)
  writeTile(cur, 0xfe)
}

/**
 * ADDR_0DE971 (bank_0D.asm line 7637) -- cave background fill (ext $5F).
 *
 * Writes page-0 tile $77 over 4 x 256 consecutive Map16 bytes from
 * Map16LowPtr with Y = 0, so LevelLoadPos is ignored (bank_0D.asm:7640-7652).
 * The pointer is the object's screen base from the LoadBlkPtrs tables, plus
 * $100 when the high-coordinate bit is set (bank_05.asm:730-782).
 *
 * Per-mode screen strides ($1B0 horizontal, $200 vertical) and the L1/L2 table
 * sets are traced in docs/architecture/screens.md (SMWDisX bank_00.asm:6999-7065).
 * A vertical screen is the left $100 bytes (cols 0-15) then the right $100
 * (cols 16-31), 16 rows each.
 *
 * Evidence scope: SMWDisX trace; the horizontal layout is also checked by the
 * L1 differential on the vanilla corpus; vertical: SMWDisX trace only, no
 * capture or differential.
 *
 * Not modelled: (1) vertical modes 3/4 at screen 14+, where the ROM table
 * jumps to $1B00 (DATA_00BB62) instead of 14 * $200; (2) a run that leaves the
 * grid: the ROM keeps writing into whatever follows in WRAM (near the end of a
 * 16-screen horizontal level, into the L2 buffer), the port clips at the
 * declared width (the narrowest row, so rows an earlier object grew do not
 * change the clip) or, vertically, at the last row.
 */
export function handle_0DE971(cur: Cursor): void {
  const RUN = 0x400
  const { grid, vertical } = cur
  const width = vertical ? 32 : Math.min(...grid.map(r => r.length))
  let offset: number
  if (vertical) {
    offset = (cur.row >> 4) * 0x200 + (cur.col >> 4) * 0x100
  } else {
    offset = (cur.col >> 4) * MAP16_BYTES_PER_SCREEN_H + (cur.row >> 4) * 0x100
  }
  const col0 = cur.col
  const row0 = cur.row
  setPage0(cur)
  for (let i = 0; i < RUN; i++, offset++) {
    let r: number
    let c: number
    if (vertical) {
      r = (offset >> 9) * 16 + ((offset >> 4) & 15)
      c = ((offset >> 8) & 1) * 16 + (offset & 15)
    } else {
      const screen = Math.floor(offset / MAP16_BYTES_PER_SCREEN_H)
      const within = offset - screen * MAP16_BYTES_PER_SCREEN_H
      r = within >> 4
      c = screen * 16 + (within & 15)
    }
    if (r >= grid.length || c >= width) continue
    cur.row = r
    cur.col = c
    writeTile(cur, 0x77)
  }
  cur.col = col0
  cur.row = row0
}

/**
 * CODE_0DE9AA (bank_0D.asm line 7662) -- 3×3 tile block (ext $61..$63).
 *
 * Index into DATA_0DE98F: X = (objNo − $61) × 9.
 * Reads 9 tiles row-major (3 per row), page 0.
 *
 * ASM: saveBookmark; inner BPL loop (_0=2, 3 iters); restoreBookmark+advanceRowRaw;
 * outer BPL (_1=2, 3 rows).
 *
 * DATA_0DE98F operand at handler+29.
 */
export function handle_0DE9AA(cur: Cursor): void {
  const xi = (cur.objNo - 0x61) * 9
  const addr = readLongOperand(cur, cur.handlerAddr + 29)
  saveBookmark(cur)
  let x = xi
  for (let row = 0; row < 3; row++) {
    setPage0(cur)
    for (let col = 0; col < 3; col++) {
      writeTileAdvance(cur, cur.rom.readByte(addr + x++) ?? 0)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * ADDR_0DEA3E (bank_0D.asm line 7731) -- 4×4 tile block (ext $66..$67).
 *
 * Index into DATA_0DEA1E: X = (objNo − $66) × 16.
 * Reads 16 tiles row-major (4 per row), page 0.
 *
 * DATA_0DEA1E operand at handler+25.
 */
export function handle_0DEA3E(cur: Cursor): void {
  const xi = (cur.objNo - 0x66) * 16
  const addr = readLongOperand(cur, cur.handlerAddr + 25)
  saveBookmark(cur)
  let x = xi
  for (let row = 0; row < 4; row++) {
    setPage0(cur)
    for (let col = 0; col < 4; col++) {
      writeTileAdvance(cur, cur.rom.readByte(addr + x++) ?? 0)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DE0AE (bank_0D.asm line 7260) -- 6-row waterfall/cascade tile column
 * (ext $71..$74). Per-variant offset from DATA_0DE0AA; tile data from DATA_0DE05E.
 *
 * Row 0: 4 tiles, page 1.
 * Rows 1–3: 3 tiles each, page 0 (3 middle rows).
 * Row 4: 3 tiles page 0 + hardcoded tile $5F page 1.
 * Row 5: 3 tiles, page 0.
 *
 * DATA_0DE0AA operand at handler+9; DATA_0DE05E operand at handler+28.
 */
export function handle_0DE0AE(cur: Cursor): void {
  const addrIdx = readLongOperand(cur, cur.handlerAddr + 9) // DATA_0DE0AA
  const addrData = readLongOperand(cur, cur.handlerAddr + 28) // DATA_0DE05E
  let xi = cur.rom.readByte(addrIdx + (cur.objNo - 0x71)) ?? 0
  saveBookmark(cur)
  // Row 0: 4 tiles, page 1
  setPage1(cur)
  for (let c = 0; c < 4; c++) {
    writeTileAdvance(cur, cur.rom.readByte(addrData + xi++) ?? 0)
  }
  restoreBookmark(cur)
  advanceRowRaw(cur)
  // Rows 1–3: 3 tiles each, page 0
  for (let r = 0; r < 3; r++) {
    setPage0(cur)
    for (let c = 0; c < 3; c++) {
      writeTileAdvance(cur, cur.rom.readByte(addrData + xi++) ?? 0)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
  // Row 4: 3 tiles page 0 + tile $5F page 1
  setPage0(cur)
  for (let c = 0; c < 3; c++) {
    writeTileAdvance(cur, cur.rom.readByte(addrData + xi++) ?? 0)
  }
  setPage1(cur)
  writeTile(cur, 0x5f)
  restoreBookmark(cur)
  advanceRowRaw(cur)
  // Row 5: 3 tiles, page 0
  setPage0(cur)
  for (let c = 0; c < 3; c++) {
    writeTileAdvance(cur, cur.rom.readByte(addrData + xi++) ?? 0)
  }
}

/**
 * CODE_0DDA68 (bank_0D.asm line 6389) -- single page-0 tile (ext $75..$7B).
 *
 * X = objNo − $75; tile from DATA_0DDA61[X] = {$7D..$83}.
 * DATA_0DDA61 operand at handler+12.
 */
export function handle_0DDA68(cur: Cursor): void {
  const X = cur.objNo - 0x75
  const addr = readLongOperand(cur, cur.handlerAddr + 12)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addr + X) ?? 0)
}

/**
 * CODE_0DDA80 (bank_0D.asm line 6407) -- 2-tile vertical page-0 strip (ext $7C..$7E).
 *
 * X = objNo − $7C; top from DATA_0DDA7A[X], bottom from DATA_0DDA7D[X].
 * DATA_0DDA7A operand at handler+12; DATA_0DDA7D operand at handler+24.
 */
export function handle_0DDA80(cur: Cursor): void {
  const X = cur.objNo - 0x7c
  const addr1 = readLongOperand(cur, cur.handlerAddr + 12)
  const addr2 = readLongOperand(cur, cur.handlerAddr + 24)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addr1 + X) ?? 0)
  advanceRowRaw(cur)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addr2 + X) ?? 0)
}

/**
 * CODE_0DEB6A (bank_0D.asm line 7756) -- fixed 14×10 page-0 tile grid (ext $80).
 *
 * Reads DATA_0DEADE (140 bytes) in row-major order: 9 writeTileAdvance + 1
 * writeTile per row, 14 rows. No per-type offset; always starts at index 0.
 *
 * DATA_0DEADE operand at handler+12.
 */
export function handle_0DEB6A(cur: Cursor): void {
  const col0 = cur.col
  const addr = readLongOperand(cur, cur.handlerAddr + 12)
  let X = 0
  for (let row = 0; row < 14; row++) {
    cur.col = col0
    setPage0(cur)
    for (let col = 0; col < 9; col++) {
      writeTileAdvance(cur, cur.rom.readByte(addr + X++) ?? 0)
    }
    writeTile(cur, cur.rom.readByte(addr + X++) ?? 0)
    advanceRowRaw(cur)
  }
}

/**
 * ADDR_0DEC68 (bank_0D.asm line 7882) -- 2-tile vertical page-0 strip (ext $81).
 *
 * Data source: ADDR_0DEC66 is a CMP.B #$CA instruction ($C9,$CA), whose two
 * bytes are read as tile values for consecutive rows.
 * ADDR_0DEC66 operand at handler+8.
 */
export function handle_0DEC68(cur: Cursor): void {
  const addr = readLongOperand(cur, cur.handlerAddr + 8)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addr + 0) ?? 0)
  advanceRowRaw(cur)
  setPage0(cur)
  writeTile(cur, cur.rom.readByte(addr + 1) ?? 0)
  advanceRowRaw(cur)
}

/**
 * CODE_0DC2E9 (bank_0D.asm line 4797) -- 14×9 page-0 grid with transparency
 * (ext $84). Tile $25 (TILE_EMPTY) in DATA_0DC26B is transparent: no write,
 * but column still advances (CODE_0DA95D = advanceCol).
 * The 9th tile per row is always written.
 *
 * DATA_0DC26B operand at handler+12.
 */
export function handle_0DC2E9(cur: Cursor): void {
  const col0 = cur.col
  const addr = readLongOperand(cur, cur.handlerAddr + 12)
  let X = 0
  for (let row = 0; row < 14; row++) {
    cur.col = col0
    setPage0(cur)
    for (let col = 0; col < 8; col++) {
      const tile = cur.rom.readByte(addr + X++) ?? 0
      if (tile !== 0x25) writeTile(cur, tile)
      advanceCol(cur)
    }
    writeTile(cur, cur.rom.readByte(addr + X++) ?? 0)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DECC1 (bank_0D.asm line 7939) -- 2×2 tile block via CODE_0DE9F5 (ext $8F).
 *
 * LDX #8; JMP CODE_0DE9F5 - enters handle_0DE9ED at CODE_0DE9F5 with X=8,
 * reading DATA_0DE9E1[8..11] = [$FC,$FD,$FE,$FF] as a 2×2 grid, page 0.
 *
 * JMP target lo/hi at handler+3/+4; DATA_0DE9E1 operand at target+15.
 */
export function handle_0DECC1(cur: Cursor): void {
  const jmpLo = cur.rom.readByte(cur.handlerAddr + 3) ?? 0
  const jmpHi = cur.rom.readByte(cur.handlerAddr + 4) ?? 0
  const jmpTarget = 0x0d0000 | (jmpHi << 8) | jmpLo
  const addr = readLongOperand(cur, jmpTarget + 15)
  saveBookmark(cur)
  let xi = 8
  for (let row = 0; row < 2; row++) {
    setPage0(cur)
    for (let col = 0; col < 2; col++) {
      writeTileAdvance(cur, cur.rom.readByte(addr + xi++) ?? 0)
    }
    restoreBookmark(cur)
    advanceRowRaw(cur)
  }
}

/**
 * CODE_0DA80D (bank_0D.asm line 1808) -- 2-tile vertical page-1 strip (ext $91..$92).
 *
 * X = objNo − $91; top from DATA_0DA809[X], bottom from DATA_0DA80B[X].
 * DATA_0DA809 operand at handler+11; DATA_0DA80B operand at handler+23.
 */
export function handle_0DA80D(cur: Cursor): void {
  const X = cur.objNo - 0x91
  const addr1 = readLongOperand(cur, cur.handlerAddr + 11)
  const addr2 = readLongOperand(cur, cur.handlerAddr + 23)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr1 + X) ?? 0)
  advanceRowRaw(cur)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr2 + X) ?? 0)
}

/**
 * CODE_0DA846 (bank_0D.asm line 1850) -- 2×2 page-1 tile block (ext $93..$94).
 *
 * X = objNo − $93; four data tables: DATA_0DA83E/40/42/44[X].
 * Row 0: writeTileAdvance(table1[X]) + writeTile(table2[X]), page 1.
 * Row 1: writeTileAdvance(table3[X]) + writeTile(table4[X]), page 1.
 * Operands at handler+11/21/33/43.
 */
export function handle_0DA846(cur: Cursor): void {
  const col0 = cur.col
  const X = cur.objNo - 0x93
  const addr1 = readLongOperand(cur, cur.handlerAddr + 11)
  const addr2 = readLongOperand(cur, cur.handlerAddr + 21)
  const addr3 = readLongOperand(cur, cur.handlerAddr + 33)
  const addr4 = readLongOperand(cur, cur.handlerAddr + 43)
  setPage1(cur)
  writeTileAdvance(cur, cur.rom.readByte(addr1 + X) ?? 0)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr2 + X) ?? 0)
  advanceRowRaw(cur)
  cur.col = col0
  setPage1(cur)
  writeTileAdvance(cur, cur.rom.readByte(addr3 + X) ?? 0)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr4 + X) ?? 0)
}

/**
 * CODE_0DA87D (bank_0D.asm line 1881) -- 3-tile vertical page-1 strip (ext $95..$96).
 *
 * X = objNo − $95; tiles from DATA_0DA877[X], DATA_0DA879[X], DATA_0DA87B[X].
 * Operands at handler+11/23/35.
 */
export function handle_0DA87D(cur: Cursor): void {
  const X = cur.objNo - 0x95
  const addr1 = readLongOperand(cur, cur.handlerAddr + 11)
  const addr2 = readLongOperand(cur, cur.handlerAddr + 23)
  const addr3 = readLongOperand(cur, cur.handlerAddr + 35)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr1 + X) ?? 0)
  advanceRowRaw(cur)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr2 + X) ?? 0)
  advanceRowRaw(cur)
  setPage1(cur)
  writeTile(cur, cur.rom.readByte(addr3 + X) ?? 0)
}
