/**
 * scrollSim_1e2.test.ts — partial validation of L2 cmd $0E (sink/rise)
 * against the Mesen capture for level $1E2.
 *
 * Capture: `C:/Users/engenb/OneDrive/hackbench-fixtures/maps/1e2/l2_scroll.csv`
 * Sprite: $E8 b0=$0E → post-remap (l1cmd=0, l2cmd=$0E, l1bits=1, l2bits=0).
 *
 * What this validates:
 *
 * 1. **cmd $0E setup pass-through**: post-setup state matches row 1
 *    (l1type=0, l2type=0, l1timer=8, l2timer=2, l2y=0, nl2y=0).
 *
 * 2. **Static zone-miss path**: NextLayer2XPos=267 falls outside every
 *    `(DATA_05C7F0[X], DATA_05C7FC[X])` zone the loop checks, so the
 *    in-zone block never fires. With Layer2Touched=0 (gameplay input
 *    not modeled), `Layer1ScrollType OR Layer2Touched = 0` → BEQ →
 *    handler is a no-op. L2 stays static.
 *
 * Limitation: the sim diverges from the capture at row 59 when Mario
 * first lands on L2 in-game (Layer2Touched fires, speed ramps, L2
 * oscillates between Y=0 and Y=176). The capture doesn't record
 * Layer2Touched so we can't replay it. Validates only frames 0-57.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { loadCapture, firstMismatch, simFromCapture, type FieldKey , vanillaRomPresent } from './scrollSim_capture'

const CSV = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps/1e2/l2_scroll.csv'

const CHECK_FIELDS: readonly FieldKey[] = [
  'l1y', 'l2y',
  'l2type', 'l2timer',
  'l2yspd', 'l2yupd',
  'nl2y',
]

describe.skipIf(!vanillaRomPresent)('scrollSim — $1E2 capture validation (L2 cmd $0E, sink/rise)', () => {
  it('post-setup state matches capture row 1', () => {
    if (!fs.existsSync(CSV)) {
      console.warn(`[skip] ${CSV} not found`)
      return
    }
    const cap = loadCapture(CSV)
    const sim = simFromCapture(cap[0])
    const m = firstMismatch(sim.stateAtFrame(0), cap[0], CHECK_FIELDS)
    expect(m).toBe(null)
  })

  it('static zone-miss path matches all frames before Mario touches L2', () => {
    if (!fs.existsSync(CSV)) return
    const cap = loadCapture(CSV)
    const sim = simFromCapture(cap[0])

    // Stop at the first frame where l2yspd becomes non-zero — that's
    // when Layer2Touched fires in-game and the speed/move path diverges.
    let activeFrames = 0
    for (let r = 1; r < cap.length; r++) {
      if (cap[r].l2yspd !== 0) { activeFrames = r - 1; break }
      activeFrames = r
    }

    for (let r = 0; r <= activeFrames; r++) {
      const m = firstMismatch(sim.stateAtFrame(r), cap[r], CHECK_FIELDS)
      if (m !== null) {
        throw new Error(`Mismatch at capture row ${r + 1}/${activeFrames + 1}: ${m}`)
      }
    }
  })
})
