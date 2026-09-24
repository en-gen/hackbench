/**
 * scrollSim_camera_x.test.ts - validate the horizontal Mario-X camera
 * tracking port (bank_00.asm:13658-13691 + CODE_00F8AB) against Mesen
 * captures for the three vanilla cmd-$02 levels.
 *
 * Test strategy:
 *   • Seed the simulator from capture row 1 (as usual).
 *   • For each subsequent frame, inject `playerXPosNext = cap[r].marioX`
 *     into the state before ticking. This mirrors the actual SNES where
 *     Mario's physics engine writes `PlayerXPosNext` before
 *     `UpdateScreenPosition` reads it.
 *   • Assert `nextLayer1XPos` (nl1x) matches the capture column after
 *     each tick. The camera tracking writes `layer1XPos` which flows
 *     into `nextLayer1XPos` via the 8-byte Layer→Next copy at the end
 *     of `applyParallaxDerivation`.
 *
 * Capture files:
 *   $01A - <hackbench-fixtures>/maps/01a/l2_scroll.csv
 *   $111 - <hackbench-fixtures>/maps/111/l2_scroll.csv
 *   $1CF - <hackbench-fixtures>/maps/1cf/l2_scroll.csv
 *
 * Acceptance criteria: `nl1x` matches every active frame of the capture
 * (up to the freeze sentinel detected by `detectActiveFrames`).
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import {
  loadCapture,
  simFromCapture,
  detectActiveFrames,
  vanillaRomPresent,
} from './scrollSim_capture'
import { MESEN_FIXTURES_DIR } from './fixtures/loadMesenFixture'

const FIXTURES = MESEN_FIXTURES_DIR

const LEVELS = ['01a', '111', '1cf'] as const

describe.skipIf(!vanillaRomPresent)('scrollSim - Mario-X camera tracking (horizontal)', () => {
  for (const id of LEVELS) {
    const csv = `${FIXTURES}/${id}/l2_scroll.csv`

    describe(`$${id.toUpperCase()}`, () => {
      it('nl1x matches capture column-for-column (camera driven by marioX)', () => {
        if (!fs.existsSync(csv)) {
          console.warn(`[skip] ${csv} not found`)
          return
        }

        const cap = loadCapture(csv)
        // horizLayer1Setting: 1 enables camera tracking; marioWalkRate: 0
        // because the test injects cap[r].marioX before each tick.
        const sim = simFromCapture(cap[0], { horizLayer1Setting: 1 })

        const lastActive = detectActiveFrames(cap)

        let s = sim.stateAtFrame(0)
        let firstErr: string | null = null

        for (let r = 1; r <= lastActive; r++) {
          // Inject the actual Mario position captured on this frame so
          // the camera tracking sees the ground-truth PlayerXPosNext.
          s = { ...s, playerXPosNext: cap[r].marioX }
          s = sim.tick(s)

          const simNl1x = s.nextLayer1XPos
          const capNl1x = cap[r].nl1x
          if (simNl1x !== capNl1x) {
            firstErr = `frame ${cap[r].frame}: nl1x sim=${simNl1x} cap=${capNl1x} (marioX=${cap[r].marioX})`
            break
          }
        }

        if (firstErr !== null) {
          console.warn(`[$${id}] first nl1x mismatch: ${firstErr}`)
        }
        expect(firstErr).toBe(null)
      })
    })
  }
})
