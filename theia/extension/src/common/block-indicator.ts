/**
 * Block content indicators on the map (#566, designs D4, #607 split, C4a).
 *
 * Pure pixel and box maths shared by the backend (which composes each 16 x 16
 * art) and the view (which scales it and places it). Art is 16 x 16 RGBA.
 * Evidence scope: owner-picked designs from spikes #605, #607, #615; unit
 * tested on made-up pixels, not yet compared against an eye-checked render.
 */

export const BLOCK = 16
export const QUAD = BLOCK / 2

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The item box for a block at (x, y): its bottom-right quadrant at rest, the whole block on hover. */
export function indicatorBox(x: number, y: number, hover: boolean): Box {
  const o = hover ? 0 : QUAD
  return { x0: x + o, y0: y + o, x1: x + BLOCK, y1: y + BLOCK }
}

type Rgba = readonly [number, number, number, number]
const px = (a: Uint8ClampedArray, i: number): Rgba => [a[i]!, a[i + 1]!, a[i + 2]!, a[i + 3]!]

/**
 * Progressive blocks (#607): a hard diagonal from the top-left to the
 * bottom-right corner, `small` below it (bottom-left), `big` above it
 * (top-right). Pixels on the diagonal itself go to `big`; no line is drawn.
 */
export function splitDiagonal(small: Uint8ClampedArray, big: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(BLOCK * BLOCK * 4)
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const i = (y * BLOCK + x) * 4
      out.set(px(y > x ? small : big, i), i)
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

/** C4a (#615): the "+" baked into the bottom-right corner of the coin's 16 x 16 art, so it scales with the coin. */
export function bakePlus(coin: Uint8ClampedArray): Uint8ClampedArray {
  const out = coin.slice()
  const at = BLOCK - PLUS_SIZE
  PLUS.forEach((row, dy) =>
    row.forEach((v, dx) => {
      if (v)
        out.set(v === 1 ? [255, 255, 255, 255] : [0, 0, 0, 255], ((at + dy) * BLOCK + at + dx) * 4)
    }),
  )
  return out
}

/** Half scale (16 to 8): a pixel is opaque when 2 of its 2 x 2 source are, coloured by their mean. */
export function halve(art: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(QUAD * QUAD * 4)
  for (let y = 0; y < QUAD; y++) {
    for (let x = 0; x < QUAD; x++) {
      const sum = [0, 0, 0]
      let n = 0
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        // prettier-ignore
        const p = px(art, ((y * 2 + dy) * BLOCK + x * 2 + dx) * 4)
        if (p[3] === 0) continue
        n++
        for (let c = 0; c < 3; c++) sum[c]! += p[c]!
      }
      if (n >= 2) out.set([...sum.map(s => Math.round(s / n)), 255], (y * QUAD + x) * 4)
    }
  }
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

export interface Placed {
  box: Box
  /** Pixels clipped to the plane are not counted; this is the unclipped box. */
  hover: boolean
}

/**
 * Draws one indicator onto a plane (`width` x `height` RGBA) with the block's
 * top-left at (x, y), clipped to the plane. Only the item box is touched.
 * `rest` and `full` are the half and full scale art.
 */
export function paintIndicator(
  plane: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  art: { rest: Uint8ClampedArray; full: Uint8ClampedArray },
  hover: boolean,
): Placed {
  const box = indicatorBox(x, y, hover)
  const [src, size] = hover ? [art.full, BLOCK] : [art.rest, QUAD]
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [px0, py0] = [box.x0 + i, box.y0 + j]
      if (px0 < 0 || py0 < 0 || px0 >= width || py0 >= height) continue
      if (src[(j * size + i) * 4 + 3] === 0) continue
      plane.set(px(src, (j * size + i) * 4), (py0 * width + px0) * 4)
    }
  }
  return { box, hover }
}
