/** `computeMapGridLines`: synthetic dimensions only, no ROM, no DOM. */
import { describe, it, expect } from 'vitest'
import {
  computeMapGridLines,
  mapGridWeight,
  mapScreenTiles,
} from '../../../theia/extension/src/browser/map-grid'

const base = { zoom: 1, scrollX: 0, scrollY: 0, viewW: 4000, viewH: 4000 }
const weights = (ls: { pos: number; weight: number }[], w: number): number[] =>
  ls.filter(l => l.weight === w).map(l => l.pos)

describe('screen geometry per level-mode family', () => {
  it('horizontal screens are 16 x 27 tiles, vertical 32 x 16', () => {
    expect(mapScreenTiles(false)).toEqual({ cols: 16, rows: 27 })
    expect(mapScreenTiles(true)).toEqual({ cols: 32, rows: 16 })
  })

  it('horizontal: screen line every 16 columns, sub-screen at row 16 of each 27-row screen', () => {
    const g = computeMapGridLines({ ...base, vertical: false, screenCount: 3 })
    expect(weights(g.x, 5)).toEqual([0, 256, 512, 768])
    expect(weights(g.x, 3)).toEqual([])
    expect(weights(g.y, 3)).toEqual([256])
    // The strip's top and bottom edges (row 0, row 27) are screen weight.
    expect(weights(g.y, 5)).toEqual([0, 432])
  })

  it('vertical: sub-screen at column 16 of each 32-column screen, screen line every 16 rows', () => {
    const g = computeMapGridLines({ ...base, vertical: true, screenCount: 3 })
    expect(weights(g.x, 5)).toEqual([0, 512])
    expect(weights(g.x, 3)).toEqual([256])
    expect(weights(g.y, 5)).toEqual([0, 256, 512, 768])
    expect(weights(g.y, 3)).toEqual([])
  })

  it('the heavier weight wins where boundaries coincide', () => {
    expect(mapGridWeight(true, 'x', 32)).toBe(5)
    expect(mapGridWeight(true, 'x', 16)).toBe(3)
    expect(mapGridWeight(false, 'y', 27)).toBe(5)
    expect(mapGridWeight(false, 'y', 16 + 27)).toBe(3)
    expect(mapGridWeight(false, 'x', 1)).toBe(1)
  })
})

describe('viewport-only drawing', () => {
  it('draws only lines in view and keeps start inside the viewport', () => {
    const g = computeMapGridLines({
      vertical: false,
      screenCount: 40,
      zoom: 4,
      scrollX: 10000,
      scrollY: 0,
      viewW: 800,
      viewH: 600,
    })
    expect(g.x.length).toBeLessThan(20)
    for (const l of g.x) expect(l.start).toBeLessThan(800)
    for (const l of g.x) expect(l.pos).toBeGreaterThan(9900)
  })

  it('follows the scroll offset', () => {
    const at = (scrollX: number) =>
      computeMapGridLines({
        ...base,
        vertical: false,
        screenCount: 8,
        scrollX,
        viewW: 500,
        viewH: 500,
      })
    const a = at(0).x.find(l => l.pos === 256)!
    const b = at(100).x.find(l => l.pos === 256)!
    expect(a.start - b.start).toBe(100)
  })

  it('keeps tile boundaries on tiles at a fractional zoom', () => {
    const z = 0.8125
    const g = computeMapGridLines({
      ...base,
      vertical: false,
      screenCount: 4,
      zoom: z,
      scrollX: 37,
      viewW: 600,
      viewH: 600,
    })
    for (const l of g.x) {
      const centre = l.start + (l.size - 1) / 2
      expect(Math.abs(centre - (l.pos - 37))).toBeLessThanOrEqual(1)
    }
  })

  it('draws no ghost of an off-screen thin line on the viewport edge', () => {
    const g = computeMapGridLines({
      ...base,
      vertical: false,
      screenCount: 8,
      scrollX: 5,
      viewW: 100,
      viewH: 100,
    })
    // Column 0 (screen weight) is half visible; no thin line may sit at start 0 for the hidden tile edge.
    expect(g.x.filter(l => l.weight === 1 && l.start === 0)).toEqual([])
  })

  it('stops at the content edge when the viewport is larger than the map', () => {
    const g = computeMapGridLines({ ...base, vertical: false, screenCount: 1 })
    expect(Math.max(...g.x.map(l => l.start + l.size))).toBeLessThanOrEqual(256)
    expect(g.x[0]!.to).toBe(432)
  })
})

describe('device pixels, both axes, scrolled', () => {
  it('scales positions and weights by the device pixel ratio', () => {
    const g = computeMapGridLines({ ...base, vertical: false, screenCount: 2, dpr: 2 })
    const screen = g.x.find(l => l.pos === 256)!
    // 256 css px -> 512 device px; a 5 px line centred on it covers 510..514.
    expect([screen.start, screen.size]).toEqual([510, 5])
    expect(g.x.find(l => l.pos === 16)!.size).toBe(1)
    expect(g.y.find(l => l.pos === 256)!.size).toBe(3)
    expect(g.x[0]!.to).toBe(864)
  })

  it('rounds a boundary to the nearest device pixel at dpr 1.5', () => {
    const g = computeMapGridLines({ ...base, vertical: false, screenCount: 2, zoom: 1.1, dpr: 1.5 })
    // Boundaries 17.6 * i css px: 26.4, 52.8, 79.2, 105.6 device px (floor would give 52 and 105).
    expect(g.x.slice(1, 5).map(l => l.start)).toEqual([26, 53, 79, 106])
  })

  it('a vertical level scrolled down: y lines follow scrollY, x lines are unaffected by it', () => {
    const at = (scrollY: number) =>
      computeMapGridLines({
        ...base,
        vertical: true,
        screenCount: 6,
        scrollY,
        viewW: 700,
        viewH: 300,
      })
    const a = at(0)
    const b = at(500)
    expect(b.y.every(l => l.pos >= 480 && l.pos <= 816)).toBe(true)
    // 512 css px is 12 px into the view: a 5 px line centred there starts at 10.
    expect(b.y.find(l => l.pos === 512)!.start).toBe(10)
    expect(b.x.map(l => l.start)).toEqual(a.x.map(l => l.start))
    expect(b.y.every(l => l.start < 300)).toBe(true)
  })

  it('a horizontal level scrolled right keeps its rows where they were', () => {
    const at = (scrollX: number) =>
      computeMapGridLines({
        ...base,
        vertical: false,
        screenCount: 8,
        scrollX,
        viewW: 500,
        viewH: 300,
      })
    expect(at(700).y.map(l => l.start)).toEqual(at(0).y.map(l => l.start))
  })

  it('no line runs past the content right edge when the view is wider than the map', () => {
    const g = computeMapGridLines({ ...base, vertical: false, screenCount: 1, scrollX: 100 })
    // One screen is 256 px wide: with 100 scrolled, 156 are left.
    expect(g.y.every(l => l.to === 156)).toBe(true)
    expect(Math.max(...g.x.map(l => l.start + l.size))).toBeLessThanOrEqual(156)
  })

  it('no line runs past the content bottom when the view is taller than the map (vertical, scrolled)', () => {
    const g = computeMapGridLines({ ...base, vertical: true, screenCount: 1, scrollY: 100 })
    // One vertical screen is 256 px tall: 156 left after scrolling 100.
    expect(g.x.every(l => l.to === 156)).toBe(true)
    expect(Math.max(...g.y.map(l => l.start + l.size))).toBeLessThanOrEqual(156)
    expect(g.y.every(l => l.from === 0 && l.to === 512)).toBe(true)
  })
})
