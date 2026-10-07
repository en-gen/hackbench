/**
 * How a tile blank in the switch state shown is drawn (#621, #643): its
 * picture from another state in a soft screen door, in color, only in the
 * pixels left transparent, half of them at full strength and half at
 * HIDDEN_TILE_DIM_ALPHA (the owner's choice over #621's flat 25%). One rule
 * for the Map16 sheet, its inspector and the map tab. No imports, so the
 * browser can use it too.
 */
export const HIDDEN_TILE_DIM_ALPHA = 0.25

/** The screen door at cell pixel (x, y): a checkerboard on the tile's own
 * pixel grid, not the screen's, so it looks the same at every zoom. `flip`
 * swaps the squares (see `overlayHidden`). */
export function hiddenPixelStrength(x: number, y: number, flip = false): number {
  return ((x + y) % 2 === 0) !== flip ? 1 : HIDDEN_TILE_DIM_ALPHA
}

/**
 * Writes 16x16 `alt` into `dst` (row width `dstWidth` px) at (x0, y0) in the
 * screen door, where `dst` is still transparent. Parity is the pixel's place
 * in its own cell, which equals a 16-aligned strip's or sheet's.
 *
 * A one-pixel diagonal lies wholly on one parity, so the checkerboard could
 * draw it entirely at full strength, indistinguishable from a drawn tile
 * (#560: ON/OFF track $095 with ON/OFF off). A picture that would get no dim
 * pixel is therefore drawn on the other squares: a hidden tile is never as
 * strong as a shown one. The tiles are the ON/OFF tracks: the game treats $094
 * as absent with ON/OFF on and $095 as absent with it off (SMWDisX
 * bank_01.asm:11985-11995, the line-guide probe), so each must read as hidden
 * in the other state.
 */
export function overlayHidden(
  dst: Uint8ClampedArray,
  dstWidth: number,
  x0: number,
  y0: number,
  alt: Uint8ClampedArray,
): void {
  const writes = (x: number, y: number) =>
    dst[((y0 + y) * dstWidth + x0 + x) * 4 + 3] === 0 && alt[(y * 16 + x) * 4 + 3] !== 0
  let dimmed = false
  for (let y = 0; y < 16 && !dimmed; y++)
    for (let x = 0; x < 16; x++)
      if (writes(x, y) && hiddenPixelStrength(x, y) !== 1) {
        dimmed = true
        break
      }
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (!writes(x, y)) continue
      const s = (y * 16 + x) * 4
      const d = ((y0 + y) * dstWidth + x0 + x) * 4
      dst.set(alt.subarray(s, s + 3), d)
      dst[d + 3] = Math.round(alt[s + 3]! * hiddenPixelStrength(x, y, !dimmed))
    }
}

/** Whether an RGBA picture has no drawn pixel. */
export function isBlank(rgba: Uint8ClampedArray): boolean {
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
