/**
 * GraphicsDecoder — additional tests for decode2bpp, batch decoders, and
 * tilesToRgba. The original GraphicsDecoder.test.ts covers the 4bpp/3bpp
 * paths and bgr555ToRgba; these fill the gap.
 */

import { describe, it, expect } from 'vitest'
import {
  decode2bpp,
  decodeTilesBatch,
  decodeTileSheet,
  tilesToRgba,
  TILE_W,
  TILE_H,
  PIXELS_PER_TILE,
} from '../../../src/rom/GraphicsDecoder'

describe('decode2bpp', () => {
  it('returns PIXELS_PER_TILE-sized array for blank input', () => {
    const px = decode2bpp(new Uint8Array(16))
    expect(px.length).toBe(PIXELS_PER_TILE)
    expect(Array.from(px).every(p => p === 0)).toBe(true)
  })

  it('all bits set in both planes → pixel value 3', () => {
    const px = decode2bpp(new Uint8Array(16).fill(0xFF))
    expect(Array.from(px).every(p => p === 3)).toBe(true)
  })

  it('low-byte controls bit 0; high-byte controls bit 1', () => {
    // Row 0: lo=$80 (bit 7 set → leftmost pixel), hi=$00
    const buf = new Uint8Array(16)
    buf[0] = 0x80
    const px = decode2bpp(buf)
    expect(px[0]).toBe(1)
    expect(px[1]).toBe(0)
  })

  it('high-byte sets bit 1 of pixel', () => {
    const buf = new Uint8Array(16)
    buf[1] = 0x80
    const px = decode2bpp(buf)
    expect(px[0]).toBe(2)
  })

  it('respects offset for tiles past start', () => {
    const buf = new Uint8Array(32)
    buf[16] = 0xFF
    buf[17] = 0xFF
    const px = decode2bpp(buf, 16)
    // Row 0 of second tile = all 3s
    expect(Array.from(px.slice(0, 8)).every(p => p === 3)).toBe(true)
  })
})

describe('decodeTilesBatch', () => {
  it('bpp=2 splits into 16-byte tiles', () => {
    const buf = new Uint8Array(48)
    expect(decodeTilesBatch(buf, 2).length).toBe(3)
  })

  it('bpp=3 splits into 24-byte tiles', () => {
    const buf = new Uint8Array(72)
    expect(decodeTilesBatch(buf, 3).length).toBe(3)
  })

  it('bpp=4 splits into 32-byte tiles', () => {
    const buf = new Uint8Array(96)
    expect(decodeTilesBatch(buf, 4).length).toBe(3)
  })

  it('floors tile count when buffer length is not an integer multiple', () => {
    expect(decodeTilesBatch(new Uint8Array(50), 4).length).toBe(1)
  })

  it('returns empty array when buffer is shorter than one tile', () => {
    expect(decodeTilesBatch(new Uint8Array(15), 2)).toEqual([])
  })
})

describe('decodeTileSheet', () => {
  it("default '4bpp' decodes 32-byte tiles", () => {
    expect(decodeTileSheet(Buffer.alloc(64)).length).toBe(2)
  })

  it("'3bpp' decodes 24-byte tiles", () => {
    expect(decodeTileSheet(Buffer.alloc(72), '3bpp').length).toBe(3)
  })
})

describe('tilesToRgba', () => {
  it('output dimensions: width = tilesPerRow × TILE_W; height = ceil(N / tilesPerRow) × TILE_H', () => {
    const tiles = Array.from({ length: 17 }, () => new Uint8Array(64))
    const out = tilesToRgba(tiles, [[0, 0, 0, 255]], 8)
    expect(out.width).toBe(8 * TILE_W)
    expect(out.height).toBe(Math.ceil(17 / 8) * TILE_H)
  })

  it('forces alpha=0 for palette index 0 even when palette[0] is opaque', () => {
    const tiles = [new Uint8Array(64).fill(0)]
    const out = tilesToRgba(tiles, [[0, 0, 0, 255]], 1)
    expect(out.rgba[3]).toBe(0)
  })

  it('non-zero index uses palette colour and palette alpha', () => {
    const tile = new Uint8Array(64).fill(0)
    tile[0] = 1
    const out = tilesToRgba([tile], [[0, 0, 0, 255], [128, 64, 32, 200]], 1)
    expect(out.rgba[0]).toBe(128)
    expect(out.rgba[1]).toBe(64)
    expect(out.rgba[2]).toBe(32)
    expect(out.rgba[3]).toBe(200)
  })

  it('falls back to magenta sentinel when palette index is out of range', () => {
    const tile = new Uint8Array(64).fill(7)
    const out = tilesToRgba([tile], [[0, 0, 0, 255]], 1)  // only index 0 defined
    // Sentinel = [255, 0, 255, 255]
    expect(out.rgba[0]).toBe(255)
    expect(out.rgba[1]).toBe(0)
    expect(out.rgba[2]).toBe(255)
    expect(out.rgba[3]).toBe(255)
  })

  it('lays out tiles row-by-row in tile-grid order', () => {
    // 2 tiles in a 2-wide layout: tile 0 top-left, tile 1 top-right.
    const tile0 = new Uint8Array(64).fill(0)
    const tile1 = new Uint8Array(64).fill(1)
    tile1[0] = 1  // top-left pixel of tile 1 is index 1
    const out = tilesToRgba([tile0, tile1], [[0, 0, 0, 255], [255, 0, 0, 255]], 2)
    // Pixel (0, TILE_W) = top-left of tile 1 → red
    const idx = (0 * out.width + TILE_W) * 4
    expect(out.rgba[idx]).toBe(255)
  })
})
