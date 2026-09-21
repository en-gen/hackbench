/**
 * cmd0e.ts - port of `CODE_05C81C` (bank_05.asm:6034-6079).
 *
 * Cmd $0E is the L2 sink/rise zone-based Y handler. Two parts:
 *
 *  Part A - Zone loop (CODE_05C830):
 *    Iterates `Layer2ScrollTimer` times starting at X=Layer1ScrollTimer
 *    (incrementing X by 2 each iteration). For each X:
 *      if  DATA_05C7F0[X] <= NextLayer2XPos < DATA_05C7FC[X]:
 *        Layer1ScrollType = 0
 *        NextLayer2YPos   = DATA_05C80E[Y]   (Y = 0 if l1timer<8, 2 if >=8)
 *        Layer2ScrollYSpeed = 0
 *        Layer2ScrollYPosUpd = 0
 *
 *  Part B - Speed/move (CODE_05C857):
 *    `Layer1ScrollType OR= Layer2Touched`. If the result is 0, RTS.
 *    Else, if NextLayer2YPos != DATA_05C810[Y]:
 *      ramp Layer2ScrollYSpeed toward DATA_05C814[Y] cap by DATA_05C818[Y]
 *      step per frame and apply CODE_05C4F9 on the Y axis.
 *
 * Layer2Touched (gameplay-set when Mario stands on L2) is now read
 * from `state.layer2Touched` - webview surfaces a checkbox so users
 * can simulate the touch. With the checkbox unset (default), cmd $0E
 * is a near-no-op for levels that don't enter a zone - accurate for
 * pre-touch frames; with it set, the L2 plane sinks/rises as it
 * would with Mario standing on it.
 */

import {
  ADDR_DATA_05C7F0,
  ADDR_DATA_05C7FC,
  ADDR_DATA_05C80E,
  ADDR_DATA_05C810,
  ADDR_DATA_05C814,
  ADDR_DATA_05C818,
  readWord,
} from '../scrollData'
import { applyC4F9 } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

export function cmd0eL2(s: ScrollState, rom: RomFile): ScrollState {
  // Y = 0 if l1timer < 8, else 2.
  const yIdx = s.layer1ScrollTimer < 0x08 ? 0 : 2

  // Part A - zone loop.
  let next = s
  let x = s.layer1ScrollTimer
  let count = s.layer2ScrollTimer
  while (count > 0) {
    const zoneMin = readWord(rom, ADDR_DATA_05C7F0, x)
    const zoneMax = readWord(rom, ADDR_DATA_05C7FC, x)
    const nl2x = next.nextLayer2XPos
    if (nl2x >= zoneMin && nl2x < zoneMax) {
      next = {
        ...next,
        layer1ScrollType: 0,
        nextLayer2YPos: readWord(rom, ADDR_DATA_05C80E, yIdx),
        layer2ScrollYSpeed: 0,
        layer2ScrollYPosUpd: 0,
      } as ScrollState
    }
    x += 2
    count -= 1
  }

  // Part B - speed/move, gated by Layer1ScrollType | Layer2Touched.
  // The OR result is written back to Layer1ScrollType.
  // Layer2Touched is gameplay state (Mario standing on an L2
  // platform tile). The webview seeds it via `ScrollSimSeed
  // .layer2Touched` so users can simulate the touch.
  const orResult = (next.layer1ScrollType | next.layer2Touched) & 0xff
  next = { ...next, layer1ScrollType: orResult } as ScrollState
  if (orResult === 0) return next

  const targetY = readWord(rom, ADDR_DATA_05C810, yIdx)
  if (next.nextLayer2YPos === targetY) return next

  const cap = readWord(rom, ADDR_DATA_05C814, yIdx)
  const step = readWord(rom, ADDR_DATA_05C818, yIdx)
  let speed = next.layer2ScrollYSpeed
  if (speed !== cap) speed = wrap16(speed + step)
  next = { ...next, layer2ScrollYSpeed: speed } as ScrollState
  next = applyC4F9(next, 'l2', 'y', speed)
  return next
}
