/**
 * cmd0b.ts - port of `CODE_05C727` (bank_05.asm:5907-5950).
 *
 * Cmd $0B implements the On/Off Switch–controlled Layer 2 Y-scroll
 * (used in ghost houses with rising/falling platforms). The L2 dispatch
 * table routes cmd $0B to CODE_05C727.
 *
 * Algorithm (one frame):
 *
 *   1. `X = OnOffSwitch != 0 ? 2 : 0` - X selects the active direction
 *      (0 = moving toward Y=$0020=32, 2 = moving toward Y=$00C1=193).
 *
 *   2. `CPX Layer2ScrollType`
 *      - **EQUAL** (`X == type`): jump to main-loop (CODE_05C74A).
 *      - **NOT EQUAL** (`X != type`): decrement timer; if timer wraps
 *        negative (was 0 → $FFFF), update `Layer2ScrollType = X`. Then
 *        toggle `NextLayer2YPos ^= 1` (1-pixel jiggle), clear
 *        `Layer2ScrollYSpeed`, and return early (no CODE_05C32B /
 *        applyNext in this path - the tick's leading `applyNext` handles
 *        the commit on the next frame).
 *
 *   3. **Main loop (CODE_05C74A)**:
 *      - Set `Layer2ScrollTimer = $10` (16).
 *      - If `NextLayer2YPos == DATA_05C71B[X]` (target reached):
 *          set `OnOffSwitch = 0` (resets after "off" target is hit;
 *          in-game an On/Off switch block would re-set it).
 *      - Else: ramp `Layer2ScrollYSpeed` toward `DATA_05C71F[X]` cap by
 *          `DATA_05C723[X]` step per frame, then apply CODE_05C4F9 on
 *          the L2 Y axis.
 *
 * Vanilla level exercising this cmd: $0DC (sprite $E8 b0=$08 → cmd $0B).
 */

import { ADDR_DATA_05C71B, ADDR_DATA_05C71F, ADDR_DATA_05C723, readWord } from '../scrollData'
import { applyC4F9 } from './parallaxCore'
import type { RomFile } from '../RomFile'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

export function cmd0bL2(s: ScrollState, rom: RomFile): ScrollState {
  // X = OnOffSwitch == 0 ? 0 : 2
  const x = s.onOffSwitch !== 0 ? 2 : 0

  if (x !== s.layer2ScrollType) {
    // Transition frame: decrement timer; if negative, advance type.
    const newTimer = wrap16(s.layer2ScrollTimer - 1)
    const newType = newTimer & 0x8000 ? x : s.layer2ScrollType
    return {
      ...s,
      layer2ScrollTimer: newTimer,
      layer2ScrollType: newType,
      nextLayer2YPos: wrap16(s.nextLayer2YPos ^ 0x01),
      layer2ScrollYSpeed: 0,
    } as ScrollState
  }

  // Main loop (CODE_05C74A): type matches switch state.
  let cur: ScrollState = { ...s, layer2ScrollTimer: 16 } as ScrollState

  const target = readWord(rom, ADDR_DATA_05C71B, x)
  if (cur.nextLayer2YPos === target) {
    // Target reached: reset switch to 0 (CODE_05C73D: LDX #$00 / STX OnOffSwitch).
    return { ...cur, onOffSwitch: 0 } as ScrollState
  }

  // Ramp speed toward cap, then apply C4F9 on Y axis (CODE_05C770).
  const cap = readWord(rom, ADDR_DATA_05C71F, x)
  const step = readWord(rom, ADDR_DATA_05C723, x)
  let speed = cur.layer2ScrollYSpeed
  if (speed !== cap) {
    speed = wrap16(speed + step)
    cur = { ...cur, layer2ScrollYSpeed: speed } as ScrollState
  }
  cur = applyC4F9(cur, 'l2', 'y', speed)
  return cur
}
