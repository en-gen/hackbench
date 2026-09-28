/**
 * The Overworld view's two layers composed in SNES mode 1 order: L2 low,
 * L1 low, L2 high, L1 high, from each 8x8 cell's priority bit, over the
 * backdrop. Pure and file-free, so the browser re-composes on a layer toggle
 * without a round trip, and the decode test composes the same way.
 */

/** One layer: RGBA on a clear canvas (alpha 0 is clear), and a priority byte per 8x8 cell. */
export interface OwLayerPixels {
  rgba: Uint8ClampedArray
  prio: Uint8Array
}

export function compositeOverworld(
  width: number,
  height: number,
  backdrop: ArrayLike<number>,
  l2: OwLayerPixels | null,
  l1: OwLayerPixels | null,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  const rank = new Int8Array(width * height).fill(-1)
  const cellsW = width >> 3
  for (let p = 0; p < width * height; p++) out.set(backdrop, p * 4)
  const layers = [
    [l2, 0, 2],
    [l1, 1, 3],
  ] as const
  for (const [layer, low, high] of layers) {
    if (!layer) continue
    for (let p = 0; p < width * height; p++) {
      if (layer.rgba[p * 4 + 3] === 0) continue
      const cell = ((p / width / 8) | 0) * cellsW + ((p % width) >> 3)
      const r = layer.prio[cell] ? high : low
      if (r <= rank[p]!) continue
      rank[p] = r
      out.set(layer.rgba.subarray(p * 4, p * 4 + 4), p * 4)
    }
  }
  return out
}
