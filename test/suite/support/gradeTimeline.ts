/**
 * Which MAIN pass of the sprite runner corresponds to the frame Mesen caught a sprite drawing.
 * Test oracle only.
 *
 * A level-start sprite (INIT in GM12, `initFrame + 1 < gateFrame`) is counted in passes from the
 * capture's `gateFrame`, the first GM14 frame: pass `max(0, drawnFrame - gateFrame)` (#875). Frames
 * before it (GM13's fade, and the capture's incomplete first draw, #1382) are not passes: GM13
 * (GMTransitionMosaic, SMWDisX bank_00.asm:4075-4103) calls no sprite code, and the level setup
 * clears SpriteLock (bank_00.asm:4996). The pass-0 offset is NOT traced: the data fits pass 0 at
 * the gate, not the pass 1 the GM12 MAIN (bank_00.asm:2826, 4866) would predict; two candidates
 * (that MAIN not running for these sprites, or the runner's INIT frame already counting it) are
 * untested. Evidence scope: vanilla, one machine, Mesen captures `layers_v5`; of 169 level-start
 * records 126 have anchor == gate, where the anchor rule already gives the same pass; maps 0C3
 * ($49) and 130 ($76) go from wrong to exact. Any other sprite (spawned in play, possibly during
 * the entrance wait) is `drawnFrame - max(anchorFrame, initFrame + 1)` passes in: before the
 * anchor Mario is held at a leftover position and the level is still being set up.
 */

import type { RomFile } from '../../../src/rom/RomFile'
import { FIRST_SPECIAL, shellLoad } from '../../../src/rom/sprites/ShellSprites'

/** Largest pass index the grader will run for one record; a larger k falls back. */
export const MAX_GRADED_PASS = 255

/**
 * The pass a level-start sprite's drawn frame falls on (see the header), or undefined when the sprite
 * is not level-start or a field is missing. Not range-checked: `gradedPass` does that.
 */
export function levelStartPass(
  initFrame: number | undefined,
  gateFrame: number | undefined,
  drawnFrame: number | undefined,
): number | undefined {
  if (![initFrame, gateFrame, drawnFrame].every(Number.isInteger)) return undefined
  if (initFrame! + 1 >= gateFrame!) return undefined
  return Math.max(0, drawnFrame! - gateFrame!)
}

/** The pass index to grade, or undefined when a field is missing or k is out of range. `gateFrame` is optional: without it every sprite takes the anchor rule. */
export function gradedPass(
  initFrame: number | undefined,
  anchorFrame: number | undefined,
  drawnFrame: number | undefined,
  gateFrame?: number,
): number | undefined {
  const level = levelStartPass(initFrame, gateFrame, drawnFrame)
  if (level !== undefined) return level <= MAX_GRADED_PASS ? level : undefined
  if (![initFrame, anchorFrame, drawnFrame].every(Number.isInteger)) return undefined
  const k = drawnFrame! - Math.max(anchorFrame!, initFrame! + 1)
  return k >= 0 && k <= MAX_GRADED_PASS ? k : undefined
}

/** Mario's WRAM cells: $94/$96 (Next) and $D1/$D3 (Now), each 16 bit little endian. */
const MARIO_CELLS = [0x94, 0x96, 0xd1, 0xd3] as const

/** Writes the capture's marioStart into both copies of Mario's position (after INIT, before MAIN). */
export function writeMarioStart(w: Uint8Array, m: { x: number; y: number }): void {
  const put = (a: number, v: number): void => {
    w[a] = v & 0xff
    w[a + 1] = (v >> 8) & 0xff
  }
  put(MARIO_CELLS[0], m.x)
  put(MARIO_CELLS[1], m.y)
  put(MARIO_CELLS[2], m.x)
  put(MARIO_CELLS[3], m.y)
}

/** The capture-record fields the timeline reads. */
interface TimedRec {
  initFrame?: number
  drawnFrame?: number
  trueFrame?: number
  effFrame?: number
}

/**
 * Per-record seed and probe for grading on the hardware timeline. It mirrors gradeAll in
 * spriteGrade.captures.test.ts (that loop is a copy, not a caller) for the report and its test.
 * `k` is undefined (and `timed` false) when a field is missing or out of range: the caller then
 * grades the old way. Otherwise it seeds `seedExtra`, runs with `probe`, and sets `m.chosen = k`
 * when `m.passes[k]` exists.
 */
export function timelineFor(
  rec: TimedRec,
  anchorFrame: number | undefined,
  marioStart: { x: number; y: number } | undefined,
  gateFrame?: number,
  basePasses = 64,
): {
  k: number | undefined
  timed: boolean
  mainPasses: number
  seedExtra: { trueFrame?: number; effFrame?: number }
  probe: ((p: number, w: Uint8Array) => void) | undefined
} {
  const k = gradedPass(rec.initFrame, anchorFrame, rec.drawnFrame, gateFrame)
  const timed = k !== undefined && marioStart !== undefined
  // Pass p runs at seed + 1 + p only when INIT takes one frame, so pass k lands on the recorded counters.
  const seedExtra =
    timed && rec.trueFrame !== undefined && rec.effFrame !== undefined
      ? { trueFrame: (rec.trueFrame - 1 - k) & 0xff, effFrame: (rec.effFrame - 1 - k) & 0xff }
      : {}
  const probe = timed
    ? (p: number, w: Uint8Array): void => {
        if (p === -1) writeMarioStart(w, marioStart) // after INIT, before the first MAIN pass
      }
    : undefined
  return { k, timed, mainPasses: Math.max(basePasses, timed ? k + 1 : 0), seedExtra, probe }
}

/** One placed sprite from a capture's sprites.json. */
export interface PlacedSprite {
  index?: number
  id?: string
}

/**
 * The id to hand the runner for a capture record. The record's own id is the sprite number
 * Mesen read at the draw, which the loader has already rewritten for a stationary shell (list id
 * $DA-$DD or $DF becomes $04-$07 or $09, #837); the runner must be given the placed list id, which
 * sprites.json keeps under the record's listIndex. Any other record runs under its own id.
 */
export function runnerId(
  rom: RomFile,
  id: number,
  listIndex: number | undefined,
  entries: readonly PlacedSprite[] | undefined,
): number {
  if (listIndex === undefined) return id
  const placed = entries?.find(e => e.index === listIndex)?.id
  const listId = placed === undefined ? NaN : parseInt(placed.slice(1), 16)
  return Number.isNaN(listId) ? id : shellLoad(rom, listId).shell?.number === id ? listId : id
}

/**
 * The list id when the loader places it as a sprite whose INIT runs under that number, else undefined
 * (the capture's id is then all there is). Below $C9 only (SMWDisX bank_02.asm:5365-5370). Shells ($DA-$DD,
 * $DF) get status 9 and no INIT (5361), so they never reach the facing comparison. Not modeled:
 * the special-world remap (5464-5471) and the Silver P-Switch coin (5477-5487); neither fires in these captures.
 */
export function placedInitId(listId: number): number | undefined {
  return listId < FIRST_SPECIAL ? listId : undefined
}
