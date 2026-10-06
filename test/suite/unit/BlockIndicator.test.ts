/**
 * Block content indicator maths (#566): boxes, the progressive diagonal, the
 * C4a "+", half scale and clipping. Made-up pixels only.
 */
import { describe, it, expect } from 'vitest'
import {
  BLOCK,
  bakePlus,
  fitArt,
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
  it('is the bottom-right quadrant at rest and the whole block on hover, in screen pixels', () => {
    expect(indicatorBox(32, 48, 1, false)).toEqual({ x0: 40, y0: 56, x1: 48, y1: 64 })
    expect(indicatorBox(32, 48, 2, false)).toEqual({ x0: 80, y0: 112, x1: 96, y1: 128 })
    expect(indicatorBox(32, 48, 3, true)).toEqual({ x0: 96, y0: 144, x1: 144, y1: 192 })
  })
  it('stays inside the block at a fractional zoom', () => {
    const [h, r] = [indicatorBox(16, 16, 1.37, true), indicatorBox(16, 16, 1.37, false)]
    expect(r.x0).toBeGreaterThanOrEqual(h.x0)
    expect(r.x1).toBe(h.x1)
    expect(r.y1).toBe(h.y1)
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
  it('splits every pixel exactly once: 120 small, 136 big, no blended colour', () => {
    let small = 0
    let big = 0
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) {
        const p = at(out, x, y).join()
        if (p === '255,0,0,255') small++
        else if (p === '0,0,255,255') big++
      }
    expect([small, big]).toEqual([120, 136])
  })
  it('leaves transparent pixels transparent', () => {
    const part = new Uint8ClampedArray(BLOCK * BLOCK * 4)
    const o = splitDiagonal(red, part)
    expect(at(o, 15, 0)).toEqual([0, 0, 0, 0])
    expect(at(o, 3, 3)).toEqual([0, 0, 0, 0])
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

describe('fitArt', () => {
  it('centres a small bitmap and reduces a big one into 16 x 16', () => {
    const small = fitArt(solid([1, 2, 3, 255], 8), 8, 8)
    expect(at(small, 3, 3)[3]).toBe(0)
    expect(at(small, 4, 4)).toEqual([1, 2, 3, 255])
    expect(at(fitArt(solid([1, 2, 3, 255], 32), 32, 32), 15, 15)).toEqual([1, 2, 3, 255])
  })
})

describe('paintIndicator', () => {
  const W = 64
  const red = solid([9, 9, 9, 255])
  const lit = (p: Uint8ClampedArray) => {
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
  it.each([1, 2, 3])(
    'fills exactly its box at rest and on hover at %ix, never outside the block',
    z => {
      for (const hover of [false, true]) {
        const p = new Uint8ClampedArray(W * W * 4)
        const box = paintIndicator(p, W, W, 16 / z, 16 / z, red, z, hover)
        expect(lit(p)).toEqual(box)
      }
    },
  )
  it('clips at the canvas edge instead of wrapping', () => {
    const p = new Uint8ClampedArray(W * W * 4)
    paintIndicator(p, W, W, 56, 56, red, 1, true)
    expect(lit(p)).toEqual({ x0: 56, y0: 56, x1: 64, y1: 64 })
  })
  it('samples nearest-neighbour: no pixel is a blend, and 2x doubles each art pixel', () => {
    const two = new Uint8ClampedArray(16 * 16 * 4)
    two.set([255, 0, 0, 255], 0)
    two.set([0, 0, 255, 255], 4)
    const p = new Uint8ClampedArray(W * W * 4)
    paintIndicator(p, W, W, 0, 0, two, 2, true)
    expect([at(p, 0, 0, W), at(p, 1, 1, W), at(p, 2, 0, W), at(p, 3, 1, W)]).toEqual([[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255]]) // prettier-ignore
  })
  it('keeps the "+" white pixels at 2x and 3x', () => {
    const plus = bakePlus(solid([200, 160, 0, 255]))
    for (const z of [2, 3]) {
      const p = new Uint8ClampedArray(W * W * 4)
      paintIndicator(p, W, W, 0, 0, plus, z, false)
      let white = 0
      for (let i = 0; i < p.length; i += 4) if (p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255 && p[i + 3] === 255) white++ // prettier-ignore
      expect(white, `white pixels at ${z}x`).toBeGreaterThan(0)
    }
  })
})
