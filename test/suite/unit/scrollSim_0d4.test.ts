/**
 * scrollSim_0d4.test.ts - validate L2 cmd $03 (oscillating-Y scroll)
 * against the Mesen capture for `$0D4`.
 *
 * Capture: `<hackbench-fixtures>/maps/0d4/l2_scroll.csv`
 * Sprite: $EA b0=$00 → post-remap (l1cmd=0, l2cmd=3, l1bits=0, l2bits=0).
 *
 * What this validates:
 *
 * 1. **cmd $03 setup body (`CODE_05BF20`)**: 16-bit type word from
 *    DATA_05CA5C; XPosUpd init using step from DATA_05CBF5 + NextL{N}YPos.
 *    The L2 setup's 16-bit STA at $1443 (l2type) writes high byte $00
 *    to $1444 (l1timer), giving l1timer=0 (versus l1timer=1 for cmd
 *    $08). Capture row 1 confirms l1timer=0.
 *
 * 2. **cmd $03 prelude (`CODE_05BF0A`)**: clears `VertLayer2Setting`.
 *    Capture row 1 has vertL2=0.
 *
 * 3. **cmd $03 per-frame handler (`CODE_05C5BB`)**: Y-axis variant of
 *    cmd $08; sync compare is full 16-bit equality (`SEP #$10` leaves
 *    A 16-bit); INX;INX before C4F9 puts speed-carry on Y axis.
 *
 * Known divergence: `l1x` deviates from row 193 onward because
 * `Layer1XPos` is driven by Mario-X camera tracking (a horizL2=1
 * level - Mario walks right, camera advances). Checks exclude that
 * camera-position chain.
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

const CSV = join(MESEN_FIXTURES_DIR, '0d4', 'l2_scroll.csv')

/** Fields this level's capture is compared on (the rest diverge or are unused). */
const FIELDS: readonly FieldKey[] = [
  'l1y',
  'l2y',
  'l1type',
  'l2type',
  'l1timer',
  'l2timer',
  'l1yspd',
  'l2yspd',
  'l1xupd',
  'l2xupd',
  'l1yupd',
  'l2yupd',
  'nl1y',
  'nl2y',
]
const firstMismatch = (s: ScrollState, r: CaptureRow) => sharedFirstMismatch(s, r, FIELDS)

describe.skipIf(!vanillaRomPresent || !fs.existsSync(CSV))(
  'scrollSim - $0D4 capture validation (L2 cmd $03, oscillating Y)',
  () => {
    it('frame 1 matches post-cmd-$03-setup state', () => {
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
        console.warn(`[$0D4] post-setup mismatch: ${m}`)
        console.warn(
          `  cap row 1: l1=(${r0.l1x},${r0.l1y}) l2=(${r0.l2x},${r0.l2y}) types=(${r0.l1type},${r0.l2type}) timers=(${r0.l1timer},${r0.l2timer}) xupds=(${r0.l1xupd},${r0.l2xupd}) yupds=(${r0.l1yupd},${r0.l2yupd})`,
        )
        console.warn(
          `  sim   f0: l1=(${f0.layer1XPos},${f0.layer1YPos}) l2=(${f0.layer2XPos},${f0.layer2YPos}) types=(${f0.layer1ScrollType},${f0.layer2ScrollType}) timers=(${f0.layer1ScrollTimer},${f0.layer2ScrollTimer}) xupds=(${f0.layer1ScrollXPosUpd},${f0.layer2ScrollXPosUpd}) yupds=(${f0.layer1ScrollYPosUpd},${f0.layer2ScrollYPosUpd})`,
        )
      }
      expect(m).toBe(null)
    })

    it('cmd $03 oscillation matches every active captured frame', () => {
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
      let activeFrames = 0
      for (let r = 1; r < cap.length; r++) {
        const cur = cap[r - 1],
          nxt = cap[r]
        if (
          cur.l2xspd === nxt.l2xspd &&
          cur.l2yspd === nxt.l2yspd &&
          cur.l2xupd === nxt.l2xupd &&
          cur.l2yupd === nxt.l2yupd &&
          cur.nl1y === nxt.nl1y &&
          cur.nl2y === nxt.nl2y
        )
          break
        activeFrames = r
      }
      for (let r = 1; r <= activeFrames; r++) {
        const m = firstMismatch(sim.stateAtFrame(r - 1), cap[r - 1])
        if (m !== null) {
          throw new Error(`Mismatch at capture row ${r}/${activeFrames}: ${m}`)
        }
      }
    })
  },
)
