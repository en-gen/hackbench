/**
 * Layer 1 objects the expander refused, placed on the map (#816).
 *
 * A refused object drew nothing, so its footprint is unknown; only its anchor
 * cell (the parser's x,y, the same cell the handler starts from) is marked.
 * [PROP] marking the anchor alone, not a guessed rectangle.
 */
import type { LevelObject } from '../LevelParser'
import type { Refusal } from '../objectHandlers/cursor'
import { parseRefusedLine } from '../objectHandlers/interpretedGate'

export const WHY_UNPORTED = 'HackBench cannot draw this object type yet.'

export interface RefusedCell {
  /** Map tile column and row (16 px cells), the parser's absolute x,y; off the strip when the data says so. */
  x: number
  y: number
  /** Index into the parsed object list: the "Object N" of the map note. */
  objectIndex: number
  /** "type 25" or "extended type 5": the object number as the level stream holds it. */
  objectType: string
  /** The first gate refusal's handler, else the first refusal's. */
  handler: number
  /** One plain-words line per distinct issue, gate reasons first (#1005); the count badge is its length. */
  reasons: string[]
}

/** Opcode byte to the word a person reads; any other opcode falls back to a generic phrase in gateReason. */
const OPCODE_WORD: Record<string, string> = { '20': 'a call', '4C': 'a jump' }

/**
 * A gate refusal in words first, hex last, so the tooltip reads for a person; the address stays because
 * it is what tells two gate refusals on one object apart. Unrecognized lines keep their own text.
 */
export function gateReason(line: string): string {
  const op = /the byte at \$(\w+) is (\$\w\w|nothing), not the \$(\w\w) opcode/.exec(line)
  if (op) {
    const found =
      op[2] === 'nothing' ? `there is no byte at $${op[1]}` : `byte $${op[1]} is ${op[2]}`
    return `Its drawing code was changed where HackBench expects ${OPCODE_WORD[op[3]] ?? 'an instruction it relies on'} (${found}).`
  }
  const span = /the required operand span at \$(\w+) is outside the ROM/.exec(line)
  if (span) return `Its drawing code runs past the end of the ROM (at $${span[1]}).`
  const val = /the operand at \$(\w+) is (\$\w\w), not the/.exec(line)
  if (val)
    return `Its drawing code uses a value HackBench relies on (byte $${val[1]} is ${val[2]}).`
  const call = /the JSR at \$(\w+) calls/.exec(line)
  if (call)
    return `Its drawing code calls somewhere HackBench does not expect (call at $${call[1]}).`
  const detail = line
    .replace(/^Handler \$(\w+) refused: /, '')
    .replace(/, so the object is not drawn\.$/, '')
  return `Its drawing code was changed in a way HackBench does not expect (${detail}).`
}

/**
 * One cell per refused OBJECT (an object can be refused twice, handle_0DB49E), listing every distinct
 * reason: gate reasons first, then unported, each in refusal order, identical text counted once (#1005).
 * The handler is the first gate refusal's, since the gate is the more specific cause.
 * A refusal whose object index is not in `objects` is dropped, never guessed. The anchor is the object's
 * own x,y even when it names a cell off the strip (negative or past the end): the map view extends its
 * canvas to show it there, never clamped onto the edge (#1004, D76).
 */
export function refusedCellsOf(
  refusals: readonly Refusal[],
  objects: readonly LevelObject[],
): RefusedCell[] {
  const byObject = new Map<number, { cell: RefusedCell; gate: string[]; other: string[] }>()
  for (const r of refusals) {
    const o = objects[r.objectIndex]
    if (!o) continue
    let e = byObject.get(r.objectIndex)
    if (!e) {
      e = {
        cell: {
          x: o.x,
          y: o.y,
          objectIndex: r.objectIndex,
          objectType: `${o.type === 'extended' ? 'extended type' : 'type'} ${o.objectNumber}`,
          handler: r.handler,
          reasons: [],
        },
        gate: [],
        other: [],
      }
      byObject.set(r.objectIndex, e)
    }
    const gate = parseRefusedLine(r.reason) !== null
    if (gate && e.gate.length === 0) e.cell.handler = r.handler
    const text = gate ? gateReason(r.reason) : WHY_UNPORTED
    const list = gate ? e.gate : e.other
    if (!list.includes(text)) list.push(text)
  }
  return [...byObject.values()].map(e => ({ ...e.cell, reasons: [...e.gate, ...e.other] }))
}
