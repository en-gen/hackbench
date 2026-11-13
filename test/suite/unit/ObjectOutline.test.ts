/**
 * The outline and edge segments of an Object (#1237): where the outline splits, how a slope run is one
 * segment, and which stretch is covered. Pure geometry, no ROM.
 */
import { describe, it, expect } from 'vitest'
import { buildOutline } from '../../../src/rom/objects/Outline'
import { describeObject } from '../../../src/rom/objects/Describe'
import type { ObjectCell } from '../../../src/rom/objects/Recognize'

const cell = (row: number, col: number, tile = 1, visible = true): ObjectCell => ({ row, col, tile, visible }) // prettier-ignore
const rectCells = (r0: number, c0: number, h: number, w: number): ObjectCell[] =>
  Array.from({ length: h * w }, (_, i) => cell(r0 + Math.floor(i / w), c0 + (i % w)))
const noSlope = () => null

describe('outline segments', () => {
  it('a rectangle has four segments, all straight, and a closed solid outline', () => {
    const o = buildOutline(rectCells(2, 3, 2, 4), noSlope)
    expect(o.segments).toHaveLength(4)
    expect(o.segments.every(s => s.kind === 'straight' && s.points.length === 4)).toBe(true)
    expect(o.coveredPath).toBe('')
    expect(o.visiblePath.match(/M/g)).toHaveLength(4)
  })

  it('splits wherever the outline turns: an L has six, a mushroom eight (three on the bottom)', () => {
    const el = [...rectCells(0, 0, 3, 1), ...rectCells(2, 1, 1, 2)]
    expect(buildOutline(el, noSlope).segments).toHaveLength(6)
    const mushroom = [...rectCells(0, 0, 1, 5), ...rectCells(1, 2, 2, 1)]
    const m = buildOutline(mushroom, noSlope)
    expect(m.segments).toHaveLength(8)
    // The bottoms (y = 16 px for the cap undersides, y = 48 for the stem): two cap undersides and the stem bottom.
    const horizontal = m.segments.filter(s => s.points[1] === s.points[3])
    expect(horizontal.filter(s => s.points[1] === 16)).toHaveLength(2)
    expect(horizontal.filter(s => s.points[1] === 48)).toHaveLength(1)
  })

  it('a shape with a hole has an outline loop around the hole too', () => {
    const ring = rectCells(0, 0, 3, 3).filter(c => !(c.row === 1 && c.col === 1))
    expect(buildOutline(ring, noSlope).segments).toHaveLength(8)
  })

  it('a staircase of slope tiles at one angle is one segment, not one per step', () => {
    // A hill rising to the right: slope tile 9 on the diagonal, fill 4 beneath, flat top tile 1.
    const cells: ObjectCell[] = []
    for (let c = 0; c < 4; c++) {
      cells.push(cell(3 - c, c, 9))
      for (let r = 4 - c; r <= 4; r++) cells.push(cell(r, c, 4))
    }
    cells.push(cell(0, 4, 1), cell(1, 4, 4), cell(2, 4, 4), cell(3, 4, 4), cell(4, 4, 4))
    const o = buildOutline(cells, t => (t === 9 ? 1 : null))
    const slopes = o.segments.filter(s => s.kind === 'slope')
    expect(slopes).toHaveLength(1)
    expect(slopes[0]!.points.length).toBeGreaterThan(8)
    // The same shape with the slope tiles unknown splits at every step.
    const stepped = buildOutline(cells, noSlope).segments
    expect(stepped.length).toBeGreaterThan(o.segments.length)
  })

  it('slope tiles of two different angles are two segments', () => {
    const cells: ObjectCell[] = []
    for (let c = 0; c < 6; c++) {
      cells.push(cell(5 - c, c, c < 3 ? 9 : 10))
      for (let r = 6 - c; r <= 6; r++) cells.push(cell(r, c, 4))
    }
    const o = buildOutline(cells, t => (t === 9 ? 1 : t === 10 ? 0.5 : null))
    expect(o.segments.filter(s => s.kind === 'slope')).toHaveLength(2)
  })

  it('a covered cell puts its stretch of boundary on the dashed path only', () => {
    const cells = rectCells(0, 0, 2, 4).map(c => (c.row === 1 && c.col >= 2 ? { ...c, visible: false } : c)) // prettier-ignore
    const o = buildOutline(cells, noSlope)
    expect(o.coveredPath).not.toBe('')
    expect(o.visiblePath).not.toBe('')
    // The covered stretch is the bottom of the two covered cells: y = 32, x from 32 to 64.
    expect(o.coveredPath).toContain('M64 32L32 32')
  })

  it('every segment is stable: ids are unique within an Object', () => {
    const o = buildOutline([...rectCells(0, 0, 3, 1), ...rectCells(2, 1, 1, 2)], noSlope)
    expect(new Set(o.segments.map(s => s.id)).size).toBe(o.segments.length)
  })
})

describe('describeObject', () => {
  it('lists cells as row runs and keys the Object by definition, order and top-left cell', () => {
    const dto = describeObject(
      {
        definitionId: 'd',
        name: 'Ground',
        order: 7,
        cells: [...rectCells(2, 3, 1, 3), cell(3, 3)],
      },
      noSlope,
    )
    expect(dto.runs).toEqual([
      { row: 2, col: 3, len: 3 },
      { row: 3, col: 3, len: 1 },
    ])
    expect(dto.key).toBe('d:7:2:3')
    expect(dto.name).toBe('Ground')
  })
})
