/**
 * Which MAIN pass of the sprite runner corresponds to the frame Mesen caught a sprite drawing.
 * Test oracle only.
 *
 * A level-start sprite (INIT in GM12, `initFrame <= gateFrame`) is counted in passes from the capture's
 * `gateFrame`: pass `max(0, drawnFrame - gateFrame)` (#875). Why, from the code (SMWDisX plus the capture harness
 * source, one reading, checked by the verifier; the Mesen frame timing below is an inference, not verified):
 * - GM12 runs the loader's INIT and then one MAIN (bank_00.asm:4860, bank_05.asm:72, bank_02.asm:5172; 4866-4873
 *   to CODE_009860, bank_00.asm:2826): that MAIN is pass 0. GM12 and its INIT are skipped when IRQNMICommand is
 *   negative (bank_00.asm:4862-4864, bank_02.asm:5171).
 * - GM13 (GMTransitionMosaic, bank_00.asm:4075-4103) runs no sprite code: the callers of CODE_01808C are exactly
 *   bank_00.asm:2826, 2922, 4534 (GM14) and bank_02.asm:5172, and the level setup clears SpriteLock (4996).
 * - The harness stamps frames by WRAM writes to $0200-$049F, not PPU OAM (headless_capture.lua:1285-1293),
 *   frame = frame + 1 (1768) in onFrame on endFrame (2128); `drawnFrame` 1417/1421, `firstRealFrame` 1317.
 *   `gateFrame` is `levelGateFrame` (1884), set the first time onFrame reads GameMode == $14 (1797): that is
 *   the endFrame of the game frame whose INC GameMode (bank_00.asm:4094) left GM13, so G is the LAST GM13 frame
 *   and the first GM14 MAIN is stamped G + 1. A draw stamped D is therefore pass D - G.
 * Assumes Mesen fires endFrame before the NMI handler and no GM14 lag frame between G and D (one would
 * overstate the pass). No sprite code runs in GM13, so no INIT is stamped between GM12 and G: INIT at or
 * before G is GM12's. Evidence: maps 0C3 ($49), 130 ($76) and 0D0 ($6F idx 29) go from wrong to exact; of
 * 169 level-start records 126 have anchor == gate, where the anchor rule gave the same pass. Vanilla, one
 * machine. Any other sprite (spawned in play, possibly during the entrance wait) is
 * `drawnFrame - max(anchorFrame, initFrame + 1)` passes in: before the anchor Mario is held at a leftover
 * position and the level is still being set up.
 */

import type { RomFile } from '../../../src/rom/RomFile'
import { FIRST_SPECIAL, shellLoad } from '../../../src/rom/sprites/ShellSprites'

/** Largest pass index the grader will run for one record; a larger k falls back. */
export const MAX_GRADED_PASS = 255

/**
 * Passes added to `drawnFrame - gateFrame` for a level-start sprite: 0, because G is the last GM13 frame and the
 * first GM14 MAIN is G + 1 (see the header). Map 127 $16 and 1bf $15 grade exact at 0 and close at 1. One
 * constant so it is the one place to change; the tests are written against it.
 */
export const LEVEL_START_PASS_OFFSET = 0

/**
 * The pass a level-start sprite's drawn frame falls on (see the header), or undefined when the sprite
 * is not level-start or a field is missing. Level start means INIT ran in GM12: the loader's INIT is there
 * (SMWDisX bank_05.asm:72) and GM13 runs no sprite code (bank_00.asm:4075-4103), so no INIT is stamped
 * between GM12 and the gate frame G (the last GM13 frame): `initFrame <= gateFrame` is the whole test.
 * Not range-checked: `gradedPass` does that.
 */
export function levelStartPass(
  initFrame: number | undefined,
  gateFrame: number | undefined,
  drawnFrame: number | undefined,
): number | undefined {
  if (![initFrame, gateFrame, drawnFrame].every(Number.isInteger)) return undefined
  if (initFrame! > gateFrame!) return undefined
  return Math.max(0, drawnFrame! - gateFrame! + LEVEL_START_PASS_OFFSET)
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
