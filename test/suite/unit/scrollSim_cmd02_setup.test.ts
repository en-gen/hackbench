/**
 * scrollSim_cmd02_setup.test.ts — validate cmd $02 (Layer 2 Smash)
 * SETUP body and per-frame smash logic against the three vanilla
 * cmd-$02 captures.
 *
 * SETUP tests: row-1 post-setup state and known type/timer values.
 *
 * PER-FRAME tests: smash zone detection + post-loop math column-for-
 * column from SpriteLock-cleared frame to last active frame. SpriteLock
 * prevents cmd $02 from running during the level intro (`CODE_05BCA5`
 * BNE guard). We skip intro frames by detecting the first frame where
 * `l1timer` decrements from its post-setup value, then seed from that
 * point with the full capture state.
 *
 * Camera override: `applyParallaxDerivation` sets `nextLayer2XPos =
 * layer1XPos`. The sim's +1 px/frame camera approximation only advances
 * `nextLayer1XPos`, not `nextLayer2XPos`, so cmd $02 (which reads
 * `nextLayer2XPos`) is unaffected by the approx. We still override
 * `nextLayer2XPos = cap[r].l1x` each frame to drive it directly from
 * the real SNES camera position, bypassing all camera-tracking state.
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
import {
  loadCapture, firstMismatch, simFromCapture, detectActiveFrames,
  loadVanillaRom, type CaptureRow, type FieldKey, vanillaRomPresent,
} from './scrollSim_capture'
import { cmd02L2 } from '../../../src/rom/scroll/cmd02'
import type { ScrollState } from '../../../src/rom/scrollSim'

const FIXTURES = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps'

/** Build a minimal ScrollState from a CaptureRow. Populates all fields
 *  present in the CSV; leaves gameplay-only fields (backgroundVertOffset,
 *  playerXPosNext, etc.) at safe defaults. */
function stateFromCapture(r: CaptureRow): ScrollState {
  return {
    frame: r.frame,
    layer1XPos: r.l1x,         layer1YPos: r.l1y,
    layer2XPos: r.l2x,         layer2YPos: r.l2y,
    layer1ScrollCmd:  r.l1cmd, layer2ScrollCmd:  r.l2cmd,
    layer1ScrollBits: r.l1bits, layer2ScrollBits: r.l2bits,
    layer1ScrollType:  r.l1type,  layer2ScrollType:  r.l2type,
    layer1ScrollTimer: r.l1timer, layer2ScrollTimer: r.l2timer,
    layer1ScrollXSpeed: r.l1xspd, layer1ScrollYSpeed: r.l1yspd,
    layer2ScrollXSpeed: r.l2xspd, layer2ScrollYSpeed: r.l2yspd,
    layer1ScrollXPosUpd: r.l1xupd, layer1ScrollYPosUpd: r.l1yupd,
    layer2ScrollXPosUpd: r.l2xupd, layer2ScrollYPosUpd: r.l2yupd,
    scrollLayerIndex: 4,
    layer1ScrollDir: r.l1dir,
    nextLayer1XPos: r.nl1x, nextLayer1YPos: r.nl1y,
    nextLayer2XPos: r.nl2x, nextLayer2YPos: r.nl2y,
    playerXPosNext: r.marioX, playerYPosNext: r.marioY,
    screenShakeYOffset: r.shakeY,
    horizLayer2Setting: r.horizL2, vertLayer2Setting: r.vertL2,
    onOffSwitch: 0, layer2Touched: 0, lastScreenHoriz: 0x1F,
    backgroundVertOffset: 0,
  }
}

const PERFRAME_FIELDS: readonly FieldKey[] = ['l2type', 'l1timer', 'nl2y', 'l2yspd', 'l2yupd']

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

      it('per-frame smash zone + post-loop math matches capture from SpriteLock-cleared frame', () => {
        // Validates CODE_05C95B (zone loop) + CODE_05C8C8/05C8FE/05C934
        // (smash-math tables) via bank_05.asm:6133-6192.
        //
        // SpriteLock skipped: cmd $02 only runs in-game once SpriteLock
        // clears (CODE_05BCA5 BNE guard). We skip intro frames by finding
        // the first row where l1timer decrements from its post-setup value,
        // then seed the carry state from that row via stateFromCapture.
        //
        // Camera override: cmd $02 reads nextLayer2XPos, which
        // applyParallaxDerivation sets = layer1XPos (horizSetting=1).
        // We override nextLayer2XPos = cap[r].l1x each frame so the zone
        // detection uses the actual SNES camera position, not the sim's
        // +1 px/frame approximation.
        if (!fs.existsSync(csv)) return
        const cap = loadCapture(csv)
        const rom = loadVanillaRom()

        const setupTimer = cap[0].l1timer
        let introEnd = -1
        for (let r = 1; r < cap.length; r++) {
          if (cap[r].l1timer !== setupTimer) { introEnd = r; break }
        }
        if (introEnd < 0) {
          console.warn(`[$${lvl.id}] l1timer never changed — SpriteLock period covers entire capture`)
          return
        }

        const lastActive = detectActiveFrames(cap)
        let s = stateFromCapture(cap[introEnd - 1])

        for (let r = introEnd; r <= lastActive; r++) {
          // Drive nextLayer2XPos directly from capture camera position.
          // horizLayer2Setting=1 → nextLayer2XPos = layer1XPos, so
          // cap[r].l1x is the canonical smash-zone input for this frame.
          const driven = { ...s, nextLayer2XPos: cap[r].l1x, scrollLayerIndex: 4 }
          const out = cmd02L2(driven, rom)
          s = out
          const m = firstMismatch(out, cap[r], PERFRAME_FIELDS)
          if (m !== null) {
            throw new Error(
              `[$${lvl.id.toUpperCase()}] frame ${cap[r].frame} (row ${r + 1}): ${m}`,
            )
          }
        }
      })
    })
  }
})
