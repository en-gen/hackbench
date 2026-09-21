/**
 * setup.ts - port of the cmd setup routines in bank_05.
 *
 * The scroll-sprite spawn (`bank_02.asm:5290+`) writes the original
 * `Layer1ScrollCmd` (= spriteId - $E7) and `Layer1ScrollBits` (= b0 >> 2),
 * then `JSL CODE_05BCD6`. CODE_05BCD6 dispatches L1 setup (CODE_05BCE9) →
 * per-cmd routine indexed by the ORIGINAL `Layer1ScrollCmd`, then L2 setup
 * (CODE_05BD0E) → per-cmd routine indexed by `Layer2ScrollCmd` AFTER the
 * L1 routine remapped it.
 *
 * `simulateScrollSetup` (`scrollDispatch.ts`) already runs the cmd-byte
 * remap, so this file consumes the post-remap `(l1cmd, l2cmd, l1bits,
 * l2bits)` and runs the per-cmd SETUP BODY (the part after the remap)
 * with the right `ScrollLayerIndex` (0 for L1, 4 for L2).
 *
 * Per-layer dispatch detail (bank_05.asm:4567-4604):
 *
 *   - L1 dispatch (`CODE_05BCE9`) keys on the ORIGINAL Layer1ScrollCmd.
 *     Different originals can produce the same post-remap pair. We
 *     dispatch on the post-remap `(l1cmd, l2cmd)` pair instead - every
 *     cmd-$00..$0E original produces a unique post-remap pair, so the
 *     mapping is invertible. The actual setup body is identified by
 *     this pair.
 *
 *   - L2 dispatch (`CODE_05BD0E`) has `BEQ Return05BD35` when
 *     `Layer2ScrollCmd == 0` - the entire L2 setup is skipped. This is
 *     why levels with sprite $E8 b0=$0C ($00C) keep `l2type=0` and
 *     `l2timer=0` after setup despite L1 setup running.
 *
 * 16-bit STA side effects (key invariant):
 *
 *   The cmd $08/$03 setup bodies write `STA.W Layer1ScrollType,X` with
 *   A in 16-bit mode. WRAM layout is consecutive:
 *     $1442 Layer1ScrollType / $1443 Layer2ScrollType
 *     $1444 Layer1ScrollTimer / $1445 Layer2ScrollTimer
 *
 *   At X=0 (L1 setup): writes $1442+$1443 → l1type, l2type
 *   At X=1 (L2 setup, X = ScrollLayerIndex>>2): writes $1443+$1444 →
 *     l2type AND l1timer (overwrites L1's $FF). The high byte of the
 *     16-bit A determines whether l1timer ends up $01 (cmd $08, type
 *     word $0101) or $00 (cmd $03, type word $0001).
 *
 *   For cmd $00/$01 setup, A is in 8-bit mode (`SEP #$20` precedes the
 *   STA), so type/timer writes are 8-bit and have NO inter-layer side
 *   effect - `l1timer` stays at the value the L1 setup wrote.
 */

import {
  ADDR_DATA_05CA46,
  ADDR_DATA_05CA5C,
  ADDR_DATA_05CA61,
  ADDR_DATA_05CA68,
  ADDR_DATA_05CBED,
  ADDR_DATA_05CBF5,
  ADDR_DATA_05C808,
  ADDR_DATA_05C80B,
  readByte,
  readWord,
} from '../scrollData'
import { applyCmd02Setup } from './cmd02'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap8, wrap16 } from '../scrollSim'

// ── Cmd $00/$01 setup body (CODE_05BD4C) ────────────────────────────────
//
// Per-layer 8-bit type/timer write. No 16-bit STA side effect.

function applyCmd0001L1Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer1ScrollBits
  return {
    ...s,
    layer1ScrollType: wrap8(readByte(rom, ADDR_DATA_05CA61, bits)),
    layer1ScrollTimer: wrap8(readByte(rom, ADDR_DATA_05CA68, bits)),
    layer1ScrollXSpeed: 0,
    layer1ScrollYSpeed: 0,
    layer1ScrollXPosUpd: 0,
    layer1ScrollYPosUpd: 0,
  }
}

function applyCmd0001L2Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer2ScrollBits
  return {
    ...s,
    layer2ScrollType: wrap8(readByte(rom, ADDR_DATA_05CA61, bits)),
    layer2ScrollTimer: wrap8(readByte(rom, ADDR_DATA_05CA68, bits)),
    layer2ScrollXSpeed: 0,
    layer2ScrollYSpeed: 0,
    layer2ScrollXPosUpd: 0,
    layer2ScrollYPosUpd: 0,
  }
}

// ── Cmd $08 prelude (CODE_05BEA6) ──────────────────────────────────────
//
// Clears HorizLayer1Setting (we don't track), Layer1XPos, NextLayer1XPos,
// Layer2XPos, NextLayer2XPos. The cmd-byte remap done here is already
// applied upstream by simulateScrollSetup.

function applyCmd08Prelude(s: ScrollState): ScrollState {
  return {
    ...s,
    layer1XPos: 0,
    nextLayer1XPos: 0,
    layer2XPos: 0,
    nextLayer2XPos: 0,
  }
}

// ── Cmd $08 setup body (CODE_05BEC6) ────────────────────────────────────
//
// 16-bit type word from DATA_05CA46, written to consecutive WRAM bytes.
// 16-bit XPosUpd accumulator initialized from the step + NextL{N}XPos.

function applyCmd08L1Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer1ScrollBits
  // Type WORD - written 16-bit at X=0: low → l1type, high → l2type.
  const typeWord = readWord(rom, ADDR_DATA_05CA46, bits)
  // Step low byte. CPX #$01 (X = type-low after TAX) - for type=1 keep
  // positive, otherwise negate (16-bit two's complement).
  const stepWord = readWord(rom, ADDR_DATA_05CBED, bits * 2)
  let step = stepWord & 0x00ff
  const typeLowFromTax = typeWord & 0xff
  if (typeLowFromTax !== 0x01) {
    step = wrap16((step ^ 0xffff) + 1)
  }
  // ADC NextLayer1XPos,X with X=0 → reads NextLayer1XPos (16-bit).
  const sum = wrap16(step + s.nextLayer1XPos) & 0x00ff
  return {
    ...s,
    layer1ScrollType: typeWord & 0xff,
    layer2ScrollType: (typeWord >> 8) & 0xff,
    layer1ScrollYPosUpd: sum,
    layer1ScrollXPosUpd: 0,
    // CODE_05BDC9: clear speeds.
    layer1ScrollXSpeed: 0,
    layer1ScrollYSpeed: 0,
    // CODE_05BDCF: 8-bit STA timer at X=0 → l1timer = $FF.
    layer1ScrollTimer: 0xff,
  }
}

function applyCmd08L2Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer2ScrollBits
  // Type WORD - written 16-bit at X=1 (= ScrollLayerIndex>>2): low →
  // l2type, high → l1timer (the famous side effect overwriting the
  // $FF that L1 setup wrote).
  const typeWord = readWord(rom, ADDR_DATA_05CA46, bits)
  const stepWord = readWord(rom, ADDR_DATA_05CBED, bits * 2)
  let step = stepWord & 0x00ff
  const typeLowFromTax = typeWord & 0xff
  if (typeLowFromTax !== 0x01) {
    step = wrap16((step ^ 0xffff) + 1)
  }
  // ADC NextLayer1XPos,X with X=4 → reads NextLayer2XPos.
  const sum = wrap16(step + s.nextLayer2XPos) & 0x00ff
  return {
    ...s,
    layer2ScrollType: typeWord & 0xff,
    layer1ScrollTimer: (typeWord >> 8) & 0xff, // ← side effect
    layer2ScrollYPosUpd: sum,
    layer2ScrollXPosUpd: 0,
    layer2ScrollXSpeed: 0,
    layer2ScrollYSpeed: 0,
    layer2ScrollTimer: 0xff,
  }
}

// ── Cmd $03 prelude (CODE_05BF0A) ──────────────────────────────────────
//
// Clears VertLayer2Setting. (The cmd/bits remap is done upstream.)

function applyCmd03Prelude(s: ScrollState): ScrollState {
  return { ...s, vertLayer2Setting: 0 }
}

// ── Cmd $03 setup body (CODE_05BF20) ────────────────────────────────────
//
// Symmetric to cmd $08 but writes XPosUpd (instead of YPosUpd) using
// step + NextLayer1YPos (instead of NextLayer1XPos), and clears YSpeed
// (instead of falling into CODE_05BDC9 to clear both speeds).

function applyCmd03L1Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer1ScrollBits
  const typeWord = readWord(rom, ADDR_DATA_05CA5C, bits)
  const stepWord = readWord(rom, ADDR_DATA_05CBF5, bits * 2)
  let step = stepWord & 0x00ff
  const typeLowFromTax = typeWord & 0xff
  if (typeLowFromTax !== 0x01) {
    step = wrap16((step ^ 0xffff) + 1)
  }
  // ADC NextLayer1YPos,X with X=0.
  const sum = wrap16(step + s.nextLayer1YPos) & 0x00ff
  return {
    ...s,
    layer1ScrollType: typeWord & 0xff,
    layer2ScrollType: (typeWord >> 8) & 0xff,
    layer1ScrollXPosUpd: sum,
    layer1ScrollYPosUpd: 0,
    layer1ScrollYSpeed: 0,
    // JMP CODE_05BDCF: 8-bit STA timer,X=0 → l1timer = $FF.
    layer1ScrollTimer: 0xff,
  }
}

function applyCmd03L2Body(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer2ScrollBits
  const typeWord = readWord(rom, ADDR_DATA_05CA5C, bits)
  const stepWord = readWord(rom, ADDR_DATA_05CBF5, bits * 2)
  let step = stepWord & 0x00ff
  const typeLowFromTax = typeWord & 0xff
  if (typeLowFromTax !== 0x01) {
    step = wrap16((step ^ 0xffff) + 1)
  }
  // ADC NextLayer1YPos,X with X=4 → reads NextLayer2YPos.
  const sum = wrap16(step + s.nextLayer2YPos) & 0x00ff
  return {
    ...s,
    layer2ScrollType: typeWord & 0xff,
    layer1ScrollTimer: (typeWord >> 8) & 0xff, // ← side effect
    layer2ScrollXPosUpd: sum,
    layer2ScrollYPosUpd: 0,
    layer2ScrollYSpeed: 0,
    layer2ScrollTimer: 0xff,
  }
}

/**
 * Cmd $0E setup body - CODE_05C036 (bank_05.asm:4990-4998). Reads
 * DATA_05C808 / DATA_05C80B indexed by `Layer1ScrollBits` (post-remap
 * value, preserved by the 16-bit `STA.W Layer1ScrollCmd` not touching
 * $1440). Falls through to CODE_05BFD5 which clears Layer1ScrollType +
 * speed/posupd accumulators (already 0 in the initial state).
 */
function applyCmd0eSetup(s: ScrollState, rom: RomFile): ScrollState {
  const bits = s.layer1ScrollBits
  return {
    ...s,
    layer1ScrollTimer: wrap8(readByte(rom, ADDR_DATA_05C808, bits)),
    layer2ScrollTimer: wrap8(readByte(rom, ADDR_DATA_05C80B, bits)),
  }
}

// ── Top-level dispatcher ────────────────────────────────────────────────

/**
 * Run the full per-layer setup. L1 dispatches on the post-remap
 * `(layer1ScrollCmd, layer2ScrollCmd)` pair (since each unique pair
 * comes from a unique original cmd). L2 dispatches on `layer2ScrollCmd`
 * with the BEQ early-return for `l2cmd == 0`.
 *
 * Currently handles cmds $00, $01, $03, $08. Other cmds pass through
 * unchanged - the simulator's `cmdHold` fallback will surface a console
 * warning if those levels' per-frame dispatch hits an unported cmd.
 */
export function applyCmdSetup(s: ScrollState, rom: RomFile): ScrollState {
  let cur = s

  // ── L1 dispatch ──
  const l1cmd = cur.layer1ScrollCmd
  const l2cmd = cur.layer2ScrollCmd
  if (l1cmd === 0x01 || (l1cmd === 0x00 && l2cmd === 0x00)) {
    cur = applyCmd0001L1Body(cur, rom)
  } else if (l1cmd === 0x00 && l2cmd === 0x08) {
    cur = applyCmd08Prelude(cur)
    cur = applyCmd08L1Body(cur, rom)
  } else if (l1cmd === 0x00 && l2cmd === 0x03) {
    cur = applyCmd03Prelude(cur)
    cur = applyCmd03L1Body(cur, rom)
  } else if (l1cmd === 0x00 && l2cmd === 0x02) {
    cur = applyCmd02Setup(cur, rom)
  } else if (l1cmd === 0x00 && l2cmd === 0x0e) {
    cur = applyCmd0eSetup(cur, rom)
  }

  // ── L2 dispatch ── (BEQ Return05BD35 when l2cmd == 0)
  if (cur.layer2ScrollCmd === 0) return cur

  switch (cur.layer2ScrollCmd) {
    case 0x01:
      cur = applyCmd0001L2Body(cur, rom)
      break
    case 0x08:
      cur = applyCmd08L2Body(cur, rom)
      break
    case 0x03:
      cur = applyCmd03L2Body(cur, rom)
      break
    case 0x09:
      break
    default:
      break
  }

  return cur
}
