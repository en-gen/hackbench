/**
 * extendedHandlers.ts -- Ports of SMW bank_0D.asm extended-object handlers.
 *
 * Extended objects appear in the level stream when the 6-bit object number is
 * zero; the settings byte then selects one of 128 extended types via the
 * CODE_0DA106 dispatch table (bank_0D.asm line 1056).
 */

import { Cursor, writeTile, setPage0, setPage1, readLongOperand, readImmByte } from './cursor'

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
 * CODE_0DB583 (bank_0D.asm line 3726) -- on/off switch block, palette-1
 * variant (extended type $8e). Single tile: $6A page 1 when the switch is
 * on, $6B page 0 when off. For editor rendering we always show the
 * dormant $6B so level layout is visible regardless of switch state.
 *
 * Paired with CODE_0DB58B (ext type $8f, LDX #$00) which would mirror this
 * for a different switch flag; not yet encountered in the levels we've
 * inspected but can be added if the dispatch table points at it.
 */
export function handle_0DB583(cur: Cursor): void {
  // CODE_0DB583: LDX #$01 at +0 (X selects the pal-1 variant).
  // The dormant path (switch off) takes LDA.L DATA_0DB589,X at +21.
  // For editor rendering we always show the dormant tile.
  const X = readImmByte(cur, cur.handlerAddr + 1)
  const tableAddr = readLongOperand(cur, cur.handlerAddr + 21)
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
