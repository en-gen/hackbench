/**
 * How a tile blank in the switch state shown is drawn (#621): its picture
 * from another state at HIDDEN_TILE_OPACITY, in color, only in the pixels
 * left transparent. One rule for the Map16 sheet, its inspector and the map
 * tab. No imports, so the browser can use it too.
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

const isBlank = (rgba: Uint8ClampedArray) => {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false
  return true
}

/**
 * What a cell blank in the switch state shown draws faintly (#621, both
 * ways): a tile a switch reveals, or one a switch blanks, is never simply
 * gone. The switches-off picture if it is drawn, else the first
 * single-switch alternate that is; undefined when the cell is drawn, or
 * blank in every state.
 */
export function ghostOf<T extends { kinds: readonly unknown[] }>(
  shown: Uint8ClampedArray,
  off: Uint8ClampedArray,
  alternates: readonly T[],
  rgbaOf: (alternate: T) => Uint8ClampedArray,
): Uint8ClampedArray | undefined {
  if (!isBlank(shown)) return undefined
  if (!isBlank(off)) return off
  for (const a of alternates) {
    if (a.kinds.length !== 1) continue
    const rgba = rgbaOf(a)
    if (!isBlank(rgba)) return rgba
  }
  return undefined
}
