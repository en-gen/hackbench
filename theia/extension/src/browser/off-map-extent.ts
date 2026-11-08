/**
 * How far the map view's canvas reaches past the map (owner rulings D76 call 2, D145, #1004, #1228).
 * Pure (no DOM, no Theia).
 *
 * Each side's pad is the content the data PLACES off the map there (a refused-object cell, a sprite's
 * placement cell), rounded up to whole 16 px tiles. Art that spills past an edge from a placement on the
 * map is cut there and grows nothing, on every side (owner ruling on #1325, 2026-11-07, narrowing D76
 * call 2); art that lands in the far-end gutter still draws there. The FAR end only (right of a
 * horizontal map, bottom of a vertical one) adds a 256 px gutter BEYOND that content, even for a map
 * with nothing off it, unless the map is at the 32-screen ceiling. There is no gutter before position 0
 * (growing that way would move (0,0)), and the short sides get the content alone. This is the single place
 * the canvas grows: every pointer and overlay consumer reads the resulting `Pad` as one origin.
 */
import { MAP_PLANE_KEYS, type MapPlaneKey, type MapSpriteDto } from '../common/project-protocol'
import {
  composeScreen,
  DOOR_PART_BIT,
  type ScreenInput,
  type SourceKey,
} from '../../../../src/rom/model/ColorMath'
import { decodeBase64Bytes, decodeRgba } from './map16-pixels'
import { hiddenPixelStrength } from '../../../../src/rom/render/HiddenTiles'
import { MAX_BEYOND_SCREENS, farGutter } from '../../../../src/rom/model/MapGutter'

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
 * The padding that holds every rect, plus the far-end gutter. `vertical` says which end is far (right or
 * bottom) and `screenCount` whether it has one (none at 32). A rect inside the map adds nothing: a map
 * with no off-map content is padded by the far-end gutter alone.
 */
export function offMapPad(
  mapW: number,
  mapH: number,
  rects: Iterable<Rect>,
  vertical: boolean,
  screenCount: number,
): Pad {
  let [l, t, r, b] = [0, 0, 0, 0]
  for (const q of rects) {
    l = Math.max(l, -q.x0)
    t = Math.max(t, -q.y0)
    r = Math.max(r, q.x1 - mapW)
    b = Math.max(b, q.y1 - mapH)
  }
  const gutter = farGutter(screenCount)
  return {
    left: tiles(l),
    top: tiles(t),
    right: tiles(r) + (vertical ? 0 : gutter),
    bottom: tiles(b) + (vertical ? gutter : 0),
  }
}

/**
 * The alpha mask that fades the back area (owner R24, #1228): opaque from the near edge across the map
 * and any content band, fading linearly to transparent over the far-end gutter only ("to right" on a
 * horizontal map, "to bottom" on a vertical one). A content band is not a gutter and stays opaque
 * [PROP]. With no gutter (a 32-screen map) there is no mask. A mask rather than a gradient background
 * keeps the back area's own `background-color` the map's back color, which tests and tools read.
 * `gutterPx` is the far-end gutter times the zoom.
 */
export const fadeMask = (vertical: boolean, gutterPx: number): string =>
  gutterPx > 0
    ? `linear-gradient(${vertical ? 'to bottom' : 'to right'}, #000 calc(100% - ${gutterPx}px), transparent)`
    : 'none'

/**
 * How many screens past the last one the layers must be fetched for, to fill `farPad` map px of far-end
 * canvas (off-map content band plus gutter, #1197) with screens `screenLen` px long on the scroll axis.
 */
export const beyondScreens = (farPad: number, screenLen: number): number =>
  farPad > 0 ? Math.min(Math.ceil(farPad / screenLen), MAX_BEYOND_SCREENS) : 0

/**
 * Fades the layers that continue through the far end (#1197): opaque from the map's edge across any
 * off-map content band, then linear to alpha 0 over the last `gutter` px of the far axis, the same ramp
 * as `fadeMask` (opaque to `length - gutter`, clear at `length`, sampled at pixel centers). `gutter` is
 * `farGutter(screenCount)`, so the two cannot drift. Done on the pixels, not a CSS mask, so a toggle or an
 * edit repaints one canvas. Multiplies alpha in place; `vertical` picks the far axis (y, else x).
 */
export function fadeFarEnd(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  vertical: boolean,
  gutter: number,
): void {
  if (gutter <= 0) return
  const length = vertical ? height : width
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const into = (vertical ? y : x) + 0.5 - (length - gutter)
      if (into <= 0) continue
      const a = y * width * 4 + x * 4 + 3
      rgba[a] = Math.round(rgba[a]! * Math.max(0, 1 - into / gutter))
    }
  }
}

/**
 * Clears the alpha of every pixel no plane NAMED in the screen's lists covers. `composeScreen` can fill a
 * pixel nothing it composed drew (color math against the black backdrop); in the gutter that pixel must
 * stay clear so the back area, which has its own fade, is not faded a second time (#1197). Keyed on the
 * lists, not on every plane present: a plane in neither list is not composed, so it covers nothing.
 */
export function clearUncovered(
  out: Uint8ClampedArray,
  planes: Partial<Record<SourceKey, Uint8ClampedArray | null>>,
  lists: { main: readonly SourceKey[]; sub: readonly SourceKey[] },
): void {
  const named = new Set([...lists.main, ...lists.sub])
  const sources = [...named].map(k => planes[k]).filter((p): p is Uint8ClampedArray => !!p)
  for (let a = 3; a < out.length; a += 4) {
    if (sources.every(p => p[a] === 0)) out[a] = 0
  }
}

/** One gutter screen as the view holds it: its shown-or-not planes and the stacking and color math of its reply. */
export interface GutterShot {
  width: number
  height: number
  planes: Partial<Record<MapPlaneKey, Uint8ClampedArray | null>>
  lists: ScreenInput['lists']
  math: ScreenInput['math']
}

/**
 * The far-end canvas's pixels (#1197): each screen past the last composed with the map's own stacking and
 * color math from the planes `shown` lets through (no Layer 1, sprites or flames), pixels nothing covered
 * left clear, the screens laid end to end along the scroll axis, and the whole faded over the last `gutter`
 * px. `w` x `h` is the canvas; a missing screen (a reply not in yet) leaves its stretch clear.
 */
export function composeGutter(
  shots: readonly (GutterShot | undefined)[],
  shown: (plane: MapPlaneKey) => boolean,
  vertical: boolean,
  w: number,
  h: number,
  gutter: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  shots.forEach((shot, i) => {
    if (!shot) return
    const { width: sw, height: sh, lists, math } = shot
    const planes: Partial<Record<MapPlaneKey, Uint8ClampedArray | null>> = {}
    for (const k of MAP_PLANE_KEYS) if (shown(k)) planes[k] = shot.planes[k] ?? null
    const one = composeScreen({ width: sw, height: sh, planes, lists, math })
    clearUncovered(one, planes, lists)
    if (vertical) out.set(one.subarray(0, Math.min(sh, h - i * sh) * sw * 4), i * sh * sw * 4)
    else for (let y = 0; y < h; y++) out.set(one.subarray(y * sw * 4, (y * sw + Math.min(sw, w - i * sw)) * 4), (y * w + i * sw) * 4) // prettier-ignore
  })
  fadeFarEnd(out, w, h, vertical, gutter)
  return out
}

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
  /** The screen under scroll position `px`, clamped into the map so a pad position gives its nearest edge screen. */
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

/** Whether two pads are the same on every side: a change is what makes the view restore its place. */
export const samePad = (a: Pad, b: Pad): boolean =>
  a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom

/** A refused object's 16 x 16 cell at tile (x, y). */
export const cellRect = (x: number, y: number): Rect => ({
  x0: x * TILE,
  y0: y * TILE,
  x1: (x + 1) * TILE,
  y1: (y + 1) * TILE,
})

/**
 * A sprite's placement cell: the 16 x 16 tile at `stored` where the map stores it elsewhere than it draws,
 * else at its anchor (#1325, [PROP]). The pad grows for this, never for the art in `box`.
 */
export const placementRect = (s: Pick<MapSpriteDto, 'x' | 'y' | 'stored'>): Rect => {
  const { x, y } = s.stored ?? s
  return { x0: x, y0: y, x1: x + TILE, y1: y + TILE }
}

/**
 * What the data places on the canvas, for `offMapPad`: each refused cell and each sprite's placement cell.
 * The fallback: a sprite whose art overlaps neither the map nor its own placement cell would have no visible anchor on the
 * trimmed canvas, so its `box` counts too and the pad grows to keep it drawn and selectable (D52 "never hide a placed
 * sprite", [PROP] on #1325). A sprite that overlaps either one needs no extra room, which keeps the pad from growing
 * for art that is already reachable.
 */
export const contentRects = (
  refused: readonly { x: number; y: number }[],
  sprites: readonly MapSpriteDto[],
  mapW: number,
  mapH: number,
): Rect[] => [
  ...refused.map(c => cellRect(c.x, c.y)),
  ...sprites.flatMap(s => {
    const cell = placementRect(s)
    const touches = (r: Rect) =>
      r.x0 < s.box.x1 && r.x1 > s.box.x0 && r.y0 < s.box.y1 && r.y1 > s.box.y0
    const seen = touches({ x0: 0, y0: 0, x1: mapW, y1: mapH }) || touches(cell)
    return seen ? [cell] : [cell, s.box]
  }),
]

/** Whether map pixel (x, y) is inside the map: positions in the pad have negative or too-large coordinates. */
export const insideMap = (x: number, y: number, mapW: number, mapH: number): boolean =>
  x >= 0 && y >= 0 && x < mapW && y < mapH

const decoded = new WeakMap<MapSpriteDto, { rgba: Uint8ClampedArray; prio: Uint8Array | null }>()

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
    if (!bmp)
      decoded.set(
        s,
        (bmp = {
          rgba: decodeRgba(s.rgba),
          prio: s.priority ? decodeBase64Bytes(s.priority) : null,
        }),
      )
    for (let y = Math.max(y0, -pad.top); y < Math.min(y1, mapH + pad.bottom); y++) {
      for (let x = Math.max(x0, -pad.left); x < Math.min(x1, mapW + pad.right); x++) {
        if (insideMap(x, y, mapW, mapH)) continue
        const from = ((y - y0) * (x1 - x0) + (x - x0)) * 4
        if (bmp.rgba[from + 3] === 0) continue
        out ??= new Uint8ClampedArray(w * h * 4)
        const to = ((y + pad.top) * w + x + pad.left) * 4
        out.set(bmp.rgba.subarray(from, from + 4), to)
        // A door part (the rope's extra length) keeps the door's squares past the map edge too.
        if (bmp.prio && bmp.prio[from / 4]! & DOOR_PART_BIT)
          out[to + 3] = Math.round(255 * hiddenPixelStrength(x - x0, y - y0))
      }
    }
  }
  return out
}
