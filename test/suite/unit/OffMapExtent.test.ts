/**
 * The off-map canvas padding (#1004). Pure arithmetic and
 * synthetic bitmaps: no ROM, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  cellRect,
  insideMap,
  isPadded,
  NO_PAD,
  offMapPad,
  offMapSpritePixels,
  type Pad,
  type Rect,
} from '../../../theia/extension/src/browser/off-map-extent'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

// 16 x 27 tile screens side by side, or 32 x 16 stacked (LevelParser.ts).
const SIZES = [
  { w: 256, h: 432 },
  { w: 256 * 5, h: 432 },
  { w: 512, h: 256 * 7 },
  { w: 512, h: 256 },
]

describe('offMapPad', () => {
  it('content inside the map gives no padding, on every map size and orientation', () => {
    for (const { w, h } of SIZES) {
      const rects: Rect[] = [
        cellRect(0, 0),
        cellRect(w / 16 - 1, h / 16 - 1),
        { x0: 0, y0: 0, x1: w, y1: h },
        cellRect(3, 4),
      ]
      expect(offMapPad(w, h, rects)).toEqual(NO_PAD)
      expect(isPadded(offMapPad(w, h, rects))).toBe(false)
    }
    expect(offMapPad(256, 432, [])).toEqual(NO_PAD)
  })

  it('content past one side pads that side only: whole tiles plus one tile of margin', () => {
    const { w, h } = SIZES[1]!
    // Cell at tile -2 overflows by 32 px: 32 + 16.
    expect(offMapPad(w, h, [cellRect(-2, 5)])).toEqual({ ...NO_PAD, left: 48 })
    expect(offMapPad(w, h, [cellRect(w / 16 + 1, 5)])).toEqual({ ...NO_PAD, right: 48 })
    expect(offMapPad(w, h, [cellRect(5, -1)])).toEqual({ ...NO_PAD, top: 32 })
    expect(offMapPad(w, h, [cellRect(5, h / 16)])).toEqual({ ...NO_PAD, bottom: 32 })
  })

  it('a partial tile of overflow rounds up to a whole tile, then adds the margin', () => {
    expect(offMapPad(256, 432, [{ x0: -1, y0: 0, x1: 8, y1: 8 }])).toEqual({ ...NO_PAD, left: 32 })
    expect(offMapPad(256, 432, [{ x0: 250, y0: 0, x1: 257, y1: 8 }])).toEqual({ ...NO_PAD, right: 32 }) // prettier-ignore
    expect(offMapPad(256, 432, [{ x0: 0, y0: 0, x1: 256, y1: 433 }])).toEqual({ ...NO_PAD, bottom: 32 }) // prettier-ignore
  })

  it('takes the farthest rect on each side, and all four sides at once', () => {
    const pad = offMapPad(256, 432, [
      cellRect(-1, 0),
      cellRect(-3, 0),
      cellRect(0, -2),
      cellRect(17, 0),
      cellRect(0, 28),
    ])
    expect(pad).toEqual({ left: 64, top: 48, right: 48, bottom: 48 })
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

  it('the $8D-shaped witness: a tall box above and left of the map, in the top and left margins', () => {
    // A sprite at (0, 0) whose parts reach 113 px above it (vanilla ghost-house maps pad top 144, left 32).
    const pad = { left: 32, top: 144, right: 0, bottom: 0 }
    const out = offMapSpritePixels([sprite(0, { x0: -8, y0: -113, x1: 56, y1: 111 })], 256, 432, pad, false) // prettier-ignore
    const at = reader(out, 256, pad)
    // Top margin, the box's first row and a middle row; the corner; the left margin below the map's top.
    expect(at(10, -113)).toEqual([10, 255])
    expect(at(10, -1)).toEqual([10, 255])
    expect(at(-8, -113)).toEqual([10, 255])
    expect(at(-8, 50)).toEqual([10, 255])
    // Not in the box, and in the map (the screens draw it).
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
        const pad = offMapPad(w, h, [box])
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

  it('returns null when nothing reaches the margin, or what does is transparent', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    const inside = sprite(0, { x0: 0, y0: 0, x1: 16, y1: 16 })
    const clear = sprite(0, { x0: -8, y0: 0, x1: 0, y1: 8 }, 10, 0)
    expect(offMapSpritePixels([inside], 256, 432, pad, false)).toBeNull()
    expect(offMapSpritePixels([clear], 256, 432, pad, false)).toBeNull()
  })
})
