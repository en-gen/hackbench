/**
 * cmd0c.ts - port of `CODE_05C787` (bank_05.asm:5952-5976).
 *
 * Cmd $0C is the "auto-scroll level" L1 X-scroll (used in vanilla levels
 * $1D4 and $1FC). The L1 dispatch routes cmd $0C here.
 *
 * Algorithm (one frame):
 *
 *   1. Set `Layer1ScrollDir = 2` (positive direction).
 *   2. Ramp `Layer1ScrollXSpeed` toward `DATA_05C001[bits*2]` (16-bit
 *      cap: $0080 for bits=0, $0100 for bits=2) by `+1` per frame.
 *   3. Compute end-of-level target `(LastScreenHoriz - 1) << 8` and
 *      compare to `NextLayer1XPos`. If equal, force speed to 0.
 *   4. Apply CODE_05C4F9 on the L1 X axis with the (possibly cleared)
 *      speed.
 *
 * The speed-clear at end-of-level is the only thing that prevents the
 * camera from scrolling past the last screen. Without it, cmd $0C would
 * march L1 forever.
 */

import { ADDR_DATA_05C001, readWord } from '../scrollData'
import { applyC4F9 } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

export function cmd0cL1(s: ScrollState, rom: RomFile): ScrollState {
  // Layer1ScrollDir = 2 (positive).
  let cur: ScrollState = { ...s, layer1ScrollDir: 0x02 } as ScrollState

  // Speed ramp: increment toward cap.
  const cap = readWord(rom, ADDR_DATA_05C001, cur.layer1ScrollBits * 2)
  let speed = cur.layer1ScrollXSpeed
  if (speed !== cap) speed = wrap16(speed + 1)

  // End-of-level check: if NextLayer1XPos == (LastScreenHoriz - 1) << 8,
  // clear speed before applying. The 16-bit pre-XBA load + DEC + XBA in
  // the ASM yields exactly this value when LastScreenHoriz < $100.
  const stopTarget = wrap16((cur.lastScreenHoriz - 1) << 8) & 0xff00
  if (cur.nextLayer1XPos === stopTarget) speed = 0

  cur = { ...cur, layer1ScrollXSpeed: speed } as ScrollState
  cur = applyC4F9(cur, 'l1', 'x', speed)
  return cur
}
