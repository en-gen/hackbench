/**
 * Pure pixel composition for the sprite inspector previews.
 *
 * Mirrors `CanvasRenderTarget.blit8x8`: colour index 0 is transparent,
 * `flipX`/`flipY` mirror the source read, and the palette row indexes the
 * payload's CGRAM snapshot. Kept free of DOM types so the composition can
 * be tested under vitest's node environment; the canvas glue lives in
 * `propsPane.ts`.
 */

import type { SpritePartInfo } from './spriteProps'

/** The payload's 16x16 CGRAM snapshot: `[row][index] = [r, g, b, a?]`. */
export type PaletteRows = readonly (readonly number[])[][]

/**
 * An RGBA pixel buffer. Pinned to `ArrayBuffer` rather than the default
 * `ArrayBufferLike` so it satisfies the DOM `ImageData` constructor, which
 * rejects a possibly-shared buffer.
 */
export type RgbaBuffer = Uint8ClampedArray<ArrayBuffer>

/** Pixel-space rect in sprite-local coordinates. */
export interface PreviewBounds {
  dx: number
  dy: number
  w:  number
  h:  number
}

/** Tightest rect covering every 8x8 part. Empty input gives one tile. */
export function partsBounds(parts: readonly SpritePartInfo[]): PreviewBounds {
  if (parts.length === 0) return { dx: 0, dy: 0, w: 8, h: 8 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of parts) {
    x0 = Math.min(x0, p.dx);     y0 = Math.min(y0, p.dy)
    x1 = Math.max(x1, p.dx + 8); y1 = Math.max(y1, p.dy + 8)
  }
  return { dx: x0, dy: y0, w: x1 - x0, h: y1 - y0 }
}

/** The single 8x8 cell a part occupies, for drawing it on its own. */
export function partBounds(part: SpritePartInfo): PreviewBounds {
  return { dx: part.dx, dy: part.dy, w: 8, h: 8 }
}

/**
 * Integer upscale for an art preview. Nearest-neighbour only, so the factor
 * must stay whole; 8x8 at 1:1 is unreadable and 64x64 at 8:1 would not fit
 * the 230px panel.
 */
export function previewScale(w: number, h: number, maxPx = 128, maxScale = 8): number {
  const span = Math.max(w, h, 1)
  return Math.min(maxScale, Math.max(1, Math.floor(maxPx / span)))
}

/**
 * Compose `parts` into an RGBA buffer covering `bounds`. Pixels no part
 * covers, and colour index 0 within a part, stay fully transparent.
 */
export function blitPartsRgba(
  parts:       readonly SpritePartInfo[],
  paletteRows: PaletteRows,
  bounds:      PreviewBounds,
): RgbaBuffer {
  const buf = new Uint8ClampedArray(Math.max(0, bounds.w * bounds.h * 4))
  for (const part of parts) {
    const row = paletteRows[part.palette]
    if (!row) continue
    for (let py = 0; py < 8; py++) {
      const dstY = part.dy + py - bounds.dy
      if (dstY < 0 || dstY >= bounds.h) continue
      const srcY = part.flipY ? 7 - py : py
      for (let px = 0; px < 8; px++) {
        const dstX = part.dx + px - bounds.dx
        if (dstX < 0 || dstX >= bounds.w) continue
        const srcX = part.flipX ? 7 - px : px
        const idx = part.pixels[srcY * 8 + srcX]
        if (!idx) continue
        const col = row[idx]
        if (!col) continue
        const off = (dstY * bounds.w + dstX) * 4
        buf[off]     = col[0]
        buf[off + 1] = col[1]
        buf[off + 2] = col[2]
        buf[off + 3] = 255
      }
    }
  }
  return buf
}
