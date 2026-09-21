/**
 * scrollSim_0dc.test.ts - validate cmd $0B (L2 On/Off Switch Y-scroll)
 * against the Mesen capture for level $0DC.
 *
 * Capture: `C:/Users/engenb/OneDrive/hackbench-fixtures/maps/0dc/l2_scroll.csv`
 * Sprite: $E8 b0=$08 → post-remap (l1cmd=0, l2cmd=$0B, l1bits=0, l2bits=0).
 *
 * What this validates:
 *
 * 1. **cmd $0B setup pass-through**: no dedicated setup body for cmd $0B;
 *    initial state has l2type=0, l2timer=0 (matching capture row 1).
 *
 * 2. **cmd $0B per-frame handler (CODE_05C727 → CODE_05C74A)**:
 *    On/Off switch starts at 0 → X=0 == l2type=0 → main loop path.
 *    Timer resets to $10 each frame; speed ramps from 0 toward -64
 *    ($FFC0) by -1 per frame; C4F9 accumulates fractional Y displacement
 *    into NextLayer2YPos.
 *
 * 3. **Target freeze (Y=$0020=32)**: once NextLayer2YPos reaches the
 *    target, the handler skips C4F9 and resets OnOffSwitch=0 (which was
 *    already 0). Layer2YPos stays frozen at 32 for the rest of the
 *    capture.
 *
 * Known divergence: l1x / l2x / nl1x / nl2x are driven by Mario-X
 * camera tracking and are excluded from per-frame checks.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import {
  loadCapture,
  firstMismatch,
  simFromCapture,
  type FieldKey,
  vanillaRomPresent,
} from './scrollSim_capture'

const CSV = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps/0dc/l2_scroll.csv'

const CHECK_FIELDS: readonly FieldKey[] = [
  'l1y',
  'l2y',
  'l2type',
  'l2timer',
  'l2yspd',
  'l2yupd',
  'nl1y',
  'nl2y',
]

describe.skipIf(!vanillaRomPresent)(
  'scrollSim - $0DC capture validation (L2 cmd $0B, On/Off Switch Y)',
  () => {
    it('post-setup state matches capture row 1', () => {
      if (!fs.existsSync(CSV)) {
        console.warn(`[skip] ${CSV} not found`)
        return
      }
      const cap = loadCapture(CSV)
      const sim = simFromCapture(cap[0])
      const m = firstMismatch(sim.stateAtFrame(0), cap[0], CHECK_FIELDS)
      if (m !== null) {
        const r = cap[0]
        const f0 = sim.stateAtFrame(0)
        console.warn(`[$0DC] post-setup mismatch: ${m}`)
        console.warn(
          `  cap row 1: l2=(${r.l2x},${r.l2y}) type=${r.l2type} timer=${r.l2timer} yspd=${r.l2yspd} yupd=${r.l2yupd} nl2y=${r.nl2y}`,
        )
        console.warn(
          `  sim   f0: l2=(${f0.layer2XPos},${f0.layer2YPos}) type=${f0.layer2ScrollType} timer=${f0.layer2ScrollTimer} yspd=${f0.layer2ScrollYSpeed} yupd=${f0.layer2ScrollYPosUpd} nl2y=${f0.nextLayer2YPos}`,
        )
      }
      expect(m).toBe(null)
    })

    it('cmd $0B Y-scroll matches every active captured frame', () => {
      if (!fs.existsSync(CSV)) return
      const cap = loadCapture(CSV)
      const sim = simFromCapture(cap[0])

      // Stop before the On/Off switch fires in-game (l2timer drops from 16
      // to 15 on the NOT-EQUAL path). The simulator has no way to replay
      // when Mario hit the switch, so we only validate the initial
      // "descend toward Y=32" phase.
      let activeFrames = 0
      for (let r = 1; r < cap.length; r++) {
        const t = cap[r].l2timer
        if (t > 0 && t < 16) {
          activeFrames = r - 1
          break
        }
        activeFrames = r
      }

      for (let r = 0; r <= activeFrames; r++) {
        const m = firstMismatch(sim.stateAtFrame(r), cap[r], CHECK_FIELDS)
        if (m !== null) {
          throw new Error(`Mismatch at capture row ${r + 1}/${activeFrames + 1}: ${m}`)
        }
      }
    })
  },
)
