/**
 * scrollSim_cmd0c.test.ts — validate L1 cmd $0C (auto-scroll level)
 * against the two vanilla cmd-$0C captures.
 *
 * cmd $0C dispatches via L1 to CODE_05C787. It ramps Layer1ScrollXSpeed
 * toward DATA_05C001[bits*2] (cap = $0080 for bits=0) by +1/frame, then
 * applies CODE_05C4F9 on the L1 X axis. When NextLayer1XPos reaches
 * `(LastScreenHoriz - 1) << 8`, speed is forced to 0 and the camera
 * stops at the last screen.
 *
 * Captures:
 *   $1D4 LastScreenHoriz=$03 → stop target $0200, level ends at row 1090
 *   $1FC LastScreenHoriz=$04 → stop target $0300, level ends at row 1634
 *
 * Both captures have l2cmd=0; L2 is parallax-derived from L1.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { loadCapture, firstMismatch, simFromCapture, type FieldKey , vanillaRomPresent } from './scrollSim_capture'

const FIXTURES = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps'

const LEVELS: readonly { id: string; lastScreenHoriz: number }[] = [
  { id: '1d4', lastScreenHoriz: 0x03 },
  { id: '1fc', lastScreenHoriz: 0x04 },
]

// L1 X-axis fields are what cmd $0C drives. L1 Y stays at the seeded
// value (no Y motion). L2 fields excluded because parallax derivation
// alignment is verified by other tests.
const CHECK_FIELDS: readonly FieldKey[] = [
  'l1x', 'l1y',
  'l1xspd', 'l1xupd',
  'nl1x', 'nl1y',
]

describe.skipIf(!vanillaRomPresent)('scrollSim — cmd $0C auto-scroll level validation', () => {
  for (const lvl of LEVELS) {
    const csv = `${FIXTURES}/${lvl.id}/l2_scroll.csv`
    describe(`$${lvl.id.toUpperCase()}`, () => {
      it('post-setup state matches capture row 1', () => {
        if (!fs.existsSync(csv)) {
          console.warn(`[skip] ${csv} not found`)
          return
        }
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0], { lastScreenHoriz: lvl.lastScreenHoriz })
        const m = firstMismatch(sim.stateAtFrame(0), cap[0], CHECK_FIELDS)
        expect(m).toBe(null)
      })

      it('every active captured frame matches', () => {
        if (!fs.existsSync(csv)) return
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0], { lastScreenHoriz: lvl.lastScreenHoriz })
        // Stop at game freeze (Mario stops moving in both axes — e.g.
        // death, goal). The capture continues recording past this, but
        // SpriteLock halts the bank_05 scroll handlers and our sim
        // doesn't model it.
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
            throw new Error(`[$${lvl.id}] mismatch at capture row ${r + 1}/${activeFrames + 1}: ${m}`)
          }
        }
      })
    })
  }
})
