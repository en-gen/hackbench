/**
 * Picking Objects and their edge segments on the map (#1237), as pure functions of map pixels so the
 * rules are unit tested without a browser. Read-only: nothing here changes the map.
 *
 * Hit order (the widget applies the first step): a sprite, then a segment of the SELECTED Object, then
 * the front-most Object body. A segment answers only on a selected Object: the grab zone is the strip
 * outside its outline, up to half a tile wide; inside the outline is the Object (#1234, "Edges").
 */
import type { CellRun, ObjectDto, Segment } from '../../../../src/rom/objects/Describe'
import { TILE } from './off-map-extent'

/** Half a tile: how far outside the outline a pointer still grabs the edge. */
export const GRAB = TILE / 2

export interface ObjectSelection {
  /** The selected Object's key, if any. */
  object?: string
  /** Selected segment ids of that Object. */
  segments: ReadonlySet<string>
}
export const NO_SELECTION: ObjectSelection = { segments: new Set() }

export interface ObjectHover {
  object?: string
  segment?: string
}

const cellSets = new WeakMap<ObjectDto, Set<number>>()
const cellKey = (row: number, col: number) => row * 4096 + col

function cellsOf(o: ObjectDto): Set<number> {
  let s = cellSets.get(o)
  if (!s) {
    s = new Set()
    for (const r of o.runs as readonly CellRun[])
      for (let i = 0; i < r.len; i++) s.add(cellKey(r.row, r.col + i))
    cellSets.set(o, s)
  }
  return s
}

/** Whether the map pixel (x, y) is on one of the Object's cells. */
export function containsPoint(o: ObjectDto, x: number, y: number): boolean {
  return cellsOf(o).has(cellKey(Math.floor(y / TILE), Math.floor(x / TILE)))
}

/** The front-most Object under the pixel: the largest order, the later one among equals. */
export function objectAt(
  objects: readonly ObjectDto[],
  x: number,
  y: number,
): ObjectDto | undefined {
  // prettier-ignore
  let best: ObjectDto | undefined
  for (const o of objects) if (containsPoint(o, x, y) && (!best || o.order >= best.order)) best = o
  return best
}

function distanceToPolyline(points: readonly number[], x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

/**
 * The Object's edge segment whose line the pixel is within half a tile outside of, nearest first; none
 * when the pixel is on the Object itself (that is the Object, not its edge).
 */
export function segmentAt(o: ObjectDto, x: number, y: number): Segment | undefined {
  if (containsPoint(o, x, y)) return undefined
  let best: Segment | undefined
  let bestD = GRAB
  for (const s of o.segments) {
    const d = distanceToPolyline(s.points, x, y)
    // A tie goes to the earlier segment, so the answer does not flip while the pointer rests on a corner.
    if (d < bestD || (d === bestD && !best)) {
      best = s
      bestD = d
    }
  }
  return best
}

/** What the pointer is over, given the selection: the selected Object's segment first, then an Object body. */
export function resolveHover(
  objects: readonly ObjectDto[],
  sel: ObjectSelection,
  x: number,
  y: number,
): ObjectHover {
  const chosen = sel.object ? objects.find(o => o.key === sel.object) : undefined
  const seg = chosen && segmentAt(chosen, x, y)
  if (chosen && seg) return { object: chosen.key, segment: seg.id }
  const body = objectAt(objects, x, y)
  return body ? { object: body.key } : {}
}

/**
 * The selection after a click at the pixel. A segment of the selected Object: plain click selects just
 * it, Ctrl+click toggles it among the others. An Object body selects that Object (segments cleared);
 * Ctrl+click on the selected Object leaves its segments alone. Nothing under the pointer clears.
 */
export function selectAt(
  objects: readonly ObjectDto[],
  sel: ObjectSelection,
  x: number,
  y: number,
  ctrl: boolean,
): ObjectSelection {
  const hit = resolveHover(objects, sel, x, y)
  if (!hit.object) return NO_SELECTION
  if (hit.segment) {
    const next = new Set(ctrl ? sel.segments : [])
    if (ctrl && next.has(hit.segment)) next.delete(hit.segment)
    else next.add(hit.segment)
    return { object: hit.object, segments: next }
  }
  if (hit.object === sel.object) return ctrl ? sel : { object: sel.object, segments: new Set() }
  return { object: hit.object, segments: new Set() }
}
