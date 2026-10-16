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
export const WHY_GATE = "This object's drawing code could not be read safely, so it was not drawn."

export interface RefusedCell {
  /** Map tile column and row (16 px cells), the parser's absolute x,y. */
  x: number
  y: number
  /** Index into the parsed object list: the "Object N" of the map note. */
  objectIndex: number
  /** "type 25" or "extended type 5": the object number as the level stream holds it. */
  objectType: string
  handler: number
  why: string
}

/** One cell per refusal; a refusal whose object index is not in `objects` is dropped, never guessed. */
export function refusedCellsOf(
  refusals: readonly Refusal[],
  objects: readonly LevelObject[],
): RefusedCell[] {
  const cells: RefusedCell[] = []
  for (const r of refusals) {
    const o = objects[r.objectIndex]
    if (!o) continue
    cells.push({
      x: o.x,
      y: o.y,
      objectIndex: r.objectIndex,
      objectType: `${o.type === 'extended' ? 'extended type' : 'type'} ${o.objectNumber}`,
      handler: r.handler,
      why: parseRefusedLine(r.reason) ? WHY_GATE : WHY_UNPORTED,
    })
  }
  return cells
}
