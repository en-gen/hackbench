/**
 * How a hidden tile (blank until a switch is on, #621) is drawn: its
 * switched-on art at HIDDEN_TILE_OPACITY, in color, only in the pixels its own
 * picture leaves transparent. One rule for the Map16 sheet, its inspector and
 * the map tab. No imports, so the browser can use it too.
 */
export const HIDDEN_TILE_OPACITY = 0.25

/** Writes 16x16 `alt` into `dst` (row width `dstWidth` px) at (x0, y0), where `dst` is still transparent. */
export function overlayHidden(
  dst: Uint8ClampedArray,
  dstWidth: number,
  x0: number,
  y0: number,
  alt: Uint8ClampedArray,
  opacity = HIDDEN_TILE_OPACITY,
): void {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const s = (y * 16 + x) * 4
      const d = ((y0 + y) * dstWidth + x0 + x) * 4
      if (dst[d + 3] !== 0 || alt[s + 3] === 0) continue
      dst.set(alt.subarray(s, s + 3), d)
      dst[d + 3] = Math.round(alt[s + 3]! * opacity)
    }
}

/** What a hidden tile shows with no switch on: its first single-switch alternate that is hidden. */
export function firstHiddenSingle<T extends { kinds: readonly unknown[]; hidden: boolean }>(
  alternates: readonly T[] | undefined,
): T | undefined {
  return alternates?.find(a => a.kinds.length === 1 && a.hidden)
}
