/**
 * The off-map canvas padding (#1004). Pure arithmetic and
 * synthetic bitmaps: no ROM, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  fadeMask,
  cellRect,
  centerScroll,
  insideMap,
  offMapPad,
  offMapSpritePixels,
  screensInView,
  type Pad,
  type Rect,
} from '../../../theia/extension/src/browser/off-map-extent'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

// 16 x 27 tile screens side by side, or 32 x 16 stacked (LevelParser.ts), one to seven screens.
const SHAPES = [1, 2, 5, 7].flatMap(n => [
  { w: 256 * n, h: 432, vertical: false },
  { w: 512, h: 256 * n, vertical: true },
])
const G = 128

describe('offMapPad: the gutter (D48 part 2, D145)', () => {
  it('a map with nothing off it is padded by the gutter alone, at its long ends only', () => {
    for (const { w, h, vertical } of SHAPES) {
      const inside: Rect[] = [cellRect(0, 0), cellRect(w / 16 - 1, h / 16 - 1), { x0: 0, y0: 0, x1: w, y1: h }] // prettier-ignore
      const want = vertical ? { left: 0, top: G, right: 0, bottom: G } : { left: G, top: 0, right: G, bottom: 0 } // prettier-ignore
      expect(offMapPad(w, h, inside, vertical)).toEqual(want)
      expect(offMapPad(w, h, [], vertical)).toEqual(want)
    }
  })
})

describe('offMapPad: content growth', () => {
  const H = { w: 256 * 5, h: 432, vertical: false }
  const V = { w: 512, h: 256 * 5, vertical: true }
  const pad = (m: typeof H, rects: Rect[]) => offMapPad(m.w, m.h, rects, m.vertical)

  it('on a long end the gutter sits BEYOND the tile-rounded content', () => {
    // Cell at tile -2 overflows by 32 px: 32 + the 128 gutter.
    expect(pad(H, [cellRect(-2, 5)])).toEqual({ left: 32 + G, top: 0, right: G, bottom: 0 })
    expect(pad(H, [cellRect(H.w / 16 + 1, 5)])).toEqual({ left: G, top: 0, right: 32 + G, bottom: 0 }) // prettier-ignore
    expect(pad(V, [cellRect(5, -1)])).toEqual({ left: 0, top: 16 + G, right: 0, bottom: G })
    expect(pad(V, [cellRect(5, V.h / 16)])).toEqual({ left: 0, top: G, right: 0, bottom: 16 + G }) // prettier-ignore
  })

  it('on a short side the content alone, no gutter and no extra margin', () => {
    expect(pad(H, [cellRect(5, -1)])).toEqual({ left: G, top: 16, right: G, bottom: 0 })
    expect(pad(H, [cellRect(5, 27)])).toEqual({ left: G, top: 0, right: G, bottom: 16 })
    expect(pad(V, [cellRect(-3, 5)])).toEqual({ left: 48, top: G, right: 0, bottom: G })
    expect(pad(V, [cellRect(32, 5)])).toEqual({ left: 0, top: G, right: 16, bottom: G })
  })

  it('a partial tile of overflow rounds up to a whole tile', () => {
    expect(pad(H, [{ x0: -1, y0: 0, x1: 8, y1: 8 }]).left).toBe(16 + G)
    expect(pad(H, [{ x0: 0, y0: 0, x1: H.w + 1, y1: 8 }]).right).toBe(16 + G)
    expect(pad(H, [{ x0: 0, y0: 0, x1: 8, y1: 433 }]).bottom).toBe(16)
    expect(pad(H, [{ x0: 0, y0: -17, x1: 8, y1: 8 }]).top).toBe(32)
  })

  it('content far beyond the old gutter still gets the gutter past it (no clamp, no cap)', () => {
    expect(pad(H, [cellRect(-100, 5)]).left).toBe(1600 + G)
    expect(pad(V, [cellRect(5, V.h / 16 + 300)]).bottom).toBe(4816 + G)
  })

  it('takes the farthest rect on each side, and all four sides at once', () => {
    const p = pad(H, [cellRect(-1, 0), cellRect(-3, 0), cellRect(0, -2), cellRect(H.w / 16 + 1, 0), cellRect(0, 28)]) // prettier-ignore
    expect(p).toEqual({ left: 48 + G, top: 32, right: 32 + G, bottom: 32 })
  })
})

describe('fadeMask (owner R24)', () => {
  it('fades along the scroll axis: to the right on a horizontal map, to the bottom on a vertical one', () => {
    expect(fadeMask(false, 128)).toBe('linear-gradient(to right, transparent, #000 128px, #000 calc(100% - 128px), transparent)') // prettier-ignore
    expect(fadeMask(true, 256)).toBe('linear-gradient(to bottom, transparent, #000 256px, #000 calc(100% - 256px), transparent)') // prettier-ignore
  })
})

describe('the scroll-axis lead (visibleScreens and placeStart arithmetic)', () => {
  it('a window wholly in the leading or trailing pad gets the nearest edge screen, never one past the map', () => {
    // 3 screens of 100 px behind a 128 px lead and before a 400 px trail (a wide off-map band).
    expect(screensInView(10, 50, 100, 128, 3, 0)).toEqual([0, 0])
    expect(screensInView(10, 50, 100, 128, 3, 2)).toEqual([0, 2])
    expect(screensInView(428 + 10, 50, 100, 128, 3, 0)).toEqual([2, 2]) // map ends at 428
    expect(screensInView(428 + 399, 1, 100, 128, 3, 2)).toEqual([0, 2])
    expect(screensInView(428 + 399, 1, 100, 128, 3, 0)).toEqual([2, 2])
  })

  it('never names a screen outside 0..count-1, however far the window or the margin reaches', () => {
    for (const scroll of [0, 50, 128, 300, 427, 428, 600, 828, 5000]) {
      for (const margin of [0, 1, 3]) {
        const [first, last] = screensInView(scroll, 200, 100, 128, 3, margin)
        expect(first).toBeGreaterThanOrEqual(0)
        expect(last).toBeLessThanOrEqual(2)
      }
    }
    // Reaching into the trailing pad from the map: the last screen, not a fourth.
    expect(screensInView(300, 400, 100, 128, 3, 2)).toEqual([0, 2])
  })

  it('the lead shifts every screen, the margin widens the range, clamped to the map', () => {
    // Scrolled to 228 the window starts exactly at screen 1; without the lead it would be screen 2.
    expect(screensInView(228, 50, 100, 128, 3, 0)).toEqual([1, 1])
    expect(screensInView(228, 150, 100, 128, 3, 0)).toEqual([1, 2])
    expect(screensInView(228, 50, 100, 128, 3, 1)).toEqual([0, 2])
    expect(screensInView(0, 10, 100, 0, 3, 0)).toEqual([0, 0])
    // A window straddling the leading pad and screen 0 asks for screen 0.
    expect(screensInView(100, 100, 100, 128, 3, 0)).toEqual([0, 0])
  })

  it('centers a map point on the view with the lead added, clamped to the scroll range', () => {
    expect(centerScroll(300, 128, 1, 200, 1000)).toBe(328)
    expect(centerScroll(300, 128, 2, 200, 1000)).toBe(756)
    expect(centerScroll(10, 128, 1, 200, 1000)).toBe(38)
    expect(centerScroll(0, 0, 1, 200, 1000)).toBe(0)
    expect(centerScroll(900, 128, 1, 200, 500)).toBe(500)
  })
})

describe('insideMap', () => {
  it('is true for map pixels and false past any edge, margin pixels being negative or beyond the end', () => {
    expect(insideMap(0, 0, 256, 432)).toBe(true)
    expect(insideMap(255, 431, 256, 432)).toBe(true)
    expect(insideMap(-38, 10, 256, 432)).toBe(false)
    expect(insideMap(256, 10, 256, 432)).toBe(false)
    expect(insideMap(0, -1, 256, 432)).toBe(false)
  })
})

describe('offMapSpritePixels', () => {
  const rgba = (n: number, c: number, a: number): string => {
    const b = new Uint8Array(n * 4)
    for (let i = 0; i < n; i++) b.set([c, 20, 30, a], i * 4)
    return Buffer.from(b).toString('base64')
  }
  /** `c` is the red byte: which sprite a pixel came from. */
  const sprite = (index: number, box: Rect, c = 10, a = 255): MapSpriteDto =>
    ({ index, id: 1, x: box.x0, y: box.y0, box, rgba: rgba((box.x1 - box.x0) * (box.y1 - box.y0), c, a), status: 'drawn' }) as MapSpriteDto // prettier-ignore

  /** The pixel at MAP coordinates (x, y) of a padded bitmap: [r, a], or [0, 0] when the bitmap is null. */
  const reader =
    (out: Uint8ClampedArray | null, mapW: number, pad: Pad) => (x: number, y: number) => {
      if (!out) return [0, 0]
      const i = ((y + pad.top) * (mapW + pad.left + pad.right) + x + pad.left) * 4
      return [out[i]!, out[i + 3]!]
    }

  it('keeps only the pixels outside the map, at their padded position', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    // 16 wide, straddling the map's left edge: 8 px off the map, 8 on it.
    const s = sprite(0, { x0: -8, y0: 4, x1: 8, y1: 6 })
    const at = reader(offMapSpritePixels([s], 256, 432, pad, false), 256, pad)
    expect([at(-8, 4)[1], at(-1, 4)[1], at(0, 4)[1], at(7, 4)[1], at(-8, 6)[1]]).toEqual([255, 255, 0, 0, 0]) // prettier-ignore
  })

  it('the $8D door: a box starting 8 px left of the map keeps its left-gutter pixels, and none over the map', () => {
    // Vanilla ghost houses (#1016): sprite $8D, box (-8, 287) to (56, 383); pad 144 left (one tile plus the gutter).
    const pad = { left: 144, top: 0, right: 128, bottom: 0 }
    const out = offMapSpritePixels([sprite(0, { x0: -8, y0: 287, x1: 56, y1: 383 })], 256, 432, pad, false) // prettier-ignore
    const at = reader(out, 256, pad)
    expect(at(-8, 287)).toEqual([10, 255])
    expect(at(-1, 382)).toEqual([10, 255])
    expect(at(-9, 300)[1]).toBe(0)
    expect(at(0, 300)[1]).toBe(0)
    expect(at(10, 286)[1]).toBe(0)
  })

  it('a box above and left of the map keeps its top and left pixels at the data position', () => {
    const pad = { left: 32, top: 144, right: 0, bottom: 0 }
    const out = offMapSpritePixels([sprite(0, { x0: -8, y0: -113, x1: 56, y1: 111 })], 256, 432, pad, false) // prettier-ignore
    const at = reader(out, 256, pad)
    expect(at(10, -113)).toEqual([10, 255])
    expect(at(10, -1)).toEqual([10, 255])
    expect(at(-8, -113)).toEqual([10, 255])
    expect(at(-8, 50)).toEqual([10, 255])
    expect(at(10, -114)[1]).toBe(0)
    expect(at(-9, 50)[1]).toBe(0)
    expect(at(10, 0)[1]).toBe(0)
    expect(at(56, -50)[1]).toBe(0)
  })

  it('reaches every side: left, top, right, bottom, on a horizontal and a vertical map', () => {
    for (const { w, h, vertical } of [
      { w: 512, h: 432, vertical: false },
      { w: 512, h: 512, vertical: true },
    ]) {
      const boxes: [Rect, [number, number]][] = [
        [{ x0: -6, y0: 40, x1: 4, y1: 50 }, [-3, 45]],
        [{ x0: 40, y0: -6, x1: 50, y1: 4 }, [45, -3]],
        [{ x0: w - 4, y0: 40, x1: w + 6, y1: 50 }, [w + 3, 45]],
        [{ x0: 40, y0: h - 4, x1: 50, y1: h + 6 }, [45, h + 3]],
      ]
      for (const [box, probe] of boxes) {
        const pad = offMapPad(w, h, [box], vertical)
        const at = reader(offMapSpritePixels([sprite(0, box)], w, h, pad, vertical), w, pad)
        expect(at(...probe)).toEqual([10, 255])
        // The in-map part of the same sprite is left to the screens.
        const [ix, iy] = [Math.min(Math.max(probe[0], 0), w - 1), Math.min(Math.max(probe[1], 0), h - 1)] // prettier-ignore
        expect(at(ix, iy)[1]).toBe(0)
      }
    }
  })

  it('where sprites overlap in the margin, the one the screens would stack on top wins', () => {
    const pad = { left: 48, top: 0, right: 0, bottom: 0 }
    // Horizontal map: stacked by x then stream index, later on top.
    const low = sprite(5, { x0: -16, y0: 10, x1: -4, y1: 20 }, 100)
    const high = sprite(1, { x0: -10, y0: 10, x1: -2, y1: 20 }, 200)
    for (const order of [
      [low, high],
      [high, low],
    ]) {
      const at = reader(offMapSpritePixels(order, 256, 432, pad, false), 256, pad)
      expect(at(-12, 15)).toEqual([100, 255]) // only the lower one covers it
      expect(at(-6, 15)).toEqual([200, 255]) // both cover it: larger x on top, whatever the index
    }
    // Same x: the later stream index is on top.
    const a = sprite(2, { x0: -10, y0: 10, x1: -2, y1: 20 }, 100)
    const b = sprite(7, { x0: -10, y0: 10, x1: -2, y1: 20 }, 200)
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const at = reader(offMapSpritePixels(order, 256, 432, pad, false), 256, pad)
      expect(at(-6, 15)).toEqual([200, 255])
    }
    // Vertical map: stacked by y.
    const vp = { left: 0, top: 48, right: 0, bottom: 0 }
    const up = sprite(9, { x0: 10, y0: -16, x1: 20, y1: -4 }, 100)
    const down = sprite(0, { x0: 10, y0: -10, x1: 20, y1: -2 }, 200)
    for (const order of [
      [up, down],
      [down, up],
    ]) {
      const at = reader(offMapSpritePixels(order, 512, 256, vp, true), 512, vp)
      expect(at(15, -6)).toEqual([200, 255])
    }
  })

  it('writes nothing outside the pad it is given (no wrap into the next row)', () => {
    const pad = { left: 128, top: 0, right: 128, bottom: 0 }
    // 80 px wide, 72 of them beyond the pad: only the 8 columns inside it (x -128..-121) are kept.
    const out = offMapSpritePixels([sprite(0, { x0: -200, y0: 10, x1: -120, y1: 20 })], 256, 432, pad, false)! // prettier-ignore
    let opaque = 0
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 0) opaque++
    expect(opaque).toBe(8 * 10)
  })

  it('returns null when nothing reaches the margin, or what does is transparent', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    const inside = sprite(0, { x0: 0, y0: 0, x1: 16, y1: 16 })
    const clear = sprite(0, { x0: -8, y0: 0, x1: 0, y1: 8 }, 10, 0)
    expect(offMapSpritePixels([inside], 256, 432, pad, false)).toBeNull()
    expect(offMapSpritePixels([clear], 256, 432, pad, false)).toBeNull()
  })
})
