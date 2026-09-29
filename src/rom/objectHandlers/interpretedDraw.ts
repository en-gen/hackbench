/**
 * The handlers the map expander draws from the bounded interpreter instead of
 * a hand port (en-gen/hackbench#342, first slice of #351 phase 2).
 *
 * The interpreter reads the handler's own bytes from THIS ROM. When it
 * refuses, the caller draws the port and this records the reason, so the
 * picture is never blank and never claims a verification it did not get.
 */

import { OWNER_NONE, type Cursor } from './cursor'
import {
  ENTRY_STANDARD,
  applyWrites,
  horizontalPlacement,
  interpret,
  seedFromGrid,
  type InterpretOptions,
} from './interpret'

/** Standard-object handlers drawn by the interpreter. CODE_0DADEB is the cloud slope (bank_0D.asm:2671). */
export const INTERPRETED_HANDLERS: ReadonlySet<number> = new Set([0x0dadeb])

export interface InterpretedDraw {
  vertical: boolean
  /** One line per distinct reason a port drew an object the interpreter refused. */
  unverified: string[]
  /** Test seam: enter here, with these options, instead of the loader's entry. */
  entry?: number
  options?: InterpretOptions
}

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** True when the interpreter drew the object; false leaves it to the port, with the reason recorded. */
export function drawInterpreted(cur: Cursor, handler: number, ctx: InterpretedDraw): boolean {
  const note = (why: string): false => {
    const line = `Handler ${hex6(handler)} is drawn by the built-in model, not verified against this ROM: ${why}.`
    if (!ctx.unverified.includes(line)) ctx.unverified.push(line)
    return false
  }
  if (ctx.vertical) return note('vertical levels are not interpreted yet')
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
  if (ctx.entry === undefined && r.dispatches.at(-1) !== handler)
    return note(`the ROM's dispatch reaches ${hex6(r.dispatches.at(-1) ?? 0)}`)
  applyWrites(cur.grid, r.writes, (row, col) => {
    const orow = cur.owners?.[row]
    if (!orow) return
    while (orow.length < col) orow.push(OWNER_NONE)
    orow[col] = cur.owner
  })
  return true
}
