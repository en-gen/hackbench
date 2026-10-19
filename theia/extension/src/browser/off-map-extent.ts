/**
 * The fixed gutter beside a horizontal map and the sprite pixels that fall in it (D48 part 2,
 * #1004). Pure (no DOM, no Theia). A horizontal map gets half a screen of canvas on its left and
 * right, always, whatever it holds; a vertical map gets none, and nothing is added above or
 * below either (pending D145). A reserved "add screen" area (#950, D69) would add to `gutterPad`.
 */
import type { MapSpriteDto } from '../common/project-protocol'
import { decodeRgba } from './map16-pixels'
import { GUTTER_PX } from '../../../../src/rom/model/MapGutter'

/** One map tile in map pixels; the gutter is whole tiles so the grid runs on across it. */
export const TILE = 16

/** Map pixels of canvas beyond each side of the map. */
export interface Pad {
  left: number
  top: number
  right: number
  bottom: number
}

/** No margin: a vertical map, and every strip before its layout is known. */
export const NO_PAD: Pad = { left: 0, top: 0, right: 0, bottom: 0 }

/** Whether any side has a margin: the strip then differs from the plain map. */
export const isPadded = (p: Pad): boolean => p.left + p.top + p.right + p.bottom > 0

const GUTTER: Pad = { left: GUTTER_PX, top: 0, right: GUTTER_PX, bottom: 0 }

/** The canvas beyond each side of the map: the fixed gutter on a horizontal map, nothing on a vertical one. */
export const gutterPad = (vertical: boolean): Pad => (vertical ? NO_PAD : GUTTER)

/** Whether map pixel (x, y) is inside a map of `mapW` x `mapH` pixels. */
export const insideMap = (x: number, y: number, mapW: number, mapH: number): boolean =>
  x >= 0 && y >= 0 && x < mapW && y < mapH

const decoded = new WeakMap<MapSpriteDto, Uint8ClampedArray>()

/**
 * The sprite pixels that fall in the margin `pad` (the gutter bands), on a bitmap of the padded
 * size. The map's own pixels stay transparent (the screens draw those, under the tiles'
 * priority) and so does everything beyond the gutter or above or below the map, as on develop.
 * The bitmap spans the whole padded strip rather than just the two bands: simpler, and it is
 * only allocated when a sprite reaches the gutter. Stacked as the screens stack them, by
 * position along the scroll axis then stream index. Null when no sprite reaches the margin.
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
