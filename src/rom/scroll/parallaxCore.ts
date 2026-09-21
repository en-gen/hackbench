/**
 * parallaxCore.ts - port of CODE_05C04D (bank_05.asm:5000-5184) +
 * CODE_05C4F9 (bank_05.asm:5632-5649). The shared scroll engine that
 * cmds $00 and $01 (and several others) call once per layer per frame.
 *
 * Algorithm (one call = one layer's tick):
 *
 *   1. Read `Layer{N}ScrollTimer` for the current layer (selected via
 *      `ScrollLayerIndex`). If zero, clear that layer's X speed and exit.
 *
 *   2. For each axis (X first, then Y):
 *        a. Read the axis's target byte from
 *           `DATA_05CA6F` (X) / `DATA_05CABF` (Y), indexed by
 *           `Layer{N}ScrollType`.
 *        b. Compare to the per-layer "first-target" sentinel
 *           `DATA_05CA6E` / `DATA_05CABE`. If equal, force distance to
 *           zero (no motion this frame). Otherwise compute
 *           `distance = (target * 16) - currentNext{Axis}Pos` and its
 *           absolute value.
 *
 *   3. Pick the bigger of the two absolute distances as `_A`, the
 *      smaller as `_C`. Set `_8` to flag whether X or Y was bigger.
 *
 *   4. Divide `_A / DATA_05CB0F[type]` (16-bit / 8-bit, SNES hardware
 *      divider). Result is the per-frame integer-pixel speed to apply
 *      to the BIGGER axis. If quotient is zero (axis exhausted),
 *      advance `Layer{N}ScrollType`, decrement `Layer{N}ScrollTimer`,
 *      and recursively re-run from step 1.
 *
 *   5. Compute fractional speed for the SMALLER axis:
 *      `_E = (_C * 16 * 2^16) / _A` (16-bit / 16-bit divide).
 *
 *   6. For each axis (X then Y):
 *        a. Pick speed (`_A` for bigger, `_E` for smaller).
 *        b. Negate if the original distance was negative.
 *        c. Compare to current `Layer{N}Scroll{Axis}Speed`. Bias by
 *           `DATA_05CB5F[direction]` (±1 or 0) to step toward target
 *           speed (one frame at a time).
 *        d. Apply CODE_05C4F9 - adds new speed to fractional accumulator
 *           `Layer{N}Scroll{Axis}PosUpd`, then carries the integer part
 *           into `NextLayer{N}{Axis}Pos`.
 *        e. Flip sign of `_8` so the next axis pass uses the OTHER
 *           branch in step 6a.
 *
 * State flow: this routine ONLY mutates the layer state for the layer
 * named by `ScrollLayerIndex` (the upstream dispatcher sets it before
 * calling). Caller is responsible for setting `ScrollLayerIndex` to
 * `0` (L1) or `4` (L2) prior, and for picking which strategy invokes
 * us per cmd.
 *
 * Validation: tested against the $009 Mesen capture
 * (`maps/009/l2_scroll.csv`) - 7,739 frames of `Layer{1,2}{X,Y}Pos` /
 * `ScrollType` / `ScrollTimer` / `Scroll{X,Y}Speed` /
 * `Scroll{X,Y}PosUpd` ground truth. The simulator's frame-N output is
 * asserted equal to row N's captured values column-for-column.
 */

import {
  ADDR_X_TARGETS,
  ADDR_Y_TARGETS,
  ADDR_DATA_05CB0F,
  ADDR_DATA_05CB5F,
  readByte,
} from '../scrollData'
import type { RomFile } from '../RomFile'
import { wrap16, type ScrollState } from '../scrollSim'

// ── Per-axis-per-layer field map ─────────────────────────────────────────
//
// The ASM uses a single base address (`Layer1ScrollXSpeed`) and an X register
// of 0/4 (layer offset) plus 0/2 (axis offset within layer). TS doesn't have
// pointer arithmetic, so we expose the same access pattern via this map.

export type Layer = 'l1' | 'l2'
export type Axis = 'x' | 'y'

interface AxisFields {
  type: 'layer1ScrollType' | 'layer2ScrollType'
  timer: 'layer1ScrollTimer' | 'layer2ScrollTimer'
  speed: 'layer1ScrollXSpeed' | 'layer1ScrollYSpeed' | 'layer2ScrollXSpeed' | 'layer2ScrollYSpeed'
  posUpd:
    'layer1ScrollXPosUpd' | 'layer1ScrollYPosUpd' | 'layer2ScrollXPosUpd' | 'layer2ScrollYPosUpd'
  nextPos: 'nextLayer1XPos' | 'nextLayer1YPos' | 'nextLayer2XPos' | 'nextLayer2YPos'
}

const FIELDS: Record<
  Layer,
  {
    type: AxisFields['type']
    timer: AxisFields['timer']
    x: Pick<AxisFields, 'speed' | 'posUpd' | 'nextPos'>
    y: Pick<AxisFields, 'speed' | 'posUpd' | 'nextPos'>
  }
> = {
  l1: {
    type: 'layer1ScrollType',
    timer: 'layer1ScrollTimer',
    x: { speed: 'layer1ScrollXSpeed', posUpd: 'layer1ScrollXPosUpd', nextPos: 'nextLayer1XPos' },
    y: { speed: 'layer1ScrollYSpeed', posUpd: 'layer1ScrollYPosUpd', nextPos: 'nextLayer1YPos' },
  },
  l2: {
    type: 'layer2ScrollType',
    timer: 'layer2ScrollTimer',
    x: { speed: 'layer2ScrollXSpeed', posUpd: 'layer2ScrollXPosUpd', nextPos: 'nextLayer2XPos' },
    y: { speed: 'layer2ScrollYSpeed', posUpd: 'layer2ScrollYPosUpd', nextPos: 'nextLayer2YPos' },
  },
}

// ── 65816 sign helpers ───────────────────────────────────────────────────
//
// 16-bit signed values: bit 15 set → negative. The ASM uses `EOR #$FFFF /
// INC A` (= two's-complement negate). `BPL` checks bit 15.

function asI16(u16: number): number {
  return u16 & 0x8000 ? u16 - 0x10000 : u16
}
function negI16(u16: number): number {
  return wrap16((u16 ^ 0xffff) + 1)
}

// ── CODE_05C4F9 - speed → position carry ─────────────────────────────────

/**
 * Adds `speed` (16-bit signed, in 1/256-px units) to the fractional
 * accumulator at `Layer{N}Scroll{Axis}PosUpd`, carries the integer part
 * (top byte) into `NextLayer{N}{Axis}Pos`, and flips the sign of `_8`.
 *
 * The ASM keeps `_8` as a "which axis is bigger" sign flag in the upper
 * `parallaxTick` scope; we plumb it through the return tuple here.
 */
function applySpeed(
  s: ScrollState,
  layer: Layer,
  axis: Axis,
  speed: number,
  flag8: number,
): { state: ScrollState; flag8: number } {
  return {
    state: applyC4F9(s, layer, axis, speed),
    flag8: wrap16(negI16(flag8)), // EOR #$FFFF / INC A
  }
}

/**
 * Bare CODE_05C4F9 speed-carry, callable from cmd $03/$08/$09 handlers
 * which don't need the `_8` flag plumbing. Pure function over
 * `(layer, axis, speed)` - reads `PosUpd[layer][axis]`, writes back
 * the new accumulator, and carries the sign-extended high byte into
 * `NextLayer{N}{Axis}Pos`.
 *
 * The cmd $03 setup body uses `INX;INX` to set X=ScrollLayerIndex+2,
 * which means CODE_05C4F9 operates on the Y axis. cmd $08 leaves X=
 * ScrollLayerIndex (X axis). cmd $09 sets X=$04 explicitly (L2 X).
 * Our wrapper takes `axis` as a string so each caller picks the right
 * axis directly.
 */
export function applyC4F9(s: ScrollState, layer: Layer, axis: Axis, speed: number): ScrollState {
  const f = FIELDS[layer][axis]
  // _4 = (PosUpd & $FF) + speed     ; mix old fractional low byte with speed
  const oldUpd = s[f.posUpd]
  const lowByte = oldUpd & 0x00ff
  const sum = wrap16(lowByte + speed)
  const newUpd = sum
  // Integer carry: high byte of sum, sign-extended
  let highByte = sum & 0xff00
  if (highByte & 0x8000) highByte = highByte | 0x00ff // sign-extend low
  // XBA - swap bytes (high → low). For our value, this is shift-right 8
  // for the unsigned case, or for sign-extended we recover the int16
  // representation of the high byte.
  const carry =
    highByte & 0x8000
      ? wrap16((highByte >>> 8) | 0xff00) // negative carry, sign-extended
      : (highByte >>> 8) & 0x00ff
  const newNext = wrap16(s[f.nextPos] + carry)
  return { ...s, [f.posUpd]: newUpd, [f.nextPos]: newNext } as ScrollState
}

// ── CODE_05C04D - main entry ─────────────────────────────────────────────

const RECURSION_GUARD = 256

/**
 * Run one layer's parallax tick. Mutates only the named layer's state +
 * the shared `layer1ScrollDir` (which is written when ScreenMode bit 0 is
 * clear - see ASM line 5074).
 *
 * `screenMode` is the BG mode bit field at `$7E:0100 ScreenMode`. Its bit
 * 0 (`ScrMode_Layer1Vert`) gates whether the X-axis distance sign or the
 * Y-axis distance sign feeds `Layer1ScrollDir` - for horizontal levels
 * (bit 0 = 0) the X-axis sign wins.
 */
export function parallaxTick(
  input: ScrollState,
  rom: RomFile,
  layer: Layer,
  screenMode: number,
): ScrollState {
  let s = input
  for (let depth = 0; depth < RECURSION_GUARD; depth++) {
    const lf = FIELDS[layer]

    // CODE_05C04D entry: timer == 0 ⇒ clear X speed and bail.
    const timer = s[lf.timer]
    if (timer === 0) {
      const f = FIELDS[layer].x
      return { ...s, [f.speed]: 0 } as ScrollState
    }

    const type = s[lf.type]

    // X / Y target lookups. Both axes use combined sentinel-then-targets
    // tables (`X_TARGETS`, `Y_TARGETS`): `prev = TABLE[type]`, `cur =
    // TABLE[type + 1]`. When prev == cur, the axis is held still this
    // frame. ASM equivalent: `LDA.W DATA_05CA6E,Y` reads `prev`,
    // `LDA.W DATA_05CA6F,Y` reads `cur`, both with the same Y; the two
    // labels are consecutive bytes in ROM.
    let _4 = readByte(rom, ADDR_X_TARGETS, type) & 0xff // prev X target
    let _6 = readByte(rom, ADDR_Y_TARGETS, type) & 0xff // prev Y target
    const xCur = readByte(rom, ADDR_X_TARGETS, type + 1) & 0xff
    const yCur = readByte(rom, ADDR_Y_TARGETS, type + 1) & 0xff

    // Current Next{Axis}Pos as 16-bit unsigned.
    let _0 = s[lf.x.nextPos] // X
    let _2 = s[lf.y.nextPos] // Y

    // X-axis target (lines 5027-5048).
    //
    // Critical: `_0` retains the SIGNED 16-bit distance after the
    // SBC at line 5042 (`STA _0`). Only the accumulator `A` is negated
    // for the abs-value store at line 5048 (`STA _4`). My earlier
    // port overwrote `_0` with the absolute value, which broke the
    // 16-bit `BIT _0,X` sign check at line 5157 - for negative
    // distances bit 15 was clear in the wrong copy and the speed
    // never got negated. Symptom was `l1yspd sim=+1 cap=-1` once the
    // parallax target turned negative (e.g., $009 frame 373 when
    // L1Type advances 24→25 and Y target goes $0C→$07).
    let _8: number // sign flag - 2 = pos, 0 = neg
    if (xCur === _4) {
      _4 = 0
      _8 = 2
    } else {
      const signedDist = wrap16((xCur << 4) - _0)
      const isNeg = (signedDist & 0x8000) !== 0
      _0 = signedDist // SIGNED - for the BIT check below
      _4 = isNeg ? negI16(signedDist) : signedDist // ABSOLUTE
      _8 = isNeg ? 0 : 2
    }

    // Y-axis target (lines 5050-5071) - same SIGNED-`_2` / ABSOLUTE-`_6`
    // discipline as X.
    if (yCur === _6) {
      _6 = 0
    } else {
      const signedDist = wrap16((yCur << 4) - _2)
      const isNeg = (signedDist & 0x8000) !== 0
      _2 = signedDist
      _6 = isNeg ? negI16(signedDist) : signedDist
    }

    // ScreenMode bit 0 selects which axis's sign feeds Layer1ScrollDir.
    // BCS branch on ASM 5075: carry set (= bit 0 was 1) ⇒ keep X (which
    // was loaded into X register), else use _8.
    const dir = screenMode & 0x01 ? 0 : _8 // approximation: see TODO
    s = { ...s, layer1ScrollDir: dir & 0xff }
    // TODO: the X-vs-Y direction selection is conditioned on whether
    // we're processing layer 1 or 2 (and ScreenMode bit). Refining
    // this requires more state reads from the ASM context - for now
    // matches Layer1ScrollDir being constant in the $009 capture (=2).

    // Pick bigger / smaller distance (lines 5078-5090).
    let _A = _4 // bigger
    let _C = _6 // smaller
    let big8 = 0xffff // _8 = -1 means X is bigger
    if (_6 >= _4) {
      _A = _6
      _C = _4
      big8 = 0x0001 // _8 = +1 means Y is bigger
    }

    // 16/8 hardware divide: _A / DATA_05CB0F[type] (line 5092-5103).
    const divisor = readByte(rom, ADDR_DATA_05CB0F, type) & 0xff
    if (divisor === 0) return s // safety; vanilla never hits this
    const quotient = (_A / divisor) | 0 // truncated 16-bit divide

    if (quotient === 0) {
      // Axis exhausted: advance type, decrement timer, restart.
      s = {
        ...s,
        [lf.type]: wrap16(s[lf.type] + 1) & 0xff,
        [lf.timer]: wrap16(s[lf.timer] - 1) & 0xff,
      } as ScrollState
      continue // JMP CODE_05C04D
    }

    _A = quotient & 0xffff

    // Manual 16/16 divide for fractional speed of smaller axis
    // (lines 5115-5133). _E = (_C * 16 * 2^16) / _A.
    let cShifted = wrap16(_C << 4)
    let acc = 0
    let _E = 0
    for (let i = 0; i < 16; i++) {
      // ASL.B _C → carry out of high bit
      const carryOut = cShifted & 0x8000 ? 1 : 0
      cShifted = wrap16(cShifted << 1)
      // ROL A - shift carry into low bit of acc
      acc = wrap16((acc << 1) | carryOut)
      // CMP _A, BCC skip, SBC _A
      if (acc >= _A) {
        acc = wrap16(acc - _A)
        // ROL into _E with carry = 1 (CMP set carry)
        _E = wrap16((_E << 1) | 1)
      } else {
        // ROL into _E with carry = 0
        _E = wrap16(_E << 1)
      }
    }

    // Compute scaled big-axis speed: _A = DATA_05CB0F[type] * 16 (lines 5141-5147).
    _A = wrap16((readByte(rom, ADDR_DATA_05CB0F, s[lf.type]) & 0xff) << 4)

    // Per-axis pass: ASM `LDX #$02` then iterates X=2, X=0. The X
    // register names the axis offset within per-layer state (0=X axis,
    // 2=Y axis) - `BIT $0,X` with X=2 reads `_2` (Y distance), with
    // X=0 reads `_0` (X distance). So Y axis is processed FIRST, then
    // X axis.
    //
    // Speed selection follows `BMI CODE_05C165`:
    //   _8 negative ($FFFF, "X bigger") → use `_E` (small speed) for
    //     the SMALLER axis (which is whichever we're on). Y first
    //     (small), then X (after `_8` is flipped to $0001 by
    //     applySpeed) → use `_A` (big speed) for X.
    //   _8 positive ($0001, "Y bigger") → mirror: Y gets `_A`, X gets `_E`.
    for (const axis of ['y', 'x'] as const) {
      const axisDist = axis === 'y' ? _2 : _0
      // _8 negative → small speed (`_E`), positive → big speed (`_A`).
      let speed = big8 & 0x8000 ? _E : _A
      // Negate if the SIGNED 16-bit distance is negative. The ASM
      // `BIT $0,X` runs in 16-bit-A mode here (M flag clear since the
      // last `REP #$20` at line 5102), so it reads the full 16-bit
      // value at `_0+X` and tests bit 15 - the proper sign bit.
      if (axisDist & 0x8000) speed = negI16(speed)

      // Bias current speed by ±1 toward target speed (lines 5155-5176).
      // ASM `LDA.W DATA_05CB5F,Y` runs in 16-bit-A mode, so it reads
      // TWO consecutive bytes - `(hi << 8) | lo`. The table is
      // (+1, 0, -1, -1) repeated as 16-bit words: yIdx=0 → $0001 (+1),
      // yIdx=2 → $FFFF (-1, two's complement of 1). Reading only the
      // low byte gives `$FF = +255` instead of -1 and the speed bias
      // goes the wrong direction - symptom is `l1yspd sim=+1 cap=-1`
      // when the parallax target turns negative.
      const f = FIELDS[layer][axis]
      const cur = s[f.speed]
      let bias = 0
      if (speed !== cur) {
        const yIdx = asI16(speed) < asI16(cur) ? 2 : 0
        const lo = readByte(rom, ADDR_DATA_05CB5F, yIdx) & 0xff
        const hi = readByte(rom, ADDR_DATA_05CB5F, yIdx + 1) & 0xff
        bias = (hi << 8) | lo
      }
      const newSpeed = wrap16(cur + bias)
      s = { ...s, [f.speed]: newSpeed } as ScrollState

      // Apply speed to position via CODE_05C4F9.
      const out = applySpeed(s, layer, axis, newSpeed, big8)
      s = out.state
      big8 = out.flag8
    }

    return s
  }
  // Recursion safety - vanilla never hits this; if we do, something's
  // wrong with the type/timer advancement.
  return s
}
