/**
 * How far the map view's canvas reaches past the map (owner rulings D48 part 2, D76 call 2, D145,
 * #1004). Pure (no DOM, no Theia).
 *
 * Each side's pad is the content the data places off the map there (a refused-object mark, a sprite),
 * rounded up to whole 16 px tiles, and at each LONG end (left and right of a horizontal map, top and
 * bottom of a vertical one) a fixed 128 px gutter BEYOND that content, always, even for a map with
 * nothing off it. The short sides get the content alone. This is the single place the canvas grows:
 * every pointer and overlay consumer reads the resulting `Pad` as one origin.
 */
import type { MapSpriteDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { GUTTER_PX } from '../../../../src/rom/model/MapGutter'

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

/** Overflow of `px` rounded up to whole tiles, so the grid runs on across the pad on the same lattice. */
const tiles = (px: number): number => (px > 0 ? Math.ceil(px / TILE) * TILE : 0)

/**
 * The padding that holds every rect, plus the gutter at the long ends. `vertical` says which ends are
 * long. A rect inside the map adds nothing: a map with no off-map content is padded by the gutter alone.
 */
export function offMapPad(
  mapW: number,
  mapH: number,
  rects: Iterable<Rect>,
  vertical: boolean,
): Pad {
  let [l, t, r, b] = [0, 0, 0, 0]
  for (const q of rects) {
    l = Math.max(l, -q.x0)
    t = Math.max(t, -q.y0)
    r = Math.max(r, q.x1 - mapW)
    b = Math.max(b, q.y1 - mapH)
  }
  const g = (long: boolean): number => (long ? GUTTER_PX : 0)
  return {
    left: tiles(l) + g(!vertical),
    top: tiles(t) + g(vertical),
    right: tiles(r) + g(!vertical),
    bottom: tiles(b) + g(vertical),
  }
}

/**
 * The alpha mask that fades the back area (owner R24): opaque across the map and its content bands,
 * fading linearly to transparent over the GUTTER only, at each long end ("to right" on a horizontal
 * map, "to bottom" on a vertical one). A band the content grew on a short side is not a gutter and
 * stays opaque [PROP]. A mask rather than a gradient background keeps the back area's own
 * `background-color` the map's back color, which tests and tools read. `gutterPx` is 128 * zoom.
 */
export const fadeMask = (vertical: boolean, gutterPx: number): string =>
  `linear-gradient(${vertical ? 'to bottom' : 'to right'}, transparent, #000 ${gutterPx}px, #000 calc(100% - ${gutterPx}px), transparent)` // prettier-ignore

/**
 * Which screens of an N-screen map a scroll window touches, `margin` either side, as an inclusive
 * `[first, last]`. `scroll` and `view` are along the scroll axis in screen px, `size` one screen's px
 * and `lead` the pad before screen 0 in the same px, which shifts every screen by that much. Both ends
 * stay in `0..count-1`: a window wholly in the leading or trailing pad is taken at the nearest edge
 * screen (so an edit still refreshes the layout there), and a screen the map does not have is never
 * named, because asking for one is an error the view would keep.
 */
export function screensInView(
  scroll: number,
  view: number,
  size: number,
  lead: number,
  count: number,
  margin: number,
): [number, number] {
  const end = count * size - 1
  const at = (px: number): number => Math.floor(Math.min(Math.max(px - lead, 0), end) / size)
  const first = Math.min(count - 1, Math.max(0, at(scroll) - margin))
  const last = Math.max(first, Math.min(count - 1, at(scroll + view - 1) + margin))
  return [first, last]
}

/**
 * The scroll offset that centers map point `start` (map px along the scroll axis) in a `view` px window:
 * the point sits `lead` px (the pad before the map, map px) further along the strip, clamped to
 * `[0, max]`.
 */
export const centerScroll = (
  start: number,
  lead: number,
  zoom: number,
  view: number,
  max: number,
): number =>
  // prettier-ignore
  Math.min(Math.max((start + lead) * zoom - view / 2, 0), max)

export const samePad = (a: Pad, b: Pad): boolean =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

/** A refused object's 16 x 16 cell at tile (x, y). */
export const cellRect = (x: number, y: number): Rect => ({
  x0: x * TILE,
  y0: y * TILE,
  x1: (x + 1) * TILE,
  y1: (y + 1) * TILE,
})

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
