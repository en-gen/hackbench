/**
 * The handlers the map expander draws from the bounded interpreter instead of
 * a hand port (en-gen/hackbench#342, first slice of #351 phase 2).
 *
 * The interpreter reads the handler's own bytes from THIS ROM. When it
 * refuses, the caller draws the port and this records the reason, so the
 * picture is never blank and never claims a verification it did not get.
 */

import type { Cursor } from './cursor'
import {
  ENTRY_STANDARD,
  applyWrites,
  horizontalPlacement,
  interpret,
  seedFromGrid,
  type RecognizedPrimitive,
} from './interpret'
import { mirror } from '../addressing'
import { noteUnverified } from './interpretedGate'
import { dataBanksOf } from '../DataBanks'

export interface InterpretedDraw {
  vertical: boolean
  /** One line per distinct reason a port drew an object the interpreter refused. */
  unverified: string[]
  /** The routines this ROM's interpreter may recognize; the caller supplies the table it trusts. */
  primitives: readonly RecognizedPrimitive[]
  /** The drawing function itself, so the expander never imports it (see interpretedGate.ts). */
  draw: DrawInterpreted
}

export type DrawInterpreted = (cur: Cursor, handler: number, ctx: InterpretedDraw) => boolean

/** What a caller of expandMap hands over: the note sink and the function that fills it. */
export type InterpretedSink = Pick<InterpretedDraw, 'unverified' | 'draw' | 'primitives'>

const hex6 = (n: number): string => '$' + n.toString(16).toUpperCase().padStart(6, '0')

/** True when the interpreter drew the object; false leaves it to the port, with the reason recorded. */
export function drawInterpreted(cur: Cursor, handler: number, ctx: InterpretedDraw): boolean {
  const note = (why: string): false => {
    noteUnverified(ctx.unverified, handler, why)
    return false
  }
  if (ctx.vertical) return note('vertical levels are not interpreted yet')
  // The object code bank is the recorded one (detected, or hand-edited in the project's data-banks.json); a
  // missing or malformed record refuses rather than guessing vanilla's $0D.
  const found = dataBanksOf(cur.rom).objectCode
  if ('notFound' in found) return note(found.notFound)
  const inBank = (a: number): number => (found.bank << 16) | (a & 0xffff)
  const r = interpret(
    cur.rom,
    inBank(ENTRY_STANDARD),
    horizontalPlacement('standard', cur.objNo, cur.size, cur.col, cur.row),
    { tileset: cur.tileset, switchFlags: cur.switchFlags },
    {
      primitives: ctx.primitives,
      seed: seedFromGrid(cur.grid),
    },
  )
  if (r.refusal) return note(`${r.refusal.reason} at ${hex6(r.refusal.at)}`)
  const reached = r.dispatches[r.dispatches.length - 1]
  if (reached === undefined) return note('the run reached no dispatch')
  if (mirror(reached) !== mirror(handler) && mirror(reached) !== mirror(inBank(handler)))
    return note(`the ROM's dispatch reaches ${hex6(reached)}`)
  applyWrites(cur.grid, r.writes, cur.owners, cur.owner)
  return true
}
