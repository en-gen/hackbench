/**
 * cmd08.ts — port of `CODE_05C51F` (bank_05.asm:5651-5725).
 *
 * Cmd $08 implements an oscillating-X-scroll pattern. Both L1 and L2
 * dispatch tables route cmd $08 to the same handler — `ScrollLayerIndex`
 * (0 for L1, 4 for L2) selects which layer's fields are touched.
 *
 * Algorithm (one frame):
 *
 *   1. Sort `(NextLayer{N}XPos, Layer{N}ScrollYPosUpd)` so that
 *      `_4 = max`, `_2 = min`.
 *   2. **`SEP #$10`** at line 5667 → XY become 8-bit. *A stays 16-bit*
 *      (M flag unchanged). `LDA.B _2 / CMP.B _4` is a FULL 16-bit
 *      compare; `BCC` skips when `_2 < _4`. Sync fires only on exact
 *      equality `_2 == _4`.
 *   3. **On sync:**
 *      - `step = DATA_05CBEE[bits*2] & $FF` (read 16-bit, low byte).
 *      - Toggle `Layer{N}ScrollType` via `EOR #$0001`.
 *      - If new type == 0: negate step (16-bit two's complement).
 *      - `Layer{N}ScrollYPosUpd += step` (16-bit wrapping).
 *   4. **Bias `Layer{N}ScrollXSpeed` toward `±$80`:**
 *      - `target = DATA_05CBF1[type] & $FF`; if type != 1, negate.
 *      - Skip if speed already equals target.
 *      - Direction: `BPL` (signed) — `Y=0` if `target >= speed`, else
 *        `Y=2`. `bias = DATA_05CBC3[Y]` as 16-bit LE word ($0001 or
 *        $FFFF). `newSpeed = wrap16(speed + bias)`.
 *   5. **`CODE_05C4F9`** with `X=ScrollLayerIndex` (X-axis): carry
 *      the speed-low-byte sum into `NextLayer{N}XPos`.
 *
 * The "M flag unchanged on `SEP #$10`" invariant is the bug the prior
 * port fell into: treating the sync compare as 8-bit fires false
 * syncs whenever `nextLayer{N}XPos` happens to share a low byte with
 * `Layer{N}ScrollYPosUpd`. The actual bytes diverge after the first
 * 16-bit wrap, but the low bytes can match coincidentally.
 *
 * `DATA_05CBC3[0..3] = $01,$00,$FF,$FF` (two LE words `$0001` and
 * `$FFFF`). Reading just the low byte at index 2 gives `$FF = +255`
 * instead of -1, inverting the bias direction (same pitfall as
 * `DATA_05CB5F` in the parallax core).
 */

import {
  ADDR_DATA_05CBC3,
  ADDR_DATA_05CBEE,
  ADDR_DATA_05CBF1,
  readByte,
  readWord,
} from '../scrollData'
import { applyC4F9, type Axis, type Layer } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

interface FieldSet {
  type:    keyof Pick<ScrollState, 'layer1ScrollType' | 'layer2ScrollType'>
  bits:    keyof Pick<ScrollState, 'layer1ScrollBits' | 'layer2ScrollBits'>
  yposupd: keyof Pick<ScrollState, 'layer1ScrollYPosUpd' | 'layer2ScrollYPosUpd'>
  xspeed:  keyof Pick<ScrollState, 'layer1ScrollXSpeed'  | 'layer2ScrollXSpeed'>
  nextX:   keyof Pick<ScrollState, 'nextLayer1XPos'      | 'nextLayer2XPos'>
}
const FIELDS: Record<Layer, FieldSet> = {
  l1: {
    type:    'layer1ScrollType',
    bits:    'layer1ScrollBits',
    yposupd: 'layer1ScrollYPosUpd',
    xspeed:  'layer1ScrollXSpeed',
    nextX:   'nextLayer1XPos',
  },
  l2: {
    type:    'layer2ScrollType',
    bits:    'layer2ScrollBits',
    yposupd: 'layer2ScrollYPosUpd',
    xspeed:  'layer2ScrollXSpeed',
    nextX:   'nextLayer2XPos',
  },
}

function asI16(u16: number): number {
  return (u16 & 0x8000) ? u16 - 0x10000 : u16
}
function negI16(u16: number): number {
  return wrap16((u16 ^ 0xFFFF) + 1)
}

export function cmd08(s: ScrollState, rom: RomFile, layer: Layer, _screenMode: number): ScrollState {
  const f = FIELDS[layer]
  const yposupd = s[f.yposupd]
  const nextX   = s[f.nextX]
  const bits    = s[f.bits]

  // Step 1: sort sync counter and position target.
  // ASM:
  //   LDA.W Layer1ScrollYPosUpd,Y → TAX (X holds yposupd)
  //   LDA.W NextLayer1XPos,Y     → A holds nextX
  //   CMP.W Layer1ScrollYPosUpd,Y
  //   BCC CODE_05C538            ; A < yposupd ⇒ swap
  //   STA _4 / STX _2            ; max=nextX, min=yposupd
  //   BRA +
  // CODE_05C538:
  //   STA _2 / STX _4            ; max=yposupd, min=nextX
  let _2: number, _4: number
  if (nextX < yposupd) {
    _2 = nextX
    _4 = yposupd
  } else {
    _4 = nextX
    _2 = yposupd
  }

  // Step 2: SEP #$10 leaves A 16-bit; CMP _4 is full 16-bit compare.
  // BCC skips on `_2 < _4` (carry clear). So the sync fires only when
  // `_2 == _4` (carry set, _2 >= _4 — but we already swapped to put
  // the min in _2, so the only way _2 >= _4 is _2 === _4).
  let next = s
  if (_2 === _4) {
    // Step 3a: read step, low byte only.
    let step = readWord(rom, ADDR_DATA_05CBEE, bits * 2) & 0x00FF
    // Step 3b: toggle type via EOR #$0001 → 8-bit STA at X=ScrollLayerIndex>>2.
    const newType = (s[f.type] ^ 0x01) & 0xFF
    next = { ...next, [f.type]: newType } as ScrollState
    // Step 3c: if new type==0, negate step.
    if (newType === 0) step = negI16(step)
    // Step 3d: yposupd += step (16-bit).
    const newYposupd = wrap16(yposupd + step)
    next = { ...next, [f.yposupd]: newYposupd } as ScrollState
  }

  // Step 4: speed bias toward ±$80.
  // ASM:
  //   LDA Layer1ScrollType,X (X = ScrollLayerIndex>>2)
  //   TAX
  //   LDA.W DATA_05CBF1,X
  //   AND.W #$00FF
  //   CPX.B #$01
  //   BEQ +              ; if type==1, keep positive
  //   EOR #$FFFF; INC A  ; else negate (16-bit two's complement)
  // + LDX ScrollLayerIndex
  //   LDY #$00
  //   CMP Layer1ScrollXSpeed,X
  //   BEQ skip                   ; speed already equals target
  //   BPL +                      ; signed: target >= speed → Y=0 (+1)
  //   LDY #$02                   ; else Y=2 (-1)
  // + LDA Layer1ScrollXSpeed,X
  //   CLC; ADC DATA_05CBC3,Y     ; 16-bit ADC of bias word
  //   STA Layer1ScrollXSpeed,X
  // skip: JMP CODE_05C328 → JSR CODE_05C4F9
  const type = next[f.type]
  let target = readByte(rom, ADDR_DATA_05CBF1, type) & 0xFF
  if (type !== 0x01) target = negI16(target)

  const curSpeed = next[f.xspeed]
  let newSpeed = curSpeed
  if (target !== curSpeed) {
    // BPL is the signed-comparison branch: A=target, CMP curSpeed sets
    // N flag = (target - curSpeed) high bit. If N=1 (target<curSpeed
    // signed), we want Y=2 (-1); else Y=0 (+1).
    const yIdx = asI16(target) >= asI16(curSpeed) ? 0 : 2
    const bias = readWord(rom, ADDR_DATA_05CBC3, yIdx)
    newSpeed = wrap16(curSpeed + bias)
    next = { ...next, [f.xspeed]: newSpeed } as ScrollState
  }

  // Step 5: CODE_05C4F9 X-axis on the strategy's layer.
  next = applyC4F9(next, layer, 'x' as Axis, newSpeed)
  return next
}
