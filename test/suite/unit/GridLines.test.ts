/** `computeGridLines`: synthetic sizes only, no ROM, no DOM. */
import { describe, it, expect } from 'vitest'
import { computeGridLines } from '../../../theia/extension/src/browser/grid-lines'

const pos = (ls: { pos: number }[]): number[] => ls.map(l => l.pos)

describe('computeGridLines', () => {
  it('spaces lines by cell size times zoom, edges included', () => {
    const g = computeGridLines({ cellSize: 8, width: 32, height: 16, zoom: 3 })
    expect(pos(g.x)).toEqual([0, 24, 48, 72, 96])
    expect(pos(g.y)).toEqual([0, 24, 48])
  })

  it('keeps every line at base weight regardless of zoom', () => {
    for (const zoom of [1, 2, 8]) {
      const g = computeGridLines({ cellSize: 16, width: 64, height: 64, zoom })
      expect([...g.x, ...g.y].every(l => l.weight === 1)).toBe(true)
    }
  })

  it('a tier thickens every Nth line on its own axis only', () => {
    const g = computeGridLines({
      cellSize: 8,
      width: 64,
      height: 64,
      zoom: 1,
      tiers: [
        { every: 4, weight: 2 },
        { every: 8, axis: 'x', weight: 3 },
      ],
    })
    expect(g.x.map(l => l.weight)).toEqual([3, 1, 1, 1, 2, 1, 1, 1, 3])
    expect(g.y.map(l => l.weight)).toEqual([2, 1, 1, 1, 2, 1, 1, 1, 2])
  })

  it('bands leave the gaps between them unlined, and tiers restart per band', () => {
    const g = computeGridLines({
      cellSize: 16,
      width: 32,
      height: 100,
      zoom: 2,
      tiers: [{ every: 2, axis: 'y', weight: 2 }],
      bands: [
        { top: 0, height: 32 },
        { top: 48, height: 32 },
      ],
    })
    expect(pos(g.y)).toEqual([0, 32, 64, 96, 128, 160])
    expect(g.y.map(l => l.weight)).toEqual([2, 1, 2, 2, 1, 2])
    expect(g.x.filter(l => l.pos === 0).map(l => [l.from, l.to])).toEqual([
      [0, 64],
      [96, 160],
    ])
  })

  it('returns nothing for a degenerate cell size or zoom', () => {
    expect(computeGridLines({ cellSize: 0, width: 8, height: 8, zoom: 1 }).x).toEqual([])
    expect(computeGridLines({ cellSize: 8, width: 8, height: 8, zoom: 0 }).y).toEqual([])
  })
})
