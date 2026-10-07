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
  LINE_BIG,
  LINE_SMALL,
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

/** An art with the given anti-diagonal pixels opaque: pixel k is (x = k, y = 15 - k). */
const onLine = (ks: number[]) => {
  const a = new Uint8ClampedArray(BLOCK * BLOCK * 4)
  for (const k of ks) a.set([0, 0, 255, 255], ((BLOCK - 1 - k) * BLOCK + k) * 4)
  return a
}

describe('splitDiagonal', () => {
  const red = solid([255, 0, 0, 255])
  const blue = solid([0, 0, 255, 255])
  const out = splitDiagonal(red, blue) // red is the base, blue the upgrade
  it('puts the base item bottom-right and the upgrade top-left, split along the anti-diagonal, hard', () => {
    expect(at(out, 15, 15)).toEqual([255, 0, 0, 255]) // bottom-right: the base
    expect(at(out, 0, 0)).toEqual([0, 0, 255, 255]) // top-left: the upgrade
    expect(at(out, 15, 0)[3]).toBe(255) // top-right and bottom-left are on the line
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++)
        if (x + y !== 15) expect(at(out, x, y)).toEqual(at(x + y > 15 ? red : blue, x, y))
  })
  it('splits every off-line pixel once: 120 base, 120 upgrade, 16 black', () => {
    let base = 0
    let black = 0
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) {
        const p = at(out, x, y)
        if (p[0] === 255) base++
        if (p.join() === '0,0,0,255') black++
      }
    expect([base, black]).toEqual([120, 16])
  })
  it('paints the line where EITHER item is opaque on the line pixel, and nowhere else', () => {
    // The base (bottom-right) is opaque at line pixels 0-3 only; the upgrade (top-left) at 6-9 only.
    const o = splitDiagonal(onLine([0, 1, 2, 3]), onLine([6, 7, 8, 9]))
    // The alpha says which half(s): LINE_SMALL = the base's only, LINE_BIG = the upgrade's only, 255 = both.
    for (let k = 0; k < BLOCK; k++) {
      const want = k <= 3 ? LINE_SMALL : k >= 6 && k <= 9 ? LINE_BIG : 0
      expect(at(o, k, 15 - k), `line pixel ${k}`).toEqual([0, 0, 0, want])
    }
    // Nothing off the line is drawn: neither item paints there.
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) if (x + y !== 15) expect(at(o, x, y)[3]).toBe(0)
  })
  it('draws the whole line black when both items are opaque, and keeps either side hard', () => {
    const o = splitDiagonal(red, blue)
    for (let k = 0; k < BLOCK; k++) expect(at(o, k, 15 - k)).toEqual([0, 0, 0, 255])
    expect(at(o, 8, 8)).toEqual([255, 0, 0, 255]) // below-right of the line: the base
    expect(at(o, 7, 7)).toEqual([0, 0, 255, 255]) // above-left of it: the upgrade
  })
  it('is not the old main-diagonal split: the corners say which way it runs', () => {
    expect(at(out, 0, 15)[3]).toBe(255) // bottom-left corner is a line pixel (black), not the base
    expect(at(out, 0, 15)).toEqual([0, 0, 0, 255])
    expect(at(out, 15, 15)).toEqual([255, 0, 0, 255])
    expect(at(out, 0, 0)).toEqual([0, 0, 255, 255])
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
          expect(x).toBeGreaterThanOrEqual(8)
          expect(y).toBeGreaterThanOrEqual(8)
          expect(x).toBeLessThan(15) // inside the 16 x 16 art, one pixel in from the corner
          expect(y).toBeLessThan(15)
        }
        if (p.join() === '255,255,255,255') white++
      }
    expect(white).toBe(9)
    expect(diff).toBe(25) // 9 white + 16 edge
    expect(at(out, 11, 11)).toEqual([255, 255, 255, 255]) // the centre, on an odd art pixel
    expect(at(out, 8, 11)).toEqual([0, 0, 0, 255])
  })
  it('does not mutate its input', () => {
    expect(at(coin, 11, 11)).toEqual([200, 160, 0, 255])
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
  it('keeps the "+" centre row and column white at 1x, 2x and 3x, at rest and on hover, inside the art', () => {
    const plus = bakePlus(solid([200, 160, 0, 255]))
    const white = (p: Uint8ClampedArray, x: number, y: number) =>
      at(p, x, y, W).join() === '255,255,255,255'
    for (const z of [1, 2, 3]) {
      for (const hover of [false, true]) {
        const p = new Uint8ClampedArray(W * W * 4)
        const box = paintIndicator(p, W, W, 0, 0, plus, z, hover)
        const [w, h] = [box.x1 - box.x0, box.y1 - box.y0]
        // The art pixel each screen pixel samples, as `paintIndicator` does (its centre, in art pixels).
        const art = (i: number, n: number) => Math.floor(((i + 0.5) * BLOCK) / n)
        let [row, col] = [0, 0]
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++) {
            if (!white(p, box.x0 + i, box.y0 + j)) continue
            if (art(j, h) === 11) row++ // the centre row of the "+"
            if (art(i, w) === 11) col++ // its centre column
          }
        expect(row, `centre row, ${z}x ${hover ? 'hover' : 'rest'}`).toBeGreaterThan(0)
        expect(col, `centre column, ${z}x ${hover ? 'hover' : 'rest'}`).toBeGreaterThan(0)
      }
    }
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

describe('the line at sub-pixel level: each half of the line pixel follows its own item', () => {
  const W = 32
  // Every line pixel (x, 15 - x), in turn: 0 the base only (bottom-right half), 1 the upgrade only (top-left half),
  // 2 both items, 3 neither; repeated down the whole line.
  const kind = (k: number) => k % 4
  const base = onLine(
    Array.from({ length: BLOCK }, (_, k) => k).filter(k => kind(k) === 0 || kind(k) === 2),
  )
  const upgrade = onLine(
    Array.from({ length: BLOCK }, (_, k) => k).filter(k => kind(k) === 1 || kind(k) === 2),
  )
  const art = splitDiagonal(base, upgrade)
  const p = new Uint8ClampedArray(W * W * 4)
  paintIndicator(p, W, W, 0, 0, art, 2, true)
  const lit = (x: number, y: number) => p[(y * W + x) * 4 + 3] !== 0
  // A line pixel (k, 15 - k) is screen pixels (2k..2k+1, 30-2k..31-2k) at 2x.
  const quad = (k: number) => [lit(2 * k, 30 - 2 * k), lit(2 * k + 1, 30 - 2 * k), lit(2 * k, 31 - 2 * k), lit(2 * k + 1, 31 - 2 * k)] // prettier-ignore
  const EXPECT: Record<number, boolean[]> = {
    0: [false, true, true, true], // only the base: its bottom-right triangle, the top-left screen pixel clear
    1: [true, true, true, false], // only the upgrade: its top-left triangle, the bottom-right screen pixel clear
    2: [true, true, true, true], // both items: the whole square
    3: [false, false, false, false], // neither: nothing
  }
  it('shows a black triangle, not a square, where only one item is opaque, at 2x, on every line pixel', () => {
    for (let k = 0; k < BLOCK; k++) expect(quad(k), `line pixel ${k}`).toEqual(EXPECT[kind(k)])
  })
  it('paints every lit pixel black, and nothing off the line', () => {
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const onTheLine = x >> 1 === (31 - y) >> 1 // art pixel (x >> 1, y >> 1) with x + y = 15
        if (!onTheLine) expect(lit(x, y), `(${x}, ${y}) is off the line`).toBe(false)
        if (lit(x, y)) expect(Array.from(p.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))).toEqual([0, 0, 0, 255]) // prettier-ignore
      }
  })
})
