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

describe('splitDiagonal', () => {
  const red = solid([255, 0, 0, 255])
  const blue = solid([0, 0, 255, 255])
  const out = splitDiagonal(red, blue)
  it('puts the small item bottom-left and the big item top-right, hard, off the diagonal', () => {
    expect(at(out, 0, 15)).toEqual([255, 0, 0, 255])
    expect(at(out, 15, 0)).toEqual([0, 0, 255, 255])
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++)
        if (x !== y) expect(at(out, x, y)).toEqual(at(y > x ? red : blue, x, y))
  })
  it('splits every off-diagonal pixel once: 120 small, 120 big, 16 black', () => {
    let small = 0
    let black = 0
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) {
        const p = at(out, x, y)
        if (p[0] === 255) small++
        if (p.join() === '0,0,0,255') black++
      }
    expect([small, black]).toEqual([120, 16])
  })
  it('paints the line where EITHER item is opaque on the diagonal pixel, and nowhere else', () => {
    // small (bottom-left) is opaque at the diagonal pixels 0-3 only; big (top-right) at 6-9 only.
    const only = (cells: number[]) => {
      const a = new Uint8ClampedArray(BLOCK * BLOCK * 4)
      for (const c of cells) a.set([0, 0, 255, 255], (c * BLOCK + c) * 4)
      return a
    }
    const o = splitDiagonal(only([0, 1, 2, 3]), only([6, 7, 8, 9]))
    // Opaque where either item is; the alpha says which half(s): 1 = bottom-left only, 2 = top-right only, 255 = both.
    for (let d = 0; d < BLOCK; d++) {
      const want = d <= 3 ? LINE_SMALL : d >= 6 && d <= 9 ? LINE_BIG : 0
      expect(at(o, d, d), `diagonal pixel ${d}`).toEqual([0, 0, 0, want])
    }
    // Nothing off the diagonal is drawn: neither item paints there.
    for (let y = 0; y < BLOCK; y++)
      for (let x = 0; x < BLOCK; x++) if (x !== y) expect(at(o, x, y)[3]).toBe(0)
  })
  it('draws the whole diagonal black when both items are opaque, and keeps either side hard', () => {
    const o = splitDiagonal(red, blue)
    for (let d = 0; d < BLOCK; d++) expect(at(o, d, d)).toEqual([0, 0, 0, 255])
    expect(at(o, 5, 4)).toEqual([0, 0, 255, 255]) // above the diagonal: big
    expect(at(o, 4, 5)).toEqual([255, 0, 0, 255]) // below it: small
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

describe('the line at sub-pixel level: each half of the diagonal pixel follows its own item', () => {
  const W = 32
  const only = (cells: number[]) => {
    const a = new Uint8ClampedArray(BLOCK * BLOCK * 4)
    for (const c of cells) a.set([9, 9, 9, 255], (c * BLOCK + c) * 4)
    return a
  }
  // Diagonal art pixel 0: bottom-left item only. 1: top-right only. 2: both.
  const art = splitDiagonal(only([0, 2]), only([1, 2]))
  const p = new Uint8ClampedArray(W * W * 4)
  paintIndicator(p, W, W, 0, 0, art, 2, true)
  const lit = (x: number, y: number) => p[(y * W + x) * 4 + 3] !== 0
  it('shows a black triangle, not a square, where only one item is opaque, at 2x', () => {
    // Art pixel 0 is dest (0..1, 0..1): bottom-left half only; the pixel above the diagonal stays clear.
    expect([lit(0, 0), lit(1, 0), lit(0, 1), lit(1, 1)]).toEqual([true, false, true, true])
    // Art pixel 1 is dest (2..3, 2..3): top-right half only.
    expect([lit(2, 2), lit(3, 2), lit(2, 3), lit(3, 3)]).toEqual([true, true, false, true])
    // Art pixel 2, both items: the whole square.
    expect([lit(4, 4), lit(5, 4), lit(4, 5), lit(5, 5)]).toEqual([true, true, true, true])
  })
  it('paints every lit diagonal pixel black, and nothing on art pixels without a line', () => {
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) if (lit(x, y)) expect(Array.from(p.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))).toEqual([0, 0, 0, 255]) // prettier-ignore
    for (let y = 6; y < W; y++) for (let x = 0; x < W; x++) expect(lit(x, y)).toBe(false)
  })
})
