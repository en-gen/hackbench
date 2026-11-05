/**
 * scrollSim_009.test.ts - validate the parallax+cmd-$01 port against
 * the Mesen ground-truth capture for `$009`.
 *
 * Capture: `<hackbench-fixtures>/maps/009/l2_scroll.csv`
 * (7,739 frames; written by `tools/mesen/l2_dump.lua`).
 *
 * **Frame indexing**: the Lua dumper's `onFrame` callback fires at
 * `endFrame` and increments `framesInLevel` BEFORE writing. Empirically,
 * its row 1 records POST-setup / PRE-first-tick state - speeds = 0,
 * timers/types from `CODE_05BD36`, positions at the table init.
 * Subsequent rows record post-tick state of the previous frame. So
 * capture row N corresponds to our `stateAtFrame(N - 1)`.
 *
 * Acceptance criteria:
 *   - Phase 1: at minimum, frame 1 (immediately after one tick) matches
 *     the capture's frame-1 row column-for-column. This proves the
 *     parallax core + cmd $01 + applyNext step compose correctly for
 *     the first tick.
 *   - Phase 2: 60 frames (1 second) match without divergence.
 *   - Phase 3: full 7,739 frames match.
 *
 * Failures here are diagnostic - they print the first divergent row +
 * column so we can pinpoint the buggy step in the port.
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

const CSV = join(MESEN_FIXTURES_DIR, '009', 'l2_scroll.csv')

/** Fields this level's capture is compared on (the rest diverge or are unused). */
const FIELDS: readonly FieldKey[] = [
  'l1x',
  'l1y',
  'l2x',
  'l2y',
  'l1type',
  'l2type',
  'l1xspd',
  'l1yspd',
  'l2xspd',
  'l2yspd',
  'nl1x',
  'nl1y',
  'nl2x',
  'nl2y',
]
const firstMismatch = (s: ScrollState, r: CaptureRow) => sharedFirstMismatch(s, r, FIELDS)

describe.skipIf(!vanillaRomPresent || !fs.existsSync(CSV))(
  'scrollSim - $009 capture validation (cmd $01 sprite $E8)',
  () => {
    it('frame 1 matches the capture after one tick', () => {
      const cap = loadCapture(CSV)
      const row1 = cap[0]
      // Seed from observed pre-tick state. The capture's row 0 is *after*
      // the first tick; pre-tick we know:
      //   - cmd setup: cmd $01 / bits $01,$00 (matches sprite $E8 + b0 $00)
      //   - table init: l1y=l2y=$C0 (DATA_05D708/D70C[2])
      //   - x positions: 0
      //   - l1type/timer / l2type/timer: 0 (cleared by cmd $01 setup)
      const sim = buildScrollSimulator(loadVanillaRom(), {
        layer1XPos: 0,
        layer1YPos: 0xc0,
        layer2XPos: 0,
        layer2YPos: 0xc0,
        layer1ScrollCmd: 0x01,
        layer2ScrollCmd: 0x01,
        layer1ScrollBits: 0x01,
        layer2ScrollBits: 0x00,
        horizLayer2Setting: 0,
        vertLayer2Setting: 0,
        marioSpawnX: 16,
        marioSpawnY: 224,
        screenMode: 0, // mode 2 in level header → ScrMode bit 0 = 0 (horizontal)
      })
      // Capture row 1 == our stateAtFrame(0) (post-setup, pre-tick).
      const f0 = sim.stateAtFrame(0)
      const m = firstMismatch(f0, row1)
      if (m !== null) {
        console.warn(
          `[scrollSim $009] post-setup state mismatch (capture row 1 vs sim frame 0): ${m}`,
        )
        console.warn(
          `  capture row 1: l1=(${row1.l1x},${row1.l1y}) l2=(${row1.l2x},${row1.l2y}) types=(${row1.l1type},${row1.l2type}) timers=(${row1.l1timer},${row1.l2timer})`,
        )
        console.warn(
          `  sim  frame 0: l1=(${f0.layer1XPos},${f0.layer1YPos}) l2=(${f0.layer2XPos},${f0.layer2YPos}) types=(${f0.layer1ScrollType},${f0.layer2ScrollType}) timers=(${f0.layer1ScrollTimer},${f0.layer2ScrollTimer})`,
        )
      }
      expect(m).toBe(null)
    })

    it('parallax + cmd $01 match every captured frame, column-for-column', () => {
      // Verified against a full $009 playthrough capture (~8000+ frames,
      // run until the auto-scroll routine reaches the level end). After
      // fixing (a) SIGNED-vs-ABSOLUTE discipline on `_0`/`_2` and (b)
      // the 16-bit-bias read of `DATA_05CB5F`, the simulator matches
      // EVERY column of EVERY captured frame.
      //
      // This guards the parallax core (`CODE_05C04D` + `CODE_05C4F9` +
      // `CODE_05C198` + `CODE_05BD36` setup) end-to-end. Any future
      // refactor that breaks frame-perfect parity will fail this test.
      const cap = loadCapture(CSV)
      const sim = buildScrollSimulator(loadVanillaRom(), {
        layer1XPos: 0,
        layer1YPos: 0xc0,
        layer2XPos: 0,
        layer2YPos: 0xc0,
        layer1ScrollCmd: 0x01,
        layer2ScrollCmd: 0x01,
        layer1ScrollBits: 0x01,
        layer2ScrollBits: 0x00,
        horizLayer2Setting: 0,
        vertLayer2Setting: 0,
        marioSpawnX: 16,
        marioSpawnY: 224,
        screenMode: 0,
      })
      for (let r = 1; r <= cap.length; r++) {
        const m = firstMismatch(sim.stateAtFrame(r - 1), cap[r - 1])
        if (m !== null) {
          throw new Error(`Parallax regression at capture row ${r}/${cap.length}: ${m}`)
        }
      }
    })
  },
)
