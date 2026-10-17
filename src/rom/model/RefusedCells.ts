/**
 * Layer 1 objects the expander refused, placed on the map (#816).
 *
 * A refused object drew nothing, so its footprint is unknown; only its anchor
 * cell (the parser's x,y, the same cell the handler starts from) is marked.
 * [PROP] marking the anchor alone, not a guessed rectangle.
 */
import { SCREEN_H, SCREEN_H_VERT, SCREEN_W, SCREEN_W_VERT, type LevelObject } from '../LevelParser'
import type { Refusal } from '../objectHandlers/cursor'
import { parseRefusedLine } from '../objectHandlers/interpretedGate'

export const WHY_UNPORTED = 'HackBench cannot draw this object type yet.'
export const WHY_GATE = "This object's drawing code could not be read safely, so it was not drawn."

export interface RefusedCell {
  /** Map tile column and row (16 px cells), the parser's absolute x,y. */
  x: number
  y: number
  /** Index into the parsed object list: the "Object N" of the map note. */
  objectIndex: number
  /** "type 25" or "extended type 5": the object number as the level stream holds it. */
  objectType: string
  /** First refusal's handler. */
  handler: number
  /** One plain-words line per distinct issue, gate reasons first (#1005); the count badge is its length. */
  reasons: string[]
}

/** The strip's size in map tiles, so an anchor can be kept on it. */
export function refusedBounds(
  isVertical: boolean,
  screenCount: number,
): { cols: number; rows: number } {
  return isVertical
    ? { cols: SCREEN_W_VERT, rows: SCREEN_H_VERT * screenCount }
    : { cols: SCREEN_W * screenCount, rows: SCREEN_H }
}

const clamp = (v: number, n: number): number => Math.max(0, Math.min(v, n - 1))

/**
 * The gate line with its handler and byte detail, so two gate refusals on one object read as two issues.
 * The raw line is kept in plain words minus its "refused:" and "so the object is not drawn" framing.
 */
function gateReason(line: string): string {
  const detail = line.replace(' refused:', ':').replace(/, so the object is not drawn\.$/, '')
  return `${WHY_GATE} (${detail})`
}

/**
 * One cell per refused OBJECT (an object can be refused twice, handle_0DB49E), listing every distinct
 * reason: gate reasons first, then unported, each in refusal order, identical text counted once (#1005).
 * A refusal whose object index is not in `objects` is dropped, never guessed. An anchor the parser put
 * past the strip is pulled onto its last row or column: an undrawn object is never hidden (D52).
 */
export function refusedCellsOf(
  refusals: readonly Refusal[],
  objects: readonly LevelObject[],
  bounds: { cols: number; rows: number },
): RefusedCell[] {
  const byObject = new Map<number, { cell: RefusedCell; gate: string[]; other: string[] }>()
  for (const r of refusals) {
    const o = objects[r.objectIndex]
    if (!o) continue
    let e = byObject.get(r.objectIndex)
    if (!e) {
      e = {
        cell: {
          x: clamp(o.x, bounds.cols),
          y: clamp(o.y, bounds.rows),
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
    const text = gate ? gateReason(r.reason) : WHY_UNPORTED
    const list = gate ? e.gate : e.other
    if (!list.includes(text)) list.push(text)
  }
  return [...byObject.values()].map(e => ({ ...e.cell, reasons: [...e.gate, ...e.other] }))
}
