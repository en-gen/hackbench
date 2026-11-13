/**
 * The off-map canvas padding (#1004). Pure arithmetic and
 * synthetic bitmaps: no ROM, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  addScreenRect,
  farEdge,
  fadeMask,
  cellRect,
  centerScroll,
  contentRects,
  placementRect,
  insideMap,
  offMapPad,
  offMapSpritePixels,
  screensInView,
  NO_PAD,
  type Pad,
  type Rect,
} from '../../../theia/extension/src/browser/off-map-extent'
import { spriteAt } from '../../../theia/extension/src/browser/map-view-model'
import { GUTTER_PX, MAX_SCREENS, farGutter } from '../../../src/rom/model/MapGutter'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

// 16 x 27 tile screens side by side, or 32 x 16 stacked (LevelParser.ts), one to 32 screens, the 5-bit ceiling.
const SHAPES = [1, 2, 5, 7, 31, 32].flatMap(n => [
  { n, w: 256 * n, h: 432, vertical: false },
  { n, w: 512, h: 256 * n, vertical: true },
])
const G = 256

describe('offMapPad: the far-end gutter (#1228)', () => {
  it('a map with nothing off it is padded by one screen at its far end alone', () => {
    for (const { n, w, h, vertical } of SHAPES) {
      const g = n === MAX_SCREENS ? 0 : G
      const inside: Rect[] = [
        cellRect(0, 0),
        cellRect(w / 16 - 1, h / 16 - 1),
        { x0: 0, y0: 0, x1: w, y1: h },
      ]
      const want = vertical
        ? { left: 0, top: 0, right: 0, bottom: g }
        : { left: 0, top: 0, right: g, bottom: 0 }
      expect(offMapPad(w, h, inside, vertical, n)).toEqual(want)
      expect(offMapPad(w, h, [], vertical, n)).toEqual(want)
    }
  })

  it('the gutter is one 256 px screen', () => {
    expect(GUTTER_PX).toBe(256)
  })

  it('32 screens, the ceiling, has no far-end pad; 31 has the full gutter, on both shapes', () => {
    expect(MAX_SCREENS).toBe(32)
    // Every legal count: one screen of gutter up to 31, none at the 32-screen ceiling.
    for (let n = 1; n <= MAX_SCREENS; n++)
      expect(farGutter(n), `${n} screens`).toBe(n === 32 ? 0 : 256)
    expect(offMapPad(256 * 32, 432, [], false, 32)).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    })
    expect(offMapPad(256 * 31, 432, [], false, 31)).toEqual({
      left: 0,
      top: 0,
      right: 256,
      bottom: 0,
    })
    expect(offMapPad(512, 256 * 32, [], true, 32)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(offMapPad(512, 256 * 31, [], true, 31)).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 256,
    })
  })

  it('a map at the ceiling still grows by its off-map content, with no gutter beyond it', () => {
    expect(
      offMapPad(256 * 32, 432, [cellRect(-2, 5), cellRect((256 * 32) / 16 + 1, 5)], false, 32),
    ).toEqual({ left: 32, top: 0, right: 32, bottom: 0 })
  })
})

describe('offMapPad: content growth', () => {
  const H = { w: 256 * 5, h: 432, vertical: false }
  const V = { w: 512, h: 256 * 5, vertical: true }
  const pad = (m: typeof H, rects: Rect[]) => offMapPad(m.w, m.h, rects, m.vertical, 5)

  it('at the far end the gutter sits BEYOND the tile-rounded content; the near end is content alone', () => {
    // Cell at tile -2 overflows by 32 px: content alone on the near end, the gutter only at the far end.
    expect(pad(H, [cellRect(-2, 5)])).toEqual({ left: 32, top: 0, right: G, bottom: 0 })
    expect(pad(H, [cellRect(H.w / 16 + 1, 5)])).toEqual({
      left: 0,
      top: 0,
      right: 32 + G,
      bottom: 0,
    })
    expect(pad(V, [cellRect(5, -1)])).toEqual({ left: 0, top: 16, right: 0, bottom: G })
    expect(pad(V, [cellRect(5, V.h / 16)])).toEqual({ left: 0, top: 0, right: 0, bottom: 16 + G })
  })

  it('on the short sides the content alone, no gutter and no extra margin', () => {
    expect(pad(H, [cellRect(5, -1)])).toEqual({ left: 0, top: 16, right: G, bottom: 0 })
    expect(pad(H, [cellRect(5, 27)])).toEqual({ left: 0, top: 0, right: G, bottom: 16 })
    expect(pad(V, [cellRect(-3, 5)])).toEqual({ left: 48, top: 0, right: 0, bottom: G })
    expect(pad(V, [cellRect(32, 5)])).toEqual({ left: 0, top: 0, right: 16, bottom: G })
  })

  it('a partial tile of overflow rounds up to a whole tile', () => {
    expect(pad(H, [{ x0: -1, y0: 0, x1: 8, y1: 8 }]).left).toBe(16)
    expect(pad(H, [{ x0: 0, y0: 0, x1: H.w + 1, y1: 8 }]).right).toBe(16 + G)
    expect(pad(H, [{ x0: 0, y0: 0, x1: 8, y1: 433 }]).bottom).toBe(16)
    expect(pad(H, [{ x0: 0, y0: -17, x1: 8, y1: 8 }]).top).toBe(32)
  })

  it('content far beyond the gutter still gets the gutter past it (no clamp, no cap)', () => {
    expect(pad(H, [cellRect(-100, 5)]).left).toBe(1600)
    expect(pad(V, [cellRect(5, V.h / 16 + 300)]).bottom).toBe(4816 + G)
  })

  it('takes the farthest rect on each side, and all four sides at once', () => {
    const p = pad(H, [
      cellRect(-1, 0),
      cellRect(-3, 0),
      cellRect(0, -2),
      cellRect(H.w / 16 + 1, 0),
      cellRect(0, 28),
    ])
    expect(p).toEqual({ left: 48, top: 32, right: 32 + G, bottom: 32 })
  })
})

describe('fadeMask (owner R24, #1228)', () => {
  it('opaque from the near edge, fading to transparent across the far-end gutter only', () => {
    expect(fadeMask(false, 256)).toBe(
      'linear-gradient(to right, #000 calc(100% - 256px), transparent)',
    )
    expect(fadeMask(true, 512)).toBe(
      'linear-gradient(to bottom, #000 calc(100% - 512px), transparent)',
    )
  })

  it('with no gutter (a 32-screen map) there is no fade at all', () => {
    expect(fadeMask(false, 0)).toBe('none')
    expect(fadeMask(true, 0)).toBe('none')
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
    ({
      index,
      id: 1,
      x: box.x0,
      y: box.y0,
      box,
      rgba: rgba((box.x1 - box.x0) * (box.y1 - box.y0), c, a),
      status: 'drawn',
    }) as MapSpriteDto

  /** The pixel at MAP coordinates (x, y) of a padded bitmap: [r, a], or [0, 0] when the bitmap is null. */
  const reader =
    (out: Uint8ClampedArray | null, mapW: number, pad: Pad) => (x: number, y: number) => {
      if (!out) return [0, 0]
      const i = ((y + pad.top) * (mapW + pad.left + pad.right) + x + pad.left) * 4
      return [out[i]!, out[i + 3]!]
    }

  it('a sprite its parent drew paints nothing off the map either: the parent holds its pixels (#1173)', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    // Parent 1, C 2, child 3 overlap at x -8..-1. The child's pixel would sit over C if it painted; spriteAt skips it too.
    const parent = sprite(1, { x0: -8, y0: 4, x1: 8, y1: 6 }, 30)
    const c = sprite(2, { x0: -8, y0: 4, x1: 0, y1: 6 }, 40)
    const child = { ...sprite(3, { x0: -8, y0: 4, x1: 0, y1: 6 }, 50), drawnBy: 1 }
    const out = offMapSpritePixels([parent, c, child], 256, 432, pad, false)
    expect(reader(out, 256, pad)(-4, 4)).toEqual([40, 255]) // C over the parent, as spriteAt answers
    expect(
      reader(offMapSpritePixels([parent, child], 256, 432, pad, false), 256, pad)(-4, 4),
    ).toEqual([30, 255]) // the parent's own bitmap shows
    expect(offMapSpritePixels([child], 256, 432, pad, false)).toBeNull()
    expect(offMapSpritePixels([{ ...child, drawnBy: 0 }], 256, 432, pad, false)).toBeNull() // parent at index 0
  })

  it('keeps only the pixels outside the map, at their padded position', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    // 16 wide, straddling the map's left edge: 8 px off the map, 8 on it.
    const s = sprite(0, { x0: -8, y0: 4, x1: 8, y1: 6 })
    const at = reader(offMapSpritePixels([s], 256, 432, pad, false), 256, pad)
    expect([at(-8, 4)[1], at(-1, 4)[1], at(0, 4)[1], at(7, 4)[1], at(-8, 6)[1]]).toEqual([
      255, 255, 0, 0, 0,
    ])
  })

  it('the $8D door: a box starting 8 px left of the map keeps its left-gutter pixels, and none over the map', () => {
    // Vanilla ghost houses (#1016): sprite $8D, box (-8, 287) to (56, 383); pad 16 left (one tile of content, no left gutter).
    const pad = { left: 16, top: 0, right: 256, bottom: 0 }
    const out = offMapSpritePixels(
      [sprite(0, { x0: -8, y0: 287, x1: 56, y1: 383 })],
      256,
      432,
      pad,
      false,
    )
    const at = reader(out, 256, pad)
    expect(at(-8, 287)).toEqual([10, 255])
    expect(at(-1, 382)).toEqual([10, 255])
    expect(at(-9, 300)[1]).toBe(0)
    expect(at(0, 300)[1]).toBe(0)
    expect(at(10, 286)[1]).toBe(0)
  })

  it('a box above and left of the map keeps its top and left pixels at the data position', () => {
    const pad = { left: 32, top: 144, right: 0, bottom: 0 }
    const out = offMapSpritePixels(
      [sprite(0, { x0: -8, y0: -113, x1: 56, y1: 111 })],
      256,
      432,
      pad,
      false,
    )
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
        const pad = offMapPad(w, h, [box], vertical, 5)
        const at = reader(offMapSpritePixels([sprite(0, box)], w, h, pad, vertical), w, pad)
        expect(at(...probe)).toEqual([10, 255])
        // The in-map part of the same sprite is left to the screens.
        const [ix, iy] = [
          Math.min(Math.max(probe[0], 0), w - 1),
          Math.min(Math.max(probe[1], 0), h - 1),
        ]
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
    const out = offMapSpritePixels(
      [sprite(0, { x0: -200, y0: 10, x1: -120, y1: 20 })],
      256,
      432,
      pad,
      false,
    )!
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

describe('what grows the canvas: placement, never art (#1325)', () => {
  const SIZES = [
    { w: 256 * 5, h: 432, vertical: false },
    { w: 512, h: 256 * 5, vertical: true },
  ]
  /** A drawn sprite anchored at (x, y) whose art is `box`. */
  const sp = (x: number, y: number, box: Rect, stored?: { x: number; y: number }): MapSpriteDto =>
    ({ index: 0, id: 1, x, y, box, stored, rgba: '', status: 'drawn' }) as MapSpriteDto
  const padOf = (
    m: (typeof SIZES)[number],
    sprites: MapSpriteDto[],
    refused: { x: number; y: number }[] = [],
  ) => offMapPad(m.w, m.h, contentRects(refused, sprites, m.w, m.h), m.vertical, 5)
  /** The pad with the far-end gutter taken out, so the long side compares like the short ones. */
  const bare = (m: (typeof SIZES)[number], p: Pad): Pad => ({
    ...p,
    right: p.right - (m.vertical ? 0 : G),
    bottom: p.bottom - (m.vertical ? G : 0),
  })

  it('art overhanging each of the 4 sides by 1 to 32 px, from a placement on the map, pads nothing', () => {
    for (const m of SIZES)
      for (let k = 1; k <= 32; k++) {
        const arts: Rect[] = [
          { x0: -k, y0: 40, x1: 48 - k, y1: 88 },
          { x0: 40, y0: -k, x1: 88, y1: 48 - k },
          { x0: m.w - 48 + k, y0: 40, x1: m.w + k, y1: 88 },
          { x0: 40, y0: m.h - 48 + k, x1: 88, y1: m.h + k },
        ]
        for (const art of arts) {
          const s = sp(Math.max(art.x0, 0), Math.max(art.y0, 0), art)
          expect(bare(m, padOf(m, [s])), `${k}px ${JSON.stringify(art)}`).toEqual(NO_PAD)
        }
      }
  })

  it('a sprite placed off each of the 4 sides pads that side AND draws there; a refused cell pads too', () => {
    // The art (32 x 32) overlaps both its cell and the map edge, so no fallback hides a clamped cell.
    const white = Buffer.alloc(32 * 32 * 4, 255).toString('base64')
    for (const m of SIZES) {
      const cases: [number, number, keyof Pad][] = [
        [-16, 40, 'left'],
        [40, -16, 'top'],
        [m.w, 40, 'right'],
        [40, m.h, 'bottom'],
      ]
      for (const [x, y, side] of cases) {
        const s = { ...sp(x, y, { x0: x - 8, y0: y - 8, x1: x + 24, y1: y + 24 }), rgba: white }
        const pad = padOf(m, [s])
        expect(bare(m, pad)[side], `${side} pad`).toBe(16)
        const out = offMapSpritePixels([s], m.w, m.h, pad, m.vertical)
        const i = ((y + 8 + pad.top) * (m.w + pad.left + pad.right) + x + 8 + pad.left) * 4 + 3
        expect(out?.[i], `${side} draws`).toBe(255)
      }
      const refused: [number, number, keyof Pad][] = [
        [-1, 5, 'left'],
        [5, -1, 'top'],
        [m.w / 16, 5, 'right'],
        [5, m.h / 16, 'bottom'],
      ]
      for (const [x, y, side] of refused)
        expect(bare(m, padOf(m, [], [{ x, y }]))[side], `refused ${side}`).toBe(16)
    }
  })

  it('a sprite placed just below the map pads its one cell and its art is cut past it', () => {
    const m = SIZES[0]!
    const art = { x0: 64, y0: m.h, x1: 96, y1: m.h + 24 }
    const rgba = Buffer.alloc(32 * 24 * 4, 255).toString('base64')
    const s = { ...sp(64, m.h, art), rgba }
    const pad = padOf(m, [s])
    expect(pad.bottom).toBe(16)
    const out = offMapSpritePixels([s], m.w, m.h, pad, false)
    const at = (y: number) =>
      out?.[((y + pad.top) * (m.w + pad.left + pad.right) + 70 + pad.left) * 4 + 3]
    expect([at(m.h + 15), at(m.h + 16)]).toEqual([255, undefined])
  })

  it('a sprite with no art on the map or its placement cell is never hidden (D52): its box pads and draws, 1 px of art on the map does not', () => {
    const m = SIZES[0]!
    const box = { x0: -48, y0: 8, x1: -32, y1: 24 }
    const rgba = Buffer.alloc(16 * 16 * 4, 255).toString('base64')
    const s = { ...sp(-48, 8, box, { x: 8, y: 8 }), rgba }
    const pad = padOf(m, [s])
    expect(pad.left).toBe(48)
    const out = offMapSpritePixels([s], m.w, m.h, pad, false)
    expect(out?.[((8 + pad.top) * (m.w + pad.left + pad.right) + pad.left - 48) * 4 + 3]).toBe(255)
    const one = sp(-47, 8, { x0: -15, y0: 8, x1: 1, y1: 24 }, { x: 8, y: 8 })
    expect(padOf(m, [one]).left).toBe(0)
  })

  it('a sprite placed off the map still draws there, while its art past the edge from a placed-on-map sprite is not in the pad', () => {
    const m = SIZES[0]!
    const off = { x0: -16, y0: 40, x1: 0, y1: 56 }
    const onMap = { x0: 40, y0: m.h - 16, x1: 56, y1: m.h + 8 }
    const sprites = [sp(-16, 40, off), sp(40, m.h - 16, onMap)]
    const pad = padOf(m, sprites)
    expect(pad.bottom).toBe(0)
    const out = offMapSpritePixels(
      sprites.map(s => ({ ...s, rgba: Buffer.alloc(256 * 4, 255).toString('base64') })),
      m.w,
      m.h,
      pad,
      false,
    )
    expect(out).not.toBeNull()
    const i = (40 + pad.top) * (m.w + pad.left + pad.right) * 4 + (-8 + pad.left) * 4 + 3
    expect(out![i]).toBe(255)
  })

  it('`stored` wins over the anchor, in either direction', () => {
    const art = { x0: 0, y0: 0, x1: 16, y1: 16 }
    expect(placementRect(sp(0, 0, art, { x: -32, y: 8 }))).toEqual({
      x0: -32,
      y0: 8,
      x1: -16,
      y1: 24,
    })
    const m = SIZES[0]!
    expect(padOf(m, [sp(-48, 8, art, { x: 8, y: 8 })]).left).toBe(0)
    expect(padOf(m, [sp(8, 8, art, { x: -32, y: 8 })]).left).toBe(32)
  })

  it('a sprite whose art is cut at the bottom still hits from the part left on the map', () => {
    const art = { x0: 64, y0: 416, x1: 96, y1: 448 }
    const s = { ...sp(64, 416, art), rgba: Buffer.alloc(32 * 32 * 4, 255).toString('base64') }
    const g = { orientation: 'horizontal' as const, width: 256, height: 432 }
    expect(padOf(SIZES[0]!, [s]).bottom).toBe(0)
    expect(spriteAt([s], g, 80, 424)).toBe(s)
  })

  it('the far-end gutter is unchanged, with or without art past the far edge', () => {
    for (const m of SIZES) {
      const art = m.vertical
        ? { x0: 40, y0: m.h - 8, x1: 56, y1: m.h + 40 }
        : { x0: m.w - 8, y0: 40, x1: m.w + 40, y1: 56 }
      const p = padOf(m, [sp(m.vertical ? 32 : m.w - 16, m.vertical ? m.h - 16 : 32, art)])
      expect(m.vertical ? [p.bottom, p.right] : [p.right, p.bottom]).toEqual([G, 0])
      expect(padOf(m, [])).toEqual(p)
    }
  })
})

describe('the end line and the Add screen rect (#1296)', () => {
  const [W, H] = [512, 432]
  const content: Rect[] = [{ x0: 600, y0: 40, x1: 616, y1: 56 }] // a cell 104 px past the far edge

  it('puts the end line on the screen count times the screen size, never on content or the canvas end', () => {
    for (const vertical of [false, true]) {
      const [mw, mh] = vertical ? [256, 864] : [W, H]
      const pad = offMapPad(
        mw,
        mh,
        vertical ? [{ x0: 0, y0: 900, x1: 16, y1: 916 }] : content,
        vertical,
        2,
      )
      const e = farEdge(mw, mh, pad, vertical)
      if (vertical) {
        expect(e.y0).toBe(mh + pad.top)
        expect(e.y1).toBe(e.y0)
        expect(e.y0).toBeLessThan(mh + pad.top + pad.bottom)
      } else {
        expect(e.x0).toBe(mw + pad.left)
        expect(e.x1).toBe(e.x0)
        expect(e.x0).toBeLessThan(mw + pad.left + pad.right)
      }
    }
  })

  it('does not move when content lies past the end', () => {
    const bare = farEdge(W, H, offMapPad(W, H, [], false, 2), false)
    const past = farEdge(W, H, offMapPad(W, H, content, false, 2), false)
    expect(past).toEqual(bare)
  })

  it('fills the last gutter screen of the strip, after any content band', () => {
    const pad = offMapPad(W, H, content, false, 2)
    const r = addScreenRect(W, H, pad, false, 2)!
    expect(r.x1 - r.x0).toBe(GUTTER_PX)
    expect(r.x1).toBe(W + pad.left + pad.right)
    expect(r.x0).toBe(W + 112) // the band: 616 - 512 = 104 px, rounded up to 112
    expect([r.y0, r.y1]).toEqual([pad.top, pad.top + H])
    const v = addScreenRect(256, 864, offMapPad(256, 864, [], true, 2), true, 2)!
    expect([v.y0, v.y1]).toEqual([864, 864 + GUTTER_PX])
  })

  it('has no Add screen rect at the 32-screen ceiling, and the end line is still the map edge', () => {
    const pad = offMapPad(W * 16, H, [], false, MAX_SCREENS)
    expect(addScreenRect(W * 16, H, pad, false, MAX_SCREENS)).toBeNull()
    expect(farEdge(W * 16, H, pad, false).x0).toBe(W * 16)
  })

  // A band BEFORE position 0 (a cell at tile (-2, 5) and one at (3, -1)) shifts the map right and down by
  // 32 and 16 px, so every expected number below carries those leads as literals, never read from `pad`.
  it.each([false, true])(
    'shifts the end line and the Add screen rect by the near bands, every screen count (vertical %s)',
    vertical => {
      for (const bands of [[], [cellRect(-2, 5), cellRect(3, -1)]]) {
        for (const far of [0, 112]) {
          for (let n = 1; n <= MAX_SCREENS; n++) {
            const [mw, mh] = vertical ? [512, 256 * n] : [256 * n, 432]
            const [lx, ly] = bands.length ? [32, 16] : [0, 0]
            const rects = [...bands]
            if (far)
              rects.push(vertical ? cellRect(1, (mh + 96) / 16) : cellRect((mw + 96) / 16, 1))
            const pad = offMapPad(mw, mh, rects, vertical, n)
            const e = farEdge(mw, mh, pad, vertical)
            const want = vertical
              ? { x0: lx, y0: ly + mh, x1: lx + mw, y1: ly + mh }
              : { x0: lx + mw, y0: ly, x1: lx + mw, y1: ly + mh }
            const tag = JSON.stringify({ vertical, n, near: bands.length, far })
            expect(e, tag).toEqual(want)
            const a = addScreenRect(mw, mh, pad, vertical, n)
            if (n >= MAX_SCREENS) {
              expect(a, tag).toBeNull()
              continue
            }
            const wantAdd = vertical
              ? { x0: lx, y0: ly + mh + far, x1: lx + mw, y1: ly + mh + far + GUTTER_PX }
              : { x0: lx + mw + far, y0: ly, x1: lx + mw + far + GUTTER_PX, y1: ly + mh }
            expect(a, tag).toEqual(wantAdd)
          }
        }
      }
    },
  )
})
