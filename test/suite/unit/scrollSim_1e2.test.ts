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
import { loadCapture, firstMismatch, simFromCapture, detectActiveFrames, type FieldKey, vanillaRomPresent } from './scrollSim_capture'

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

  it('post-touch speed/move path matches capture after Mario lands on L2', () => {
    // Validate cmd $0E Part B (bank_05.asm:6057-6079, CODE_05C857):
    // speed ramps toward DATA_05C814[yIdx] in steps of DATA_05C818[yIdx],
    // integrated by CODE_05C4F9.
    //
    // Layer2Touched ($7E:1471) is not in the CSV. We inject it into the
    // state one frame before the first non-zero l2yspd, then drive
    // sim.tick() forward directly. The tick carries layer2Touched through
    // state unchanged, so Part B fires for the rest of the run.
    if (!fs.existsSync(CSV)) return
    const cap = loadCapture(CSV)
    const sim = simFromCapture(cap[0])

    let touchIdx = -1
    for (let r = 1; r < cap.length; r++) {
      if (cap[r].l2yspd !== 0) { touchIdx = r; break }
    }
    if (touchIdx < 0) {
      console.warn('[skip] no post-touch frames found in capture')
      return
    }

    const lastActive = detectActiveFrames(cap)

    // Seed from the last clean frame, inject Layer2Touched=1. sim.tick()
    // preserves it across frames, so Part B of cmd0eL2 fires every tick.
    let s = { ...sim.stateAtFrame(touchIdx - 1), layer2Touched: 1 }
    for (let r = touchIdx; r <= lastActive; r++) {
      s = sim.tick(s)
      const m = firstMismatch(s, cap[r], CHECK_FIELDS)
      if (m !== null) {
        throw new Error(
          `Post-touch mismatch at frame ${cap[r].frame} (capture row ${r + 1}): ${m}`,
        )
      }
    }
  })
})
