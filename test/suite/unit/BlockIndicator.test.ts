/**
 * Block content indicator maths (#566): boxes, the progressive diagonal, the
 * C4a "+", half scale and clipping. Made-up pixels only.
 */
import { describe, it, expect } from 'vitest'
import {
  BLOCK,
  bakePlus,
  fitArt,
  halve,
  indicatorBox,
  paintIndicator,
  splitDiagonal,
} from '../../../theia/extension/src/common/block-indicator'

const solid = (c: [number, number, number, number], n = BLOCK) => {
  const a = new Uint8ClampedArray(n * n * 4)
  for (let i = 0; i < n * n; i++) a.set(c, i * 4)
  return a
}
const at = (a: Uint8ClampedArray, x: number, y: number, w = BLOCK) =>
  Array.from(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4))

describe('indicatorBox', () => {
  it('is the bottom-right quadrant at rest and the whole block on hover', () => {
    expect(indicatorBox(32, 48, false)).toEqual({ x0: 40, y0: 56, x1: 48, y1: 64 })
    expect(indicatorBox(32, 48, true)).toEqual({ x0: 32, y0: 48, x1: 48, y1: 64 })
  })
})

describe('splitDiagonal', () => {
  const red = solid([255, 0, 0, 255])
  const blue = solid([0, 0, 255, 255])
  const out = splitDiagonal(red, blue)
  it('puts the small item bottom-left and the big item top-right, hard', () => {
    expect(at(out, 0, 15)).toEqual([255, 0, 0, 255])
    expect(at(out, 15, 0)).toEqual([0, 0, 255, 255])
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) expect(at(out, x, y)).toEqual(at(y > x ? red : blue, x, y))
  })
  it('splits every pixel exactly once: 120 small, 136 big', () => {
    let small = 0
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) if (at(out, x, y)[0] === 255) small++
    expect(small).toBe(120)
  })
})

describe('bakePlus', () => {
  const coin = solid([200, 160, 0, 255])
  const out = bakePlus(coin)
  it('changes only the 7 x 7 corner, with 9 white pixels and a black edge', () => {
    let white = 0
    let diff = 0
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) {
        const p = at(out, x, y)
        if (p.join() !== at(coin, x, y).join()) {
          diff++
          expect(x).toBeGreaterThanOrEqual(9)
          expect(y).toBeGreaterThanOrEqual(9)
        }
        if (p.join() === '255,255,255,255') white++
      }
    expect(white).toBe(9)
    expect(diff).toBe(25) // 9 white + 16 edge
    expect(at(out, 12, 12)).toEqual([255, 255, 255, 255])
    expect(at(out, 9, 12)).toEqual([0, 0, 0, 255])
  })
  it('does not mutate its input', () => {
    expect(at(coin, 12, 12)).toEqual([200, 160, 0, 255])
  })
})

describe('halve', () => {
  it('keeps a solid block opaque and a clear one clear', () => {
    expect(at(halve(solid([10, 20, 30, 255])), 3, 3, 8)).toEqual([10, 20, 30, 255])
    expect(at(halve(new Uint8ClampedArray(BLOCK * BLOCK * 4)), 3, 3, 8)).toEqual([0, 0, 0, 0])
  })
  it('needs 2 of 4 source pixels to be opaque, and averages them', () => {
    const a = new Uint8ClampedArray(BLOCK * BLOCK * 4)
    a.set([100, 0, 0, 255], 0)
    expect(at(halve(a), 0, 0, 8)[3]).toBe(0)
    a.set([200, 0, 0, 255], 4)
    expect(at(halve(a), 0, 0, 8)).toEqual([150, 0, 0, 255])
  })
})

describe('fitArt', () => {
  it('centres a small bitmap and reduces a big one into 16 x 16', () => {
    const small = fitArt(solid([1, 2, 3, 255], 8), 8, 8)
    expect(at(small, 3, 3)[3]).toBe(0)
    expect(at(small, 4, 4)).toEqual([1, 2, 3, 255])
    expect(at(fitArt(solid([1, 2, 3, 255], 32), 32, 32), 15, 15)).toEqual([1, 2, 3, 255])
  })
})

describe('paintIndicator', () => {
  const art = { rest: solid([9, 9, 9, 255], 8), full: solid([7, 7, 7, 255]) }
  const W = 48
  const plane = () => new Uint8ClampedArray(W * W * 4)
  const bbox = (p: Uint8ClampedArray) => {
    const b = { x0: W, y0: W, x1: -1, y1: -1 }
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++)
        if (p[(y * W + x) * 4 + 3]) {
          b.x0 = Math.min(b.x0, x)
          b.y0 = Math.min(b.y0, y)
          b.x1 = Math.max(b.x1, x + 1)
          b.y1 = Math.max(b.y1, y + 1)
        }
    return b
  }
  it('fills exactly its box at rest and on hover, never outside the block', () => {
    for (const hover of [false, true]) {
      const p = plane()
      const placed = paintIndicator(p, W, W, 16, 16, art, hover)
      expect(bbox(p)).toEqual(placed.box)
      expect(placed.box).toEqual(indicatorBox(16, 16, hover))
    }
  })
  it('clips at the plane edge instead of wrapping', () => {
    const p = plane()
    paintIndicator(p, W, W, 40, 40, art, true)
    expect(bbox(p)).toEqual({ x0: 40, y0: 40, x1: 48, y1: 48 })
  })
})
