/**
 * Block content indicators on the map (#566, designs D4, #607 split, C4a).
 *
 * Pure pixel and box maths shared by the backend (which composes each 16 x 16
 * art) and the view (which scales it and places it). Art is 16 x 16 RGBA.
 * Evidence scope: owner-picked designs from spikes #605, #607, #615; unit
 * tested on made-up pixels, not yet compared against an eye-checked render.
 */

export const BLOCK = 16
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The item box in SCREEN pixels for the block at map-pixel (x, y) at `zoom`:
 * 8 x zoom square in the bottom-right quadrant at rest, the whole 16 x zoom
 * block on hover. Edges are rounded from map pixels, so neighbouring blocks
 * share an edge at a fractional zoom and the box never passes the block's.
 */
export function indicatorBox(x: number, y: number, zoom: number, hover: boolean): Box {
  const o = hover ? 0 : BLOCK / 2
  const r = (v: number) => Math.round(v * zoom)
  return { x0: r(x + o), y0: r(y + o), x1: r(x + BLOCK), y1: r(y + BLOCK) }
}

type Rgba = readonly [number, number, number, number]
const px = (a: Uint8ClampedArray, i: number): Rgba => [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!]

/**
 * The line's alpha on an anti-diagonal art pixel only one item paints: the art has no room for a
 * half pixel, so the alpha says which triangle of the pixel is black. 255 (the ordinary opaque value)
 * is both halves. `paintIndicator` turns these into triangles at screen resolution.
 */
export const LINE_SMALL = 1 // the base item's triangle only (bottom-right)
export const LINE_BIG = 2 // the upgrade's triangle only (top-left)

/**
 * Split indicators (#607 and the two-outcome blocks; owner ruling 2026-10-06): the split runs along
 * the anti-diagonal, bottom-left to top-right (x + y = 15 in the 16 x 16 art), so a mirrored feather
 * is not cut along its length. The BASE item (`small`: the mushroom, or the coin of option A) is the
 * bottom-right half, the UPGRADE (`big`: flower, feather, star, 1-up) the top-left half. On the
 * line itself runs the owner's L1 line: black, one art pixel wide (so it scales with zoom). It is
 * drawn once per item, each clipped to that item's own triangle of the line pixel, so a line art pixel
 * is black in the half of each item that is opaque there: both halves (alpha 255), only the base's
 * (LINE_SMALL), only the upgrade's (LINE_BIG), or clear. The rest of the split is hard: no blending.
 */
export function splitDiagonal(small: Uint8ClampedArray, big: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(BLOCK * BLOCK * 4)
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const i = (y * BLOCK + x) * 4
      if (x + y !== BLOCK - 1) out.set(px(x + y > BLOCK - 1 ? small : big, i), i)
      else {
        const [s, b] = [small[i + 3] !== 0, big[i + 3] !== 0]
        if (s || b) out.set([0, 0, 0, s && b ? 255 : s ? LINE_SMALL : LINE_BIG], i)
      }
    }
  }
  return out
}

/** The "+" of C4a: a 5 x 5 white cross with arms 1 px wide, inside a 1 px black edge (7 x 7; 9 white, 16 black pixels as in spike #615) (1 = white, 2 = black). */
const PLUS: readonly (readonly number[])[] = [
  [0, 0, 0, 2, 0, 0, 0],
  [0, 0, 2, 1, 2, 0, 0],
  [0, 2, 2, 1, 2, 2, 0],
  [2, 1, 1, 1, 1, 1, 2],
  [0, 2, 2, 1, 2, 2, 0],
  [0, 0, 2, 1, 2, 0, 0],
  [0, 0, 0, 2, 0, 0, 0],
]
export const PLUS_SIZE = 7

/**
 * C4a (#615): the "+" baked into the bottom-right corner of the coin's 16 x 16 art, so it scales with the coin.
 * Origin (8, 8), one pixel in from the corner (owner ruling 2026-10-06): its centre row and column are art
 * row and column 11, odd, which centre sampling keeps at 1x (it takes art pixels 2i + 1), so the "+" does
 * not lose its centre lines there. The 5 x 5 white cross and its 7 x 7 black edge are unchanged.
 */
export function bakePlus(coin: Uint8ClampedArray): Uint8ClampedArray {
  const out = coin.slice()
  const at = BLOCK - PLUS_SIZE - 1
  PLUS.forEach((row, dy) =>
    row.forEach((v, dx) => {
      if (v)
        out.set(v === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], ((at + dy) * BLOCK + at + dx) * 4)
    }),
  )
  return out
}

/** A w x h bitmap fitted into 16 x 16: centred, and reduced by nearest sampling when larger. */
export function fitArt(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(BLOCK * BLOCK * 4)
  const k = Math.max(1, Math.max(w, h) / BLOCK)
  const [ow, oh] = [Math.min(BLOCK, Math.round(w / k)), Math.min(BLOCK, Math.round(h / k))]
  const [ox, oy] = [(BLOCK - ow) >> 1, (BLOCK - oh) >> 1]
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const from = (Math.min(h - 1, Math.floor(y * k)) * w + Math.min(w - 1, Math.floor(x * k))) * 4
      out.set(px(rgba, from), ((oy + y) * BLOCK + ox + x) * 4)
    }
  }
  return out
}

/**
 * Paints one indicator's 16 x 16 `art` into a screen-space canvas
 * (`width` x `height` RGBA) at `zoom`, nearest-neighbour as the spikes' CSS
 * scaling does (spikes/progressive-powerup-indicators/gen.cjs:65-67): the box
 * of `indicatorBox`, each pixel taking the art pixel `floor(i * 16 / size)`.
 * No blending, so a hard diagonal stays hard at every zoom. Clipped to the
 * canvas; returns the unclipped box. `(x, y)` is the block's corner in this
 * canvas's map pixels.
 */
export function paintIndicator(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  art: Uint8ClampedArray,
  zoom: number,
  hover: boolean,
  /** Screen-pixel origin of `canvas` when it is a region of the screen (default: the whole screen). */
  origin: readonly [number, number] = [0, 0],
): Box {
  const box = indicatorBox(x, y, zoom, hover)
  const [w, h] = [box.x1 - box.x0, box.y1 - box.y0]
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [dx, dy] = [box.x0 + i - origin[0], box.y0 + j - origin[1]]
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue
      // One sample point per screen pixel (its centre, in art pixels, as CSS nearest-neighbour samples) picks
      // both the art pixel and, for a half-painted line pixel, which triangle of it the pixel lies in.
      const [sx, sy] = [((i + 0.5) * BLOCK) / w, ((j + 0.5) * BLOCK) / h]
      const [ax, ay] = [Math.floor(sx), Math.floor(sy)]
      const from = (ay * BLOCK + ax) * 4
      const alpha = art[from + 3]!
      if (alpha === 0) continue
      if (alpha === LINE_SMALL || alpha === LINE_BIG) {
        // Only one item paints this anti-diagonal pixel: its line is that item's own triangle of it, split by
        // the anti-diagonal u + v = 1 of the pixel (the line itself belongs to both).
        const sum = sx - ax + (sy - ay)
        if (alpha === LINE_SMALL ? sum < 1 : sum > 1) continue
        canvas.set([0, 0, 0, 255], (dy * width + dx) * 4)
        continue
      }
      canvas.set(px(art, from), (dy * width + dx) * 4)
    }
  }
  return box
}
