/**
 * cmd03.ts - port of `CODE_05C5BB` (bank_05.asm:5727-5803).
 *
 * Cmd $03 is the Y-axis mirror of cmd $08:
 *
 * | Role                | cmd $08 (X)             | cmd $03 (Y)             |
 * |---------------------|-------------------------|-------------------------|
 * | Sync counter        | `Layer{N}ScrollYPosUpd` | `Layer{N}ScrollXPosUpd` |
 * | Position target     | `NextLayer{N}XPos`      | `NextLayer{N}YPos`      |
 * | Step table          | `DATA_05CBEE[bits*2]`   | `DATA_05CBF6[bits*2]`   |
 * | Speed field         | `Layer{N}ScrollXSpeed`  | `Layer{N}ScrollYSpeed`  |
 * | C4F9 axis           | X (X=ScrollLayerIndex)  | Y (X=ScrollLayerIndex+2)|
 *
 * The same SEP-#$10-leaves-A-16-bit invariant applies: the sync compare
 * is a full 16-bit equality, NOT 8-bit masking.
 *
 * Test coverage: `scrollSim_0d4.test.ts` validates this against the
 * $0D4 capture (sprite $EA b0=$00 → cmd $03). The capture diverges in
 * `l1x` from row 193 onward due to Mario-X camera tracking which we
 * don't model - checks exclude the camera-position chain past that
 * point.
 */

import {
  ADDR_DATA_05CBC3,
  ADDR_DATA_05CBF1,
  ADDR_DATA_05CBF6,
  readByte,
  readWord,
} from '../scrollData'
import { applyC4F9, type Axis, type Layer } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

interface FieldSet {
  type: keyof Pick<ScrollState, 'layer1ScrollType' | 'layer2ScrollType'>
  bits: keyof Pick<ScrollState, 'layer1ScrollBits' | 'layer2ScrollBits'>
  xposupd: keyof Pick<ScrollState, 'layer1ScrollXPosUpd' | 'layer2ScrollXPosUpd'>
  yspeed: keyof Pick<ScrollState, 'layer1ScrollYSpeed' | 'layer2ScrollYSpeed'>
  nextY: keyof Pick<ScrollState, 'nextLayer1YPos' | 'nextLayer2YPos'>
}
const FIELDS: Record<Layer, FieldSet> = {
  l1: {
    type: 'layer1ScrollType',
    bits: 'layer1ScrollBits',
    xposupd: 'layer1ScrollXPosUpd',
    yspeed: 'layer1ScrollYSpeed',
    nextY: 'nextLayer1YPos',
  },
  l2: {
    type: 'layer2ScrollType',
    bits: 'layer2ScrollBits',
    xposupd: 'layer2ScrollXPosUpd',
    yspeed: 'layer2ScrollYSpeed',
    nextY: 'nextLayer2YPos',
  },
}

function asI16(u16: number): number {
  return u16 & 0x8000 ? u16 - 0x10000 : u16
}
function negI16(u16: number): number {
  return wrap16((u16 ^ 0xffff) + 1)
}

export function cmd03(
  s: ScrollState,
  rom: RomFile,
  layer: Layer,
  _screenMode: number,
): ScrollState {
  const f = FIELDS[layer]
  const xposupd = s[f.xposupd]
  const nextY = s[f.nextY]
  const bits = s[f.bits]

  // Step 1: sort sync counter (XPosUpd) and position target (NextYPos).
  let _2: number, _4: number
  if (nextY < xposupd) {
    _2 = nextY
    _4 = xposupd
  } else {
    _4 = nextY
    _2 = xposupd
  }

  // Step 2: SEP #$10 leaves A 16-bit. Full 16-bit equality on sync.
  let next = s
  if (_2 === _4) {
    let step = readWord(rom, ADDR_DATA_05CBF6, bits * 2) & 0x00ff
    const newType = (s[f.type] ^ 0x01) & 0xff
    next = { ...next, [f.type]: newType } as ScrollState
    if (newType === 0) step = negI16(step)
    const newXposupd = wrap16(xposupd + step)
    next = { ...next, [f.xposupd]: newXposupd } as ScrollState
  }

  // Step 4: speed bias toward ±$80 (Y axis).
  const type = next[f.type]
  let target = readByte(rom, ADDR_DATA_05CBF1, type) & 0xff
  if (type !== 0x01) target = negI16(target)

  const curSpeed = next[f.yspeed]
  let newSpeed = curSpeed
  if (target !== curSpeed) {
    const yIdx = asI16(target) >= asI16(curSpeed) ? 0 : 2
    const bias = readWord(rom, ADDR_DATA_05CBC3, yIdx)
    newSpeed = wrap16(curSpeed + bias)
    next = { ...next, [f.yspeed]: newSpeed } as ScrollState
  }

  // Step 5: CODE_05C4F9 Y-axis on the strategy's layer.
  // ASM does INX;INX before JMP CODE_05C328 to bump X to Y-axis.
  next = applyC4F9(next, layer, 'y' as Axis, newSpeed)
  return next
}
