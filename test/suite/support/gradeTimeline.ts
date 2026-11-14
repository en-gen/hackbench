/**
 * Which MAIN pass of the sprite runner corresponds to the frame Mesen caught a sprite drawing.
 * Test oracle only.
 *
 * A map-start sprite (its INIT ran in GM12: `initFrame <= gateFrame`) is counted in passes from the capture's
 * `gateFrame`, the last GM13 frame: pass `max(0, drawnFrame - gateFrame)` (#875). Any other sprite (spawned in
 * play, possibly during the entrance wait) is `drawnFrame - max(anchorFrame, initFrame + 1)` passes in.
 * Scope: maps without an entrance reload (capture_summary `reloadDuringWait` false); on a reload map `gateFrame`
 * is the entrance room's first GM14 frame, so its map-start sprites have init > gate and keep the anchor rule
 * (#1397). The derivation, with SMWDisX and harness line numbers, is in docs/testing.md, "Map-start sprites in the
 * sprite grader".
 */

import type { RomFile } from '../../../src/rom/RomFile'
import { FIRST_SPECIAL, shellLoad } from '../../../src/rom/sprites/ShellSprites'

/** Largest pass index the grader will run for one record; a larger k falls back. */
export const MAX_GRADED_PASS = 255

/**
 * A capture's gate frame, or an error naming the map. The harness writes `levelGateFrame or 0` when it never saw
 * GM14 (headless_capture.lua:1147), so a missing or non-positive value is a broken capture, not a reason to
 * quietly grade every sprite by the anchor rule.
 */
export function requireGateFrame(map: string, gateFrame: unknown): number {
  if (typeof gateFrame !== 'number' || !Number.isInteger(gateFrame) || gateFrame <= 0)
    throw new Error(
      `map ${map}: capture_summary.json has no usable gateFrame (${String(gateFrame)})`,
    )
  return gateFrame
}

/**
 * The pass a map-start sprite's drawn frame falls on, or undefined when the sprite was spawned in play or a field
 * is missing. `initFrame <= gateFrame` is the whole test: no INIT is stamped between GM12 and the gate.
 * Not range-checked: `gradedPass` does that.
 */
export function mapStartPass(
  initFrame: number | undefined,
  gateFrame: number,
  drawnFrame: number | undefined,
): number | undefined {
  if (![initFrame, drawnFrame].every(Number.isInteger)) return undefined
  if (initFrame! > gateFrame) return undefined
  return Math.max(0, drawnFrame! - gateFrame)
}

/** The pass index to grade, or undefined when a field is missing or k is out of range. */
export function gradedPass(
  initFrame: number | undefined,
  anchorFrame: number | undefined,
  drawnFrame: number | undefined,
  gateFrame: number,
): number | undefined {
  const mapStart = mapStartPass(initFrame, gateFrame, drawnFrame)
  if (mapStart !== undefined) return mapStart <= MAX_GRADED_PASS ? mapStart : undefined
  if (![initFrame, anchorFrame, drawnFrame].every(Number.isInteger)) return undefined
  const k = drawnFrame! - Math.max(anchorFrame!, initFrame! + 1)
  return k >= 0 && k <= MAX_GRADED_PASS ? k : undefined
}

/** Whether a record is graded on the hardware timeline (a pass k and a Mario start exist) or falls back to the first drawing pass. */
export const isTimed = (k: number | undefined, marioStart: unknown): boolean =>
  k !== undefined && marioStart !== undefined

/** Counters the grader keeps apart so a fallback or a miss cannot hide in the wrong total. */
export interface TimelineTally {
  fallbacks: number
  missAtK: number
}

/**
 * After the run: a timed record grades at pass k (`m.chosen = k`); when that pass drew nothing it is a miss, counted
 * apart; an untimed record is a fallback. A k past the passes run changes nothing.
 */
export function settleGradedPass(
  m: { chosen?: number; passes: { parts: unknown[] }[] },
  k: number | undefined,
  timed: boolean,
  tally: TimelineTally,
): void {
  if (!timed) tally.fallbacks++
  else if (m.passes[k!]) {
    m.chosen = k
    if (!m.passes[k!]!.parts.length) tally.missAtK++
  }
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
  gateFrame: number,
  basePasses = 64,
): {
  k: number | undefined
  timed: boolean
  mainPasses: number
  seedExtra: { trueFrame?: number; effFrame?: number }
  probe: ((p: number, w: Uint8Array) => void) | undefined
} {
  const k = gradedPass(rec.initFrame, anchorFrame, rec.drawnFrame, gateFrame)
  const timed = isTimed(k, marioStart)
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
