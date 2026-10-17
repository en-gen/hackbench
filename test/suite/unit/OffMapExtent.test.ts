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
  const rgba = (n: number, a = 255): string => {
    const b = new Uint8Array(n * 4)
    for (let i = 0; i < n; i++) b.set([10, 20, 30, a], i * 4)
    return Buffer.from(b).toString('base64')
  }
  const sprite = (index: number, box: Rect, a = 255): MapSpriteDto =>
    ({ index, id: 1, x: box.x0, y: box.y0, box, rgba: rgba((box.x1 - box.x0) * (box.y1 - box.y0), a), status: 'drawn' }) as MapSpriteDto // prettier-ignore

  it('keeps only the pixels outside the map, at their padded position', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    // 16 wide, straddling the map's left edge: 8 px off the map, 8 on it.
    const s = sprite(0, { x0: -8, y0: 4, x1: 8, y1: 6 })
    const out = offMapSpritePixels([s], 256, 432, pad, false)!
    const w = 256 + 32
    const at = (x: number, y: number) => out[(y * w + x) * 4 + 3]
    expect([at(24, 4), at(31, 4), at(32, 4), at(40, 4), at(24, 6)]).toEqual([255, 255, 0, 0, 0])
  })

  it('returns null when nothing reaches the margin, or what does is transparent', () => {
    const pad = { left: 32, top: 0, right: 0, bottom: 0 }
    const inside = sprite(0, { x0: 0, y0: 0, x1: 16, y1: 16 })
    const clear = sprite(0, { x0: -8, y0: 0, x1: 0, y1: 8 }, 0)
    expect(offMapSpritePixels([inside], 256, 432, pad, false)).toBeNull()
    expect(offMapSpritePixels([clear], 256, 432, pad, false)).toBeNull()
  })
})
