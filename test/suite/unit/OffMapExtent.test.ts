/**
 * The fixed gutter and the sprite pixels that fall in it (D48 part 2, #1004). Pure arithmetic
 * and synthetic bitmaps: no ROM, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  gutterPad,
  insideMap,
  isPadded,
  NO_PAD,
  offMapSpritePixels,
  type Pad,
} from '../../../theia/extension/src/browser/off-map-extent'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

/** A sprite box in map pixels, x1 and y1 exclusive. */
interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

describe('gutterPad (D48 part 2)', () => {
  it('a horizontal map always has 128 px each side and none above or below, whatever its length', () => {
    // The gutter is a property of the orientation alone: no map length or content enters it.
    expect(gutterPad(false)).toEqual({ left: 128, top: 0, right: 128, bottom: 0 })
    expect(isPadded(gutterPad(false))).toBe(true)
  })

  it('a vertical map has no gutter at all', () => {
    expect(gutterPad(true)).toEqual(NO_PAD)
    expect(isPadded(gutterPad(true))).toBe(false)
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

  const G = gutterPad(false)
  const [W, H] = [256, 432]
  /** The pixel at MAP coordinates (x, y) of a padded bitmap: [r, a], or [0, 0] when the bitmap is null. */
  const reader =
    (out: Uint8ClampedArray | null, mapW: number, pad: Pad) => (x: number, y: number) => {
      if (!out) return [0, 0]
      const i = ((y + pad.top) * (mapW + pad.left + pad.right) + x + pad.left) * 4
      return [out[i]!, out[i + 3]!]
    }
  const draw = (sprites: MapSpriteDto[]) =>
    reader(offMapSpritePixels(sprites, W, H, G, false), W, G)

  it('keeps the pixels in the left and right gutters at the data position, and leaves the map to the screens', () => {
    // 16 wide, straddling the map's left edge: 8 px in the gutter, 8 on the map.
    const left = draw([sprite(0, { x0: -8, y0: 4, x1: 8, y1: 6 })])
    expect([left(-8, 4)[1], left(-1, 4)[1], left(0, 4)[1], left(7, 4)[1], left(-8, 6)[1]]).toEqual([255, 255, 0, 0, 0]) // prettier-ignore
    const right = draw([sprite(0, { x0: W - 8, y0: 4, x1: W + 8, y1: 6 })])
    expect([right(W - 1, 4)[1], right(W, 4)[1], right(W + 7, 4)[1], right(W + 8, 4)[1]]).toEqual([0, 255, 255, 0]) // prettier-ignore
  })

  it('a ghost-house door shape: pixels at x -8..-1 of the left gutter are kept', () => {
    const at = draw([sprite(0, { x0: -8, y0: 287, x1: 8, y1: 335 })])
    expect(at(-8, 300)).toEqual([10, 255])
    expect(at(-1, 334)).toEqual([10, 255])
    expect(at(-9, 300)[1]).toBe(0)
  })

  it('drops what is beyond the gutter, and what is above or below the map', () => {
    const beyond = draw([sprite(0, { x0: -140, y0: 10, x1: -120, y1: 20 })])
    expect(beyond(-129, 15)[1]).toBe(0) // beyond the gutter's outer edge
    expect(beyond(-128, 15)[1]).toBe(255) // the outermost gutter column
    const far = draw([sprite(0, { x0: W + 120, y0: 10, x1: W + 140, y1: 20 })])
    expect(far(W + 127, 15)[1]).toBe(255)
    expect(far(W + 128, 15)[1]).toBe(0)
    // Above and below: no row outside 0..H is kept, even inside the gutter's columns.
    const rows = draw([sprite(0, { x0: -8, y0: -20, x1: 8, y1: -4 }), sprite(1, { x0: -8, y0: H + 4, x1: 8, y1: H + 20 })]) // prettier-ignore
    expect(rows(-4, -10)[1]).toBe(0)
    expect(rows(-4, H + 10)[1]).toBe(0)
    expect(offMapSpritePixels([sprite(0, { x0: -8, y0: -20, x1: 8, y1: -4 })], W, H, G, false)).toBeNull() // prettier-ignore
  })

  it('where sprites overlap in the gutter, the one the screens would stack on top wins', () => {
    // Horizontal map: stacked by x then stream index, later on top.
    const low = sprite(5, { x0: -16, y0: 10, x1: -4, y1: 20 }, 100)
    const high = sprite(1, { x0: -10, y0: 10, x1: -2, y1: 20 }, 200)
    for (const order of [
      [low, high],
      [high, low],
    ]) {
      const at = draw(order)
      expect(at(-12, 15)).toEqual([100, 255]) // only the lower one covers it
      expect(at(-6, 15)).toEqual([200, 255]) // both cover it: larger x on top, whatever the index
    }
    // Same x: the later stream index is on top.
    const a = sprite(2, { x0: -10, y0: 10, x1: -2, y1: 20 }, 100)
    const b = sprite(7, { x0: -10, y0: 10, x1: -2, y1: 20 }, 200)
    for (const order of [
      [a, b],
      [b, a],
    ])
      expect(draw(order)(-6, 15)).toEqual([200, 255])
  })

  it('returns null when nothing reaches the gutter, or what does is transparent', () => {
    expect(draw([sprite(0, { x0: 0, y0: 0, x1: 16, y1: 16 })])(0, 0)).toEqual([0, 0])
    expect(offMapSpritePixels([sprite(0, { x0: 0, y0: 0, x1: 16, y1: 16 })], W, H, G, false)).toBeNull() // prettier-ignore
    expect(offMapSpritePixels([sprite(0, { x0: -8, y0: 0, x1: 0, y1: 8 }, 10, 0)], W, H, G, false)).toBeNull() // prettier-ignore
  })
})
