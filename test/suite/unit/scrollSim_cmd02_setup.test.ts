/**
 * scrollSim_cmd02_setup.test.ts — validate cmd $02 (Layer 2 Smash)
 * SETUP body against the three vanilla cmd-$02 captures.
 *
 * Per-frame validation is deferred: cmd $02's per-frame handler
 * shares the smash-loop body with the setup, but the captures show
 * extended "level intro" frames where SpriteLock gates the L2
 * dispatch in the SNES (`CODE_05BCA5:4546 BNE Return05BC49`). Our
 * simulator doesn't model SpriteLock so per-frame parity diverges
 * during the intro. The setup body produces the post-row-1 state we
 * can validate column-for-column.
 *
 * Captures:
 *   $01A b0=$00 → l1bits=0  → setup loop iter X=$0A, body skipped
 *                              (NextLayer2XPos=0 < $000A), post-loop
 *                              math sets l1timer=$80, l2type=$12
 *   $111 b0=$04 → l1bits=12 → setup loop iter X=$16, body skipped
 *                              (NextLayer2XPos=0 < $0E80), same
 *                              post-loop output
 *   $1CF b0=$08 → l1bits=24 → setup loop iter X=$22, body RUNS
 *                              (NextLayer2XPos=0 in [$0000, $0080)) →
 *                              l1type=$10, then post-loop sets
 *                              l1timer=$40
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { loadCapture, firstMismatch, simFromCapture , vanillaRomPresent } from './scrollSim_capture'

const FIXTURES = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps'

const LEVELS: readonly { id: string; expectedL1Type: number; expectedL1Timer: number }[] = [
  // Verified by tracing CODE_05BF6A → CODE_05C95B with Y=1 across the
  // three vanilla cmd-$02 levels:
  { id: '01a', expectedL1Type: 0x00, expectedL1Timer: 0x80 },
  { id: '111', expectedL1Type: 0x00, expectedL1Timer: 0x80 },
  { id: '1cf', expectedL1Type: 0x10, expectedL1Timer: 0x40 },
]

describe.skipIf(!vanillaRomPresent)('scrollSim — cmd $02 setup body validation', () => {
  for (const lvl of LEVELS) {
    const csv = `${FIXTURES}/${lvl.id}/l2_scroll.csv`
    describe(`$${lvl.id.toUpperCase()}`, () => {
      it('post-setup state matches capture row 1', () => {
        if (!fs.existsSync(csv)) {
          console.warn(`[skip] ${csv} not found`)
          return
        }
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0])
        const m = firstMismatch(sim.stateAtFrame(0), cap[0])
        if (m !== null) {
          const r = cap[0]
          const f0 = sim.stateAtFrame(0)
          console.warn(`[$${lvl.id}] post-setup mismatch: ${m}`)
          console.warn(`  cap row 1: l1=(${r.l1x},${r.l1y}) l2=(${r.l2x},${r.l2y}) types=(${r.l1type},${r.l2type}) timers=(${r.l1timer},${r.l2timer})`)
          console.warn(`  sim   f0: l1=(${f0.layer1XPos},${f0.layer1YPos}) l2=(${f0.layer2XPos},${f0.layer2YPos}) types=(${f0.layer1ScrollType},${f0.layer2ScrollType}) timers=(${f0.layer1ScrollTimer},${f0.layer2ScrollTimer})`)
        }
        expect(m).toBe(null)
      })

      it(`l1type=$${lvl.expectedL1Type.toString(16).padStart(2, '0').toUpperCase()} matches the analytic trace`, () => {
        if (!fs.existsSync(csv)) return
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0])
        expect(sim.stateAtFrame(0).layer1ScrollType).toBe(lvl.expectedL1Type)
      })

      it(`l1timer=$${lvl.expectedL1Timer.toString(16).padStart(2, '0').toUpperCase()} matches the analytic trace`, () => {
        if (!fs.existsSync(csv)) return
        const cap = loadCapture(csv)
        const sim = simFromCapture(cap[0])
        expect(sim.stateAtFrame(0).layer1ScrollTimer).toBe(lvl.expectedL1Timer)
      })
    })
  }
})
