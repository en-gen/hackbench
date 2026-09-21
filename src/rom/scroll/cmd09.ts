/**
 * cmd09.ts - port of `CODE_05C7C1` (bank_05.asm:5981-6001).
 *
 * Cmd $09 only appears as an L2 per-frame handler (the L1 dispatch
 * table at 4535 routes cmd $09 → `Return05BC49`). The handler:
 *
 *   1. Sets `Layer2ScrollDir = $02` (we don't track this).
 *   2. Bumps `Layer2ScrollXSpeed` by +1, capped at `$0400`.
 *   3. Calls `CODE_05C4F9` with `X=$04` to apply the speed → carry
 *      onto `NextLayer2XPos`.
 *   4. Adds the signed low byte of `Layer1DXPos` to `NextLayer2XPos`.
 *      In our simulator we treat `Layer1DXPos = 0` (a Mario-driven
 *      delta we don't model).
 *
 * `BGFastScrollActive` is referenced elsewhere in the bank as a gate;
 * we treat it as always active. For levels that toggle it dynamically
 * the simulator may diverge.
 *
 * Test coverage: `scrollSim_0c8.test.ts` validates this against the
 * $0C8 capture (sprite $E8 b0=$10 → L1 cmd $01 / L2 cmd $09).
 */

import { applyC4F9 } from './parallaxCore'
import type { ScrollState } from '../scrollSim'
import { wrap16 } from '../scrollSim'

const SPEED_CAP_X = 0x0400

export function cmd09L2(s: ScrollState): ScrollState {
  // Step 2: speed bump, capped.
  let newSpeed = s.layer2ScrollXSpeed
  if (newSpeed !== SPEED_CAP_X) {
    newSpeed = wrap16(newSpeed + 1)
  }
  // Step 3: CODE_05C4F9 with X=$04 → L2 X-axis carry.
  let s2: ScrollState = { ...s, layer2ScrollXSpeed: newSpeed }
  s2 = applyC4F9(s2, 'l2', 'x', newSpeed)
  // Step 4: Layer1DXPos contribution. Treated as 0.
  return s2
}
