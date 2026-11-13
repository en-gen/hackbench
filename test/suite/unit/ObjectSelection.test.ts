/**
 * Picking Objects and edge segments by map pixel (#1237): the grab zone, the hit order and the
 * selection rules, as pure functions. Acceptance 7 in unit form; the Playwright spec drives the real view.
 */
import { describe, it, expect } from 'vitest'
import { describeObject, type ObjectDto } from '../../../src/rom/objects/Describe'
import type { ObjectCell } from '../../../src/rom/objects/Recognize'
import {
  EDGE_BAND,
  NO_SELECTION,
  objectAt,
  resolveHover,
  segmentAt,
  selectAt,
} from '../../../theia/extension/src/browser/object-selection'

const cells = (row: number, col: number, h: number, w: number, tile = 1): ObjectCell[] =>
  Array.from({ length: h * w }, (_, i) => ({ row: row + Math.floor(i / w), col: col + (i % w), tile, visible: true })) // prettier-ignore
const dto = (
  cs: ObjectCell[],
  order = 0,
  id = 'd',
  slope: Record<number, number> = {},
): ObjectDto =>
  describeObject({ definitionId: id, name: 'Ground', order, cells: cs }, t => slope[t] ?? null)

// A 4 x 2 platform: x 48..112, y 80..112 (cells row 5-6, col 3-6).
const PLATFORM = dto(cells(5, 3, 2, 4))
const top = PLATFORM.segments.find(s => s.points[1] === 80 && s.points[3] === 80)!

// The edge line runs EDGE_BAND inside the outline (through the edge tiles); the grab zone is the outer
// half of an edge tile (between the line and the outline) and the same width just outside the outline.
describe('the grab zone of an edge segment', () => {
  it('just outside the outline, up to half a tile, is the segment', () => {
    expect(segmentAt(PLATFORM, 80, 80 - 3)?.id).toBe(top.id)
    expect(segmentAt(PLATFORM, 80, 80 - EDGE_BAND + 0.5)?.id).toBe(top.id)
  })

  it('in the outer half of an edge tile, inside the outline, is the segment too', () => {
    expect(segmentAt(PLATFORM, 80, 80 + 3)?.id).toBe(top.id)
    expect(segmentAt(PLATFORM, 80, 80 + EDGE_BAND - 0.5)?.id).toBe(top.id)
  })

  it('inside the edge line, half a tile in, is the Object, not the segment', () => {
    expect(segmentAt(PLATFORM, 80, 80 + 12)).toBeUndefined()
    expect(segmentAt(PLATFORM, 80, 96)).toBeUndefined()
  })

  it('farther than half a tile outside is neither', () => {
    expect(segmentAt(PLATFORM, 80, 80 - EDGE_BAND - 1)).toBeUndefined()
  })

  it('works on every side', () => {
    expect(segmentAt(PLATFORM, 48 - 3, 96)?.points).toEqual([48, 112, 48, 80])
    expect(segmentAt(PLATFORM, 48 + 3, 96)?.points).toEqual([48, 112, 48, 80])
    expect(segmentAt(PLATFORM, 112 + 3, 96)?.points).toEqual([112, 80, 112, 112])
    expect(segmentAt(PLATFORM, 112 - 3, 96)?.points).toEqual([112, 80, 112, 112])
    expect(segmentAt(PLATFORM, 80, 112 + 3)?.points).toEqual([112, 112, 48, 112])
    expect(segmentAt(PLATFORM, 80, 112 - 3)?.points).toEqual([112, 112, 48, 112])
  })

  it('on a slope, the zone follows the staircase of the one slope segment, both sides', () => {
    // A hill rising right: slope tile 9 on the diagonal, fill 4 beneath.
    const cs: ObjectCell[] = []
    for (let c = 0; c < 4; c++) {
      cs.push({ row: 3 - c, col: c, tile: 9, visible: true })
      for (let r = 4 - c; r <= 4; r++) cs.push({ row: r, col: c, tile: 4, visible: true })
    }
    const hill = dto(cs, 0, 'd', { 9: 1 })
    const slope = hill.segments.find(s => s.kind === 'slope')!
    // Sky just above the second step (slope cell row 2, col 1): outside the outline.
    expect(segmentAt(hill, 1 * 16 + 8, 2 * 16 - 3)?.id).toBe(slope.id)
    // The outer half of that slope tile, inside the outline.
    expect(segmentAt(hill, 1 * 16 + 8, 2 * 16 + 3)?.id).toBe(slope.id)
    // Half a tile in, inside the edge line: the Object.
    expect(segmentAt(hill, 1 * 16 + 12, 2 * 16 + 12)).toBeUndefined()
  })
})

describe('hit order and selection', () => {
  const back = dto(cells(5, 3, 3, 6), 1, 'back')
  const front = dto(cells(6, 4, 2, 3), 5, 'front')
  const objects = [back, front]

  it('the front-most Object is under the pointer where two overlap', () => {
    expect(objectAt(objects, 5 * 16 + 4, 6 * 16 + 4)?.definitionId).toBe('front')
    expect(objectAt(objects, 3 * 16 + 4, 5 * 16 + 4)?.definitionId).toBe('back')
    expect(objectAt(objects, 0, 0)).toBeUndefined()
  })

  it('a click selects the Object, a click outside clears it', () => {
    const sel = selectAt(objects, NO_SELECTION, 3 * 16 + 4, 5 * 16 + 4, false)
    expect(sel.object).toBe(back.key)
    expect(selectAt(objects, sel, 0, 0, false)).toEqual(NO_SELECTION)
  })

  it('on an unselected Object no segment responds', () => {
    // Just outside the back Object's top edge, nothing selected: no segment hover.
    expect(resolveHover(objects, NO_SELECTION, 3 * 16 + 4, 5 * 16 - 3)).toEqual({})
    const sel = selectAt(objects, NO_SELECTION, 3 * 16 + 4, 5 * 16 + 4, false)
    expect(resolveHover(objects, sel, 3 * 16 + 4, 5 * 16 - 3).segment).toBeDefined()
  })

  it('Ctrl+click adds segments, a second Ctrl+click on one removes it, a plain click replaces', () => {
    let sel = selectAt(objects, NO_SELECTION, 3 * 16 + 4, 5 * 16 + 4, false)
    const topAt = [3 * 16 + 4, 5 * 16 - 3] as const
    const leftAt = [3 * 16 - 3, 5 * 16 + 4] as const
    sel = selectAt(objects, sel, ...topAt, true)
    sel = selectAt(objects, sel, ...leftAt, true)
    expect(sel.segments.size).toBe(2)
    expect(sel.object).toBe(back.key)
    sel = selectAt(objects, sel, ...topAt, true)
    expect(sel.segments.size).toBe(1)
    sel = selectAt(objects, sel, ...topAt, false)
    expect([...sel.segments]).toHaveLength(1)
    // Clicking the body keeps the Object and drops its segments.
    sel = selectAt(objects, sel, 3 * 16 + 8, 5 * 16 + 8, false)
    expect(sel.object).toBe(back.key)
    expect(sel.segments.size).toBe(0)
  })

  it('a segment of the selected Object wins over the body of another Object beside it', () => {
    const a = dto(cells(5, 3, 2, 2), 1, 'a')
    const b = dto(cells(5, 5, 2, 2), 9, 'b') // touching on the right
    const sel = selectAt([a, b], NO_SELECTION, 3 * 16 + 4, 5 * 16 + 4, false)
    const hit = resolveHover([a, b], sel, 5 * 16 + 3, 5 * 16 + 8)
    expect(hit.object).toBe(a.key)
    expect(hit.segment).toBeDefined()
  })
})
