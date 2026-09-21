import { describe, it, expect } from 'vitest'
import {
  decode4bpp,
  decode3bpp,
  bgr555ToRgba,
  decodePalette,
  PIXELS_PER_TILE,
} from '../../../src/rom/GraphicsDecoder'

describe('bgr555ToRgba', () => {
  it('converts black (0x0000)', () => {
    expect(bgr555ToRgba(0x0000)).toEqual([0, 0, 0, 255])
  })
  it('converts white (0x7FFF → 255,255,255 via bit-replication)', () => {
    expect(bgr555ToRgba(0x7fff)).toEqual([255, 255, 255, 255])
  })
  it('converts pure red (0x001F → r=255 via bit-replication)', () => {
    expect(bgr555ToRgba(0x001f)).toEqual([255, 0, 0, 255])
  })
  it('converts pure green (0x03E0 → g=255 via bit-replication)', () => {
    expect(bgr555ToRgba(0x03e0)).toEqual([0, 255, 0, 255])
  })
  it('converts pure blue (0x7C00 → b=255 via bit-replication)', () => {
    expect(bgr555ToRgba(0x7c00)).toEqual([0, 0, 255, 255])
  })
  it('alpha is always 255', () => {
    expect(bgr555ToRgba(0x1234)[3]).toBe(255)
  })
})

describe('decodePalette', () => {
  it('decodes two colors from 4 bytes', () => {
    const data = Buffer.from([0x1f, 0x00, 0x00, 0x7c]) // red, blue (little-endian)
    const palette = decodePalette(data)
    expect(palette).toHaveLength(2)
    expect(palette[0]).toEqual([255, 0, 0, 255])
    expect(palette[1]).toEqual([0, 0, 255, 255])
  })
  it('respects count parameter', () => {
    const data = Buffer.alloc(8, 0)
    expect(decodePalette(data, 2)).toHaveLength(2)
  })
})

describe('decode4bpp', () => {
  it('returns 64 palette indices for a blank tile', () => {
    const data = new Uint8Array(32)
    const pixels = decode4bpp(data)
    expect(pixels).toHaveLength(PIXELS_PER_TILE)
    expect(Array.from(pixels).every(p => p === 0)).toBe(true)
  })

  it('decodes a tile with all pixels = color index 15 (0xF)', () => {
    // All bits set in all bit planes → index = 0b1111 = 15
    const data = new Uint8Array(32).fill(0xff)
    const pixels = decode4bpp(data)
    expect(pixels).toHaveLength(64)
    expect(Array.from(pixels).every(p => p === 15)).toBe(true)
  })

  it('decodes bit plane 0 only (index 0 or 1)', () => {
    // plane0-lo row0 = 0xFF (all 1s), everything else 0 → indices are 1
    const data = new Uint8Array(32)
    data[0] = 0xff // plane0 lo, row 0
    const pixels = decode4bpp(data)
    // first 8 pixels should be 1 (only bit 0 set)
    expect(Array.from(pixels.slice(0, 8))).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(Array.from(pixels.slice(8))).toEqual(new Array(56).fill(0))
  })

  it('decodes with non-zero offset', () => {
    const data = new Uint8Array(64) // 2 tiles
    data.fill(0xff, 32, 64) // second tile all-set
    const px1 = decode4bpp(data, 0)
    const px2 = decode4bpp(data, 32)
    expect(Array.from(px1).every(p => p === 0)).toBe(true)
    expect(Array.from(px2).every(p => p === 15)).toBe(true)
  })
})

describe('decode3bpp', () => {
  it('returns 64 palette indices for a blank tile', () => {
    const data = new Uint8Array(24)
    const pixels = decode3bpp(data)
    expect(pixels).toHaveLength(PIXELS_PER_TILE)
    expect(Array.from(pixels).every(p => p === 0)).toBe(true)
  })

  it('decodes a tile with all pixels = color index 7 (0b111)', () => {
    const data = new Uint8Array(24).fill(0xff)
    const pixels = decode3bpp(data)
    expect(Array.from(pixels).every(p => p === 7)).toBe(true)
  })

  it('max index is 7 for 3bpp', () => {
    const data = new Uint8Array(24).fill(0xff)
    const pixels = decode3bpp(data)
    expect(Math.max(...pixels)).toBe(7)
  })
})
