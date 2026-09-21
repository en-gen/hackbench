/**
 * Port of `bank_05.asm` scroll-sprite setup dispatch (CODE_05BCD6).
 *
 * When an L1 sprite stream emits a scroll sprite (id $E7..$F5), bank_02
 * stores `(spriteId - $E7)` in `Layer1ScrollCmd` and the upper 6 bits of
 * b0 in `Layer1ScrollBits`, then `JSL CODE_05BCD6`. CODE_05BCD6 calls L1
 * setup (CODE_05BCE9) then L2 setup (CODE_05BD0E). Each setup dispatch
 * runs a per-cmd routine that frequently does a 16-bit `STA Layer1ScrollCmd`
 * - which writes the cmd's low byte to `$143E` and the **high byte to
 * `$143F` (Layer2ScrollCmd)**. This is how `Layer2ScrollCmd` ends up
 * non-zero in gameplay.
 *
 * For the editor, we don't care about the timer/speed init the routines
 * perform - we only need the post-setup `{ l1Cmd, l2Cmd, l1Bits, l2Bits }`
 * so we can look up the right per-frame motion routine and its bounds
 * tables. This file ports just the cmd-byte-modifying parts.
 *
 * Source: bank_05.asm:4567-5037 (CODE_05BCD6 + the 15 dispatch routines).
 */

import type { RomFile } from './RomFile'

/** Index into the bank_05 L1 setup dispatch table at bank_05.asm:4583. */
type L1SetupCmd =
  | 0x00
  | 0x01
  | 0x02
  | 0x03
  | 0x04
  | 0x05
  | 0x06
  | 0x07
  | 0x08
  | 0x09
  | 0x0a
  | 0x0b
  | 0x0c
  | 0x0d
  | 0x0e

export interface ScrollSetupState {
  /** $7E:143E. Layer 1 scroll-cmd dispatch index for per-frame routine. */
  layer1ScrollCmd: number
  /** $7E:143F. Layer 2 scroll-cmd dispatch index for per-frame routine. */
  layer2ScrollCmd: number
  /** $7E:1440. */
  layer1ScrollBits: number
  /** $7E:1441. */
  layer2ScrollBits: number
}

// ── Per-cmd remap tables from bank_05.asm ────────────────────────────────────
// Each table holds 5 16-bit `(L1ScrollCmd-low, L2ScrollCmd-high)` pairs at
// even offsets, and matching `(L1ScrollBits, L2ScrollBits)` pairs in the
// adjacent table. Indexed by `Layer1ScrollBits * 2`.

const DATA_05C9D1 = 0x05c9d1 // cmd $00, $01 (CODE_05BD36) - Auto-Scroll cmd remap
const DATA_05C9DB = 0x05c9db //              - Auto-Scroll bits remap
const DATA_05CA08 = 0x05ca08 // cmd $04 (ADDR_05BDDD) - cmd remap
const DATA_05CA0C = 0x05ca0c //                       - bits remap
const DATA_05CA16 = 0x05ca16 // cmd $0A (ADDR_05BE3A) - cmd remap
const DATA_05CA1E = 0x05ca1e //                       - bits remap
const DATA_05CA3E = 0x05ca3e // cmd $08 (CODE_05BEA6) - Layer 2 Scroll cmd remap
const DATA_05CA42 = 0x05ca42 //                       - bits remap
const DATA_05CA48 = 0x05ca48 // cmd $03 (CODE_05BF0A) - Layer 2 Scroll cmd remap
const DATA_05CA52 = 0x05ca52 //                       - bits remap

/**
 * Read a 16-bit LE word from ROM at `snesAddr`. Returns 0 on read failure
 * (matches the game's behavior - those addresses are valid ROM in vanilla).
 */
function readWord(rom: RomFile, snesAddr: number): number {
  const lo = rom.readByte(snesAddr) ?? 0
  const hi = rom.readByte(snesAddr + 1) ?? 0
  return (hi << 8) | lo
}

/**
 * Apply a 16-bit STA pattern: `STA Layer1ScrollCmd` writes A's low byte
 * to `$143E` (Layer1ScrollCmd) and A's high byte to `$143F` (Layer2ScrollCmd).
 * Mirrors the `STA.W Layer1ScrollCmd` 16-bit write that every L1 setup
 * routine eventually performs.
 */
function writeCmdPair(state: ScrollSetupState, word: number): void {
  state.layer1ScrollCmd = word & 0xff
  state.layer2ScrollCmd = (word >> 8) & 0xff
}

/**
 * Apply a 16-bit STA pattern: `STA Layer1ScrollBits` writes A's low byte
 * to `$1440` and high byte to `$1441` (Layer2ScrollBits).
 */
function writeBitsPair(state: ScrollSetupState, word: number): void {
  state.layer1ScrollBits = word & 0xff
  state.layer2ScrollBits = (word >> 8) & 0xff
}

/**
 * Apply the table-driven cmd/bits remap shared by cmds $00/$01/$03/$04/$08/$0A.
 * Each routine reads `Layer1ScrollBits * 2` as a 16-bit index into two adjacent
 * 16-bit tables and stores the results via 16-bit STA at Layer1ScrollCmd /
 * Layer1ScrollBits.
 */
function applyTableRemap(
  rom: RomFile,
  state: ScrollSetupState,
  cmdTable: number,
  bitsTable: number,
): void {
  const idx = (state.layer1ScrollBits * 2) & 0xff
  writeCmdPair(state, readWord(rom, cmdTable + idx))
  writeBitsPair(state, readWord(rom, bitsTable + idx))
}

/**
 * Run the L1 setup dispatch (`CODE_05BCE9` at bank_05.asm:4579) for a given
 * starting `Layer1ScrollCmd`. Mutates `state` to the post-setup values.
 *
 * The L2 setup pass (`CODE_05BD0E` at line 4599) doesn't write the cmd
 * bytes itself - it just runs the per-axis init for whatever cmd L1 setup
 * left in `Layer2ScrollCmd`. So the post-L1-setup state IS the post-
 * L2-setup state for our purposes.
 */
function runL1Setup(rom: RomFile, state: ScrollSetupState): void {
  const cmd = state.layer1ScrollCmd as L1SetupCmd
  switch (cmd) {
    case 0x00:
    case 0x01:
      // CODE_05BD36 (bank_05.asm:4623). Auto-Scroll.
      applyTableRemap(rom, state, DATA_05C9D1, DATA_05C9DB)
      return
    case 0x02:
      // CODE_05BF6A (bank_05.asm:4890) → JSR CODE_05BFD2 with A=$0200.
      // Note: CODE_05BF6A also writes its own bits via DATA_05C94F/52
      // BEFORE the JSR - we capture those too.
      applyBitsOnly(rom, state, 0x05c94f, 0x05c952)
      writeCmdPair(state, 0x0200)
      return
    case 0x03:
      // CODE_05BF0A (bank_05.asm:4846).
      applyTableRemap(rom, state, DATA_05CA48, DATA_05CA52)
      return
    case 0x04:
      // ADDR_05BDDD (bank_05.asm:4701).
      applyTableRemap(rom, state, DATA_05CA08, DATA_05CA0C)
      return
    case 0x05:
      // ADDR_05BFBA (bank_05.asm:4926). STZ Layer1ScrollBits, then JSR
      // CODE_05BFD2 with A=$0005 → L1Cmd=$05, L2Cmd=$00.
      state.layer1ScrollBits = 0
      state.layer2ScrollBits = 0
      writeCmdPair(state, 0x0005)
      return
    case 0x06:
      // ADDR_05BF97 (bank_05.asm:4910). LDA #$0600 → L1Cmd=$00, L2Cmd=$06.
      // Also: `LDA #$60 / STA Layer2ScrollBits` (8-bit) at bank_05.asm:4922.
      writeCmdPair(state, 0x0600)
      state.layer2ScrollBits = 0x60
      return
    case 0x07:
      // Return05BD35 (bank_05.asm:4620). No-op - leave state unchanged.
      return
    case 0x08:
      // CODE_05BEA6 (bank_05.asm:4800).
      applyTableRemap(rom, state, DATA_05CA3E, DATA_05CA42)
      return
    case 0x09:
      // Return05BC49 (bank_05.asm:4488). No-op.
      return
    case 0x0a:
      // ADDR_05BE3A (bank_05.asm:4747).
      applyTableRemap(rom, state, DATA_05CA16, DATA_05CA1E)
      return
    case 0x0b:
      // CODE_05BFF6 (bank_05.asm:4953). LDA #$0B00 → L1Cmd=$00, L2Cmd=$0B.
      writeCmdPair(state, 0x0b00)
      return
    case 0x0c:
      // CODE_05C005 (bank_05.asm:4965). DATA_05BFFD-driven bits + LDA #$000C.
      applyBitsOnly(rom, state, 0x05bffd, 0x05bffd + 4)
      writeCmdPair(state, 0x000c)
      return
    case 0x0d:
      // CODE_05C01A (bank_05.asm:4976). LDA #$0D00 → L1Cmd=$00, L2Cmd=$0D.
      writeCmdPair(state, 0x0d00)
      return
    case 0x0e:
      // CODE_05C036 (bank_05.asm:4990). LDA #$0E00 → L1Cmd=$00, L2Cmd=$0E.
      writeCmdPair(state, 0x0e00)
      return
  }
}

/**
 * Helper for routines that remap bits without remapping the cmd byte
 * (cmd $02 reads DATA_05C94F/52; cmd $0C reads DATA_05BFFD).
 */
function applyBitsOnly(
  rom: RomFile,
  state: ScrollSetupState,
  l1Table: number,
  l2Table: number,
): void {
  const idx = (state.layer1ScrollBits * 2) & 0xff
  state.layer1ScrollBits = rom.readByte(l1Table + idx) ?? 0
  state.layer2ScrollBits = rom.readByte(l2Table + idx) ?? 0
}

/**
 * Simulate the post-setup state of the L1/L2 scroll cmd bytes for a level
 * given its sprite-spawn inputs. Mirrors `bank_02.asm:5290-5306` followed
 * by `JSL CODE_05BCD6`.
 *
 * `spriteId` must be in `[$E7..$F5]` (a valid scroll sprite). `b0` is the
 * sprite stream's first byte (NSyyyysy format) - the routine reads it as
 * `LSR; LSR` to get `Layer1ScrollBits`. Returns `null` for non-scroll
 * sprite ids.
 */
export function simulateScrollSetup(
  rom: RomFile,
  spriteId: number,
  b0: number,
): ScrollSetupState | null {
  if (spriteId < 0xe7) return null
  const state: ScrollSetupState = {
    // bank_02.asm:5295-5300: store (spriteId - $E7) in Layer1ScrollCmd.
    layer1ScrollCmd: spriteId - 0xe7,
    layer2ScrollCmd: 0,
    // bank_02.asm:5301-5305: shift b0 right by 2 → Layer1ScrollBits.
    layer1ScrollBits: (b0 >> 2) & 0x3f,
    layer2ScrollBits: 0,
  }
  runL1Setup(rom, state)
  return state
}
