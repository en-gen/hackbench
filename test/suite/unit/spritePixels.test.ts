/**
 * spritePixels - pure composition behind the sprite inspector previews.
 *
 * These lock the rules the map canvas already follows, so a preview cannot
 * disagree with what the level shows: colour index 0 is transparent, flips
 * mirror the source read, and the palette row indexes the payload snapshot.
 * Compared against `CanvasRenderTarget.blit8x8` by reading, not by running
 * both; no canvas exists under vitest's node environment.
 */

import { describe, expect, it } from 'vitest'
import {
  blitPartsRgba, partBounds, partsBounds, previewScale,
  type PaletteRows,
} from '../../../src/webview/mapEditor/spritePixels'
import type { SpritePartInfo } from '../../../src/webview/mapEditor/spriteProps'

/** Row r, index i is [r, i, 0, 255], so a pixel names its own row and index. */
const ROWS: PaletteRows = Array.from({ length: 16 }, (_, r) =>
  Array.from({ length: 16 }, (_, i) => [r, i, 0, 255]))

function info(over: Partial<SpritePartInfo> = {}): SpritePartInfo {
  return {
    char: 0x100, palette: 8, flipX: false, flipY: false, dx: 0, dy: 0,
    pixels: new Uint8Array(64).fill(1), ...over,
  }
}

/** Colour index written at (x, y), read back from the buffer's green channel. */
const at = (buf: Uint8ClampedArray, w: number, x: number, y: number): number =>
  buf[(y * w + x) * 4 + 1]

const alphaAt = (buf: Uint8ClampedArray, w: number, x: number, y: number): number =>
  buf[(y * w + x) * 4 + 3]

/** One lit pixel at source (sx, sy), index 5. */
function dot(sx: number, sy: number): Uint8Array {
  const px = new Uint8Array(64)
  px[sy * 8 + sx] = 5
  return px
}

describe('partsBounds', () => {
  it('covers every part, including ones placed above and left of the origin', () => {
    expect(partsBounds([info({ dx: -8, dy: -16 }), info({ dx: 8, dy: 0 })]))
      .toEqual({ dx: -8, dy: -16, w: 24, h: 24 })
  })

  it('is one tile for a single part at the origin', () => {
    expect(partsBounds([info()])).toEqual({ dx: 0, dy: 0, w: 8, h: 8 })
  })

  it('falls back to one tile rather than an infinite rect when there are no parts', () => {
    expect(partsBounds([])).toEqual({ dx: 0, dy: 0, w: 8, h: 8 })
  })

  it('gives a single part its own cell', () => {
    expect(partBounds(info({ dx: 24, dy: -8 }))).toEqual({ dx: 24, dy: -8, w: 8, h: 8 })
  })
})

describe('previewScale', () => {
  it('magnifies a lone 8x8 tile to the cap', () => {
    expect(previewScale(8, 8)).toBe(8)
  })

  it('shrinks the step as the sprite grows, keeping it inside the 230px panel', () => {
    expect(previewScale(16, 16)).toBe(8)
    expect(previewScale(32, 32)).toBe(4)
    expect(previewScale(64, 64)).toBe(2)   // $9F Banzai Bill
  })

  it('scales on the longer side, so a tall sprite still fits', () => {
    expect(previewScale(16, 64)).toBe(2)
  })

  it('never drops below 1:1 or returns a fraction', () => {
    expect(previewScale(512, 512)).toBe(1)
    expect(Number.isInteger(previewScale(24, 40))).toBe(true)
  })
})

describe('blitPartsRgba', () => {
  it('reads colours from the part own palette row', () => {
    const buf = blitPartsRgba([info({ palette: 11, pixels: dot(0, 0) })], ROWS, partsBounds([info()]))
    expect(buf[0]).toBe(11)      // red channel carries the row
    expect(buf[1]).toBe(5)       // green channel carries the colour index
  })

  it('leaves colour index 0 fully transparent', () => {
    const buf = blitPartsRgba([info({ pixels: dot(3, 4) })], ROWS, partsBounds([info()]))
    expect(alphaAt(buf, 8, 3, 4)).toBe(255)
    expect(alphaAt(buf, 8, 0, 0)).toBe(0)
  })

  it('mirrors horizontally when flipX is set', () => {
    const b = partsBounds([info()])
    expect(at(blitPartsRgba([info({ pixels: dot(1, 2) })], ROWS, b), 8, 1, 2)).toBe(5)
    expect(at(blitPartsRgba([info({ pixels: dot(1, 2), flipX: true })], ROWS, b), 8, 6, 2)).toBe(5)
  })

  it('mirrors vertically when flipY is set', () => {
    const b = partsBounds([info()])
    expect(at(blitPartsRgba([info({ pixels: dot(1, 2), flipY: true })], ROWS, b), 8, 1, 5)).toBe(5)
  })

  it('mirrors both axes at once', () => {
    const b = partsBounds([info()])
    const buf = blitPartsRgba([info({ pixels: dot(1, 2), flipX: true, flipY: true })], ROWS, b)
    expect(at(buf, 8, 6, 5)).toBe(5)
  })

  it('places each part at its displacement relative to the bounds origin', () => {
    const parts = [
      info({ dx: -8, dy: 0, pixels: dot(0, 0) }),
      info({ dx: 0,  dy: 8, pixels: dot(1, 1) }),
    ]
    const b = partsBounds(parts)
    expect(b).toEqual({ dx: -8, dy: 0, w: 16, h: 16 })
    const buf = blitPartsRgba(parts, ROWS, b)
    expect(at(buf, 16, 0, 0)).toBe(5)    // part 0 at bounds-local (0, 0)
    expect(at(buf, 16, 9, 9)).toBe(5)    // part 1 at bounds-local (8, 8) + (1, 1)
  })

  it('clips a part that reaches outside the requested bounds', () => {
    const buf = blitPartsRgba([info({ dx: 4 })], ROWS, { dx: 0, dy: 0, w: 8, h: 8 })
    expect(alphaAt(buf, 8, 7, 0)).toBe(255)
    expect(alphaAt(buf, 8, 3, 0)).toBe(0)
    expect(buf).toHaveLength(8 * 8 * 4)
  })

  it('skips a part whose palette row the payload does not carry', () => {
    const buf = blitPartsRgba([info({ palette: 9 })], [], partsBounds([info()]))
    expect(alphaAt(buf, 8, 0, 0)).toBe(0)
  })

  it('draws later parts over earlier ones, as the map render order does', () => {
    const b = { dx: 0, dy: 0, w: 8, h: 8 }
    const buf = blitPartsRgba([
      info({ palette: 3, pixels: new Uint8Array(64).fill(1) }),
      info({ palette: 7, pixels: new Uint8Array(64).fill(1) }),
    ], ROWS, b)
    expect(buf[0]).toBe(7)
  })
})
