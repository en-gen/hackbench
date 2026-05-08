/**
 * cmd02.ts — port of `CODE_05C955` / `CODE_05C95B` (bank_05.asm:6133-
 * 6192). Layer 2 Smash routine.
 *
 * Cmd $02 only appears as an L2 per-frame handler (the L1 dispatch
 * routes cmd $02 → `Return05BC49`, no-op). The setup body
 * (`CODE_05BF6A`) calls the same smash logic with a single iteration
 * (Y=1, X = post-remap-l1bits + $0A) at level entry; the per-frame
 * body uses Y=Layer2ScrollBits (=5 in vanilla) and X = post-remap-
 * l1bits.
 *
 * Algorithm (one frame):
 *
 *   1. **Zone-detection loop** (Y iterations). For each iteration,
 *      compare `NextLayer2XPos` against the pairwise smash-zone bounds
 *      `[DATA_05C880[X], DATA_05C8A4[X])` (16-bit reads). When the
 *      camera enters a zone:
 *
 *        - `Layer1ScrollType = (X >> 1) & $FE`
 *        - `NextLayer2YPos = $00C1`
 *        - `Layer1ScrollTimer = 0`
 *
 *      `INX; INX` after each iteration so the loop scans 5 (or 1)
 *      consecutive zones starting at the X seed.
 *
 *   2. **Timer dec/RTS** (post-loop). If `Layer1ScrollTimer != 0`
 *      after the loop, just `DEC` it and return — no smash this
 *      frame. Otherwise fall through.
 *
 *   3. **Smash math**. Compute `Y = l1type + l2type`. Read
 *      `DATA_05C8C8[Y]` (target Y) and `DATA_05C8FE[Y]` (Y EOR mask)
 *      as 16-bit words. Test `(NextLayer2YPos − target) XOR mask` for
 *      sign:
 *        - BPL (positive): set `NextLayer2YPos = target`,
 *          `Layer1ScrollTimer = DATA_05C934_NTSC[Y >> 1]`,
 *          and increment `Layer2ScrollType` by `$12` (clamped at $36
 *          to $00 with KAPOW SFX + ground-shake).
 *        - BMI (negative): set `Layer2ScrollYSpeed = mask`, then
 *          run `CODE_05C4F9` with X=$06 (L2 Y-axis speed-carry).
 *
 * The "KAPOW + screen shake" branch fires at the apex of the smash —
 * we don't model the SFX or screenshake (they're observable via
 * `Layer2ScrollType` reaching $36 → $00 transition).
 */

import {
  ADDR_DATA_05C880,
  ADDR_DATA_05C8A4,
  ADDR_DATA_05C8C8,
  ADDR_DATA_05C8FE,
  ADDR_DATA_05C934,
  readByte,
  readWord,
} from '../scrollData'
import { applyC4F9 } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16, wrap8 } from '../scrollSim'

function negI16(u16: number): number {
  return wrap16((u16 ^ 0xFFFF) + 1)
}

/**
 * Run the shared smash loop body (`CODE_05C95B`/`CODE_05C95D`) for
 * `iterations` rounds starting at `xSeed`. Mutates `Layer1ScrollType`,
 * `NextLayer2YPos`, and `Layer1ScrollTimer` whenever the camera enters
 * a smash zone. Returns the new state (loop output before post-loop).
 */
function runSmashLoop(s: ScrollState, rom: RomFile, xSeed: number, iterations: number): ScrollState {
  let cur = s
  let x = xSeed & 0xFF
  for (let i = 0; i < iterations; i++) {
    const lower = readWord(rom, ADDR_DATA_05C880, x)
    const upper = readWord(rom, ADDR_DATA_05C8A4, x)
    const npos = cur.nextLayer2XPos
    if (npos >= lower && npos < upper) {
      // Body: TXA / LSR A / AND #$00FE / STA Layer1ScrollType
      const newType = (x >>> 1) & 0xFE
      cur = {
        ...cur,
        layer1ScrollType: wrap8(newType),
        nextLayer2YPos:   0x00C1,
        layer1ScrollTimer: 0,
      }
    }
    x = (x + 2) & 0xFF
  }
  return cur
}

/**
 * Post-loop smash math. Called from per-frame handler after the loop.
 * If `l1timer` is non-zero, decrements and returns (no smash this
 * frame). Otherwise computes the smash apex / pull-down via the
 * Y-target / EOR-mask tables and either snaps `NextLayer2YPos` or
 * applies a Y-axis speed-carry via CODE_05C4F9.
 */
function applySmashPostLoop(s: ScrollState, rom: RomFile): ScrollState {
  // SEP #$20; LDA Layer1ScrollTimer; BEQ + (skip dec); DEC; RTS
  if (s.layer1ScrollTimer !== 0) {
    return { ...s, layer1ScrollTimer: wrap8(s.layer1ScrollTimer - 1) }
  }

  // LDA Layer1ScrollType; CLC; ADC Layer2ScrollType → Y
  const yIdx = (s.layer1ScrollType + s.layer2ScrollType) & 0xFF
  // LSR A; TAX (X = Y >> 1, byte-indexed timer table)
  const xIdx = (yIdx >> 1) & 0xFF

  // REP #$20; LDA NextLayer2YPos; SEC; SBC DATA_05C8C8,Y
  const target  = readWord(rom, ADDR_DATA_05C8C8, yIdx)
  const distRaw = wrap16(s.nextLayer2YPos - target)
  // EOR DATA_05C8FE,Y; BPL +
  const mask    = readWord(rom, ADDR_DATA_05C8FE, yIdx)
  const xored   = distRaw ^ mask

  if ((xored & 0x8000) === 0) {
    // BPL: Y-target reached → snap, reset timer, advance type. Plus
    // KAPOW + screenshake at the type==$36 boundary (we model the
    // type transition only).
    let newL2Type = (s.layer2ScrollType + 0x12) & 0xFF
    if (newL2Type >= 0x36) newL2Type = 0
    return {
      ...s,
      nextLayer2YPos:    target,
      layer1ScrollTimer: wrap8(readByte(rom, ADDR_DATA_05C934, xIdx)),
      layer2ScrollType:  newL2Type,
    }
  }

  // BMI: still smashing → set Y speed = mask, run C4F9 on L2 Y axis.
  const speed = mask
  const carried = applyC4F9({ ...s, layer2ScrollYSpeed: speed }, 'l2', 'y', speed)
  return carried
}

/**
 * cmd $02 setup body. Runs ONE smash-loop iteration starting at
 * `X = post-remap-l1bits + $0A`, then runs the post-loop smash math,
 * then forces `Layer2YPos = NextLayer2YPos` (CODE_05BF6A's tail).
 */
export function applyCmd02Setup(s: ScrollState, rom: RomFile): ScrollState {
  const xSeed = (s.layer1ScrollBits + 0x0A) & 0xFF
  let cur = runSmashLoop(s, rom, xSeed, 1)
  cur = applySmashPostLoop(cur, rom)
  // CODE_05BF6A tail: REP #$20; LDA NextLayer2YPos; STA Layer2YPos
  return { ...cur, layer2YPos: cur.nextLayer2YPos }
}

/**
 * cmd $02 per-frame handler. Runs `Y = l2bits` smash-loop iterations
 * starting at `X = post-remap-l1bits`, then post-loop smash math.
 *
 * **SpriteLock caveat**: the SNES `CODE_05BCA5` BEQs out the entire
 * L2 dispatch when `SpriteLock != 0` (level intro / item box / cape /
 * etc.). Our simulator doesn't model SpriteLock so this handler runs
 * every frame. Test captures should validate row 1 (post-setup) only,
 * or skip frames where SpriteLock was empirically set.
 */
export function cmd02L2(s: ScrollState, rom: RomFile): ScrollState {
  const xSeed = s.layer1ScrollBits & 0xFF
  const iterations = s.layer2ScrollBits & 0xFF
  let cur = runSmashLoop(s, rom, xSeed, iterations)
  cur = applySmashPostLoop(cur, rom)
  return cur
}

// Suppress unused-import warning for negI16 — kept for symmetry with
// other cmd handlers that use it.
void negI16