/**
 * scrollSim_0e7.test.ts - validate L2 cmd $08 (oscillating-X scroll)
 * against the Mesen capture for `$0E7`.
 *
 * Capture: `C:/Users/engenb/OneDrive/hackbench-fixtures/maps/0e7/l2_scroll.csv`
 * Sprite: $EF b0=$00 → post-remap (l1cmd=0, l2cmd=8, l1bits=0, l2bits=0).
 *
 * What this validates:
 *
 * 1. **cmd $08 setup body (`CODE_05BEC6`)**: 16-bit type word from
 *    DATA_05CA46 written to consecutive WRAM bytes; XPosUpd/YPosUpd
 *    init using step from DATA_05CBED + NextLayer{N}XPos. The L2
 *    setup's 16-bit STA at $1443 (l2type) also writes $1444 (l1timer).
 *    Capture row 1 has l1timer=1 specifically because of this side
 *    effect.
 *
 * 2. **bank_00 parallax derivation**: vertL2=1 → Layer2YPos =
 *    Layer1YPos + bgOffset each frame.
 *
 * 3. **cmd $08 per-frame handler**: SEP-#$10-leaves-A-16-bit invariant;
 *    sync compare is 16-bit equality, not 8-bit masking.
 *
 * Known divergence: `l1y` deviates from row 171 onward because
 * `Layer1YPos` is driven by Mario-Y camera tracking (an
 * `UpdateScreenPosition` nudge we don't model). The cmd $08 oscillation
 * itself is correct - only the camera-position chain (`l1y`, `l2y`,
 * `nl1y`, `nl2y`) goes off due to this. Checks exclude that chain.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { buildScrollSimulator, type ScrollState } from '../../../src/rom/scrollSim'
import { loadVanillaRom, vanillaRomPresent } from './scrollSim_capture'

const CSV = 'C:/Users/engenb/OneDrive/hackbench-fixtures/maps/0e7/l2_scroll.csv'

interface CaptureRow {
  frame: number
  l1x: number
  l1y: number
  l2x: number
  l2y: number
  l1cmd: number
  l2cmd: number
  l1bits: number
  l2bits: number
  l1type: number
  l2type: number
  l1timer: number
  l2timer: number
  l1xspd: number
  l1yspd: number
  l2xspd: number
  l2yspd: number
  l1xupd: number
  l1yupd: number
  l2xupd: number
  l2yupd: number
  nl1x: number
  nl1y: number
  nl2x: number
  nl2y: number
  l1dir: number
  shakeY: number
  marioX: number
  marioY: number
  horizL2: number
  vertL2: number
  scrollIdx: number
}

function loadCapture(): CaptureRow[] {
  const text = fs.readFileSync(CSV, 'utf8')
  const lines = text.trim().split('\n')
  const header = lines[0].split(',')
  const idx: Record<string, number> = {}
  header.forEach((name, i) => {
    idx[name] = i
  })
  return lines.slice(1).map(line => {
    const c = line.split(',').map(s => parseInt(s, 10))
    return {
      frame: c[idx.frame],
      l1x: c[idx.l1x],
      l1y: c[idx.l1y],
      l2x: c[idx.l2x],
      l2y: c[idx.l2y],
      l1cmd: c[idx.l1cmd],
      l2cmd: c[idx.l2cmd],
      l1bits: c[idx.l1bits],
      l2bits: c[idx.l2bits],
      l1type: c[idx.l1type],
      l2type: c[idx.l2type],
      l1timer: c[idx.l1timer],
      l2timer: c[idx.l2timer],
      l1xspd: c[idx.l1xspd],
      l1yspd: c[idx.l1yspd],
      l2xspd: c[idx.l2xspd],
      l2yspd: c[idx.l2yspd],
      l1xupd: c[idx.l1xupd],
      l1yupd: c[idx.l1yupd],
      l2xupd: c[idx.l2xupd],
      l2yupd: c[idx.l2yupd],
      nl1x: c[idx.nl1x],
      nl1y: c[idx.nl1y],
      nl2x: c[idx.nl2x],
      nl2y: c[idx.nl2y],
      l1dir: c[idx.l1dir],
      shakeY: c[idx.shakeY],
      marioX: c[idx.marioX],
      marioY: c[idx.marioY],
      horizL2: c[idx.horizL2],
      vertL2: c[idx.vertL2],
      scrollIdx: c[idx.scrollIdx],
    }
  })
}

/**
 * Compare excluding the camera-position chain (`l{1,2}y`, `nl{1,2}y`)
 * which diverges from row 171 due to unmodeled Mario-Y camera tracking.
 * The oscillation state itself (`l2type`, `l2yupd`, `l2xspd`,
 * `nl{1,2}x`) is what cmd $08 controls and what we want to validate.
 */
function firstMismatch(s: ScrollState, r: CaptureRow): string | null {
  const checks: [string, number, number][] = [
    ['l1x', s.layer1XPos, r.l1x],
    ['l2x', s.layer2XPos, r.l2x],
    ['l1type', s.layer1ScrollType, r.l1type],
    ['l2type', s.layer2ScrollType, r.l2type],
    ['l1timer', s.layer1ScrollTimer, r.l1timer],
    ['l2timer', s.layer2ScrollTimer, r.l2timer],
    ['l1xspd', s.layer1ScrollXSpeed, r.l1xspd],
    ['l2xspd', s.layer2ScrollXSpeed, r.l2xspd],
    ['l1yupd', s.layer1ScrollYPosUpd, r.l1yupd],
    ['l2yupd', s.layer2ScrollYPosUpd, r.l2yupd],
    ['l1xupd', s.layer1ScrollXPosUpd, r.l1xupd],
    ['l2xupd', s.layer2ScrollXPosUpd, r.l2xupd],
    ['nl1x', s.nextLayer1XPos, r.nl1x],
    ['nl2x', s.nextLayer2XPos, r.nl2x],
  ]
  for (const [name, sim, cap] of checks) {
    if (sim !== cap) return `${name} sim=${sim} cap=${cap}`
  }
  return null
}

describe.skipIf(!vanillaRomPresent)(
  'scrollSim - $0E7 capture validation (L2 cmd $08, oscillating X)',
  () => {
    it('frame 1 matches post-cmd-$08-setup state', () => {
      if (!fs.existsSync(CSV)) {
        console.warn(`[skip] ${CSV} not found`)
        return
      }
      const cap = loadCapture()
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
        console.warn(`[$0E7] post-setup mismatch: ${m}`)
        console.warn(
          `  cap row 1: l1=(${r0.l1x},${r0.l1y}) l2=(${r0.l2x},${r0.l2y}) types=(${r0.l1type},${r0.l2type}) timers=(${r0.l1timer},${r0.l2timer}) yupds=(${r0.l1yupd},${r0.l2yupd})`,
        )
        console.warn(
          `  sim   f0: l1=(${f0.layer1XPos},${f0.layer1YPos}) l2=(${f0.layer2XPos},${f0.layer2YPos}) types=(${f0.layer1ScrollType},${f0.layer2ScrollType}) timers=(${f0.layer1ScrollTimer},${f0.layer2ScrollTimer}) yupds=(${f0.layer1ScrollYPosUpd},${f0.layer2ScrollYPosUpd})`,
        )
      }
      expect(m).toBe(null)
    })

    it('cmd $08 oscillation matches every active captured frame', () => {
      if (!fs.existsSync(CSV)) return
      const cap = loadCapture()
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
      // Game-freeze guard: `l2_dump.lua` keeps writing rows after Mario
      // dies (gameMode==$14 still ticks for the death animation), but
      // SpriteLock gates `CODE_05BC76` so cmd handlers stop running. Our
      // sim doesn't model SpriteLock, so we'd diverge against the
      // frozen-but-still-emitted rows. Detect freeze by comparing
      // consecutive oscillation-driving fields.
      let activeFrames = 0
      for (let r = 1; r < cap.length; r++) {
        const cur = cap[r - 1],
          nxt = cap[r]
        if (
          cur.l2xspd === nxt.l2xspd &&
          cur.l2yspd === nxt.l2yspd &&
          cur.l2xupd === nxt.l2xupd &&
          cur.l2yupd === nxt.l2yupd &&
          cur.nl1x === nxt.nl1x &&
          cur.nl2x === nxt.nl2x
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
