/**
 * The handlers the map expander draws from the bounded interpreter instead of
 * a hand port (en-gen/hackbench#342, first slice of #351 phase 2).
 *
 * The interpreter reads the handler's own bytes from THIS ROM. When it
 * refuses, the caller draws the port and this records the reason, so the
 * picture is never blank and never claims a verification it did not get.
 */

import type { Cursor } from './cursor'
import type { RomFile } from '../RomFile'
import {
  ENTRY_STANDARD,
  applyWrites,
  horizontalPlacement,
  interpret,
  seedFromGrid,
  type InterpretOptions,
} from './interpret'
import { mirror, noteUnverified } from './interpretedGate'

/** LevLoadNrmObj: SEP #$30; JSL CODE_0DA40F; RTS (bank_05.asm:805-808). */
const LOADER_ROUTINE = 0x0586ea
const LOADER_LEN = 7
/** The `JSR LevLoadNrmObj` in LoadLevelData (bank_05.asm:788): where the loader reaches that routine. */
const LOADER_CALL_SITE = 0x0586cf
/** `LDA LvlLoadObjNo; BNE +6` (bank_05.asm:783-784): the branch that sends a standard object to that call. */
const LOADER_BRANCH = 0x0586c5
const LOADER_BRANCH_BYTES = [0xa5, 0x5a, 0xd0, 0x06]

/**
 * Why the loader no longer reaches ENTRY_STANDARD, or null when it does. The
 * routine is read as bytes: SEP, JSL, RTS, with the JSL operand compared
 * bank-mirror normalized, and so is the JSR that reaches it. A hack that re-points the JSL is drawn from the port.
 */
function loaderProblem(rom: RomFile): string | null {
  const branch = rom.readAt(LOADER_BRANCH, LOADER_BRANCH_BYTES.length)
  if (!branch || LOADER_BRANCH_BYTES.some((v, i) => branch[i] !== v))
    return `the loader's branch to its standard-object call at ${hex6(LOADER_BRANCH)} is not LDA $5A, BNE +6`
  const call = rom.readAt(LOADER_CALL_SITE, 3)
  if (!call || call[0] !== 0x20 || (call[1] | (call[2] << 8)) !== (LOADER_ROUTINE & 0xffff))
    return `the loader's call at ${hex6(LOADER_CALL_SITE)} is not JSR ${hex6(LOADER_ROUTINE)}`
  const b = rom.readAt(LOADER_ROUTINE, LOADER_LEN)
  if (!b || b[0] !== 0xe2 || b[1] !== 0x30 || b[2] !== 0x22 || b[6] !== 0x60)
    return `the loader's routine at ${hex6(LOADER_ROUTINE)} is not SEP, JSL, RTS`
  const to = b[3] | (b[4] << 8) | (b[5] << 16)
  return mirror(to) === mirror(ENTRY_STANDARD)
    ? null
    : `the loader's JSL at ${hex6(LOADER_ROUTINE + 2)} reaches ${hex6(to)}, not ${hex6(ENTRY_STANDARD)}`
}

export interface InterpretedDraw {
  vertical: boolean
  /** One line per distinct reason a port drew an object the interpreter refused. */
  unverified: string[]
  /** Test seam: enter here, with these options, instead of the loader's entry. */
  entry?: number
  options?: InterpretOptions
  /** The drawing function itself, so the expander never imports it (see interpretedGate.ts). */
  draw: DrawInterpreted
}

export type DrawInterpreted = (cur: Cursor, handler: number, ctx: InterpretedDraw) => boolean

/** What a caller of expandMap hands over: the note sink and the function that fills it. */
export type InterpretedSink = Pick<InterpretedDraw, 'unverified' | 'draw'>

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** True when the interpreter drew the object; false leaves it to the port, with the reason recorded. */
export function drawInterpreted(cur: Cursor, handler: number, ctx: InterpretedDraw): boolean {
  const note = (why: string): false => {
    noteUnverified(ctx.unverified, handler, why)
    return false
  }
  if (ctx.vertical) return note('vertical levels are not interpreted yet')
  if (ctx.entry === undefined) {
    const why = loaderProblem(cur.rom)
    if (why) return note(why)
  }
  const r = interpret(
    cur.rom,
    ctx.entry ?? ENTRY_STANDARD,
    horizontalPlacement('standard', cur.objNo, cur.size, cur.col, cur.row),
    { tileset: cur.tileset, switchFlags: cur.switchFlags },
    {
      entryCall: ctx.entry === undefined ? 'jsl' : 'jsr',
      seed: seedFromGrid(cur.grid),
      ...ctx.options,
    },
  )
  if (r.refusal) return note(`${r.refusal.reason} at ${hex6(r.refusal.at)}`)
  const reached = r.dispatches[r.dispatches.length - 1] ?? 0
  if (ctx.entry === undefined && mirror(reached) !== mirror(handler))
    return note(`the ROM's dispatch reaches ${hex6(reached)}`)
  applyWrites(cur.grid, r.writes, cur.owners, cur.owner)
  return true
}
