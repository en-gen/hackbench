/** `computeGridLines`: synthetic sizes only, no ROM, no DOM. */
import { describe, it, expect } from 'vitest'
import { computeGridLines } from '../../../theia/extension/src/browser/grid-lines'

const pos = (ls: { pos: number }[]): number[] => ls.map(l => l.pos)
const start = (ls: { start: number }[]): number[] => ls.map(l => l.start)

describe('computeGridLines', () => {
  it('spaces lines by cell size times zoom, edges included', () => {
    const g = computeGridLines({ cellSize: 8, width: 32, height: 16, zoom: 3 })
    expect(pos(g.x)).toEqual([0, 24, 48, 72, 96])
    expect(pos(g.y)).toEqual([0, 24, 48])
  })

  it('keeps every line at base weight regardless of zoom', () => {
    for (const zoom of [1, 2, 8]) {
      const g = computeGridLines({ cellSize: 16, width: 64, height: 64, zoom })
      expect([...g.x, ...g.y].every(l => l.weight === 1 && l.size === 1)).toBe(true)
    }
  })

  it('a single pixel takes the boundary pixel; the trailing edge is pulled inside', () => {
    const g = computeGridLines({ cellSize: 8, width: 16, height: 8, zoom: 1 })
    expect(start(g.x)).toEqual([0, 8, 15])
    expect(start(g.y)).toEqual([0, 7])
  })

  it('a line spans the full extent across its axis', () => {
    const g = computeGridLines({ cellSize: 8, width: 32, height: 16, zoom: 2 })
    expect(g.x.map(l => [l.from, l.to])).toEqual(g.x.map(() => [0, 32]))
    expect(g.y.map(l => [l.from, l.to])).toEqual(g.y.map(() => [0, 64]))
  })

  it('a tier thickens every Nth line on its own axis only', () => {
    const g = computeGridLines({
      cellSize: 8,
      width: 64,
      height: 64,
      zoom: 1,
      tiers: [
        { every: 4, weight: 3 },
        { every: 8, axis: 'x', weight: 5 },
      ],
    })
    expect(g.x.map(l => l.weight)).toEqual([5, 1, 1, 1, 3, 1, 1, 1, 5])
    expect(g.y.map(l => l.weight)).toEqual([3, 1, 1, 1, 3, 1, 1, 1, 3])
  })

  it('where tiers overlap the heaviest wins, whatever their order', () => {
    const heavyFirst = [
      { every: 4, weight: 5 },
      { every: 2, weight: 3 },
    ]
    for (const tiers of [heavyFirst, [...heavyFirst].reverse()]) {
      const g = computeGridLines({ cellSize: 8, width: 64, height: 8, zoom: 1, tiers })
      expect(g.x.map(l => l.weight)).toEqual([5, 1, 3, 1, 5, 1, 3, 1, 5])
    }
  })

  it('a heavier line is centred on its boundary and clipped at the edges, never shifted', () => {
    const g = computeGridLines({
      cellSize: 8,
      width: 16,
      height: 8,
      zoom: 1,
      tiers: [{ every: 1, axis: 'x', weight: 3 }],
    })
    // Boundaries 0, 8, 16: centred 3px runs would be [-1,2), [7,10), [15,18).
    expect(g.x.map(l => [l.start, l.size])).toEqual([
      [0, 2],
      [7, 3],
      [15, 1],
    ])
  })

  it('bands leave the gaps unlined, tiers restart per band, and lines span their own band', () => {
    const g = computeGridLines({
      cellSize: 16,
      width: 32,
      height: 100,
      zoom: 2,
      tiers: [{ every: 2, axis: 'y', weight: 3 }],
      bands: [
        { top: 0, height: 32 },
        { top: 48, height: 32 },
      ],
    })
    expect(pos(g.y)).toEqual([0, 32, 64, 96, 128, 160])
    expect(g.y.map(l => l.weight)).toEqual([3, 1, 3, 3, 1, 3])
    // Edge lines clip at their band (64, 96, 160) instead of shifting inward.
    expect(g.y.map(l => [l.start, l.size])).toEqual([
      [0, 2],
      [32, 1],
      [63, 1],
      [96, 2],
      [128, 1],
      [159, 1],
    ])
    expect(g.x.filter(l => l.pos === 0).map(l => [l.from, l.to])).toEqual([
      [0, 64],
      [96, 160],
    ])
  })

  it('an empty band list draws nothing', () => {
    const g = computeGridLines({ cellSize: 8, width: 32, height: 32, zoom: 1, bands: [] })
    expect(g).toEqual({ x: [], y: [] })
  })

  it('device pixels: positions round, thickness stays 1 device px, extents scale', () => {
    for (const dpr of [1.25, 1.5, 2]) {
      const g = computeGridLines({ cellSize: 8, width: 32, height: 16, zoom: 3, dpr })
      expect(g.x.slice(0, 4).map(l => l.start)).toEqual(
        [0, 24, 48, 72].map(p => Math.round(p * dpr)),
      )
      expect(g.x.every(l => l.size === 1)).toBe(true)
      expect(g.y[0]!.to).toBe(Math.round(96 * dpr))
      expect(g.x[0]!.to).toBe(Math.round(48 * dpr))
      // pos stays in CSS px, so cell spacing is still cell * zoom.
      expect(g.x[1]!.pos).toBe(24)
    }
  })

  it('returns nothing for a degenerate cell size or zoom', () => {
    expect(computeGridLines({ cellSize: 0, width: 8, height: 8, zoom: 1 }).x).toEqual([])
    expect(computeGridLines({ cellSize: 8, width: 8, height: 8, zoom: 0 }).y).toEqual([])
  })
})
