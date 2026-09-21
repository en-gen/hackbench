/**
 * scrollSim_122.test.ts - validate L2 cmd $0D (Fast BG scroll)
 * against the Mesen capture for level $122.
 *
 * Capture: `C:/Users/engenb/OneDrive/hackbench-fixtures/maps/122/l2_scroll.csv`
 * Sprite: $E8 b0=$0D → post-remap (l1cmd=0, l2cmd=$0D).
 *
 * cmd $0D dispatches via L2 to CODE_05C7BC, which checks
 * `BGFastScrollActive` and (when set) falls into CODE_05C7C1 - the cmd
 * $09 body. We treat BGFastScrollActive as always set, so the simulator
 * routes cmd $0D directly to `cmd09L2`. This test confirms that path
 * matches the Mesen capture's L2 X behavior.
 *
 * Validation scope: L2 X-axis fields (`l2xspd`, `l2xupd`, `nl2x`) which
 * are wholly driven by cmd09L2. L1/L2 Y fields are Mario-Y-tracking +
 * parallax-derived (level $122 is vertical with Mario climbing); the
 * sim's Mario-Y camera tracking is approximate so those are excluded.
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

const CSV = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps/122/l2_scroll.csv'

const CHECK_FIELDS: readonly FieldKey[] = ['l2xspd', 'l2xupd', 'nl2x']

describe.skipIf(!vanillaRomPresent)(
  'scrollSim - $122 capture validation (L2 cmd $0D, Fast BG scroll)',
  () => {
    it('post-setup state matches capture row 1 on L2 X fields', () => {
      if (!fs.existsSync(CSV)) {
        console.warn(`[skip] ${CSV} not found`)
        return
      }
      const cap = loadCapture(CSV)
      const sim = simFromCapture(cap[0])
      const m = firstMismatch(sim.stateAtFrame(0), cap[0], CHECK_FIELDS)
      expect(m).toBe(null)
    })

    it('L2 X auto-scroll matches every active captured frame', () => {
      if (!fs.existsSync(CSV)) return
      const cap = loadCapture(CSV)
      const sim = simFromCapture(cap[0])

      // Stop at game freeze (Mario stops moving - death/goal).
      let activeFrames = 0
      for (let r = 1; r < cap.length; r++) {
        if (cap[r].marioX === cap[r - 1].marioX && cap[r].marioY === cap[r - 1].marioY) {
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
