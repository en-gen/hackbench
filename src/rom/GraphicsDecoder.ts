export const TILE_W = 8
export const TILE_H = 8
export const PIXELS_PER_TILE = TILE_W * TILE_H

export type RgbaColor = [number, number, number, number]

/** Decode a single 2BPP tile (16 bytes) → 64 palette indices (0–3). */
export function decode2bpp(data: ArrayLike<number>, offset = 0): Uint8Array {
  const px = new Uint8Array(PIXELS_PER_TILE)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] = ((p0lo >> bit) & 1) | (((p0hi >> bit) & 1) << 1)
    }
  }
  return px
}

/** Decode a single 4BPP tile (32 bytes) → 64 palette indices. */
export function decode4bpp(data: ArrayLike<number>, offset = 0): Uint8Array {
  const px = new Uint8Array(PIXELS_PER_TILE)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    const p1lo = data[offset + 16 + row * 2]
    const p1hi = data[offset + 16 + row * 2 + 1]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1) |
        (((p0hi >> bit) & 1) << 1) |
        (((p1lo >> bit) & 1) << 2) |
        (((p1hi >> bit) & 1) << 3)
    }
  }
  return px
}

/** Decode a single 3BPP tile (24 bytes) → 64 palette indices (0–7). */
export function decode3bpp(data: ArrayLike<number>, offset = 0): Uint8Array {
  const px = new Uint8Array(PIXELS_PER_TILE)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[offset + row * 2]
    const p0hi = data[offset + row * 2 + 1]
    const p2 = data[offset + 16 + row]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1) | (((p0hi >> bit) & 1) << 1) | (((p2 >> bit) & 1) << 2)
    }
  }
  return px
}

/**
 * Which bytes hold one pixel row's bitplanes, lowest plane first.
 *
 * The inverse of what decode2/3/4bpp read: 2BPP and 4BPP interleave plane
 * pairs two bytes per row, and 3BPP's third plane is a flat 8 bytes after
 * the first sixteen.
 *
 * This is a SECOND statement of that layout, not the only one. decode2bpp,
 * decode3bpp and decode4bpp still compute their offsets inline, so the two
 * can drift. Routing the decoders through this function would fix that and
 * is worth doing, but it changes read paths this branch does not otherwise
 * touch, so it is left for the change that rebuilds the painter.
 */
export function planeOffsets(bpp: 2 | 3 | 4, offset: number, row: number): number[] {
  const base = [offset + row * 2, offset + row * 2 + 1]
  if (bpp === 2) return base
  if (bpp === 3) return [...base, offset + 16 + row]
  return [...base, offset + 16 + row * 2, offset + 16 + row * 2 + 1]
}

/**
 * Write one palette index into a tile's bitplanes, in place.
 *
 * Refuses a value the depth cannot hold rather than truncating it: a 4BPP
 * color painted into a 3BPP file would silently become a different color,
 * and the caller would have no way to know.
 */
export function setTilePixel(
  data: Uint8Array,
  offset: number,
  bpp: 2 | 3 | 4,
  x: number,
  y: number,
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0 || value >= 1 << bpp) {
    throw new Error(`palette index ${value} does not fit ${bpp}bpp`)
  }
  // Integer-checked, not merely range-checked. A fractional y indexes
  // between two plane rows and writes BOTH, corrupting two rows from one
  // call and returning normally; a fractional x shifts the mask off the
  // pixel the caller named. These arrive as JSON in a persisted op, so a
  // migrated or hand-edited file reaches this directly.
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= TILE_W ||
    y < 0 ||
    y >= TILE_H
  ) {
    throw new Error(`pixel (${x}, ${y}) is outside an 8x8 tile`)
  }
  const mask = 1 << (7 - x)
  planeOffsets(bpp, offset, y).forEach((at, plane) => {
    if (at >= data.length) throw new Error(`tile at ${offset} runs past the end of the sheet`)
    data[at] = ((value >> plane) & 1) === 1 ? data[at]! | mask : data[at]! & ~mask & 0xff
  })
}

/** Bytes one tile occupies at a given bit depth. */
export function bytesPerTile(bpp: 2 | 3 | 4): number {
  return bpp === 4 ? 32 : bpp === 3 ? 24 : 16
}

/** Decode all tiles from raw bytes using the given BPP mode.
 *  Works in both Node and browser contexts (accepts any array-like input). */
export function decodeTilesBatch(data: ArrayLike<number>, bpp: 2 | 3 | 4): Uint8Array[] {
  const bpt = bytesPerTile(bpp)
  const count = Math.floor(data.length / bpt)
  const decode = bpp === 4 ? decode4bpp : bpp === 3 ? decode3bpp : decode2bpp
  return Array.from({ length: count }, (_, i) => decode(data, i * bpt))
}

/** Decode all tiles in a GFX buffer. */
export function decodeTileSheet(data: Buffer, format: '3bpp' | '4bpp' = '4bpp'): Uint8Array[] {
  const bpt = format === '4bpp' ? 32 : 24
  const count = Math.floor(data.length / bpt)
  const decoder = format === '4bpp' ? decode4bpp : decode3bpp
  return Array.from({ length: count }, (_, i) => decoder(data, i * bpt))
}

/** Convert SNES BGR555 word to RGBA.
 *  Uses bit-replication (c5<<3 | c5>>2) so that 0→0 and 31→255 exactly. */
export function bgr555ToRgba(v: number): RgbaColor {
  const r5 = v & 0x1f
  const g5 = (v >> 5) & 0x1f
  const b5 = (v >> 10) & 0x1f
  return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2), 255]
}

/** Decode a block of BGR555 palette data → RGBA array. */
export function decodePalette(data: Buffer, count?: number): RgbaColor[] {
  const n = count ?? Math.floor(data.length / 2)
  return Array.from({ length: n }, (_, i) => bgr555ToRgba(data.readUInt16LE(i * 2)))
}

/**
 * Render a tile sheet to RGBA ImageData-compatible bytes.
 * Returned object is suitable for `new ImageData(rgba, width, height)` in a webview.
 */
export function tilesToRgba(
  tiles: Uint8Array[],
  palette: RgbaColor[],
  tilesPerRow = 16,
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const rows = Math.ceil(tiles.length / tilesPerRow)
  const width = tilesPerRow * TILE_W
  const height = rows * TILE_H
  const rgba = new Uint8ClampedArray(width * height * 4)

  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t]
    const tileCol = t % tilesPerRow
    const tileRow = Math.floor(t / tilesPerRow)
    for (let py = 0; py < TILE_H; py++) {
      for (let px = 0; px < TILE_W; px++) {
        const idx = tile[py * TILE_W + px]
        const color = palette[idx] ?? [255, 0, 255, 255]
        const dest = ((tileRow * TILE_H + py) * width + tileCol * TILE_W + px) * 4
        rgba[dest] = color[0]
        rgba[dest + 1] = color[1]
        rgba[dest + 2] = color[2]
        rgba[dest + 3] = idx === 0 ? 0 : color[3]
      }
    }
  }
  return { rgba, width, height }
}
