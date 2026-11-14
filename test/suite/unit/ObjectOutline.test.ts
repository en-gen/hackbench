/**
 * The outline and edge segments of an Object (#1237): where the outline splits, how a slope run is one
 * segment, and which stretch is covered. Pure geometry, no ROM.
 */
import { describe, it, expect } from 'vitest'
import { buildOutline } from '../../../src/rom/objects/Outline'
import { describeObject, describeObjects } from '../../../src/rom/objects/Describe'
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
    expect(o.segments.filter(s => s.kind === 'slope').length).toBeGreaterThanOrEqual(2)
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
  it('lists cells as row runs and keys the Object by definition and top-left cell, not its order', () => {
    const dto = describeObject(
      {
        definitionId: 'd',
        name: 'Ground',
        order: 7,
        pieces: [],
        cells: [...rectCells(2, 3, 1, 3), cell(3, 3)],
      },
      noSlope,
    )
    expect(dto.runs).toEqual([
      { row: 2, col: 3, len: 3 },
      { row: 3, col: 3, len: 1 },
    ])
    expect(dto.key).toBe('d:2:3')
    expect(dto.name).toBe('Ground')
  })
})

describe('review round 1: slope chains, stable ids and keys', () => {
  const hillCells = (): ObjectCell[] => {
    const cs: ObjectCell[] = []
    for (let c = 0; c < 4; c++) {
      cs.push(cell(3 - c, c, 9))
      for (let r = 4 - c; r <= 4; r++) cs.push(cell(r, c, 4))
    }
    cs.push(cell(0, 4, 1), cell(1, 4, 4), cell(2, 4, 4), cell(3, 4, 4), cell(4, 4, 4))
    return cs
  }
  const directions = (points: number[]): Set<string> => {
    const out = new Set<string>()
    for (let i = 0; i + 3 < points.length; i += 2)
      out.add(
        `${Math.sign(points[i + 2]! - points[i]!)},${Math.sign(points[i + 3]! - points[i + 1]!)}`,
      )
    return out
  }
  const onlySlope = (t: number) => (t === 9 ? 1 : null)

  it('a slope segment is a monotone staircase: it never turns down a wall or round a corner', () => {
    for (const s of buildOutline(hillCells(), onlySlope).segments.filter(x => x.kind === 'slope'))
      expect(directions(s.points).size).toBeLessThanOrEqual(2)
  })

  it('segment ids do not depend on the order the cells arrive in', () => {
    const a = buildOutline(hillCells(), onlySlope)
    const b = buildOutline([...hillCells()].reverse(), onlySlope)
    expect(b.segments).toEqual(a.segments)
    expect(b.visiblePath).toBe(a.visiblePath)
  })

  it('a segment id names where it is, so it survives an unrelated change elsewhere on the Object', () => {
    const base = buildOutline(rectCells(0, 0, 2, 3), noSlope).segments.map(s => s.id)
    const taller = buildOutline([...rectCells(0, 0, 2, 3), cell(2, 0)], noSlope).segments.map(s => s.id) // prettier-ignore
    const top = base.find(id => id.startsWith('0,0'))!
    expect(taller).toContain(top)
  })

  it('the Object key does not change when it moves forward in the stored list', () => {
    const at = (order: number) => describeObject({ definitionId: 'd', name: 'G', order, cells: rectCells(2, 3, 1, 3), pieces: [] }, noSlope).key // prettier-ignore
    expect(at(4)).toBe(at(9))
  })
})

describe('slope segments (issue item 4, round 3 ruling 8)', () => {
  /** A staircase of `n` slope tiles with a flat tile at its top and fill beneath: the flat side has no wall. */
  const hill = (n: number, rising: boolean): ObjectCell[] => {
    const cs: ObjectCell[] = []
    const at = (c: number) => (rising ? c : n - c) // columns shift by one when falling, for the flat tile at 0
    for (let c = 0; c < n; c++) {
      cs.push(cell(n - 1 - c, at(c), 9))
      for (let r = n - c; r <= n; r++) cs.push(cell(r, at(c), 4))
    }
    cs.push(cell(0, at(n), 1))
    for (let r = 1; r <= n; r++) cs.push(cell(r, at(n), 4))
    return cs
  }
  const onlySlope = (t: number) => (t === 9 ? 1 : null)
  const steps = (pts: number[]) => {
    const out: [number, number][] = []
    for (let i = 0; i + 3 < pts.length; i += 2)
      out.push([pts[i + 2]! - pts[i]!, pts[i + 3]! - pts[i + 1]!])
    return out
  }
  const monotone = (pts: number[]) => {
    const d = steps(pts)
    return !(d.some(([x]) => x > 0) && d.some(([x]) => x < 0)) && !(d.some(([, y]) => y > 0) && d.some(([, y]) => y < 0)) // prettier-ignore
  }

  for (let n = 1; n <= 7; n++)
    for (const rising of [true, false])
      it(`a ${n}-tile ${rising ? 'rising' : 'falling'} slope is one slope segment, monotone in x and y`, () => {
        const slopes = buildOutline(hill(n, rising), onlySlope).segments.filter(
          s => s.kind === 'slope',
        )
        expect(slopes).toHaveLength(1)
        expect(monotone(slopes[0]!.points)).toBe(true)
        // It holds only boundary of slope cells: its end is the top of the last slope tile, never the flat tile's.
        const xs = slopes[0]!.points.filter((_, i) => i % 2 === 0)
        const span = Math.max(...xs) - Math.min(...xs)
        expect(span).toBe(n * 16)
      })

  it('the round 1 witness: the top of the top slope tile and its right wall are not one segment', () => {
    const cs: ObjectCell[] = []
    for (let c = 0; c < 4; c++) {
      cs.push(cell(3 - c, c, 9))
      for (let r = 4 - c; r <= 4; r++) cs.push(cell(r, c, 4))
    }
    for (const s of buildOutline(cs, onlySlope).segments)
      expect(s.points.join().includes('48,0,64,0,64,16'), s.points.join()).toBe(false)
  })

  it('a floor of slope tiles never wraps round its seam: every slope segment is monotone', () => {
    for (let w = 1; w <= 6; w++) {
      const floor = Array.from({ length: w }, (_, c) => cell(2, c, 9))
      for (const s of buildOutline(floor, onlySlope).segments) {
        expect(monotone(s.points), `${w}: ${s.points.join()}`).toBe(true)
        expect(s.points.join().includes(`${w * 16},32,0,32,0,16`)).toBe(false)
      }
    }
  })

  it('a slope segment never takes the boundary of a non-slope cell', () => {
    // Slope tile beside a flat tile: the flat tile's top and sides are straight segments of their own.
    const cs = [cell(1, 0, 9), cell(1, 1, 1), cell(2, 0, 4), cell(2, 1, 4)]
    const o = buildOutline(cs, onlySlope)
    const slope = o.segments.filter(s => s.kind === 'slope')
    expect(slope.length).toBeGreaterThan(0)
    for (const s of slope)
      expect(Math.max(...s.points.filter((_, i) => i % 2 === 0))).toBeLessThanOrEqual(16)
  })

  it('segment ids do not depend on the order the cells arrive in', () => {
    const a = buildOutline(hill(4, true), onlySlope)
    const b = buildOutline([...hill(4, true)].reverse(), onlySlope)
    expect(b.segments).toEqual(a.segments)
    expect(b.visiblePath).toBe(a.visiblePath)
  })

  it('twin Objects keep their keys when the list order flips', () => {
    const a = { definitionId: 'd', name: 'G', order: 3, cells: rectCells(2, 2, 2, 3), pieces: [3] }
    const b = {
      definitionId: 'd',
      name: 'G',
      order: 5,
      cells: [...rectCells(2, 2, 1, 2), cell(3, 2)],
      pieces: [5],
    }
    const keysOf = (list: (typeof a)[]) =>
      new Map(describeObjects(list, noSlope).map(d => [d.runs.map(r => r.len).join(), d.key]))
    expect(keysOf([a, b])).toEqual(keysOf([b, a]))
    expect(new Set(describeObjects([a, b], noSlope).map(d => d.key)).size).toBe(2)
    expect(new Set(describeObjects([b, a], noSlope).map(d => d.key)).size).toBe(2)
  })
})
