/**
 * scrollSim_00c.test.ts - validate cmd $01 + L2 cmd $00 (parallax-only
 * L2) against the Mesen capture for `$00C`.
 *
 * Capture: `<hackbench-fixtures>/maps/00c/l2_scroll.csv`
 * Sprite: $E8 b0=$0C → post-remap (l1cmd=1, l2cmd=0, l1bits=5, l2bits=0).
 *
 * What this validates:
 *
 * 1. **Per-layer setup with L2 cmd $00 BEQ early-return**:
 *    `applyCmdSetup` must run L1 cmd $00/$01 body (writing l1type/timer
 *    from DATA_05CA61/CA68[5]) and SKIP the L2 body (l2type=0,
 *    l2timer=0). Capture row 1 confirms.
 *
 * 2. **bank_00 parallax derivation each frame**: $00C has horizL2=2 /
 *    vertL2=2, so per-frame Layer2*Pos is derived as
 *    `(Layer1*Pos >> 1) + bgOffset`. Without this the L2 plane stays
 *    frozen at level entry while L1 advances.
 *
 * 3. **`backgroundVertOffset` calibration**: bgOffset = 192 - 96 = 96
 *    so the first frame's derived Y matches the seed.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { buildScrollSimulator, type ScrollState } from '../../../src/rom/scrollSim'
import {
  loadCapture,
  firstMismatch as sharedFirstMismatch,
  loadVanillaRom,
  vanillaRomPresent,
  type CaptureRow,
  type FieldKey,
} from './scrollSim_capture'
import { join } from 'path'
import { MESEN_FIXTURES_DIR } from './fixtures/loadMesenFixture'

const CSV = join(MESEN_FIXTURES_DIR, '00c', 'l2_scroll.csv')

/** Fields this level's capture is compared on (the rest diverge or are unused). */
const FIELDS: readonly FieldKey[] = [
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
const firstMismatch = (s: ScrollState, r: CaptureRow) => sharedFirstMismatch(s, r, FIELDS)

describe.skipIf(!vanillaRomPresent)(
  'scrollSim - $00C capture validation (cmd $01 / L2 cmd $00)',
  () => {
    it('frame 1 matches the capture after setup', () => {
      if (!fs.existsSync(CSV)) {
        console.warn(`[skip] ${CSV} not found`)
        return
      }
      const cap = loadCapture(CSV)
      const r0 = cap[0]
      const sim = buildScrollSimulator(loadVanillaRom(), {
        layer1XPos: r0.l1x,
        layer1YPos: r0.l1y,
        layer2XPos: r0.l2x,
        layer2YPos: r0.l2y,
        layer1ScrollCmd: r0.l1cmd,
        layer2ScrollCmd: r0.l2cmd,
        layer1ScrollBits: r0.l1bits,
        layer2ScrollBits: r0.l2bits,
        horizLayer2Setting: r0.horizL2,
        vertLayer2Setting: r0.vertL2,
        marioSpawnX: r0.marioX,
        marioSpawnY: r0.marioY,
        screenMode: 0,
      })
      const f0 = sim.stateAtFrame(0)
      const m = firstMismatch(f0, r0)
      if (m !== null) {
        console.warn(`[$00C] post-setup mismatch: ${m}`)
        console.warn(
          `  cap row 1: l1=(${r0.l1x},${r0.l1y}) l2=(${r0.l2x},${r0.l2y}) types=(${r0.l1type},${r0.l2type}) timers=(${r0.l1timer},${r0.l2timer}) yupds=(${r0.l1yupd},${r0.l2yupd})`,
        )
        console.warn(
          `  sim   f0: l1=(${f0.layer1XPos},${f0.layer1YPos}) l2=(${f0.layer2XPos},${f0.layer2YPos}) types=(${f0.layer1ScrollType},${f0.layer2ScrollType}) timers=(${f0.layer1ScrollTimer},${f0.layer2ScrollTimer}) yupds=(${f0.layer1ScrollYPosUpd},${f0.layer2ScrollYPosUpd})`,
        )
      }
      expect(m).toBe(null)
    })

    it('parallax + cmd $01 + bank_00 derivation match every captured frame', () => {
      if (!fs.existsSync(CSV)) return
      const cap = loadCapture(CSV)
      const r0 = cap[0]
      const sim = buildScrollSimulator(loadVanillaRom(), {
        layer1XPos: r0.l1x,
        layer1YPos: r0.l1y,
        layer2XPos: r0.l2x,
        layer2YPos: r0.l2y,
        layer1ScrollCmd: r0.l1cmd,
        layer2ScrollCmd: r0.l2cmd,
        layer1ScrollBits: r0.l1bits,
        layer2ScrollBits: r0.l2bits,
        horizLayer2Setting: r0.horizL2,
        vertLayer2Setting: r0.vertL2,
        marioSpawnX: r0.marioX,
        marioSpawnY: r0.marioY,
        screenMode: 0,
      })
      for (let r = 1; r <= cap.length; r++) {
        const m = firstMismatch(sim.stateAtFrame(r - 1), cap[r - 1])
        if (m !== null) {
          throw new Error(`Mismatch at capture row ${r}/${cap.length}: ${m}`)
        }
      }
    })
  },
)
