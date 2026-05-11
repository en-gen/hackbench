/**
 * Shared block-view rendering helpers used by both the level/map
 * editor and the overworld viewer. Block view paints each non-empty
 * tile cell with a deterministic color hashed from its tile ID and
 * (at sufficient zoom) labels the cell with `$XXX`. It's a debug /
 * inspection mode that surfaces the underlying tile-id grid without
 * any GFX rendering.
 */

import { hexN } from './hex'

/**
 * Deterministic color hash for a tile ID. Same ID → same color across
 * editors so visual identification is consistent. Compatible with both
 * Map16 IDs (0..511) and SNES char numbers (0..1023).
 *
 * The hash is a low-entropy mix that spreads adjacent IDs into
 * visually distinguishable colors — bits 0-4 → red, bits 5-8 → green,
 * full ID → blue (offset to keep a baseline brightness).
 */
export function tileBlockColor(tileId: number): string {
  const r = (tileId & 0x1F) << 3
  const g = ((tileId >> 5) & 0xF) << 4
  const b = Math.round((tileId / 0x1FF) * 180) + 40
  return `rgb(${r},${g},${b})`
}

/**
 * Paint a colored fill for one cell using {@link tileBlockColor}.
 * Cell coords are in canvas pixels.
 */
export function paintBlockFill(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cellPx: number,
  tileId: number,
): void {
  ctx.fillStyle = tileBlockColor(tileId)
  ctx.fillRect(px, py, cellPx, cellPx)
}

/**
 * Paint a `$XXX` (or `$XX`) label centered in a block-view cell.
 * The font auto-scales to the cell pixel size with a 6-px floor; the
 * caller should skip calling this entirely below ~16-px cells where
 * the label can't fit legibly.
 *
 * @param hexDigits Number of hex digits in the label (2 for char numbers
 *                  in 2bpp / 8-bit ranges, 3 for Map16 / SNES char).
 */
export function paintBlockLabel(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  cellPx: number,
  tileId: number,
  hexDigits: 2 | 3 = 3,
): void {
  const fontSize = Math.max(6, Math.round(cellPx * 0.35))
  ctx.save()
  ctx.font = `${fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.22))
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.lineJoin = 'round'
  ctx.fillStyle = '#fff'
  const cx = px + cellPx / 2
  const cy = py + cellPx / 2
  const label = `$${hexN(tileId, hexDigits)}`
  ctx.strokeText(label, cx, cy)
  ctx.fillText(label, cx, cy)
  ctx.restore()
}

/** Minimum cell pixel size at which labels are legible. */
export const BLOCK_LABEL_MIN_PX = 16
