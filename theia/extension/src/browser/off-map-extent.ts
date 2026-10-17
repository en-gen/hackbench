/**
 * How far the map view's canvas must reach past the map to show content the data
 * places off the map (#1004, owner ruling D76 call 2): a refused-object mark or a
 * sprite is drawn where the data names it, never clamped. Pure (no DOM, no Theia).
 *
 * The padding is the ONLY place the canvas grows. A reserved "add screen" area
 * (#950, D69) would add to `offMapPad`'s result here, not in the widget.
 */
import type { MapSpriteDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'

/** One map tile in map pixels; the pad is whole tiles so the grid runs on across the margin. */
export const TILE = 16

/** Map pixels of canvas beyond each side of the map. */
export interface Pad {
  left: number
  top: number
  right: number
  bottom: number
}

/** A rectangle in map pixels, x1 and y1 exclusive. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const NO_PAD: Pad = { left: 0, top: 0, right: 0, bottom: 0 }

export const isPadded = (p: Pad): boolean => p.left + p.top + p.right + p.bottom > 0

/** [PROP] one tile of margin past the farthest off-map content, so a mark never sits on the canvas edge. */
const MARGIN = TILE

const side = (overflow: number): number =>
  overflow > 0 ? Math.ceil(overflow / TILE) * TILE + MARGIN : 0

/** The padding that holds every rect: zero on a side nothing overflows. */
export function offMapPad(mapW: number, mapH: number, rects: Iterable<Rect>): Pad {
  let [l, t, r, b] = [0, 0, 0, 0]
  for (const q of rects) {
    l = Math.max(l, -q.x0)
    t = Math.max(t, -q.y0)
    r = Math.max(r, q.x1 - mapW)
    b = Math.max(b, q.y1 - mapH)
  }
  return { left: side(l), top: side(t), right: side(r), bottom: side(b) }
}

export const samePad = (a: Pad, b: Pad): boolean =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

/** A refused object's 16 x 16 cell at tile (x, y). */
export const cellRect = (x: number, y: number): Rect => ({
  x0: x * TILE,
  y0: y * TILE,
  x1: (x + 1) * TILE,
  y1: (y + 1) * TILE,
})

/** A strip pixel (the strip includes the padding) as a map pixel; negative or past the end in the margin. */
export const stripToMap = (x: number, y: number, pad: Pad): [number, number] => [
  x - pad.left,
  y - pad.top,
]

export const insideMap = (x: number, y: number, mapW: number, mapH: number): boolean =>
  x >= 0 && y >= 0 && x < mapW && y < mapH

const decoded = new WeakMap<MapSpriteDto, Uint8ClampedArray>()

/**
 * The sprite pixels that fall OUTSIDE the map, on a bitmap of the padded size (the map's
 * pixels stay transparent: the screens draw those, under the tiles' priority). Stacked as
 * the screens stack them, by position along the scroll axis then stream index. Null when
 * no sprite reaches the margin.
 */
export function offMapSpritePixels(
  sprites: readonly MapSpriteDto[],
  mapW: number,
  mapH: number,
  pad: Pad,
  vertical: boolean,
): Uint8ClampedArray | null {
  const [w, h] = [mapW + pad.left + pad.right, mapH + pad.top + pad.bottom]
  let out: Uint8ClampedArray | null = null
  const order = [...sprites].sort((a, b) => (vertical ? a.y - b.y : a.x - b.x) || a.index - b.index)
  for (const s of order) {
    const { x0, y0, x1, y1 } = s.box
    let bmp = decoded.get(s)
    if (!bmp) decoded.set(s, (bmp = decodeRgba(s.rgba)))
    for (let y = Math.max(y0, -pad.top); y < Math.min(y1, mapH + pad.bottom); y++) {
      for (let x = Math.max(x0, -pad.left); x < Math.min(x1, mapW + pad.right); x++) {
        if (insideMap(x, y, mapW, mapH)) continue
        const from = ((y - y0) * (x1 - x0) + (x - x0)) * 4
        if (bmp[from + 3] === 0) continue
        out ??= new Uint8ClampedArray(w * h * 4)
        out.set(bmp.subarray(from, from + 4), ((y + pad.top) * w + x + pad.left) * 4)
      }
    }
  }
  return out
}
