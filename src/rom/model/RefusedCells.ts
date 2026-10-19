/**
 * Layer 1 objects the expander refused, placed on the map (#816).
 *
 * A refused object drew nothing, so its footprint is unknown; only its anchor
 * cell (the parser's x,y, the same cell the handler starts from) is marked.
 * [PROP] marking the anchor alone, not a guessed rectangle.
 */
import { SCREEN_H, SCREEN_H_VERT, SCREEN_W, SCREEN_W_VERT, type LevelObject } from '../LevelParser'
import { GUTTER_TILES } from './MapGutter'
import type { Refusal } from '../objectHandlers/cursor'
import { parseRefusedLine } from '../objectHandlers/interpretedGate'

export const WHY_UNPORTED = 'HackBench cannot draw this object type yet.'
export const WHY_GATE = "This object's drawing code could not be read safely, so it was not drawn."

export interface RefusedCell {
  /** Map tile column and row (16 px cells), the parser's absolute x,y; inside the map or its gutter, else clamped onto the map. */
  x: number
  y: number
  /** Index into the parsed object list: the "Object N" of the map note. */
  objectIndex: number
  /** "type 25" or "extended type 5": the object number as the level stream holds it. */
  objectType: string
  handler: number
  why: string
}

/**
 * The strip's size in map tiles, and how many tiles of gutter a horizontal map has on each
 * side (none on a vertical one), so an anchor can be kept where the view draws it.
 */
export function refusedBounds(
  isVertical: boolean,
  screenCount: number,
): { cols: number; rows: number; gutter: number } {
  return isVertical
    ? { cols: SCREEN_W_VERT, rows: SCREEN_H_VERT * screenCount, gutter: 0 }
    : { cols: SCREEN_W * screenCount, rows: SCREEN_H, gutter: GUTTER_TILES }
}

/** Pulls `v` onto the last row or column of an axis `n` tiles long (the #969 clamp, unchanged). */
const clamp = (v: number, n: number): number => Math.max(0, Math.min(v, n - 1))

/** `v` as drawn: raw inside the axis or its `gutter` tiles each side, else clamped onto the axis. */
const place = (v: number, n: number, gutter: number): number =>
  v >= -gutter && v < n + gutter ? v : clamp(v, n)

/**
 * One cell per refused OBJECT (an object can be refused twice, handle_0DB49E,
 * and the gate reason wins over the unported one); a refusal whose object index
 * is not in `objects` is dropped, never guessed. An anchor keeps the object's own x,y
 * inside the map and, on a horizontal map, inside its gutter (D48 part 2, #1004); beyond
 * that (above or below a horizontal map, anywhere off a vertical one) it is pulled onto the
 * last row or column as before: an undrawn object is never hidden (D52).
 */
export function refusedCellsOf(
  refusals: readonly Refusal[],
  objects: readonly LevelObject[],
  bounds: { cols: number; rows: number; gutter: number },
): RefusedCell[] {
  const byObject = new Map<number, RefusedCell>()
  for (const r of refusals) {
    const o = objects[r.objectIndex]
    if (!o) continue
    const why = parseRefusedLine(r.reason) ? WHY_GATE : WHY_UNPORTED
    const had = byObject.get(r.objectIndex)
    if (had && !(had.why === WHY_UNPORTED && why === WHY_GATE)) continue
    byObject.set(r.objectIndex, {
      x: place(o.x, bounds.cols, bounds.gutter),
      y: place(o.y, bounds.rows, 0),
      objectIndex: r.objectIndex,
      objectType: `${o.type === 'extended' ? 'extended type' : 'type'} ${o.objectNumber}`,
      handler: r.handler,
      why,
    })
  }
  return [...byObject.values()]
}
