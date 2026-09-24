/**
 * scrollSim_b0_variants.test.ts - extend cmd $03 / $08 validation
 * across the b0 setup variants beyond the primary $0D4 / $0E7
 * captures.
 *
 * Cmd $03 (sprite $EA) appears in 5 vanilla levels with 4 distinct
 * b0 values:
 *   $0D4 b0=$00 - primary capture (covered by scrollSim_0d4)
 *   $1E3 b0=$04 - covered here
 *   $115 b0=$08 - Valley of Bowser 2; covered here
 *   $1D1 b0=$10 - covered here
 *   $1F3 b0=$0C - orphaned, no capture
 *
 * Cmd $08 (sprite $EF) appears in 2 vanilla levels:
 *   $0E7 b0=$00 - primary capture (covered by scrollSim_0e7)
 *   $1CE b0=$04 - covered here
 *
 * Each capture exercises the per-cmd setup body across different b0
 * (= initial ScrollBits) values, which select different rows in the
 * type-init / step-init data tables. If the per-frame handler is
 * correct in general, all variants should validate frame-perfect on
 * the active-frames span.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import {
  loadCapture,
  firstMismatch,
  simFromCapture,
  detectActiveFrames,
  vanillaRomPresent,
  type FieldKey,
} from './scrollSim_capture'
import { MESEN_FIXTURES_DIR } from './fixtures/loadMesenFixture'

const FIXTURES = MESEN_FIXTURES_DIR

interface VariantSpec {
  level: string
  cmd: '03' | '08'
  /** Fields excluded from comparison (Mario-camera tracking divergences). */
  excludeFields: readonly FieldKey[]
}

/**
 * cmd $03 oscillates Y → l1x deviates from Mario-X tracking on
 * horizL2=1 levels. cmd $08 oscillates X → l1y deviates from Mario-Y
 * tracking on vertL2=1 levels. The captures show this clearly; we
 * exclude the camera-driven axis chain.
 */
const VARIANTS: readonly VariantSpec[] = [
  { level: '1e3', cmd: '03', excludeFields: ['l1x', 'nl1x', 'l2x', 'nl2x'] },
  { level: '115', cmd: '03', excludeFields: ['l1x', 'nl1x', 'l2x', 'nl2x'] },
  { level: '1d1', cmd: '03', excludeFields: ['l1x', 'nl1x', 'l2x', 'nl2x'] },
  { level: '1ce', cmd: '08', excludeFields: ['l1y', 'nl1y', 'l2y', 'nl2y'] },
]

const ALL_FIELDS: readonly FieldKey[] = [
  'l1x',
  'l1y',
  'l2x',
  'l2y',
  'l1type',
  'l2type',
  'l1timer',
  'l2timer',
  'l1xspd',
  'l1yspd',
  'l2xspd',
  'l2yspd',
  'l1xupd',
  'l1yupd',
  'l2xupd',
  'l2yupd',
  'nl1x',
  'nl1y',
  'nl2x',
  'nl2y',
]

function activeFields(exclude: readonly FieldKey[]): readonly FieldKey[] {
  return ALL_FIELDS.filter(f => !exclude.includes(f))
}

describe.skipIf(!vanillaRomPresent)('scrollSim - b0-variant captures (cmd $03 / cmd $08)', () => {
  for (const v of VARIANTS) {
    const csv = `${FIXTURES}/${v.level}/l2_scroll.csv`

    describe(`$${v.level.toUpperCase()} (cmd $${v.cmd})`, () => {
      it('frame 1 matches post-setup state', () => {
        if (!fs.existsSync(csv)) {
          console.warn(`[skip] ${csv} not found`)
          return
        }
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0])
        const m = firstMismatch(sim.stateAtFrame(0), cap[0])
        if (m !== null) console.warn(`[$${v.level}] post-setup mismatch: ${m}`)
        expect(m).toBe(null)
      })

      it('cmd oscillation matches every active captured frame', () => {
        if (!fs.existsSync(csv)) return
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0])
        const fields = activeFields(v.excludeFields)
        const active = detectActiveFrames(cap)
        for (let r = 1; r <= active; r++) {
          const m = firstMismatch(sim.stateAtFrame(r - 1), cap[r - 1], fields)
          if (m !== null) {
            throw new Error(`Mismatch at row ${r}/${active}: ${m}`)
          }
        }
      })
    })
  }
})
